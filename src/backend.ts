// 판단 게이트 — 로어북 항목 판단 활성화 (backend only).
declare const spindle: import('lumiverse-spindle-types').SpindleAPI;

import { createGate, type EvaluateFn, type GateCtx } from './gate';
import { LOG_MESSAGES } from './i18n';
import { normalizeSettings } from './settings';

const SETTINGS_PATH = 'settings.json';

async function getSettings() {
  try {
    return normalizeSettings(await spindle.storage.getJson<unknown>(SETTINGS_PATH, { fallback: {} }));
  } catch {
    return normalizeSettings({});
  }
}

const gate = createGate({
  evaluate: ((input, options) => spindle.decisions.evaluate(input as never, options) as never) as EvaluateFn,
  getSettings,
  log: (m) => spindle.log.info(m),
});

spindle.registerWorldInfoInterceptor(async (ctx) => {
  try {
    return await gate.handler(ctx as unknown as GateCtx);
  } catch (e) {
    const settings = await getSettings();
    spindle.log.warn(LOG_MESSAGES[settings.language].internalError(e instanceof Error ? e.name : 'error'));
  }
}, 100);

spindle.log.info(LOG_MESSAGES[(await getSettings()).language].ready);
