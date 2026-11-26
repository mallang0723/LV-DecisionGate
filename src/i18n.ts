// Keep numeric fields and machine-readable failure categories identical in both languages.
const decision = (failed: string) => (failure: string, scores: string, elapsed: number, usage: string) =>
  `[decision-gate] ${failure ? `${failed}(${failure}) ` : ''}${scores} ${elapsed}ms${usage}`;

export const LOG_MESSAGES = {
  en: {
    ready: '[decision-gate] ready',
    emptyScene: (count: number) => `[decision-gate] empty scene, call skipped (entries ${count})`,
    cacheHit: (count: number) => `[decision-gate] cache hit (entries ${count})`,
    internalError: (name: string) => `[decision-gate] internal error, passed through: ${name}`,
    decision: decision('failed'),
  },
  ko: {
    ready: '[decision-gate] 준비됨',
    emptyScene: (count: number) => `[decision-gate] 빈 장면, 호출 생략 (항목 ${count}개)`,
    cacheHit: (count: number) => `[decision-gate] 캐시 적중 (항목 ${count}개)`,
    internalError: (name: string) => `[decision-gate] 내부 오류, 통과: ${name}`,
    decision: decision('실패'),
  },
};
