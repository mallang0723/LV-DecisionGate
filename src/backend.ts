// 판단 게이트 — 로어북 항목 판단 활성화 (backend only).
declare const spindle: import('lumiverse-spindle-types').SpindleAPI;

import { createGate, type EvaluateFn, type GateCtx } from './gate';

const SETTINGS_PATH = 'settings.json';

const gate = createGate({
  evaluate: ((input, options) => spindle.decisions.evaluate(input as never, options) as never) as EvaluateFn,
  getSettings: async () => {
    try { return await spindle.storage.getJson<unknown>(SETTINGS_PATH, { fallback: {} }); } catch { return {}; }
  },
  log: (m) => spindle.log.info(m),
});

spindle.registerWorldInfoInterceptor(async (ctx) => {
  try {
    return await gate.handler(ctx as unknown as GateCtx);
  } catch (e) {
    spindle.log.warn(`[decision-gate] 내부 오류, 통과: ${e instanceof Error ? e.name : 'error'}`);
  }
}, 100);

spindle.log.info('[decision-gate] 준비됨');
