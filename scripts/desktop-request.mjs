import { AUTO_RESUME_MESSAGE, normalizeAutoResumeMessage } from "./auto-resume.mjs";
import { normalizeDailyKeepAliveModel } from "./ui-settings.mjs";
import { classifyKeepAliveWindow, keepAliveQuotaReason } from "./keepalive-quota.mjs";

export { AUTO_RESUME_MESSAGE };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/i;
export const KEEP_ALIVE_MODEL = "gpt-6-luna";
export const KEEP_ALIVE_EFFORT = "low";
export const KEEP_ALIVE_MESSAGE = "只回复 OK。";

const DESKTOP_REQUEST_CLIENT_LOOKUP = `
  // Inspect real data properties/methods. RPC proxies synthesize a callable
  // value for any property name, so probing them with typeof/calling an
  // apparent getter can accidentally dispatch an unrelated RPC.
  function desktopOwnValue(value, key) {
    return value == null ? undefined : Object.getOwnPropertyDescriptor(value, key)?.value;
  }
  function desktopMethod(value, key) {
    for (let current = value, depth = 0; current && depth < 8; current = Object.getPrototypeOf(current), depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return typeof descriptor.value === 'function' ? descriptor.value : null;
    }
    return null;
  }
  function findDesktopObject(matches) {
    const root = window.__codexRoot?._internalRoot?.current;
    if (!root) throw new Error("codex-desktop-react-root-not-found");
    // Search React's actual hook/context values first. A breadth-first walk of
    // the whole graph can exhaust its budget in DOM nodes and Fiber backlinks
    // before reaching the manager retained by a hook in a large conversation.
    const fibers = [root];
    const fiberSeen = new WeakSet();
    const queue = [];
    const enqueue = (value) => {
      if (value != null && (typeof value === "object" || typeof value === "function")
        && queue.length < 500000) queue.push(value);
    };
    let fiberCursor = 0;
    while (fiberCursor < fibers.length && fiberCursor < 50000) {
      const fiber = fibers[fiberCursor++];
      if (!fiber || typeof fiber !== "object" || fiberSeen.has(fiber)) continue;
      fiberSeen.add(fiber);
      for (const key of ["memoizedState", "memoizedProps", "updateQueue"]) enqueue(fiber[key]);
      let context = fiber.dependencies?.firstContext;
      const contextSeen = new WeakSet();
      while (context && typeof context === "object" && !contextSeen.has(context)) {
        contextSeen.add(context);
        enqueue(context.memoizedValue);
        context = context.next;
      }
      if (fiber.child) fibers.push(fiber.child);
      if (fiber.sibling) fibers.push(fiber.sibling);
    }
    // Keep the general root fallback for older desktop versions and fixtures.
    enqueue(root);
    for (const fiber of fibers) enqueue(fiber);
    const seen = new WeakSet();
    let cursor = 0;
    let visited = 0;
    while (cursor < queue.length && visited < 200000) {
      const value = queue[cursor++];
      if (value == null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      try { if (matches(value)) return value; } catch {}
      // DOM/Window graphs and function prototypes are unrelated to the request
      // client and can retain an entire application through a single backlink.
      try { if (value === window || (typeof Node === "function" && value instanceof Node)) continue; } catch { continue; }
      if (typeof value === "function") continue;
      let descriptors;
      try { descriptors = Object.getOwnPropertyDescriptors(value); }
      catch { continue; }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (["return", "child", "sibling", "alternate", "stateNode", "ownerDocument", "parentNode", "parentElement", "window", "self", "document", "prototype", "_owner"].includes(key)) continue;
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) continue;
        const child = descriptor.value;
        enqueue(child);
      }
      if (value instanceof Map) {
        for (const [key, child] of value) { enqueue(key); enqueue(child); }
      } else if (value instanceof Set) {
        for (const child of value) enqueue(child);
      }
    }
    return null;
  }
  function findDesktopRequestClient() {
    const isLocalClient = value => desktopOwnValue(value, 'hostId') === 'local'
      && desktopOwnValue(value, 'requestPromises') instanceof Map && desktopMethod(value, 'sendRequest');
    function boundLocalRpcClient(scope) {
      const node = desktopOwnValue(scope, 'node');
      const families = desktopOwnValue(node, 'familyBindings');
      const store = desktopOwnValue(node, 'store');
      if (!(desktopOwnValue(scope, 'chain') instanceof Map) || !(families instanceof Map)
        || !desktopMethod(scope, 'get') || !desktopMethod(scope, 'watch') || !desktopMethod(store, 'get')) return null;
      let visited = 0;
      for (const bindings of families.values()) {
        if (++visited > 4096) break;
        if (!(bindings instanceof Map) || !bindings.has('local')) continue;
        const signal = desktopOwnValue(bindings.get('local'), 'value');
        const atom = desktopOwnValue(signal, 'atom');
        const get = desktopMethod(signal, 'get');
        // Read only already-bound local signals. Do not resolve families,
        // import application modules, initialize managers or create RPC stubs.
        if (!atom || !Object.prototype.hasOwnProperty.call(atom, 'init') || !get
          || !desktopMethod(signal, 'subscribe') || desktopOwnValue(signal, 'store') !== store) continue;
        try {
          const snapshot = get.call(signal);
          if (desktopOwnValue(snapshot, 'status') !== 'ready') continue;
          const client = desktopOwnValue(snapshot, 'client');
          if (desktopOwnValue(client, 'hostId') !== 'local') continue;
          const rpc = desktopOwnValue(client, 'rpc');
          const toString = desktopMethod(rpc, 'toString');
          if (typeof rpc !== 'function' || !desktopMethod(rpc, 'dup') || !desktopMethod(rpc, 'onRpcBroken')
            || !desktopMethod(rpc, 'map') || !toString || toString.call(rpc) !== '[object RpcStub]') continue;
          return { hostId: 'local', sendRequest: (method, params, options) => rpc.sendRequest(method, params, options),
            async readQueuedMessages(threadId) {
              if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw Error('Invalid queue thread');
              let registration, subscription, timer, finished = false;
              const dispose = value => { try { value?.[Symbol.dispose]?.(); } catch {} };
              try {
                return await new Promise((resolve, reject) => {
                  timer = setTimeout(() => reject(Error('codex-desktop-queue-read-timeout')), 5000);
                  registration = rpc.subscribe({type:'thread',key:{hostId:'local',threadId},field:'queuedMessages',listener(value) {
                    if (finished || value === undefined) return;
                    if (Array.isArray(value) && value.length <= 10000 && value.every(item => item && typeof item.id === 'string' && item.id.length > 0)) resolve(value);
                    else reject(Error('codex-desktop-queue-invalid-response'));
                  }});
                  registration.onRpcBroken(error => reject(error));
                  Promise.resolve(registration).then(value => {
                    subscription = value;
                    if (finished) dispose(value);
                  }, reject);
                });
              } finally {
                finished = true;
                clearTimeout(timer);
                dispose(registration);
                dispose(subscription);
              }
            },
          };
        } catch {}
      }
      return null;
    }
    let registeredClient = null;
    const request = findDesktopObject(value => {
      if (isLocalClient(value)) return true;
      // Current desktop scopes keep the manager in an atom store/WeakMap. Its
      // existing host registry can read it; enumerating own properties cannot.
      const scope = desktopOwnValue(value, "scope");
      const getForHostId = desktopMethod(value, 'getForHostId');
      if (scope && desktopMethod(scope, 'get') && getForHostId && desktopMethod(value, 'getImplForHostId')) {
        const manager = getForHostId.call(value, "local");
        if (manager?.hostId === "local" && manager.disposed !== true && isLocalClient(manager.requestClient)) {
          registeredClient = manager.requestClient;
          return true;
        }
      }
      // Newer desktops retain {hostId, rpc} in an existing scope signal rather
      // than exposing the legacy requestClient/host registry in React state.
      registeredClient = boundLocalRpcClient(value);
      if (registeredClient) return true;
      return false;
    });
    if (!request) throw new Error("codex-desktop-request-client-not-found");
    return registeredClient || request;
  }
`.trim();

const DESKTOP_QUEUED_FOLLOW_UP_LOOKUP = `
  function findDesktopQueuedFollowUpsQuery() {
    let query = null;
    try {
      findDesktopObject(value => {
        const getQueryCache = desktopMethod(value, 'getQueryCache');
        if (getQueryCache) {
          const cache = getQueryCache.call(value);
          const getAll = desktopMethod(cache, 'getAll');
          const queries = getAll ? getAll.call(cache) : null;
          query = Array.isArray(queries) ? queries.find((candidate) => {
            const key = candidate?.queryKey;
            return Array.isArray(key) && ((key.length === 1 && key[0] === "queued-follow-ups")
              || (key.includes("get-global-state") && JSON.stringify(key).includes("queued-follow-ups")));
          }) : null;
          return Boolean(query);
        }
        return false;
      });
    } catch {}
    return query;
  }
  async function desktopQueuedFollowUps(threadId, request) {
    // RPC-backed desktops have no global queue query. Read that authoritative
    // per-thread source directly instead of walking a large unrelated cache.
    if (typeof request?.readQueuedMessages === 'function') return threadId ? {[threadId]:await request.readQueuedMessages(threadId)} : undefined;
    const query = findDesktopQueuedFollowUpsQuery();
    const data = query?.state?.data;
    const value = Array.isArray(query?.queryKey) && query.queryKey.length === 1 && query.queryKey[0] === "queued-follow-ups"
      ? data?.state : data?.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return undefined;
  }

  async function queuedFollowUpIds(threadId, request) {
    const queuedByThread = await desktopQueuedFollowUps(threadId, request);
    const queuedForThread = queuedByThread?.[threadId];
    return Array.isArray(queuedForThread)
      ? queuedForThread.map((item) => String(item?.id || "")).filter(Boolean)
      : [];
  }
`.trim();

export function buildDesktopRequestProbeExpression() {
  return `(async () => {
    ${DESKTOP_REQUEST_CLIENT_LOOKUP}
    const request = findDesktopRequestClient();
    return { ok: true, method: "codex-desktop-internal-request", hostId: request.hostId };
  })()`;
}

export function buildDesktopCompatibilityProbeExpression({ threadId = null, model = KEEP_ALIVE_MODEL } = {}) {
  const payload = { threadId: UUID_PATTERN.test(String(threadId || "")) ? threadId : null, model: normalizeDailyKeepAliveModel(model) };
  return `(async () => {
    ${DESKTOP_REQUEST_CLIENT_LOOKUP}
    ${DESKTOP_QUEUED_FOLLOW_UP_LOOKUP}
    const payload = ${JSON.stringify(payload)};
    const result = { interface: window.__CODEX_USAGE_MONITOR_STATE__?.diagnose?.()?.ok === true && typeof window.__codexUsageMonitorSaveSettings === "function",
      client: false, quota: false, model: false, queue: false, thread: null, failures: {} };
    const errorKind = error => /timeout|timed out|aborterror/i.test(String(error?.name || '') + ' ' + String(error?.message || '')) ? 'timeout' : 'unavailable';
    let request;
    try { request = findDesktopRequestClient(); result.client = true; } catch (error) { result.failures.client = errorKind(error); return result; }
    const options = { priority: "background", source: "usage_monitor_compatibility", timeoutMs: 10000 };
    const deadline = Date.now() + 18000;
    // Independent read requests run together so a slow quota request does not
    // consume the time budget for a healthy thread-read channel.
    await Promise.all([
      (async () => {
        try {
          const queued = await desktopQueuedFollowUps(payload.threadId, request);
          result.queue = Boolean(queued && typeof queued === 'object' && !Array.isArray(queued));
          if (!result.queue && !payload.threadId && request.readQueuedMessages) result.queue = null;
          else if (!result.queue) result.failures.queue = 'invalid-response';
        } catch (error) { result.failures.queue = errorKind(error); }
      })(),
      (async () => {
        try {
          const data = await request.sendRequest("account/rateLimits/read", {}, options);
          const bucket = data?.rateLimitsByLimitId?.codex || data?.rateLimits;
          result.quota = Boolean(bucket && [bucket.primary, bucket.secondary].some(window =>
            typeof window?.usedPercent === "number" && Number.isFinite(window.usedPercent)
            && window.usedPercent >= 0 && window.usedPercent <= 100 && Number.isFinite(window.windowDurationMins)));
          if (!result.quota) result.failures.quota = 'invalid-response';
        } catch (error) { result.failures.quota = errorKind(error); }
      })(),
      (async () => {
        try {
          let cursor;
          const seen = new Set();
          for (let page = 0; page < 20 && Date.now() < deadline; page++) {
            const data = await request.sendRequest("model/list", { includeHidden: false, limit: 100, ...(cursor ? {cursor} : {}) }, options);
            if (!Array.isArray(data?.data)) { result.failures.model = 'invalid-response'; break; }
            if (data.data.some(item => item?.model === payload.model && item.hidden !== true
              && item.supportedReasoningEfforts?.some(effort => effort?.reasoningEffort === "low"))) { result.model = true; break; }
            cursor = data.nextCursor;
            if (!cursor || typeof cursor !== "string" || seen.has(cursor)) break;
            seen.add(cursor);
          }
          if (!result.model && Date.now() >= deadline) result.failures.model = 'timeout';
        } catch (error) { result.failures.model = errorKind(error); }
      })(),
      (async () => {
        if (!payload.threadId) return;
      try {
        const data = await request.sendRequest("thread/read", {threadId: payload.threadId, includeTurns: false}, options);
        result.thread = data?.thread?.id === payload.threadId;
          if (!result.thread) result.failures.thread = 'invalid-response';
        } catch (error) { result.thread = false; result.failures.thread = errorKind(error); }
      })(),
    ]);
    return result;
  })()`;
}

export function desktopBuildMetadataExpression() {
  return `(async () => { const asset = Array.from(document.scripts).map(item => item.src)
    .find(src => src.startsWith('app://') && src.includes('/assets/index-') && src.endsWith('.js'));
    let sessionId = null;
    try { const value = await window.electronBridge?.getAppSessionId?.(); if (typeof value === 'string' && value.length <= 200) sessionId = value; } catch {}
    return {asset: asset ? asset.slice(asset.lastIndexOf('/') + 1) : null, sessionId}; })()`;
}

export function buildMonitorInterfaceProbeExpression(expectedPid) {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) throw new TypeError("Invalid monitor PID.");
  return `(() => {
    const state = window.__CODEX_USAGE_MONITOR_STATE__;
    const host = document.getElementById('codex-usage-monitor');
    if (!state && !host) return null;
    const heartbeat = window.__CODEX_USAGE_MONITOR_BACKEND__;
    const age = typeof heartbeat?.at === 'number' ? Date.now() - heartbeat.at : null;
    return Boolean(state?.host === host && host?.isConnected && host.shadowRoot
      && state.diagnose?.()?.ok === true && typeof window.__codexUsageMonitorSaveSettings === 'function'
      && heartbeat?.pid === ${expectedPid} && heartbeat.phase === 'connected'
      && age !== null && age >= 0 && age <= 15000);
  })()`;
}

export async function collectDesktopCompatibilityProbes({ monitorSessions, requestSessions = [], expectedPid, threadId, model }) {
  const displays = monitorSessions.filter(session => !session.closed);
  // UI health belongs to display pages. The request client may be in a control
  // page that intentionally has no Composer or monitor host of its own.
  const interfaceChecks = Promise.allSettled(displays.map(session =>
    session.evaluate(buildMonitorInterfaceProbeExpression(expectedPid), 5000)));
  let probe = null;
  const score = value => value?.client === true ? 16 + (value.thread === true ? 8 : 0) + (value.quota ? 4 : 0) + (value.queue ? 2 : 0) + (value.model ? 1 : 0) : 0;
  for (const session of [...displays, ...requestSessions]) {
    if (session.closed) continue;
    try {
      const result = await session.evaluate(buildDesktopCompatibilityProbeExpression({ threadId, model }), 30000);
      if (!probe || score(result) > score(probe)) probe = result;
      // Finding a client is not enough: another known local page may finish
      // reads that timed out on the first page. Retry only these bounded pages.
      if (result?.client && result.quota && result.model && result.queue && (!threadId || result.thread === true)) break;
    } catch {}
  }
  const results = await interfaceChecks;
  const relevant = results.filter(result => result.status === 'rejected' || result.value !== null);
  const interfaceHealthy = relevant.length ? relevant.every(result => result.status === 'fulfilled' && result.value === true) : null;
  return { ...probe, interface: interfaceHealthy };
}

export function buildDesktopAutoResumeExpression({ threadId, eventId, message }) {
  const payload = {
    threadId,
    input: [{ type: "text", text: message }],
    approvalPolicy: "never",
    clientUserMessageId: `codex-usage-monitor-${eventId}`,
  };
  return `(async () => {
    ${DESKTOP_REQUEST_CLIENT_LOOKUP}
    ${DESKTOP_QUEUED_FOLLOW_UP_LOOKUP}
    const request = findDesktopRequestClient();
    const payload = ${JSON.stringify(payload)};
    const attempts = window.__CODEX_USAGE_MONITOR_SEND_ATTEMPTS__ ||= new Map();
    const attemptKey = payload.threadId + ':' + payload.clientUserMessageId;
    if (attempts.has(attemptKey)) return await attempts.get(attemptKey);
    const attempt = (async () => {
    const options = { priority: "critical", source: "usage_monitor_auto_resume" };
    const queuedMessageIds = await queuedFollowUpIds(payload.threadId, request);
    await request.sendRequest("thread/resume", { threadId: payload.threadId }, options);
    const result = await request.sendRequest("turn/start", payload, options);
    const turnId = String(result?.turn?.id || "");
    if (!turnId) throw new Error("codex-desktop-turn-id-missing");
    // A failed post-send queue observation must not turn an accepted model
    // turn into a retryable send failure.
    let queuePreserved = false;
    try {
      const queuedAfterStart = new Set(await queuedFollowUpIds(payload.threadId, request));
      queuePreserved = queuedMessageIds.every((id) => queuedAfterStart.has(id));
    } catch {}
    return {
      ok: true,
      method: "codex-desktop-internal-request",
      threadId: payload.threadId,
      turnId,
      queuedCount: queuedMessageIds.length,
      queuePreserved,
    };
    })();
    attempts.set(attemptKey, attempt);
    try { return await attempt; }
    catch (error) { attempts.delete(attemptKey); throw error; }
  })()`;
}

export async function probeDesktopRequestClient(session) {
  try {
    const result = await session.evaluate(buildDesktopRequestProbeExpression());
    return result?.ok ? result : { ok: false, reason: "desktop-request-client-unavailable" };
  } catch (error) {
    return { ok: false, reason: String(error?.message || "desktop-request-client-unavailable").slice(0, 160) };
  }
}

export async function sendContinueThroughDesktop(session, {
  threadId,
  eventId,
  message = AUTO_RESUME_MESSAGE,
} = {}) {
  const normalizedThreadId = String(threadId || "").toLowerCase();
  const normalizedEventId = String(eventId || "").toLowerCase();
  const normalizedMessage = normalizeAutoResumeMessage(message);
  if (!UUID_PATTERN.test(normalizedThreadId)) return { ok: false, reason: "invalid-auto-resume-thread-id" };
  if (!EVENT_ID_PATTERN.test(normalizedEventId)) return { ok: false, reason: "invalid-auto-resume-event-id" };
  if (!normalizedMessage) return { ok: false, reason: "invalid-auto-resume-message" };
  try {
    const result = await session.evaluate(buildDesktopAutoResumeExpression({
      threadId: normalizedThreadId,
      eventId: normalizedEventId,
      message: normalizedMessage,
    }), 60000);
    return result?.ok ? result : { ok: false, reason: "desktop-turn-start-failed" };
  } catch (error) {
    const message = String(error?.message || "");
    return { ok: false, reason: /timed out|timeout/i.test(message) ? "desktop-send-timeout"
      : /request-client|codex-root/i.test(message) ? "desktop-request-client-unavailable" : "desktop-send-failed" };
  }
}

// These helpers use the same local desktop request channel as auto-resume, but
// never resume, steer, or populate the user's working conversation. Identity is
// supplied by the public rate-limit response, never auth.json or config.toml.
const DESKTOP_KEEP_ALIVE_HELPERS = `
  ${DESKTOP_REQUEST_CLIENT_LOOKUP}
  ${DESKTOP_QUEUED_FOLLOW_UP_LOOKUP}
  ${classifyKeepAliveWindow.toString()}
  ${keepAliveQuotaReason.toString()}
  const options = { priority: "critical", source: "usage_monitor_daily_keep_alive" };
  function failure(reason) { return { ok: false, uncertain: false, reason }; }
  function stableAccountId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 200
      && value === value.trim() && !/[\\x00-\\x20\\x7f]/.test(value) ? value : "";
  }
  function mainQuota(usage, accountId) {
    const capturedAt = Date.now();
    const buckets = usage?.rateLimitsByLimitId;
    const main = buckets && typeof buckets === "object" && Object.prototype.hasOwnProperty.call(buckets, "codex")
      ? buckets.codex : usage?.rateLimits;
    const safeMain = main && typeof main === "object" && (!main.limitId || main.limitId === "codex") ? main : null;
    function windowFor(duration) {
      const value = [safeMain?.primary, safeMain?.secondary].find((item) => item?.windowDurationMins === duration);
      return value && typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent)
        && value.usedPercent >= 0 && value.usedPercent <= 100
        && typeof value.resetsAt === "number" && Number.isSafeInteger(value.resetsAt)
        && value.resetsAt > 0 && Number.isSafeInteger(value.resetsAt * 1000)
        ? { usedPercent: value.usedPercent, resetsAt: value.resetsAt * 1000 } : null;
    }
    const fiveHour = windowFor(300);
    const quota = { capturedAt, accountId,
      ordinaryUsageAllowed: typeof usage?.ordinaryUsageAllowed === "boolean" ? usage.ordinaryUsageAllowed : null,
      fiveHour, weekly: windowFor(10080) };
    const windowState = classifyKeepAliveWindow(quota, capturedAt);
    return { ...quota, activeFiveHour: windowState === "active" ? true
      : windowState === "idle" || windowState === "expired" ? false : null };
  }
  function maySend(identity, quotaBaseline) {
    return keepAliveQuotaReason(identity.quota, Date.now(), quotaBaseline) === null;
  }
  async function readIdentity(request) {
    const account = await request.sendRequest("account/read", { refreshToken: false }, options);
    if (account?.account?.type !== "chatgpt") return failure("keep-alive-official-subscription-required");
    const usage = await request.sendRequest("account/rateLimits/read", {}, options);
    const accountId = stableAccountId(usage?.accountId);
    if (!accountId) return failure("keep-alive-account-id-unavailable");
    return { ok: true, accountId, ordinaryUsageAllowed: usage.ordinaryUsageAllowed === true,
      quota: mainQuota(usage, accountId) };
  }
  async function keepAliveModels(request) {
    const cursors = new Set();
    const models = new Map();
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await request.sendRequest("model/list", {
        includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}),
      }, options);
      if (!Array.isArray(result?.data)) return [];
      for (const model of result.data) {
        if (typeof model?.model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model.model)
          && model.model === model.model.trim() && model.hidden !== true && Array.isArray(model.supportedReasoningEfforts)
          && model.supportedReasoningEfforts.some((option) => option?.reasoningEffort === "low")) {
          models.set(model.model, { id: model.model, label: String(model.displayName || model.model).slice(0, 100) });
        }
      }
      cursor = result.nextCursor;
      if (!cursor) return [...models.values()].slice(0, 100);
      if (typeof cursor !== "string" || cursors.has(cursor)) return [];
      cursors.add(cursor);
    }
    return [];
  }
`;

const DESKTOP_KEEP_ALIVE_THREAD_HELPERS = `
  const createdThreads = window.__CODEX_USAGE_MONITOR_KEEP_ALIVE_CREATED_THREADS__ ||= new Map();
  const normalizedCwd = (value) => String(value || "").replace(/\\\\/g, "/").replace(/\\/+$/, "").toLowerCase();
  async function queuedStateIsEmpty(threadId, request) {
    const value = await desktopQueuedFollowUps(threadId, request);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (!Object.prototype.hasOwnProperty.call(value, threadId)) return true;
    return Array.isArray(value[threadId]) && value[threadId].length === 0;
  }
  async function validateKeepAliveThread(thread, threadId, workspacePath, request) {
    if (thread?.id !== threadId) return failure("keep-alive-thread-id-mismatch");
    if (normalizedCwd(thread.cwd) !== normalizedCwd(workspacePath)) return failure("keep-alive-workspace-mismatch");
    if (thread.modelProvider !== "openai") return failure("keep-alive-thread-settings-mismatch");
    if (thread.archived === true || /(?:^|[\\\\/])archived_sessions(?:[\\\\/]|$)/i.test(String(thread.path || "")))
      return failure("keep-alive-thread-unavailable");
    if (!["idle", "notLoaded"].includes(thread.status?.type)) return failure("keep-alive-thread-busy");
    if (!Array.isArray(thread.turns)) return failure("keep-alive-history-unverified");
    for (const turn of thread.turns) {
      if (turn?.status === "inProgress") return failure("keep-alive-thread-busy");
      if (!["completed", "failed", "interrupted"].includes(turn?.status)
        || (turn.itemsView != null && turn.itemsView !== "full") || !Array.isArray(turn.items))
        return failure("keep-alive-history-unverified");
      let userMessages = 0;
      for (const item of turn.items) {
        if (item?.type === "userMessage") {
          userMessages += 1;
          if (!Array.isArray(item.content) || item.content.length !== 1
            || item.content[0]?.type !== "text" || item.content[0].text !== "只回复 OK。")
            return failure("keep-alive-thread-content-changed");
        } else if (item?.type === "agentMessage") {
          if (typeof item.text !== "string" || !/^OK[.!。！]?$/i.test(item.text.trim()))
            return failure("keep-alive-thread-content-changed");
        } else if (item?.type !== "reasoning") return failure("keep-alive-history-unverified");
      }
      if (userMessages !== 1) return failure("keep-alive-history-unverified");
    }
    if (!await queuedStateIsEmpty(threadId, request)) return failure("keep-alive-thread-queue-unverified");
    return { ok: true };
  }
  async function confirmUnarchivedThread(request, threadId, workspacePath) {
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 20; page += 1) {
      const result = await request.sendRequest("thread/list", {
        archived: false, cwd: workspacePath, modelProviders: ["openai"], limit: 100,
        ...(cursor ? { cursor } : {}),
      }, options);
      if (!Array.isArray(result?.data)) return false;
      if (result.data.some((thread) => thread?.id === threadId)) return true;
      cursor = result.nextCursor;
      if (!cursor || typeof cursor !== "string" || seen.has(cursor)) return false;
      seen.add(cursor);
    }
    return false;
  }
  function validateKeepAliveSettings(result, threadId, workspacePath, model) {
    if (result?.thread?.id !== threadId) return failure("keep-alive-thread-id-mismatch");
    if (result.model !== model || result.modelProvider !== "openai"
      || result.approvalPolicy !== "never" || result.sandbox?.type !== "readOnly"
      || result.sandbox.networkAccess === true || (result.reasoningEffort != null && result.reasoningEffort !== "low"))
      return failure("keep-alive-thread-settings-mismatch");
    return normalizedCwd(result.cwd) === normalizedCwd(workspacePath)
      ? { ok: true } : failure("keep-alive-workspace-mismatch");
  }
  function keepAliveThreadSettings(workspacePath, model) {
    return { model, modelProvider: "openai", cwd: workspacePath,
      approvalPolicy: "never", sandbox: "read-only", config: { model_reasoning_effort: "low" },
      baseInstructions: "Reply only OK. Do not use tools, read files, or carry out any other task.",
      developerInstructions: "This is an isolated usage-window keep-alive. Reply only OK without using tools." };
  }
  async function readKeepAliveThread(request, payload) {
    try {
      return { ok: true, response: await request.sendRequest("thread/read", {
        threadId: payload.threadId, includeTurns: true,
      }, options) };
    } catch (error) {
      const created = createdThreads.get(payload.threadId);
      const expectedError = "thread " + payload.threadId
        + " is not materialized yet; includeTurns is unavailable before first user message";
      // Confirmed against the installed CLI with an isolated fixture provider:
      // a new legacy thread exists in memory before its first user message but
      // has no rollout to hydrate/resume. This exception is deliberately narrow.
      if (!created || created.accountId !== payload.expectedAccountId || created.issued
        || !String(error?.message || "").includes(expectedError)) throw error;
      const response = await request.sendRequest("thread/read", { threadId: payload.threadId, includeTurns: false }, options);
      const checked = await validateKeepAliveThread(response?.thread, payload.threadId, payload.workspacePath, request);
      if (!checked.ok) return checked;
      if (response.thread.status.type !== "idle" || response.thread.turns.length !== 0)
        return failure("keep-alive-history-unverified");
      const loaded = await request.sendRequest("thread/loaded/list", {}, options);
      if (!Array.isArray(loaded?.data) || !loaded.data.includes(payload.threadId))
        return failure("keep-alive-thread-unavailable");
      // The first turn can select a different model after the empty dedicated
      // thread was prepared. Its original settings were verified at creation;
      // turn/start below still explicitly pins the newly selected model/low.
      const settings = validateKeepAliveSettings(created.settings, payload.threadId, payload.workspacePath, created.settings.model);
      return settings.ok ? { ok: true, response, firstUnmaterialized: true } : settings;
    }
  }
  async function prepareThread(request, payload, onCreating) {
    if (!payload.threadId) {
      onCreating();
      const started = await request.sendRequest("thread/start", {
        ...keepAliveThreadSettings(payload.workspacePath, payload.model), ephemeral: false, historyMode: "legacy",
      }, options);
      const threadId = String(started?.thread?.id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId))
        return failure("keep-alive-thread-id-missing");
      const validated = validateKeepAliveSettings(started, threadId, payload.workspacePath, payload.model);
      if (!validated.ok) return { ...validated, threadId };
      createdThreads.set(threadId, { accountId: payload.expectedAccountId, settings: started, issued: false });
      // Naming does not submit a model turn. Older servers may not support it.
      try { await request.sendRequest("thread/name/set", { threadId, name: "Codex 定时保活" }, options); } catch {}
      return { ok: true, threadId };
    }
    const threadId = payload.threadId;
    const inspected = await readKeepAliveThread(request, payload);
    if (!inspected.ok) return inspected;
    const response = inspected.response;
    const validated = await validateKeepAliveThread(response?.thread, threadId, payload.workspacePath, request);
    if (!validated.ok) return validated;
    if (inspected.firstUnmaterialized) return { ok: true, threadId };
    // A just-created empty thread can be absent from the persisted thread list
    // until its first turn. Only this renderer's own account-bound creation may
    // use that exception; restored IDs must be positively found as unarchived.
    const created = createdThreads.get(threadId);
    if (!(response.thread.turns.length === 0 && created?.accountId === payload.expectedAccountId && !created.issued)
      && !await confirmUnarchivedThread(request, threadId, payload.workspacePath))
      return failure("keep-alive-thread-unavailable");
    const resumed = await request.sendRequest("thread/resume", {
      ...keepAliveThreadSettings(payload.workspacePath, payload.model), threadId,
    }, options);
    const settings = validateKeepAliveSettings(resumed, threadId, payload.workspacePath, payload.model);
    if (!settings.ok) return settings;
    const checked = await validateKeepAliveThread(resumed.thread, threadId, payload.workspacePath, request);
    return checked.ok ? { ok: true, threadId } : checked;
  }
`;

export function buildDesktopKeepAliveContextExpression(model = "gpt-6-luna", listOnly = false) {
  return `(async () => {
    ${DESKTOP_KEEP_ALIVE_HELPERS}
    try {
      const request = findDesktopRequestClient();
      const identity = await readIdentity(request);
      if (!identity.ok) return identity;
      const models = await keepAliveModels(request);
      if (!${JSON.stringify(listOnly)} && !models.some(item => item.id === ${JSON.stringify(model)})) return failure("keep-alive-low-model-unavailable");
      const latest = await readIdentity(request);
      if (!latest.ok) return latest;
      if (identity.accountId !== latest.accountId) return failure("keep-alive-account-changed");
      return { ...latest, models, model: ${JSON.stringify(model)}, effort: "low" };
    } catch { return failure("keep-alive-context-unavailable"); }
  })()`;
}

export async function readKeepAliveContextThroughDesktop(session, { model = "gpt-6-luna" } = {}) {
  try {
    const result = await session.evaluate(buildDesktopKeepAliveContextExpression(normalizeDailyKeepAliveModel(model)), 30000);
    return result?.ok === true ? result : result?.ok === false ? result
      : { ok: false, uncertain: false, reason: "keep-alive-context-unavailable" };
  } catch { return { ok: false, uncertain: false, reason: "keep-alive-context-unavailable" }; }
}

export async function readKeepAliveModelsThroughDesktop(session) {
  try {
    const result = await session.evaluate(buildDesktopKeepAliveContextExpression("gpt-6-luna", true), 30000);
    return result?.ok ? { ok: true, accountId: result.accountId, models: result.models } : { ok: false, models: [] };
  } catch { return { ok: false, models: [] }; }
}

function buildDesktopKeepAliveOperationExpression({ eventId, expectedAccountId, workspacePath, threadId = "", model = "gpt-6-luna", quotaBaseline = null }, prepareOnly) {
  const payload = { eventId, expectedAccountId, workspacePath, threadId, model, quotaBaseline, prepareOnly };
  return `(async () => {
    ${DESKTOP_KEEP_ALIVE_HELPERS}
    ${DESKTOP_KEEP_ALIVE_THREAD_HELPERS}
    const payload = ${JSON.stringify(payload)};
    const attempts = payload.prepareOnly
      ? window.__CODEX_USAGE_MONITOR_KEEP_ALIVE_PREPARES__ ||= new Map()
      : window.__CODEX_USAGE_MONITOR_KEEP_ALIVE_ATTEMPTS__ ||= new Map();
    const attemptKey = payload.expectedAccountId + ':' + payload.eventId;
    if (attempts.has(attemptKey)) return await attempts.get(attemptKey);
    const attempt = (async () => {
      let turnAttempted = false;
      let creationAttempted = false;
      let threadId = "";
      const attemptStartedAt = Date.now();
      const withinDeadline = () => Date.now() >= attemptStartedAt && Date.now() - attemptStartedAt < 50000;
      const usageNotReady = () => ({ ...failure("keep-alive-usage-not-ready"),
        retryable: !turnAttempted && !creationAttempted });
      try {
        const request = findDesktopRequestClient();
        let identity = await readIdentity(request);
        if (!identity.ok) return identity;
        if (identity.accountId !== payload.expectedAccountId) return failure("keep-alive-account-changed");
        if (!maySend(identity, payload.quotaBaseline)) return usageNotReady();
        if (!(await keepAliveModels(request)).some(item => item.id === payload.model)) return failure("keep-alive-low-model-unavailable");
        identity = await readIdentity(request);
        if (!identity.ok) return identity;
        if (identity.accountId !== payload.expectedAccountId) return failure("keep-alive-account-changed");
        if (!maySend(identity, payload.quotaBaseline)) return usageNotReady();
        if (!withinDeadline()) return failure("keep-alive-preflight-expired");
        const prepared = await prepareThread(request, payload, () => { creationAttempted = true; });
        if (!prepared.ok) return prepared;
        threadId = prepared.threadId;
        // Recheck identity after thread creation and immediately before a model
        // turn. A changed account must never inherit a previous schedule event.
        identity = await readIdentity(request);
        if (!identity.ok) return identity;
        if (identity.accountId !== payload.expectedAccountId) return failure("keep-alive-account-changed");
        if (!maySend(identity, payload.quotaBaseline)) return usageNotReady();
        if (!withinDeadline()) return failure("keep-alive-preflight-expired");
        if (payload.prepareOnly) return { ok: true, threadId, accountId: identity.accountId };
        // Re-read after the identity check: concurrent human work or queued
        // messages must not turn this into a request on an ordinary task.
        if (payload.threadId) {
          const inspected = await readKeepAliveThread(request, payload);
          if (!inspected.ok) return inspected;
          const checked = await validateKeepAliveThread(inspected.response?.thread, threadId, payload.workspacePath, request);
          if (!checked.ok) return checked;
          identity = await readIdentity(request);
          if (!identity.ok) return identity;
          if (identity.accountId !== payload.expectedAccountId) return failure("keep-alive-account-changed");
          if (!maySend(identity, payload.quotaBaseline)) return usageNotReady();
          if (!await queuedStateIsEmpty(threadId, request)) return failure("keep-alive-thread-queue-unverified");
          if (!withinDeadline()) return failure("keep-alive-preflight-expired");
        }
        const created = createdThreads.get(threadId);
        if (created?.accountId === payload.expectedAccountId) created.issued = true;
        turnAttempted = true;
        const result = await request.sendRequest("turn/start", {
          threadId, model: payload.model, effort: "low", approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          input: [{ type: "text", text: "只回复 OK。" }],
          clientUserMessageId: "codex-usage-monitor-keep-alive-" + payload.eventId,
        }, options);
        const turnId = String(result?.turn?.id || "");
        if (!turnId || turnId.length > 200 || /[\\x00-\\x20\\x7f]/.test(turnId))
          return { ok: false, uncertain: true, reason: "keep-alive-turn-id-missing", threadId };
        // Submission is deliberately not completion or a quota reset claim.
        return { ok: true, threadId, turnId, accountId: identity.accountId };
      } catch {
        return { ok: false, uncertain: turnAttempted || creationAttempted, reason: turnAttempted
          ? "keep-alive-send-uncertain" : creationAttempted ? "keep-alive-prepare-uncertain"
          : "keep-alive-preflight-failed", ...(threadId ? { threadId } : {}) };
      }
    })();
    // Unknown submissions and all operations that attempted thread creation
    // retain their barrier. Only a proven side-effect-free quota preflight may
    // be retried with a newer observation while the controller retains its claim.
    attempts.set(attemptKey, attempt);
    const result = await attempt;
    if (result?.retryable === true && result.uncertain === false && attempts.get(attemptKey) === attempt)
      attempts.delete(attemptKey);
    return result;
  })()`;
}

export function buildDesktopKeepAliveExpression(payload) {
  return buildDesktopKeepAliveOperationExpression(payload, false);
}

export function buildDesktopKeepAlivePrepareExpression(payload) {
  return buildDesktopKeepAliveOperationExpression(payload, true);
}

async function runKeepAliveOperationThroughDesktop(session, {
  eventId, expectedAccountId, workspacePath, threadId, model = "gpt-6-luna", quotaBaseline = null,
} = {}, prepareOnly) {
  const normalizedEventId = String(eventId || "").toLowerCase();
  if (normalizeDailyKeepAliveModel(model) !== model) return { ok: false, uncertain: false, reason: "invalid-keep-alive-model" };
  if (!EVENT_ID_PATTERN.test(normalizedEventId))
    return { ok: false, uncertain: false, reason: "invalid-keep-alive-event-id" };
  if (threadId != null && (typeof threadId !== "string" || !UUID_PATTERN.test(threadId)))
    return { ok: false, uncertain: false, reason: "invalid-keep-alive-thread-id" };
  if (typeof expectedAccountId !== "string" || !expectedAccountId || expectedAccountId.length > 200
    || expectedAccountId !== expectedAccountId.trim() || /[\x00-\x20\x7f]/.test(expectedAccountId))
    return { ok: false, uncertain: false, reason: "invalid-keep-alive-account-id" };
  if (typeof workspacePath !== "string" || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(workspacePath)
    || /[\x00-\x1f\x7f]/.test(workspacePath))
    return { ok: false, uncertain: false, reason: "invalid-keep-alive-workspace" };
  try {
    const result = await session.evaluate(buildDesktopKeepAliveOperationExpression({
      eventId: normalizedEventId, expectedAccountId, workspacePath, threadId: threadId?.toLowerCase() || "", model, quotaBaseline,
    }, prepareOnly), 60000);
    return result?.ok === true || result?.ok === false ? result
      : { ok: false, uncertain: true, reason: prepareOnly ? "keep-alive-prepare-uncertain" : "keep-alive-send-uncertain" };
  } catch { return { ok: false, uncertain: true,
    reason: prepareOnly ? "keep-alive-prepare-uncertain" : "keep-alive-send-uncertain" }; }
}

export async function prepareKeepAliveThreadThroughDesktop(session, payload = {}) {
  return await runKeepAliveOperationThroughDesktop(session, payload, true);
}

export async function sendKeepAliveThroughDesktop(session, payload = {}) {
  return await runKeepAliveOperationThroughDesktop(session, payload, false);
}

export function buildDesktopKeepAliveTurnExpression({ threadId, turnId, expectedAccountId }) {
  return `(async () => {
    ${DESKTOP_KEEP_ALIVE_HELPERS}
    const payload = ${JSON.stringify({ threadId, turnId, expectedAccountId })};
    try {
      const request = findDesktopRequestClient();
      const identity = await readIdentity(request);
      if (!identity.ok) return identity;
      if (identity.accountId !== payload.expectedAccountId) return failure("keep-alive-account-changed");
      const response = await request.sendRequest("thread/read", { threadId: payload.threadId, includeTurns: true }, options);
      if (response?.thread?.id !== payload.threadId) return failure("keep-alive-thread-id-mismatch");
      const turn = response.thread.turns?.find((item) => item?.id === payload.turnId);
      if (!turn || !["completed", "failed", "interrupted", "inProgress"].includes(turn.status))
        return failure("keep-alive-turn-unavailable");
      const outputText = (turn.itemsView === "summary" || turn.itemsView === "notLoaded" ? [] : Array.isArray(turn.items) ? turn.items : [])
        .filter((item) => item?.type === "agentMessage")
        .map((item) => typeof item.text === "string" ? item.text : "").join("\\n").slice(0, 200);
      const latest = await readIdentity(request);
      if (!latest.ok) return latest;
      if (identity.accountId !== latest.accountId) return failure("keep-alive-account-changed");
      return { ok: true, accountId: latest.accountId, threadId: payload.threadId,
        turnId: payload.turnId, status: turn.status, outputText, quota: latest.quota };
    } catch { return failure("keep-alive-turn-unavailable"); }
  })()`;
}

export async function readKeepAliveTurnThroughDesktop(session, { threadId, turnId, expectedAccountId } = {}) {
  if (!UUID_PATTERN.test(String(threadId || "")) || typeof turnId !== "string" || !turnId
    || turnId.length > 200 || /[\x00-\x20\x7f]/.test(turnId) || typeof expectedAccountId !== "string"
    || !expectedAccountId || expectedAccountId.length > 200 || /[\x00-\x20\x7f]/.test(expectedAccountId))
    return { ok: false, uncertain: false, reason: "invalid-keep-alive-turn-reference" };
  try {
    const result = await session.evaluate(buildDesktopKeepAliveTurnExpression({ threadId, turnId, expectedAccountId }), 30000);
    return result?.ok === true || result?.ok === false ? result
      : { ok: false, uncertain: false, reason: "keep-alive-turn-unavailable" };
  } catch { return { ok: false, uncertain: false, reason: "keep-alive-turn-unavailable" }; }
}
