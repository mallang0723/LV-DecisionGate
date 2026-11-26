import { expect, test } from 'bun:test';
import { createGate, TimeoutError, type EvaluateFn, type GateCtx } from '../src/gate';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';

const context = (): GateCtx => ({
  chatId: 'chat',
  purpose: 'prompt',
  entries: [{ id: 'entry', comment: 'Entry', extensions: { decision_gate: { mode: 'trigger', statement: 'PRIVATE-CONDITION' } } }],
  messages: [{ id: 'message', role: 'user', content: 'PRIVATE-SCENE' }],
});
const success: EvaluateFn = async () => ({
  answers: { entry: { noul: 0.69 } },
  usage: { input_tokens: 10, output_tokens: 2, cost: 0.001 },
});

test('language defaults to en for new, existing, unreadable, and invalid settings', () => {
  expect(DEFAULT_SETTINGS.language).toBe('en');
  for (const raw of [undefined, null, {}, [], 'invalid', { enabled: true }, { language: null }, { language: 'fr' }, { language: 1 }]) {
    expect(normalizeSettings(raw).language).toBe('en');
  }
  expect(normalizeSettings({ language: 'en' }).language).toBe('en');
  expect(normalizeSettings({ language: 'ko' }).language).toBe('ko');
});

for (const language of [undefined, 'en', 'ko'] as const) {
  const label = language ?? 'default';
  const korean = language === 'ko';
  function setup(evaluate: EvaluateFn = success, extra: Record<string, unknown> = {}) {
    const logs: string[] = [];
    let time = 0;
    const gate = createGate({
      evaluate,
      getSettings: () => ({ language, ...extra }),
      log: (line) => logs.push(line),
      now: () => { time += 691; return time; },
    });
    return { gate, logs };
  }

  test(`${label}: scores, timing, usage, and cost retain the exact numeric format`, async () => {
    const { gate, logs } = setup();
    await gate.handler(context());
    expect(logs).toEqual(['[decision-gate] "Entry"=0.69 691ms in=10 out=2 cost=0.001']);
    await gate.handler(context());
    expect(logs[1]).toBe(korean ? '[decision-gate] 캐시 적중 (항목 1개)' : '[decision-gate] cache hit (entries 1)');
    expect(gate.evaluateCalls()).toBe(1);
  });

  test(`${label}: empty scene preserves count and skips evaluation`, async () => {
    const { gate, logs } = setup();
    await gate.handler({ ...context(), messages: [] });
    expect(logs).toEqual([korean ? '[decision-gate] 빈 장면, 호출 생략 (항목 1개)' : '[decision-gate] empty scene, call skipped (entries 1)']);
    expect(gate.evaluateCalls()).toBe(0);
  });

  for (const failure of ['error', 'timeout', 'bad-response'] as const) {
    test(`${label}: ${failure} retains category, missing score, and timing without private content`, async () => {
      const { gate, logs } = setup(async () => {
        if (failure === 'error') throw new Error('PRIVATE-ERROR');
        if (failure === 'timeout') throw new TimeoutError('PRIVATE-ERROR');
        return { answers: null } as unknown as Awaited<ReturnType<EvaluateFn>>;
      });
      await gate.handler(context());
      expect(logs).toEqual([`[decision-gate] ${korean ? '실패' : 'failed'}(${failure}) "Entry"=n/a 691ms`]);
      expect(gate.cacheSize()).toBe(0);
    });
  }

  test(`${label}: log_decisions=false suppresses success, cache, empty-scene, and failure logs`, async () => {
    const { gate, logs } = setup(success, { log_decisions: false });
    await gate.handler(context());
    await gate.handler(context());
    await gate.handler({ ...context(), messages: [] });
    const failed = setup(async () => { throw new Error('PRIVATE-ERROR'); }, { log_decisions: false });
    await failed.gate.handler(context());
    expect([...logs, ...failed.logs]).toEqual([]);
  });
}

test('changing language applies to the next call while preserving cached decisions', async () => {
  let language = 'en';
  const logs: string[] = [];
  const gate = createGate({ evaluate: success, getSettings: () => ({ language }), log: (line) => logs.push(line) });
  await gate.handler(context());
  language = 'ko';
  await gate.handler(context());
  expect(logs[1]).toBe('[decision-gate] 캐시 적중 (항목 1개)');
  language = 'en';
  await gate.handler(context());
  expect(logs[2]).toBe('[decision-gate] cache hit (entries 1)');
  expect(gate.evaluateCalls()).toBe(1);
});

test('backend startup and unexpected errors use the stored language, defaulting to English', async () => {
  const host = globalThis as unknown as { spindle?: unknown };
  const original = host.spindle;
  try {
    for (const mode of ['missing', 'en', 'ko', 'unreadable'] as const) {
      const infos: string[] = [];
      const warnings: string[] = [];
      let handler: ((ctx: GateCtx) => Promise<unknown>) | undefined;
      let language = mode === 'ko' ? 'ko' : 'en';
      host.spindle = {
        storage: { getJson: async (path: string) => {
          expect(path).toBe('settings.json');
          if (mode === 'unreadable') throw new Error('PRIVATE-STORAGE-ERROR');
          return mode === 'missing' ? {} : { language, log_decisions: false };
        } },
        decisions: { evaluate: success },
        log: { info: (line: string) => infos.push(line), warn: (line: string) => warnings.push(line) },
        registerWorldInfoInterceptor: (callback: typeof handler, priority: number) => {
          expect(priority).toBe(100);
          handler = callback;
        },
      };
      await import(`../src/backend.ts?language-test=${mode}`);
      expect(infos).toEqual([mode === 'ko' ? '[decision-gate] 준비됨' : '[decision-gate] ready']);
      expect(handler).toBeDefined();
      const broken = context();
      Object.defineProperty(broken, 'entries', { get() { throw new TypeError('PRIVATE-ERROR'); } });
      expect(await handler!(broken)).toBeUndefined();
      expect(warnings).toEqual([mode === 'ko'
        ? '[decision-gate] 내부 오류, 통과: TypeError'
        : '[decision-gate] internal error, passed through: TypeError']);
      if (mode === 'en') {
        language = 'ko';
        await handler!(broken);
        expect(warnings[1]).toBe('[decision-gate] 내부 오류, 통과: TypeError');
      }
    }
  } finally {
    if (original === undefined) delete host.spindle;
    else host.spindle = original;
  }
});
