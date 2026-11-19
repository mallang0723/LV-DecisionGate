import { expect, test } from 'bun:test';
import { createGate, type EvaluateFn, type GateCtx } from '../src/gate';

function ctx(over: Partial<GateCtx> = {}): GateCtx {
  return {
    purpose: 'prompt', chatId: 'chat', userId: 'u',
    entries: [
      { id: 'a', comment: '!중계', disabled: false, extensions: { decision_gate: { mode: 'trigger', statement: 'A?' } } },
      { id: 'b', comment: '!게이트', disabled: false, extensions: { decision_gate: { mode: 'require', statement: 'B?', threshold: 0.6 } } },
      { id: 'c', comment: '일반', disabled: false, extensions: {} },
    ],
    messages: [
      { id: 'g', role: 'assistant', content: '인사말', is_greeting: true },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `<status wi-exclude>HP</status>장면${i}` })),
    ],
    ...over,
  };
}
function mock(impl: (n: number) => Promise<any>) {
  const calls: any[] = [];
  const evaluate: EvaluateFn = (input, opt) => { calls.push({ input, opt }); return impl(calls.length); };
  return { evaluate, calls };
}
const yes = async () => ({ answers: { a: { type: 'noul', noul: 0.9 }, b: { type: 'noul', noul: 0.9 } } });
const no = async () => ({ answers: { a: { type: 'noul', noul: 0.1 }, b: { type: 'noul', noul: 0.1 } } });

test('예: trigger 항목 forced, require 항목 유지', async () => {
  const m = mock(yes);
  const g = createGate({ evaluate: m.evaluate, getSettings: () => ({}) });
  expect(await g.handler(ctx())).toEqual({ forced: ['a'] });
  expect(m.calls).toHaveLength(1);
  const { input } = m.calls[0];
  expect(Object.keys(input.questions)).toEqual(['a', 'b']);
  expect(input.questions.a).toEqual({ type: 'noul', instructions: 'A?' });
  expect(input.state).toBe('user: 장면0\nassistant: 장면1\nuser: 장면2\nassistant: 장면3\nuser: 장면4');
  expect(input.userId).toBe('u');
  expect(input.connection_id).toBeUndefined();
});
test('아니오: require 항목 disabled', async () => {
  const g = createGate({ evaluate: mock(no).evaluate, getSettings: () => ({}) });
  expect(await g.handler(ctx())).toEqual({ disabled: ['b'] });
});
test('예외: trigger 무동작, require 끔 / fail_open_require면 빈 결과', async () => {
  const boom = async () => { throw new Error('SECRET-BODY'); };
  const logs: string[] = [];
  const g = createGate({ evaluate: mock(boom).evaluate, getSettings: () => ({}), log: (s) => logs.push(s) });
  expect(await g.handler(ctx())).toEqual({ disabled: ['b'] });
  expect(logs.join('\n')).not.toContain('SECRET-BODY');
  const g2 = createGate({ evaluate: mock(boom).evaluate, getSettings: () => ({ fail_open_require: true }) });
  expect(await g2.handler(ctx())).toEqual({});
});
test('시간 초과: 멈춘 evaluate는 timeout_ms 뒤 실패 처리, 캐시 안 함', async () => {
  const m = mock(() => new Promise(() => {}));
  const g = createGate({ evaluate: m.evaluate, getSettings: () => ({ timeout_ms: 500 }) });
  expect(await g.handler(ctx())).toEqual({ disabled: ['b'] });
  expect(m.calls[0].opt.signal.aborted).toBe(true);
  expect(g.cacheSize()).toBe(0);
  await g.handler(ctx());
  expect(m.calls).toHaveLength(2);
});
test('opt-in 없으면 void, evaluate 0회', async () => {
  const m = mock(yes);
  const g = createGate({ evaluate: m.evaluate, getSettings: () => ({}) });
  const c = ctx(); c.entries = c.entries.map((e) => ({ ...e, extensions: {} }));
  expect(await g.handler(c)).toBeUndefined();
  expect(m.calls).toHaveLength(0);
});
test('disabled 항목만 opt-in이면 void; purpose=query / enabled=false도 void', async () => {
  const m = mock(yes);
  const g = createGate({ evaluate: m.evaluate, getSettings: () => ({}) });
  const c = ctx(); c.entries = c.entries.map((e) => ({ ...e, disabled: true }));
  expect(await g.handler(c)).toBeUndefined();
  expect(await g.handler(ctx({ purpose: 'query' }))).toBeUndefined();
  const off = createGate({ evaluate: m.evaluate, getSettings: () => ({ enabled: false }) });
  expect(await off.handler(ctx())).toBeUndefined();
  expect(m.calls).toHaveLength(0);
});
test('동일 ctx 두 번 → evaluate 1회(캐시), 새 메시지면 재호출', async () => {
  const m = mock(yes);
  const g = createGate({ evaluate: m.evaluate, getSettings: () => ({}) });
  const r1 = await g.handler(ctx());
  const r2 = await g.handler(ctx());
  expect(r2).toEqual(r1);
  expect(m.calls).toHaveLength(1);
  const c = ctx(); c.messages = [...c.messages, { id: 'm9', role: 'user', content: '새 입력' }];
  await g.handler(c);
  expect(m.calls).toHaveLength(2);
});
test('LRU 50개 상한', async () => {
  const g = createGate({ evaluate: mock(yes).evaluate, getSettings: () => ({}) });
  for (let i = 0; i < 60; i++) await g.handler(ctx({ chatId: `c${i}` }));
  expect(g.cacheSize()).toBe(50);
});
test('로그에 대화 본문·판단 문장 없음, 항목 이름·점수·시간만', async () => {
  const logs: string[] = [];
  const g = createGate({ evaluate: mock(yes).evaluate, getSettings: () => ({}), log: (s) => logs.push(s) });
  await g.handler(ctx());
  const all = logs.join('\n');
  expect(all).toContain('!중계=0.90'.replace('!중계', '"!중계"'));
  expect(all).not.toContain('장면');
  expect(all).not.toContain('A?');
});
test('connection_id 설정은 evaluate에 전달', async () => {
  const m = mock(yes);
  await createGate({ evaluate: m.evaluate, getSettings: () => ({ connection_id: 'conn-1' }) }).handler(ctx());
  expect(m.calls[0].input.connection_id).toBe('conn-1');
});
