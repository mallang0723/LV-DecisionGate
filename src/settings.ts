// 확장 설정 (design §5). 저장소 값은 신뢰하지 않고 타입·범위를 검증한다.
export interface GateSettings {
  enabled: boolean;
  connection_id: string | null;
  history_messages: number;
  timeout_ms: number;
  fail_open_require: boolean;
  log_decisions: boolean;
}

export const DEFAULT_SETTINGS: GateSettings = {
  enabled: true,
  connection_id: null,
  history_messages: 6,
  timeout_ms: 6000,
  fail_open_require: false,
  log_decisions: true,
};

/** 호스트 인터셉터 제한(10초)보다 반드시 짧게. */
export const TIMEOUT_MIN = 500;
export const TIMEOUT_MAX = 9500;

function int(v: unknown, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function normalizeSettings(raw: unknown): GateSettings {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    connection_id: typeof r.connection_id === 'string' && r.connection_id.trim() ? r.connection_id.trim() : null,
    history_messages: int(r.history_messages, d.history_messages, 1, 50),
    timeout_ms: int(r.timeout_ms, d.timeout_ms, TIMEOUT_MIN, TIMEOUT_MAX),
    fail_open_require: typeof r.fail_open_require === 'boolean' ? r.fail_open_require : d.fail_open_require,
    log_decisions: typeof r.log_decisions === 'boolean' ? r.log_decisions : d.log_decisions,
  };
}
