import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renameMonitorFileAtomic } from "./windows-files.mjs";

export const COMPATIBILITY_CHECK_IDS = ["interface", "official", "desktop-quota", "session", "resume-channel", "resume-execution", "keepalive-model", "keepalive-plan", "keepalive-execution", "queue", "settings", "history", "api-account", "api-key", "forecast", "updates"];
const EXECUTIONS = new Set(["resume-execution", "keepalive-execution"]);
const VERSION = /^\d+(?:\.\d+){1,4}$/;
const ASSET = /^[a-zA-Z0-9._-]{1,160}\.js$/;
const row = (id, status, detail = status) => ({ id, status, detail });
const freshSource = (source, now) => Number(source?.fetchedAt) > 0 && Number(source.fetchedAt) <= now && now - Number(source.fetchedAt) < 15 * 60000;
const sourceRow = (id, source, enabled = true, now = Date.now()) => !enabled ? row(id, "disabled")
  : source?.status === "ready" && freshSource(source, now) ? row(id, "passed", "data-read")
    : row(id, source?.status === "loading" ? "unverified" : "failed", "source-unavailable");
const sessionRow = (source, now) => source?.status === 'loading' ? row('session', 'unverified', 'session-loading')
  : source?.reason === 'no-current-thread' && freshSource(source, now) ? row('session', 'unverified', 'session-unverified')
    : source?.status !== 'ready' ? row('session', 'failed', 'session-unavailable')
      : !freshSource(source, now) ? row('session', 'failed', 'session-stale') : row('session', 'passed', 'data-read');

export function desktopBuildKey(metadata, desktopVersion) {
  const asset = ASSET.test(metadata?.asset || "") ? metadata.asset : "";
  const version = VERSION.test(desktopVersion || "") ? desktopVersion : "unknown";
  return asset ? { key: `${version}|${asset}`, version, asset } : null;
}

export function createDesktopVersionReader({ readVersion, initialVersion = "" }) {
  let identity = null;
  let version = VERSION.test(initialVersion) ? initialVersion : "";
  return async metadata => {
    const nextIdentity = metadata?.sessionId || metadata?.asset;
    if (!nextIdentity) return metadata;
    if ((identity === null && !version) || (identity !== null && identity !== nextIdentity)) {
      try {
        const result = await readVersion();
        version = VERSION.test(result?.version || "") ? result.version : "";
      } catch { version = ""; }
    }
    identity = nextIdentity;
    return { asset: metadata.asset, desktopVersion: version };
  };
}

export async function createCompatibilityStore(filePath = path.join(process.env.USERPROFILE, ".codex-usage-monitor", "compatibility-state.json")) {
  let current = {};
  try {
    if ((await fs.stat(filePath)).size <= 32 * 1024) current = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) { if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  let pending = Promise.resolve();
  return {
    get current() { return current; },
    save(value) {
      // Only build identifiers, timestamps and fixed execution IDs are saved.
      const safe = { schemaVersion: 1, buildKey: String(value.buildKey || "").slice(0, 220), executions: {} };
      for (const id of EXECUTIONS) {
        const item = value.executions?.[id];
        if (item && typeof item.ok === "boolean" && Number.isFinite(item.at) && item.at > 0) safe.executions[id] = { ok: item.ok, at: item.at };
      }
      if (Number.isFinite(value.lastProbe?.at) && value.lastProbe.at > 0) {
        safe.lastProbe = { at: value.lastProbe.at, failures: {} };
        for (const key of ["interface", "client", "quota", "model", "queue", "thread"]) {
          if (typeof value.lastProbe[key] === "boolean" || value.lastProbe[key] === null) safe.lastProbe[key] = value.lastProbe[key];
          if (["timeout", "unavailable", "invalid-response"].includes(value.lastProbe.failures?.[key])) safe.lastProbe.failures[key] = value.lastProbe.failures[key];
        }
      }
      pending = pending.catch(() => {}).then(async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temp, JSON.stringify(safe), { encoding: "utf8", flag: "wx" });
          await renameMonitorFileAtomic(temp, filePath);
        } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
        current = safe;
      });
      return pending;
    },
    flush() { return pending; },
  };
}

export function compatibilityChecks({ probe, usage, settings, settingsReadable, configuration, updateState, executions = {}, now = Date.now() }) {
  const enabledResume = Object.values(settings?.autoResumeThreads || {}).some(item => item?.enabled === true);
  const execution = id => {
    const value = executions[id];
    return value && typeof value.ok === "boolean" && Number.isFinite(value.at) && value.at <= now
      ? { ...row(id, value.ok ? "passed" : "failed", value.ok ? "actual-success" : "actual-failure"), verifiedAt: value.at }
      : row(id, "unverified", "actual-pending");
  };
  const keepAlive = settings?.dailyKeepAlive === true;
  const failures = probe?.failures || {};
  const resume = !probe?.client ? row("resume-channel", "failed", "client-unavailable")
    : probe.thread === true ? row("resume-channel", "passed", "readonly-channel")
      : probe.thread === null ? row("resume-channel", "unverified", "thread-unverified")
        : failures.thread === "timeout" ? row("resume-channel", "unverified", "thread-timeout")
          : row("resume-channel", "failed", "thread-unavailable");
  const checks = [
    row("interface", probe?.interface === true ? "passed" : probe?.interface === null ? "unverified" : "failed", "interface-read"),
    sourceRow("official", usage?.sources?.official, true, now),
    row("desktop-quota", probe?.quota ? "passed" : failures.quota === "timeout" ? "unverified" : "failed",
      probe?.quota ? "quota-read" : failures.quota === "timeout" ? "quota-timeout" : "quota-unavailable"),
    sessionRow(usage?.sources?.session, now),
    resume,
    execution("resume-execution"),
    row("keepalive-model", !keepAlive ? "disabled" : probe?.model ? "passed" : failures.model === "timeout" ? "unverified" : "failed", failures.model === "timeout" ? "model-timeout" : "model-read"),
    row("keepalive-plan", !keepAlive ? "disabled" : usage?.dailyKeepAlive?.reason !== "state-unavailable" && /^([01]\d|2[0-3]):[0-5]\d$/.test(settings?.dailyKeepAliveStart || "") ? "passed" : "failed", "plan-valid"),
    execution("keepalive-execution"),
    row("queue", probe?.queue ? "passed" : probe?.queue === null || failures.queue === 'timeout' ? "unverified" : "failed",
      probe?.queue ? "queue-read" : failures.queue === 'timeout' ? 'queue-timeout' : probe?.queue === null ? 'queue-unverified' : 'queue-read'),
    row("settings", settingsReadable ? "passed" : "failed", "settings-read"),
    row("history", !usage?.usageHistory ? "unverified" : usage.usageHistory.schemaVersion === 1 && !usage.usageHistory.error
      && Array.isArray(usage.usageHistory.tokenBuckets) && Array.isArray(usage.usageHistory.quotaSamples) ? "passed" : "failed", "history-read"),
    sourceRow("api-account", usage?.sources?.["api-account"], configuration?.account?.configured === true, now),
    sourceRow("api-key", Object.values(usage?.sources || {}).find(source => source?.accountType === "api-key"), configuration?.provider?.configured === true, now),
    sourceRow("forecast", usage?.sources?.["reset-forecast"], settings?.showResetForecast === true, now),
    !settings?.updateNotifications ? row("updates", "disabled") : row("updates",
      (updateState?.status === "up-to-date" || updateState?.status === "installed") && now >= Date.parse(updateState.checkedAt) && now - Date.parse(updateState.checkedAt) < 30 * 3600000 ? "passed" : updateState?.status === "error" ? "failed" : "unverified", "update-read"),
  ];
  if (!enabledResume) checks.find(item => item.id === "resume-execution").status = "disabled";
  if (!keepAlive) checks.find(item => item.id === "keepalive-execution").status = "disabled";
  return checks;
}

export class CompatibilityController {
  constructor({ store, readMetadata, runChecks, onChange = () => {}, desktopVersion = "", now = () => Date.now() }) {
    Object.assign(this, { store, readMetadata, runChecks, onChange, desktopVersion, now });
    this.build = null;
    this.executions = {};
    this.previousBuild = String(store?.current?.buildKey || "");
    this.nextMetadataAt = 0;
    this.nextCheckAt = 0;
    this.lastManualAt = -Infinity;
    this.pending = null;
    this.lastProbe = null;
    this.stopped = false;
    this.status = { status: "checking", checkedAt: null, desktopVersion: "", changed: false, checks: [] };
  }
  publish(extra) { this.status = { ...this.status, ...extra }; try { this.onChange(this.status); } catch {} }
  invalidate() { this.nextMetadataAt = 0; this.nextCheckAt = 0; }
  tick({ force = false } = {}) {
    if (this.stopped || this.pending) return this.pending || Promise.resolve();
    if (force && this.now() - this.lastManualAt < 30000) return Promise.resolve();
    if (!force && this.now() < this.nextMetadataAt) return Promise.resolve();
    if (force) this.lastManualAt = this.now();
    this.nextMetadataAt = this.now() + 60000;
    this.pending = this.run(force).finally(() => { this.pending = null; });
    return this.pending;
  }
  async run(force) {
    try {
      const metadata = await this.readMetadata();
      const build = desktopBuildKey(metadata, metadata?.desktopVersion ?? this.desktopVersion);
      if (!build) throw new Error("metadata-unavailable");
      const changed = this.build?.key !== build.key;
      if (changed) {
        this.build = build;
        const saved = this.store?.current;
        this.executions = saved?.buildKey === build.key ? { ...saved.executions } : {};
        this.nextCheckAt = 0;
      }
      if (!force && this.now() < this.nextCheckAt) return;
      this.publish({ status: "checking", desktopVersion: build.version, changed: Boolean(this.previousBuild && this.previousBuild !== build.key), checks: changed ? [] : this.status.checks });
      const result = await this.runChecks();
      if (this.stopped) return;
      this.lastProbe = { ...result.probe, at: this.now() };
      const checks = compatibilityChecks({ ...result, executions: this.executions, now: this.now() });
      await this.save();
      this.nextCheckAt = this.now() + 10 * 60000;
      // A transient startup failure is revisited sooner without blocking the UI.
      if (checks.some(item => item.status === "failed" || item.detail.endsWith("-timeout"))) this.nextCheckAt = this.now() + 60000;
      this.publish({ status: checks.some(item => item.status === "failed") ? "attention" : "ready", checkedAt: this.now(), checks, persistenceFailed: false });
    } catch {
      if (!this.stopped) this.publish({ status: "attention", checkedAt: this.now(), checks: COMPATIBILITY_CHECK_IDS.map(id => row(id, id === "interface" ? "failed" : "unverified", "check-unavailable")) });
    }
  }
  async save() { if (this.build) await this.store.save({ buildKey: this.build.key, executions: this.executions, lastProbe: this.lastProbe }); }
  recordExecution(id, ok) {
    if (!EXECUTIONS.has(id) || !this.build || this.stopped) return;
    const item = { ok: ok === true, at: this.now() };
    this.executions[id] = item;
    const checks = this.status.checks.map(check => check.id === id
      ? { ...check, status: item.ok ? "passed" : "failed", detail: item.ok ? "actual-success" : "actual-failure", verifiedAt: item.at } : check);
    this.publish({ checks, status: checks.some(check => check.status === "failed") ? "attention" : this.status.status === "checking" ? "checking" : "ready" });
    this.save().catch(() => this.publish({ status: "attention", persistenceFailed: true }));
  }
  async stop() { this.stopped = true; await this.pending?.catch(() => {}); await this.store.flush(); }
}
