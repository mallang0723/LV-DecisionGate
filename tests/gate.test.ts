import { expect, test } from 'bun:test';
import { buildQuestions, cacheKey, createGate, decide, parseEntryConfig, type GateCtx, type GateEntry, type GateMessage } from '../src/gate';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';

const ext = (o: unknown, ns = 'decision_gate') => ({ [ns]: o });
const entries = (): GateEntry[] => [
  { id: 'e1', comment: '!중계', disabled: false, extensions: ext({ mode: 'trigger', statement: 'S1' }) },
  { id: 'e2', comment: '!게이트', disabled: false, extensions: ext({ mode: 'require', statement: 'S2', threshold: 0.7 }) },
  { id: 'e3', comment: '평범', disabled: false, extensions: {} },
];
const msgs = (): GateMessage[] => [
  { id: 'g', role: 'assistant', content: '인사', is_greeting: true },
  ...Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `내용${i}` })),
];
const mkCtx = (over: Partial<GateCtx> = {}): GateCtx => ({ purpose: 'prompt', chatId: 'c1', userId: 'u', entries: entries(), messages: msgs(), ...over });

test('parseEntryConfig: opt-in, disabled, 잘못된 값, 기본 threshold, identifier 폴백', () => {
  expect(parseEntryConfig(entries()[0]!)).toMatchObject({ id: 'e1', mode: 'trigger', threshold: 0.5, name: '!중계' });
  expect(parseEntryConfig(entries()[2]!)).toBeNull();
  expect(parseEntryConfig({ ...entries()[0]!, disabled: true })).toBeNull();
  expect(parseEntryConfig({ id: 'x', extensions: ext({ mode: 'bad', statement: 's' }) })).toBeNull();
  expect(parseEntryConfig({ id: 'x', extensions: ext({ mode: 'trigger', statement: ' ' }) })).toBeNull();
  expect(parseEntryConfig({ id: 'x', extensions: ext({ mode: 'trigger', statement: 's' }, 'decision_gate_lv') })).not.toBeNull();
  expect(parseEntryConfig({ id: 'x', extensions: ext({ mode: 'trigger', statement: 's', threshold: 9 }) })!.threshold).toBe(1);
});

test('질문 묶기: 항목 id 키, noul', () => {
  const cfgs = [parseEntryConfig(entries()[0]!)!, parseEntryConfig(entries()[1]!)!];
  expect(buildQuestions(cfgs)).toEqual({ e1: { type: 'noul', instructions: 'S1' }, e2: { type: 'noul', instructions: 'S2' } });
});

test('decide: trigger/require 임계값 경계', () => {
  const cfgs = [parseEntryConfig(entries()[0]!)!, parseEntryConfig(entries()[1]!)!];
  expect(decide(cfgs, { e1: { type: 'noul', noul: 0.5 }, e2: { type: 'noul', noul: 0.7 } }, false).result).toEqual({ forced: ['e1'] });
  expect(decide(cfgs, { e1: { noul: 0.49 }, e2: { noul: 0.69 } }, false).result).toEqual({ disabled: ['e2'] });
});
test('decide: 실패 시 trigger 무동작, require는 끔(fail_open이면 통과)', () => {
  const cfgs = [parseEntryConfig(entries()[0]!)!, parseEntryConfig(entries()[1]!)!];
  expect(decide(cfgs, null, false).result).toEqual({ disabled: ['e2'] });
  expect(decide(cfgs, null, true).result).toEqual({});
  expect(decide(cfgs, { e1: { noul: 'x' } }, false).result).toEqual({ disabled: ['e2'] });
});

test('캐시 키: state·채팅·항목 설정이 바뀌면 달라짐', () => {
  const cfgs = [parseEntryConfig(entries()[0]!)!];
  const base = cacheKey('c', 'user: a', cfgs, DEFAULT_SETTINGS);
  expect(cacheKey('c', 'user: a', cfgs, DEFAULT_SETTINGS)).toBe(base);
  expect(cacheKey('d', 'user: a', cfgs, DEFAULT_SETTINGS)).not.toBe(base);
  expect(cacheKey('c', 'user: b', cfgs, DEFAULT_SETTINGS)).not.toBe(base);
  const cfg2 = [{ ...cfgs[0]!, statement: 'changed' }];
  expect(cacheKey('c', 'user: a', cfg2, DEFAULT_SETTINGS)).not.toBe(base);
  expect(cacheKey('c', 'user: a', cfgs, { ...DEFAULT_SETTINGS, connection_id: 'x' })).not.toBe(base);
});

test('설정 검증: 타입·범위·timeout 클램프(<10000)', () => {
  expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  const s = normalizeSettings({ enabled: 'no', timeout_ms: 99999, history_messages: 0, connection_id: ' ', log_decisions: 1 });
  expect(s.enabled).toBe(true);
  expect(s.timeout_ms).toBeLessThan(10000);
  expect(s.history_messages).toBe(1);
  expect(s.connection_id).toBeNull();
  expect(s.log_decisions).toBe(true);
  expect(normalizeSettings({ timeout_ms: 1 }).timeout_ms).toBe(500);
});

test('타임아웃: evaluate가 멈추면 timeout_ms 안에 반환', async () => {
  const gate = createGate({ evaluate: () => new Promise(() => {}), getSettings: () => ({ timeout_ms: 500 }) });
  const t = Date.now();
  const r = await gate.handler(mkCtx());
  expect(Date.now() - t).toBeLessThan(1500);
  expect(r).toEqual({ disabled: ['e2'] });
});
test('ctx.signal 중단 시 즉시 실패 처리', async () => {
  const ac = new AbortController();
  const gate = createGate({ evaluate: () => new Promise(() => {}), getSettings: () => ({}) });
  const p = gate.handler(mkCtx({ signal: ac.signal }));
  setTimeout(() => ac.abort(), 20);
  expect(await p).toEqual({ disabled: ['e2'] });
});
