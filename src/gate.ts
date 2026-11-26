import { buildState, type StateMessage } from './state';
import { normalizeSettings, type GateSettings } from './settings';
import { LOG_MESSAGES } from './i18n';

/** 항목 extensions 안의 읽는 이름 (설계서 §3 + identifier 폴백). */
export const NAMESPACES = ['decision_gate', 'decision_gate_lv'] as const;

export interface EntryConfig {
  id: string;
  name: string;
  mode: 'trigger' | 'require';
  statement: string;
  threshold: number;
}

export interface GateEntry {
  id: string;
  comment?: string;
  disabled?: boolean;
  extensions?: Readonly<Record<string, unknown>>;
}
export interface GateMessage extends StateMessage {
  id: string;
}
export interface GateCtx {
  purpose?: string;
  chatId: string;
  userId?: string;
  entries: readonly GateEntry[];
  messages: readonly GateMessage[];
  signal?: AbortSignal;
}
export interface GateResult {
  forced?: string[];
  disabled?: string[];
}
export interface EvaluateFn {
  (
    input: { connection_id?: string; state: string; questions: Record<string, { type: 'noul'; instructions: string }>; userId?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ answers: Record<string, unknown>; usage?: { input_tokens?: number | null; output_tokens?: number | null; cost?: number | null } }>;
}
export interface GateDeps {
  evaluate: EvaluateFn;
  getSettings: () => Promise<unknown> | unknown;
  log?: (msg: string) => void;
  now?: () => number;
}

export function parseEntryConfig(e: GateEntry): EntryConfig | null {
  if (e.disabled) return null;
  const ext = e.extensions ?? {};
  let raw: unknown;
  for (const ns of NAMESPACES) if (ext[ns] && typeof ext[ns] === 'object') { raw = ext[ns]; break; }
  if (!raw) return null;
  const r = raw as Record<string, unknown>;
  if (r.mode !== 'trigger' && r.mode !== 'require') return null;
  if (typeof r.statement !== 'string' || !r.statement.trim()) return null;
  const th = typeof r.threshold === 'number' && Number.isFinite(r.threshold) ? Math.min(1, Math.max(0, r.threshold)) : 0.5;
  return { id: e.id, name: String(e.comment ?? e.id), mode: r.mode, statement: r.statement.trim(), threshold: th };
}

export function hashText(s: string): string {
  return Bun.hash(s).toString(36);
}

/** 키 = 채팅 + 실제로 보내는 장면 문자열(state) 해시 + 항목·연결 설정. 판단 창 안 어느 메시지가 바뀌어도 달라진다. */
export function cacheKey(chatId: string, state: string, configs: readonly EntryConfig[], s: GateSettings): string {
  const cfg = configs.map((c) => [c.id, c.mode, c.statement, c.threshold]);
  const sh = [s.connection_id, s.history_messages, s.fail_open_require];
  return [chatId, hashText(state), hashText(JSON.stringify([cfg, sh]))].join('|');
}

/** noul 응답 → 점수. 숫자가 아니면 null(실패). */
function scoreOf(answer: unknown): number | null {
  if (!answer || typeof answer !== 'object') return null;
  const n = (answer as { noul?: unknown }).noul;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** 순수 계산: 질문 묶기. */
export function buildQuestions(configs: readonly EntryConfig[]): Record<string, { type: 'noul'; instructions: string }> {
  const q: Record<string, { type: 'noul'; instructions: string }> = {};
  for (const c of configs) q[c.id] = { type: 'noul', instructions: c.statement };
  return q;
}

/** 순수 계산: 점수 → forced/disabled. answers가 null이면 전체 실패. */
export function decide(
  configs: readonly EntryConfig[],
  answers: Record<string, unknown> | null,
  failOpenRequire: boolean,
): { result: GateResult; scores: Record<string, number | null> } {
  const forced: string[] = [];
  const disabled: string[] = [];
  const scores: Record<string, number | null> = {};
  for (const c of configs) {
    const score = answers ? scoreOf(answers[c.id]) : null;
    scores[c.id] = score;
    if (score === null) {
      if (c.mode === 'require' && !failOpenRequire) disabled.push(c.id);
      continue;
    }
    const yes = score >= c.threshold;
    if (c.mode === 'trigger' && yes) forced.push(c.id);
    if (c.mode === 'require' && !yes) disabled.push(c.id);
  }
  const result: GateResult = {};
  if (forced.length) result.forced = forced;
  if (disabled.length) result.disabled = disabled;
  return { result, scores };
}

export class TimeoutError extends Error {}

export function createGate(deps: GateDeps) {
  const cache = new Map<string, GateResult>(); // 삽입 순서 = LRU 순서
  const CACHE_MAX = 50;
  const now = deps.now ?? Date.now;
  let evaluateCalls = 0;

  async function handler(ctx: GateCtx): Promise<GateResult | void> {
    if (ctx.purpose === 'query') return; // 프롬프트 조립이 아닌 조회
    const configs = ctx.entries.map(parseEntryConfig).filter((c): c is EntryConfig => c !== null);
    if (configs.length === 0) return;

    const settings = normalizeSettings(await deps.getSettings());
    const messages = LOG_MESSAGES[settings.language];
    if (!settings.enabled) return;

    const state = buildState(ctx.messages, settings.history_messages);
    if (!state) {
      // 빈 장면(인사말뿐 등): 유료 호출 없이 실패와 같은 규칙으로 처리
      const { result } = decide(configs, null, settings.fail_open_require);
      if (settings.log_decisions) deps.log?.(messages.emptyScene(configs.length));
      return result;
    }
    const key = cacheKey(ctx.chatId, state, configs, settings);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      if (settings.log_decisions) deps.log?.(messages.cacheHit(configs.length));
      return hit;
    }

    const started = now();
    let answers: Record<string, unknown> | null = null;
    let failure = '';
    let usageNote = '';
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCtxAbort = () => ac.abort();
    try {
      if (ctx.signal) {
        if (ctx.signal.aborted) ac.abort();
        else ctx.signal.addEventListener('abort', onCtxAbort, { once: true });
      }
      const aborted = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { ac.abort(); reject(new TimeoutError('timeout')); }, settings.timeout_ms);
        ac.signal.addEventListener('abort', () => reject(new TimeoutError('aborted')), { once: true });
      });
      aborted.catch(() => {});
      evaluateCalls++;
      const res = await Promise.race([
        deps.evaluate(
          {
            ...(settings.connection_id ? { connection_id: settings.connection_id } : {}),
            state,
            questions: buildQuestions(configs),
            ...(ctx.userId ? { userId: ctx.userId } : {}),
          },
          { signal: ac.signal },
        ),
        aborted,
      ]);
      answers = res && typeof res === 'object' && res.answers && typeof res.answers === 'object' ? res.answers : null;
      if (!answers) failure = 'bad-response';
      const u = res && typeof res === 'object' ? res.usage : undefined;
      if (u && typeof u === 'object') {
        const f = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
        const bits = [['in', f(u.input_tokens)], ['out', f(u.output_tokens)], ['cost', f(u.cost)]].filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`);
        if (bits.length) usageNote = ` ${bits.join(' ')}`;
      }
    } catch (err) {
      failure = err instanceof TimeoutError ? 'timeout' : 'error'; // 오류 본문은 기록하지 않는다
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onCtxAbort);
    }
    const elapsed = now() - started;

    const { result, scores } = decide(configs, answers, settings.fail_open_require);
    if (settings.log_decisions) {
      const parts = configs.map((c) => `"${c.name}"=${scores[c.id] === null ? 'n/a' : (scores[c.id] as number).toFixed(2)}`);
      deps.log?.(messages.decision(failure, parts.join(' '), elapsed, usageNote));
    }
    if (!failure) {
      cache.set(key, result);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    }
    return result;
  }

  return { handler, cacheSize: () => cache.size, evaluateCalls: () => evaluateCalls };
}
