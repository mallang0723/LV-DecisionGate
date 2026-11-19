// @bun
// src/state.ts
var MAX_PER_MESSAGE = 1500;
var MAX_TOTAL = 8000;
var WI_EXCLUDE_BLOCK = /<([A-Za-z][\w:-]*)\b[^>]*\swi-exclude(?=[\s=>/])[^>]*>[\s\S]*?<\/\1\s*>/gi;
var DETAILS_BLOCK = /<details\b[^>]*>[\s\S]*?<\/details\s*>/gi;
function stripExcluded(text) {
  return text.replace(WI_EXCLUDE_BLOCK, "").replace(DETAILS_BLOCK, "").replace(/\n{3,}/g, `

`).trim();
}
function buildState(messages, n) {
  const picked = messages.filter((m) => !m.is_greeting).slice(-Math.max(1, n));
  const lines = [];
  let total = 0;
  for (let i = picked.length - 1;i >= 0; i--) {
    const m = picked[i];
    let body = stripExcluded(String(m.content ?? ""));
    if (!body)
      continue;
    if (body.length > MAX_PER_MESSAGE)
      body = body.slice(body.length - MAX_PER_MESSAGE);
    let line = `${m.role}: ${body}`;
    const remain = MAX_TOTAL - total;
    if (remain <= 0)
      break;
    if (line.length > remain) {
      if (remain < 200)
        break;
      line = line.slice(line.length - remain);
    }
    lines.unshift(line);
    total += line.length + 1;
  }
  return lines.join(`
`);
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  enabled: true,
  connection_id: null,
  history_messages: 6,
  timeout_ms: 6000,
  fail_open_require: false,
  log_decisions: true
};
var TIMEOUT_MIN = 500;
var TIMEOUT_MAX = 9500;
function int(v, def, min, max) {
  if (typeof v !== "number" || !Number.isFinite(v))
    return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}
function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    connection_id: typeof r.connection_id === "string" && r.connection_id.trim() ? r.connection_id.trim() : null,
    history_messages: int(r.history_messages, d.history_messages, 1, 50),
    timeout_ms: int(r.timeout_ms, d.timeout_ms, TIMEOUT_MIN, TIMEOUT_MAX),
    fail_open_require: typeof r.fail_open_require === "boolean" ? r.fail_open_require : d.fail_open_require,
    log_decisions: typeof r.log_decisions === "boolean" ? r.log_decisions : d.log_decisions
  };
}

// src/gate.ts
var NAMESPACES = ["decision_gate", "decision_gate_lv"];
function parseEntryConfig(e) {
  if (e.disabled)
    return null;
  const ext = e.extensions ?? {};
  let raw;
  for (const ns of NAMESPACES)
    if (ext[ns] && typeof ext[ns] === "object") {
      raw = ext[ns];
      break;
    }
  if (!raw)
    return null;
  const r = raw;
  if (r.mode !== "trigger" && r.mode !== "require")
    return null;
  if (typeof r.statement !== "string" || !r.statement.trim())
    return null;
  const th = typeof r.threshold === "number" && Number.isFinite(r.threshold) ? Math.min(1, Math.max(0, r.threshold)) : 0.5;
  return { id: e.id, name: String(e.comment ?? e.id), mode: r.mode, statement: r.statement.trim(), threshold: th };
}
function hashText(s) {
  return Bun.hash(s).toString(36);
}
function cacheKey(chatId, state, configs, s) {
  const cfg = configs.map((c) => [c.id, c.mode, c.statement, c.threshold]);
  const sh = [s.connection_id, s.history_messages, s.fail_open_require];
  return [chatId, hashText(state), hashText(JSON.stringify([cfg, sh]))].join("|");
}
function scoreOf(answer) {
  if (!answer || typeof answer !== "object")
    return null;
  const n = answer.noul;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function buildQuestions(configs) {
  const q = {};
  for (const c of configs)
    q[c.id] = { type: "noul", instructions: c.statement };
  return q;
}
function decide(configs, answers, failOpenRequire) {
  const forced = [];
  const disabled = [];
  const scores = {};
  for (const c of configs) {
    const score = answers ? scoreOf(answers[c.id]) : null;
    scores[c.id] = score;
    if (score === null) {
      if (c.mode === "require" && !failOpenRequire)
        disabled.push(c.id);
      continue;
    }
    const yes = score >= c.threshold;
    if (c.mode === "trigger" && yes)
      forced.push(c.id);
    if (c.mode === "require" && !yes)
      disabled.push(c.id);
  }
  const result = {};
  if (forced.length)
    result.forced = forced;
  if (disabled.length)
    result.disabled = disabled;
  return { result, scores };
}

class TimeoutError extends Error {
}
function createGate(deps) {
  const cache = new Map;
  const CACHE_MAX = 50;
  const now = deps.now ?? Date.now;
  let evaluateCalls = 0;
  async function handler(ctx) {
    if (ctx.purpose === "query")
      return;
    const configs = ctx.entries.map(parseEntryConfig).filter((c) => c !== null);
    if (configs.length === 0)
      return;
    const settings = normalizeSettings(await deps.getSettings());
    if (!settings.enabled)
      return;
    const state = buildState(ctx.messages, settings.history_messages);
    if (!state) {
      const { result } = decide(configs, null, settings.fail_open_require);
      if (settings.log_decisions)
        deps.log?.(`[decision-gate] \uBE48 \uC7A5\uBA74, \uD638\uCD9C \uC0DD\uB7B5 (\uD56D\uBAA9 ${configs.length}\uAC1C)`);
      return result;
    }
    const key = cacheKey(ctx.chatId, state, configs, settings);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      if (settings.log_decisions)
        deps.log?.(`[decision-gate] \uCE90\uC2DC \uC801\uC911 (\uD56D\uBAA9 ${configs.length}\uAC1C)`);
      return hit;
    }
    const started = now();
    let answers = null;
    let failure = "";
    let usageNote = "";
    const ac = new AbortController;
    let timer;
    const onCtxAbort = () => ac.abort();
    try {
      if (ctx.signal) {
        if (ctx.signal.aborted)
          ac.abort();
        else
          ctx.signal.addEventListener("abort", onCtxAbort, { once: true });
      }
      const aborted = new Promise((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new TimeoutError("timeout"));
        }, settings.timeout_ms);
        ac.signal.addEventListener("abort", () => reject(new TimeoutError("aborted")), { once: true });
      });
      aborted.catch(() => {});
      evaluateCalls++;
      const res = await Promise.race([
        deps.evaluate({
          ...settings.connection_id ? { connection_id: settings.connection_id } : {},
          state,
          questions: buildQuestions(configs),
          ...ctx.userId ? { userId: ctx.userId } : {}
        }, { signal: ac.signal }),
        aborted
      ]);
      answers = res && typeof res === "object" && res.answers && typeof res.answers === "object" ? res.answers : null;
      if (!answers)
        failure = "bad-response";
      const u = res && typeof res === "object" ? res.usage : undefined;
      if (u && typeof u === "object") {
        const f = (v) => typeof v === "number" && Number.isFinite(v) ? String(v) : null;
        const bits = [["in", f(u.input_tokens)], ["out", f(u.output_tokens)], ["cost", f(u.cost)]].filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`);
        if (bits.length)
          usageNote = ` ${bits.join(" ")}`;
      }
    } catch (err) {
      failure = err instanceof TimeoutError ? "timeout" : "error";
    } finally {
      if (timer)
        clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onCtxAbort);
    }
    const elapsed = now() - started;
    const { result, scores } = decide(configs, answers, settings.fail_open_require);
    if (settings.log_decisions) {
      const parts = configs.map((c) => `"${c.name}"=${scores[c.id] === null ? "n/a" : scores[c.id].toFixed(2)}`);
      deps.log?.(`[decision-gate] ${failure ? `\uC2E4\uD328(${failure}) ` : ""}${parts.join(" ")} ${elapsed}ms${usageNote}`);
    }
    if (!failure) {
      cache.set(key, result);
      if (cache.size > CACHE_MAX)
        cache.delete(cache.keys().next().value);
    }
    return result;
  }
  return { handler, cacheSize: () => cache.size, evaluateCalls: () => evaluateCalls };
}

// src/backend.ts
var SETTINGS_PATH = "settings.json";
var gate = createGate({
  evaluate: (input, options) => spindle.decisions.evaluate(input, options),
  getSettings: async () => {
    try {
      return await spindle.storage.getJson(SETTINGS_PATH, { fallback: {} });
    } catch {
      return {};
    }
  },
  log: (m) => spindle.log.info(m)
});
spindle.registerWorldInfoInterceptor(async (ctx) => {
  try {
    return await gate.handler(ctx);
  } catch (e) {
    spindle.log.warn(`[decision-gate] \uB0B4\uBD80 \uC624\uB958, \uD1B5\uACFC: ${e instanceof Error ? e.name : "error"}`);
  }
}, 100);
spindle.log.info("[decision-gate] \uC900\uBE44\uB428");
