import { expect, test } from 'bun:test';
import { buildState, stripExcluded, MAX_PER_MESSAGE, MAX_TOTAL } from '../src/state';

test('wi-exclude 태그 블록 제거', () => {
  const t = '본문<status wi-exclude>HP 10\n위치: 게이트</status>끝 <hud class="a" wi-exclude="true">x</hud>';
  expect(stripExcluded(t)).toBe('본문끝');
});
test('wi-exclude 없는 태그와 비슷한 이름은 유지', () => {
  expect(stripExcluded('<status>keep</status> <b data-wi-excluded>k</b>')).toBe('<status>keep</status> <b data-wi-excluded>k</b>');
});
test('details 제거', () => {
  expect(stripExcluded('a<details><summary>s</summary>숨김</details>b')).toBe('ab');
});
test('역할: 내용, 인사말 제외, 최근 N개', () => {
  const m = [
    { role: 'assistant', content: '인사말', is_greeting: true },
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
  ];
  expect(buildState(m, 2)).toBe('assistant: a1\nuser: u2');
  expect(buildState(m, 10)).toBe('user: u1\nassistant: a1\nuser: u2');
});
test('메시지당 1500자 상한(뒤쪽 유지)', () => {
  const s = buildState([{ role: 'user', content: 'x'.repeat(2000) + 'END' }], 6);
  expect(s.length).toBe('user: '.length + MAX_PER_MESSAGE);
  expect(s.endsWith('END')).toBe(true);
});
test('합계 8000자 상한, 최근 메시지 우선', () => {
  const m = Array.from({ length: 10 }, (_, i) => ({ role: 'assistant', content: `${i}`.repeat(1500) }));
  const s = buildState(m, 10);
  expect(s.length).toBeLessThanOrEqual(MAX_TOTAL);
  expect(s.endsWith('9'.repeat(100))).toBe(true);
});
test('제거 후 빈 메시지는 건너뜀', () => {
  expect(buildState([{ role: 'user', content: '<s wi-exclude>x</s>' }, { role: 'user', content: 'hi' }], 6)).toBe('user: hi');
});
