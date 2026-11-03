import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CombinedUsageClient } from "./usage-client.mjs";
import { createUiSettingsStore, normalizeUiSettings, MAX_UI_SETTINGS_BYTES } from "./ui-settings.mjs";
import { createAutoUpdater } from "./auto-updater.mjs";
import { AutoResumeController, createAutoResumeStateStore } from "./auto-resume.mjs";
import { sendContinueThroughDesktop, probeDesktopRequestClient, readKeepAliveModelsThroughDesktop, readKeepAliveContextThroughDesktop, prepareKeepAliveThreadThroughDesktop, sendKeepAliveThroughDesktop, readKeepAliveTurnThroughDesktop, collectDesktopCompatibilityProbes, desktopBuildMetadataExpression } from "./desktop-request.mjs";
import { CompatibilityController, createCompatibilityStore, createDesktopVersionReader } from "./compatibility.mjs";
import { DailyKeepAliveController, createDailyKeepAliveStore } from "./daily-keepalive.mjs";
import { isMainCodexRendererTarget, syncCurrentThread } from "./current-thread.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const usageAssets = [
  "usage-constants.js",
  "usage-i18n.js",
  "usage-placement.js",
  "usage-history.js",
  "usage-inject.js",
].map((name) => path.join(root, "assets", name));
const HOST_ID = "codex-usage-monitor";
const STATE_KEY = "__CODEX_USAGE_MONITOR_STATE__";
const PERSISTED_SETTINGS_KEY = "__CODEX_USAGE_MONITOR_PERSISTED_SETTINGS__";
const SETTINGS_BINDING = "__codexUsageMonitorSaveSettings";
const CONFIGURATION_KEY = "__CODEX_USAGE_MONITOR_CONFIGURATION__";
const CONFIGURATION_BINDING = "__codexUsageMonitorConfigureSource";
const MAX_CONFIGURATION_BYTES = 131072;
const TARGET_ABSENCE_EXIT_MS = 180000;

function parseArgs(argv) {
  const options = {
    port: 9335,
    mode: "watch",
    timeoutMs: 30000,
    screenshot: null,
    monitorOnly: false,
    expectedPid: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--once") options.mode = "once";
    else if (arg === "--watch") options.mode = "watch";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--remove") options.mode = "remove";
    else if (arg === "--monitor-only") options.monitorOnly = true;
    else if (arg === "--expected-pid") options.expectedPid = Number(argv[++i]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--screenshot") options.screenshot = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error(`Invalid port: ${options.port}`);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 250 || options.timeoutMs > 120000) throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  if (options.expectedPid !== null && (!Number.isSafeInteger(options.expectedPid) || options.expectedPid <= 0)) throw new Error("Invalid expected monitor PID.");
  return options;
}

export class CdpSession {
  constructor(target, commandTimeoutMs) {
    this.target = target;
    this.commandTimeoutMs = commandTimeoutMs;
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket open timed out after ${this.commandTimeoutMs} ms`)), this.commandTimeoutMs);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener("error", (error) => { clearTimeout(timer); reject(error); }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    return this;
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}, timeoutMs = this.commandTimeoutMs) {
    if (this.closed) return Promise.reject(new Error("CDP session is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, timeoutMs = this.commandTimeoutMs) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    return result.result?.value;
  }

  async close() {
    const alreadyClosed = this.closed || this.ws.readyState === WebSocket.CLOSED;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CDP session is closed"));
    }
    this.pending.clear();
    if (alreadyClosed) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.closed = true;
        resolve();
      };
      const timer = setTimeout(finish, 500);
      this.ws.addEventListener("close", finish, { once: true });
      if (this.ws.readyState !== WebSocket.CLOSING) {
        try { this.ws.close(); } catch { finish(); }
      }
    });
  }
}

function isValidDebuggerSocket(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === "ws:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())
      && Number(url.port) === port
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

async function getTargets(port) {
  return (await getTargetStatus(port)).targets;
}

async function getTargetStatus(port) {
  for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
    try {
      const response = await fetch(`http://${host}:${port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(1000) });
      if (!response.ok) continue;
      const targets = await response.json();
      if (!Array.isArray(targets)) continue;
      return { reachable: true, targets: targets.filter((item) => item?.type === "page"
        && String(item.url).startsWith("app://")
        && isValidDebuggerSocket(item.webSocketDebuggerUrl, port)) };
    } catch {}
  }
  return { reachable: false, targets: [] };
}

// A responsive desktop can legitimately have no Composer while restoring tasks
// or showing ordinary ChatGPT chat. Only sustained endpoint loss ends the watch.
export function nextEndpointLoss(previous, reachable, now, graceMs = TARGET_ABSENCE_EXIT_MS) {
  const missingSince = reachable ? null : previous ?? now;
  return { missingSince, shouldExit: missingSince !== null && now - missingSince >= graceMs };
}

export function backendHeartbeatExpression(pid, now = Date.now()) {
  return `(() => {
    const entries = window.__CODEX_USAGE_MONITOR_BACKENDS__ ||= {};
    for (const [key, value] of Object.entries(entries)) if (!value || ${now} - value.at > 60000) delete entries[key];
    const value = { pid: ${pid}, at: ${now}, phase: document.getElementById(${JSON.stringify(HOST_ID)}) ? "connected" : "waiting-composer" };
    entries[${JSON.stringify(String(pid))}] = value;
    window.__CODEX_USAGE_MONITOR_BACKEND__ = value;
    return value;
  })()`;
}

export function backendVerificationExpression(expectedPid = null, now = Date.now()) {
  return `(() => {
    const expectedPid = ${JSON.stringify(expectedPid)};
    const value = expectedPid === null ? window.__CODEX_USAGE_MONITOR_BACKEND__ : window.__CODEX_USAGE_MONITOR_BACKENDS__?.[String(expectedPid)];
    const age = typeof value?.at === "number" ? ${now} - value.at : null;
    return { backendRunning: Boolean(value && Number.isSafeInteger(value.pid) && value.pid > 0 && (expectedPid === null || value.pid === expectedPid) && age !== null && age >= 0 && age <= 15000 && ["connected", "waiting-composer"].includes(value.phase)),
      pid: value?.pid || null, phase: value?.phase || null, heartbeatAgeMs: age,
      installed: Boolean(document.getElementById(${JSON.stringify(HOST_ID)})?.shadowRoot) };
  })()`;
}

// Health checks must not wait behind a frozen renderer's attachment or RPC.
// A timed-out socket may remain OPEN, so discard it and permit a fresh attach.
export function refreshBackendHeartbeats(sessions, {
  pid = process.pid, timeoutMs = 5000, onAlive = () => {}, onFailure = () => {},
} = {}) {
  const probes = [];
  for (const [id, entry] of sessions) {
    if (!entry.healthReady || entry.heartbeatPending) continue;
    const probe = (async () => {
      try {
        await entry.session.evaluate(backendHeartbeatExpression(pid), timeoutMs);
        if (sessions.get(id) === entry) await onAlive(entry);
      } catch (error) {
        if (sessions.get(id) === entry) {
          sessions.delete(id);
          try { onFailure(error, entry); } catch {}
        }
        await entry.session.close().catch(() => {});
      }
    })();
    entry.heartbeatPending = probe;
    probe.finally(() => { if (entry.heartbeatPending === probe) entry.heartbeatPending = null; });
    probes.push(probe);
  }
  return Promise.allSettled(probes);
}

async function waitForTargets(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await getTargets(port);
    if (targets.length) return targets;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`No Codex renderer target on local port ${port} within ${timeoutMs} ms.`);
}

function isMonitorTarget(target) {
  return isMainCodexRendererTarget(target);
}

async function readUsagePayload() {
  return (await Promise.all(usageAssets.map((asset) => fs.readFile(asset, "utf8")))).join("\n");
}

async function pathExists(targetPath) {
  try { return (await fs.stat(targetPath)).isFile(); } catch { return false; }
}

async function readConfigurationSummary() {
  const stateRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "CodexUsageMonitor") : null;
  const summary = {
    account: { configured: false, baseUrl: "https://www.cctq.ai", userId: "", baselineConfigured: false, initialTokens: "0" },
    provider: { configured: false },
  };
  if (!stateRoot) return summary;
  const accountConfigPath = path.join(stateRoot, "account.json");
  const accountSecretPath = path.join(stateRoot, "account-token.dpapi");
  const accountCounterPath = path.join(stateRoot, "account-token-counter.json");
  const providerConfigPath = path.join(stateRoot, "provider.json");
  const providerSecretPath = path.join(stateRoot, "api-key.dpapi");
  try {
    const value = JSON.parse(await fs.readFile(accountConfigPath, "utf8"));
    if (value?.schemaVersion === 1) {
      summary.account = {
        configured: await pathExists(accountSecretPath),
        baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : summary.account.baseUrl,
        userId: typeof value.userId === "string" ? value.userId : "",
        baselineConfigured: false,
        initialTokens: "0",
      };
    }
  } catch {}
  try {
    const text = await fs.readFile(accountCounterPath, "utf8");
    const initialTokens = text.match(/"initialTokens"\s*:\s*(\d+)/)?.[1];
    summary.account.baselineConfigured = /"baselineConfigured"\s*:\s*true/i.test(text) && Boolean(initialTokens);
    if (initialTokens) summary.account.initialTokens = initialTokens;
  } catch {}
  try {
    const value = JSON.parse(await fs.readFile(providerConfigPath, "utf8"));
    if (value?.schemaVersion === 1) summary.provider = { ...value, configured: await pathExists(providerSecretPath) };
  } catch {}
  return summary;
}

function updateExpression(value) {
  return `(() => { const state = window[${JSON.stringify(STATE_KEY)}]; return typeof state?.updateUsage === "function" ? state.updateUsage(${JSON.stringify(value)}) : false; })()`;
}

function removeExpression() {
  return `(() => { let removed = false; try { if (window[${JSON.stringify(STATE_KEY)}]?.cleanup?.()) removed = true; } catch {} document.getElementById(${JSON.stringify(HOST_ID)})?.remove(); return removed; })()`;
}

function settingsSeedExpression(value) {
  return `(() => { const value = ${JSON.stringify(value)}; if (value && typeof value === "object") window[${JSON.stringify(PERSISTED_SETTINGS_KEY)}] = value; else delete window[${JSON.stringify(PERSISTED_SETTINGS_KEY)}]; return true; })()`;
}

function configurationSeedExpression(value) {
  return `(() => { window[${JSON.stringify(CONFIGURATION_KEY)}] = ${JSON.stringify(value)}; return true; })()`;
}

function configurationResultExpression(requestId, result) {
  return `(() => window[${JSON.stringify(STATE_KEY)}]?.configurationResult?.(${JSON.stringify(requestId)}, ${JSON.stringify(result)}) || false)()`;
}

function readSettingsExpression() {
  return `(() => window[${JSON.stringify(STATE_KEY)}]?.getSettings?.() || null)()`;
}

async function registerSettingsBinding(session, settingsStore, onSettingsChanged = null) {
  session.on("Runtime.bindingCalled", ({ name, payload }) => {
    if (name !== SETTINGS_BINDING || typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > MAX_UI_SETTINGS_BYTES) return;
    let value;
    try { value = JSON.parse(payload); } catch { return; }
    settingsStore.save(value)
      .then((saved) => onSettingsChanged?.(saved))
      .catch((error) => console.error(`[usage-monitor] UI settings save failed: ${error.message}`));
  });
  await session.send("Runtime.addBinding", { name: SETTINGS_BINDING });
}

function runPanelConfiguration(request) {
  const powerShell = process.env.CODEX_USAGE_POWERSHELL_PATH || "pwsh.exe";
  const script = path.join(root, "scripts", "configure-from-panel.ps1");
  return new Promise((resolve) => {
    const child = spawn(powerShell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;
    const collect = (target, chunk) => {
      const next = target + String(chunk);
      if (Buffer.byteLength(next, "utf8") > MAX_CONFIGURATION_BYTES) outputTooLarge = true;
      return outputTooLarge ? target : next;
    };
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 120000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, message: "无法启动本机配置服务。" });
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (outputTooLarge) { resolve({ ok: false, message: "配置服务返回内容过大。" }); return; }
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      try {
        const result = JSON.parse(lines.at(-1) || "");
        resolve(result && typeof result === "object" ? result : { ok: false, message: "配置服务返回无效。" });
      } catch {
        resolve({ ok: false, message: stderr.trim() ? "配置服务执行失败。" : "配置服务没有返回结果。" });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

function startMonitorReplacement(port) {
  const powerShell = process.env.CODEX_USAGE_POWERSHELL_PATH || "pwsh.exe";
  const script = path.join(root, "scripts", "start-monitor.ps1");
  try {
    const child = spawn(powerShell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Port", String(port), "-Replace"], {
      detached: true, windowsHide: true, stdio: "ignore",
    });
    child.unref();
  } catch {}
}

async function registerConfigurationBinding(session, port) {
  session.on("Runtime.bindingCalled", ({ name, payload }) => {
    if (name !== CONFIGURATION_BINDING || typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > MAX_CONFIGURATION_BYTES) return;
    let request;
    try { request = JSON.parse(payload); } catch { return; }
    const requestId = typeof request?.requestId === "string" ? request.requestId : "";
    if (!/^[a-z0-9-]{8,64}$/.test(requestId) || !["api-account", "api-key"].includes(request?.type)) return;
    runPanelConfiguration(request).then(async (result) => {
      await session.evaluate(configurationResultExpression(requestId, result)).catch(() => {});
      if (result?.ok) setTimeout(() => startMonitorReplacement(port), 750);
    }).catch(() => {});
  });
  await session.send("Runtime.addBinding", { name: CONFIGURATION_BINDING });
}

async function applyMonitor(session, usage, settingsStore) {
  // Read the current asset for every renderer load so an updated package is never replaced by stale source.
  if (settingsStore) await session.evaluate(settingsSeedExpression(settingsStore.current));
  await session.evaluate(configurationSeedExpression(await readConfigurationSummary()));
  const result = await session.evaluate(await readUsagePayload());
  if (usage) await session.evaluate(updateExpression(usage));
  if (settingsStore && !settingsStore.current) {
    const rendererSettings = await session.evaluate(readSettingsExpression());
    if (rendererSettings) await settingsStore.save(rendererSettings);
  }
  return result || { installed: false, mode: "monitor-only", anchoredToApproval: false };
}

async function updateMonitor(session, usage, settingsStore) {
  const updated = await session.evaluate(updateExpression(usage));
  return updated ? updated : applyMonitor(session, usage, settingsStore);
}

async function removeFromSession(session) {
  return session.evaluate(removeExpression());
}

async function verifySession(session) {
  return session.evaluate(`(() => { const host = document.getElementById(${JSON.stringify(HOST_ID)}); const health = window[${JSON.stringify(STATE_KEY)}]?.diagnose?.() || null; return { installed: Boolean(host?.shadowRoot), anchor: host?.dataset?.anchor || null, status: host?.dataset?.status || null, strategy: host?.dataset?.placementStrategy || health?.strategy || null, reason: health?.reason || null }; })()`);
}

async function capture(session, targetPath) {
  const result = await session.send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(targetPath, Buffer.from(result.data, "base64"));
}

async function closeSessions(sessions) {
  await Promise.all([...sessions.values()].map(({ session }) => session.close().catch(() => {})));
  sessions.clear();
}

export async function runOnce(options) {
  const targets = await waitForTargets(options.port, options.timeoutMs);
  const settingsStore = ["remove", "verify"].includes(options.mode) ? null : await createUiSettingsStore();
  const results = [];
  for (const target of targets) {
    if (!isMonitorTarget(target)) {
      results.push({ targetId: target.id, auxiliary: true, skipped: true });
      continue;
    }
    const session = new CdpSession(target, Math.min(options.timeoutMs, 10000));
    await session.open();
    try {
      if (options.mode === "verify") {
        // Never inject or overwrite settings/data in a health probe. A leftover
        // panel is not proof that the newly launched background process is alive.
        results.push({ targetId: target.id, verified: await session.evaluate(backendVerificationExpression(options.expectedPid)) });
        continue;
      }
      if (options.mode === "remove") {
        results.push({ targetId: target.id, removed: await removeFromSession(session) });
        continue;
      }
      await registerSettingsBinding(session, settingsStore);
      const applied = await applyMonitor(session, null, settingsStore);
      if (options.screenshot) await capture(session, options.screenshot);
      const verified = await verifySession(session);
      results.push({ targetId: target.id, title: target.title, applied, verified });
    } finally {
      await session.close();
    }
  }
  const monitorResults = results.filter((item) => !item.auxiliary);
  const verified = options.mode === "verify"
    ? monitorResults.length > 0 && monitorResults.some((item) => item.verified?.backendRunning)
    : true;
  console.log(JSON.stringify({ mode: options.mode, monitorOnly: true, port: options.port, verified, targets: results }, null, 2));
  if (settingsStore) await settingsStore.flush();
  if (options.mode === "verify" && !verified) process.exitCode = 1;
}

async function runWatch(options) {
  const sessions = new Map();
  // Recent desktop versions keep the local request client in an internal
  // control page, separate from the main page that hosts the Composer.
  const requestSessions = new Map();
  const requestRetryAt = new Map();
  const desktopEntries = () => [...sessions.values(), ...requestSessions.values()];
  const settingsStore = await createUiSettingsStore();
  const compatibilityStore = await createCompatibilityStore().catch(() => ({ current: {}, save: async () => { throw new Error("compatibility-store-unavailable"); }, flush: async () => {} }));
  const autoResumeStore = await createAutoResumeStateStore();
  const dailyKeepAliveStore = await createDailyKeepAliveStore();
  const keepAliveWorkspace = path.join(process.env.LOCALAPPDATA, "CodexUsageMonitor", "keep-alive-workspace");
  await fs.mkdir(keepAliveWorkspace, { recursive: true });
  const autoUpdater = createAutoUpdater({ root, port: options.port, settingsStore });
  let usageClient = null;
  let latestBaseUsage = null;
  let latestUsage = null;
  let keepAliveModels = [];
  let modelsCheckedAt = 0;
  let modelsProbe = null;
  let stopping = false;
  let heartbeatTimer = null;
  let targetsMissingSince = null;
  let usageStartPromise = Promise.resolve();
  let nextPendingCheckAt = 0;
  let lastPendingPromotionAt = 0;
  const watchStartedAt = Date.now();
  let lastKeepAliveEvidence = null;
  const enrichBuildMetadata = createDesktopVersionReader({
    initialVersion: process.env.CODEX_USAGE_DESKTOP_VERSION,
    readVersion: () => new Promise((resolve) => {
      execFile(process.env.CODEX_USAGE_POWERSHELL_PATH || "pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts", "desktop-version.ps1"), "-Port", String(options.port)],
        { windowsHide: true, timeout: 8000, maxBuffer: 1024 }, (error, stdout) => {
          try { resolve(error ? null : JSON.parse(stdout)); } catch { resolve(null); }
        });
    }),
  });
  const promotePendingStartup = async () => {
    if (Date.now() < nextPendingCheckAt || !process.env.LOCALAPPDATA) return;
    nextPendingCheckAt = Date.now() + 5000;
    try {
      const statePath = path.join(process.env.LOCALAPPDATA, "CodexUsageMonitor", "state.json");
      const state = JSON.parse(await fs.readFile(statePath, "utf8"));
      if (state.injectorPid !== process.pid || state.startupPhase !== "waiting-ui" || Date.now() - lastPendingPromotionAt < 30000) return;
      lastPendingPromotionAt = Date.now();
      const child = spawn(process.env.CODEX_USAGE_POWERSHELL_PATH || "pwsh.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "start-monitor.ps1"), "-Port", String(options.port)],
        { detached: true, windowsHide: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } catch {}
  };
  const publishUsage = () => {
    if (!latestBaseUsage) return;
    latestUsage = { ...latestBaseUsage, compatibility: compatibility.status, autoResume: { ...autoResumeController.status }, dailyKeepAlive: { ...dailyKeepAliveController.status, models: keepAliveModels } };
    for (const entry of sessions.values()) {
      updateMonitor(entry.session, latestUsage, settingsStore).catch((error) => console.error(`[usage-monitor] update failed: ${error.message}`));
    }
  };
  const compatibility = new CompatibilityController({
    store: compatibilityStore,
    desktopVersion: process.env.CODEX_USAGE_DESKTOP_VERSION,
    onChange: publishUsage,
    readMetadata: async () => {
      const entry = [...sessions.values()].find(item => item.healthReady && !item.session.closed);
      return entry ? enrichBuildMetadata(await entry.session.evaluate(desktopBuildMetadataExpression(), 5000)) : null;
    },
    runChecks: async () => {
      const settings = settingsStore.current;
      const probe = await collectDesktopCompatibilityProbes({
        monitorSessions: [...sessions.values()].map(entry => entry.session),
        requestSessions: [...requestSessions.values()].map(entry => entry.session),
        expectedPid: process.pid, threadId: latestBaseUsage?.currentThreadId, model: settings?.dailyKeepAliveModel,
      });
      let settingsReadable = false;
      try {
        const saved = normalizeUiSettings(JSON.parse(await fs.readFile(settingsStore.filePath, "utf8")));
        settingsReadable = Boolean(saved && JSON.stringify(saved) === JSON.stringify(normalizeUiSettings(settingsStore.current)));
      } catch {}
      let updateState = null;
      try { updateState = JSON.parse(await fs.readFile(path.join(process.env.LOCALAPPDATA, "CodexUsageMonitor", "update-state.json"), "utf8")); } catch {}
      return { probe, usage: { ...latestBaseUsage, dailyKeepAlive: dailyKeepAliveController.status }, settings: settingsStore.current, settingsReadable, configuration: await readConfigurationSummary(), updateState };
    },
  });
  const autoResumeController = new AutoResumeController({
    store: autoResumeStore,
    onStatusChange: publishUsage,
    sendContinue: async (pending) => {
      let lastReason = "codex-desktop-unavailable";
      for (const entry of desktopEntries()) {
        if (entry.session.closed) continue;
        const result = await sendContinueThroughDesktop(entry.session, {
          threadId: pending.threadId,
          eventId: pending.eventId,
          message: pending.message,
        });
        if (result?.ok) { compatibility.recordExecution("resume-execution", true); return result; }
        lastReason = result?.reason || "desktop-send-failed";
        if (lastReason !== "desktop-request-client-unavailable") { compatibility.recordExecution("resume-execution", false); return result; }
      }
      compatibility.recordExecution("resume-execution", false);
      return { ok: false, reason: lastReason };
    },
  });
  // Use the desktop's existing account and send channel. Do not create another
  // CLI/model connection or send into whichever development task is visible.
  const withDesktop = async (operation) => {
    for (const entry of desktopEntries()) {
      if (entry.session.closed) continue;
      if (!(await probeDesktopRequestClient(entry.session)).ok) continue;
      const result = await operation(entry.session);
      if (result?.ok || result?.uncertain || !/request-client|react-root|desktop-unavailable/.test(result?.reason || "")) return result;
    }
    return { ok: false, uncertain: false, reason: "desktop-unavailable" };
  };
  const dailyKeepAliveController = new DailyKeepAliveController({
    store: dailyKeepAliveStore,
    onStatusChange: () => {
      const status = dailyKeepAliveController.status;
      if (status.status === "confirmed" && status.lastAttemptAt >= watchStartedAt && status.lastAttemptAt !== lastKeepAliveEvidence) {
        lastKeepAliveEvidence = status.lastAttemptAt;
        compatibility.recordExecution("keepalive-execution", true);
      }
      publishUsage();
    },
    readContext: (model) => withDesktop((session) => readKeepAliveContextThroughDesktop(session, { model })),
    prepareThread: (attempt) => withDesktop((session) => prepareKeepAliveThreadThroughDesktop(session, {
      eventId: attempt.eventId, threadId: attempt.reuseThreadId, expectedAccountId: attempt.accountId, workspacePath: keepAliveWorkspace, model: attempt.model,
      quotaBaseline: attempt.quotaBaseline,
    })),
    sendKeepAlive: (attempt) => withDesktop((session) => sendKeepAliveThroughDesktop(session, {
      eventId: attempt.eventId, threadId: attempt.reuseThreadId, expectedAccountId: attempt.accountId, workspacePath: keepAliveWorkspace, model: attempt.model,
      quotaBaseline: attempt.quotaBaseline,
    })),
    readTurn: (attempt) => withDesktop((session) => readKeepAliveTurnThroughDesktop(session, {
      threadId: attempt.threadId, turnId: attempt.turnId, expectedAccountId: attempt.accountId,
    })),
  });
  dailyKeepAliveController.settingsChanged(settingsStore.current);
  const refreshKeepAliveModels = () => {
    if (modelsProbe || Date.now() - modelsCheckedAt < 300_000 || !sessions.size) return;
    modelsCheckedAt = Date.now();
    modelsProbe = withDesktop(readKeepAliveModelsThroughDesktop).then((result) => {
      keepAliveModels = result?.ok && Array.isArray(result.models) ? result.models : [];
      if (!result?.ok) modelsCheckedAt = Date.now() - 270_000; // Retry startup failures after 30 seconds.
      if (!stopping) publishUsage();
    }).catch(() => {}).finally(() => { modelsProbe = null; });
  };
  usageClient = new CombinedUsageClient({
    refreshMs: settingsStore.current?.refreshEvery30Seconds ? 30000 : 60000,
    onUpdate: (usage) => {
      latestBaseUsage = usage;
      publishUsage();
      autoResumeController.observeUsage(usage).catch((error) => console.error(`[usage-monitor] auto-resume failed: ${error.message}`));
    },
  });

  const attach = async (target) => {
    if (!isMonitorTarget(target)) return;
    const previous = sessions.get(target.id);
    if (previous && !previous.session.closed) return;
    if (previous) sessions.delete(target.id);
    const session = new CdpSession(target, 10000);
    try {
      await session.open();
      const entry = { session, target };
      sessions.set(target.id, entry);
      session.ws.addEventListener("close", () => {
        if (sessions.get(target.id)?.session === session) sessions.delete(target.id);
      }, { once: true });
      session.on("Page.loadEventFired", () => {
        compatibility.invalidate();
        applyMonitor(session, latestUsage, settingsStore)
          .then(() => syncCurrentThread(session, usageClient))
          .catch((error) => console.error(`[usage-monitor] renderer reload failed: ${error.message}`));
      });
      await registerSettingsBinding(session, settingsStore, (value) => {
        autoUpdater.settingsChanged(value);
        usageClient.setRefreshInterval(value?.refreshEvery30Seconds ? 30000 : 60000);
        usageClient.setAutoResumeThreadIds(Object.entries(value?.autoResumeThreads || {}).filter(([, config]) => config?.enabled === true).map(([id]) => id));
        dailyKeepAliveController.settingsChanged(value);
        compatibility.invalidate();
        return autoResumeController.settingsChanged(value);
      });
      await registerConfigurationBinding(session, options.port);
      session.on("Runtime.bindingCalled", ({ name, payload }) => {
        if (name === "__codexUsageMonitorRunDiagnostics" && payload === "run") compatibility.tick({ force: true }).catch(() => {});
      });
      await session.send("Runtime.addBinding", { name: "__codexUsageMonitorRunDiagnostics" });
      await applyMonitor(session, latestUsage, settingsStore);
      autoUpdater.settingsChanged(settingsStore.current);
      usageClient.setRefreshInterval(settingsStore.current?.refreshEvery30Seconds ? 30000 : 60000);
      usageClient.setAutoResumeThreadIds(Object.entries(settingsStore.current?.autoResumeThreads || {}).filter(([, config]) => config?.enabled === true).map(([id]) => id));
      await autoResumeController.settingsChanged(settingsStore.current);
      dailyKeepAliveController.settingsChanged(settingsStore.current);
      entry.healthReady = true;
      await syncCurrentThread(session, usageClient);
    } catch (error) {
      if (sessions.get(target.id)?.session === session) sessions.delete(target.id);
      await session.close().catch(() => {});
      throw error;
    }
  };

  const attachRequestPage = async (target) => {
    if (isMonitorTarget(target) || requestSessions.has(target.id) || Date.now() < (requestRetryAt.get(target.id) || 0)) return;
    requestRetryAt.set(target.id, Date.now() + 30_000);
    const session = new CdpSession(target, 10000);
    try {
      await session.open();
      if (!(await probeDesktopRequestClient(session)).ok) { await session.close(); return; }
      const entry = { session, target };
      requestSessions.set(target.id, entry);
      modelsCheckedAt = 0;
      session.ws.addEventListener("close", () => {
        if (requestSessions.get(target.id)?.session === session) requestSessions.delete(target.id);
      }, { once: true });
    } catch (error) { await session.close().catch(() => {}); }
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeatTimer);
    await usageStartPromise.catch(() => {});
    autoUpdater.stop();
    await compatibility.stop().catch(() => {});
    await autoResumeController.stop().catch(() => {});
    await dailyKeepAliveController.stop().catch(() => {});
    await usageClient.stop().catch(() => {});
    await settingsStore.flush().catch(() => {});
    await closeSessions(sessions);
    await closeSessions(requestSessions);
  };
  process.once("SIGINT", () => { stop().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { stop().finally(() => process.exit(0)); });

  try {
    heartbeatTimer = setInterval(() => {
      if (stopping) return;
      refreshBackendHeartbeats(sessions, {
        onAlive: (entry) => {
          promotePendingStartup().catch(() => {});
          if (!entry.threadSyncPending) {
            entry.threadSyncPending = syncCurrentThread(entry.session, usageClient)
              .catch(() => {}).finally(() => { entry.threadSyncPending = null; });
          }
        },
        onFailure: () => console.error('[usage-monitor] heartbeat failed; reconnecting renderer session'),
      }).catch(() => {});
    }, 1000);
    heartbeatTimer.unref();
    // Inject the monitor as soon as the renderer appears. The first account usage
    // request can take several seconds and must not delay the UI.
    usageStartPromise = usageClient.start().catch((error) => {
      console.error(`[usage-monitor] initial usage refresh failed: ${error.message}`);
    });
    autoUpdater.start();
    while (!stopping) {
      const { targets, reachable } = await getTargetStatus(options.port);
      const monitorTargets = targets.filter(isMonitorTarget);
      const endpointLoss = nextEndpointLoss(targetsMissingSince, reachable, Date.now());
      targetsMissingSince = endpointLoss.missingSince;
      if (endpointLoss.shouldExit) {
        console.log(`[usage-monitor] Codex endpoint unreachable for ${TARGET_ABSENCE_EXIT_MS} ms; exiting`);
        break;
      }
      const activeIds = new Set(monitorTargets.map((target) => target.id));
      for (const [id, entry] of sessions) {
        if (!activeIds.has(id)) {
          await entry.session.close().catch(() => {});
          sessions.delete(id);
        }
      }
      for (const target of monitorTargets) {
        try { await attach(target); } catch (error) { console.error(`[usage-monitor] target attach failed: ${error.message}`); }
      }
      const allTargetIds = new Set(targets.map(target => target.id));
      for (const [id, entry] of requestSessions) {
        if (!allTargetIds.has(id)) { await entry.session.close().catch(() => {}); requestSessions.delete(id); }
      }
      for (const id of requestRetryAt.keys()) { if (!allTargetIds.has(id)) requestRetryAt.delete(id); }
      for (const target of targets) await attachRequestPage(target);
      // The controller owns its serialization, 30-second probe throttle and
      // journal. A slow desktop RPC must not delay heartbeat or UI attachment.
      dailyKeepAliveController.tick().catch(() => {});
      compatibility.tick().catch(() => {});
      refreshKeepAliveModels();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    await stop();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "watch") await runWatch(options);
  else await runOnce(options);
  return options.mode;
}

function scheduleOneShotExit(code) {
  // A real Electron CDP endpoint can occasionally keep the WebSocket handle alive
  // after close(). One-shot probes must still release the PowerShell startup mutex.
  setTimeout(() => process.exit(code), 50);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((mode) => {
  if (mode !== "watch") scheduleOneShotExit(process.exitCode ?? 0);
}).catch((error) => {
  console.error(`[usage-monitor] ${error.message}`);
  scheduleOneShotExit(1);
});
