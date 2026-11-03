import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeDailyKeepAliveModel } from "./ui-settings.mjs";
import { renameMonitorFileAtomic } from "./windows-files.mjs";
import { classifyKeepAliveWindow, keepAliveQuotaReason } from "./keepalive-quota.mjs";

export { keepAliveQuotaReason } from "./keepalive-quota.mjs";

export const DAILY_KEEP_ALIVE_STATE_FILE = "daily-keep-alive-state.json";
export const NODE_GRACE_MS = 10 * 60_000;
const HOUR = 3600_000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const normalizeDailyStart = (value) => typeof value === "string" && value.length === 5 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "07:00";

// Anchor each local calendar day separately, then space its four nodes by five
// elapsed hours. Include yesterday for schedules crossing midnight.
export function dailyKeepAliveNodes(now, start = "07:00") {
  const [hour, minute] = normalizeDailyStart(start).split(":").map(Number);
  const today = new Date(now);
  return [-1, 0, 1].flatMap((offset) => {
    const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, hour, minute).getTime();
    return [0, 1, 2, 3].map((index) => anchor + index * 5 * HOUR);
  }).sort((a, b) => a - b);
}

function normalizeState(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.attempts) || value.attempts.length > 256) throw new Error("Invalid daily keep-alive journal");
  const statuses = new Set(["submitting", "submitted", "confirmed", "uncertain", "skipped"]);
  for (const row of value.attempts) {
    if (!row || !/^[a-f0-9]{64}$/.test(row.key) || !/^[a-f0-9]{32}$/.test(row.eventId)
      || !Number.isFinite(row.node) || !Number.isFinite(row.attemptedAt) || typeof row.accountId !== "string"
      || !row.accountId || !statuses.has(row.status)) throw new Error("Invalid daily keep-alive entry");
    if (row.threadId != null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.threadId)) throw new Error("Invalid daily keep-alive thread identity");
    if (row.reuseThreadId != null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.reuseThreadId)) throw new Error("Invalid reusable keep-alive thread identity");
    if (row.turnId != null && (typeof row.turnId !== "string" || !row.turnId || row.turnId.length > 200 || /[\x00-\x20\x7f]/.test(row.turnId))) throw new Error("Invalid daily keep-alive turn identity");
  }
  return structuredClone(value);
}

export async function createDailyKeepAliveStore(filePath = path.join(process.env.LOCALAPPDATA, "CodexUsageMonitor", DAILY_KEEP_ALIVE_STATE_FILE)) {
  let current = { schemaVersion: 1, attempts: [] };
  let error = false;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Invalid journal size");
    current = normalizeState(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (failure) { if (failure.code !== "ENOENT") error = true; }
  let pending = Promise.resolve();
  const bindingPath = (accountId) => path.join(`${filePath}.threads`, digest(accountId));
  const validBinding = (value, accountId) => value?.accountId === accountId && typeof value.threadId === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.threadId);
  const readBinding = async (accountId) => {
    try {
      const file = bindingPath(accountId);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("Invalid keep-alive thread binding");
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (!validBinding(value, accountId)) throw new Error("Invalid keep-alive thread binding");
      return value.threadId;
    } catch (failure) { if (failure.code === "ENOENT") return null; throw failure; }
  };
  return {
    get current() { return structuredClone(current); },
    get error() { return error; },
    getThread: readBinding,
    async reserveThread(accountId) {
      if (error) throw new Error("Daily keep-alive journal unavailable");
      const filePath = `${bindingPath(accountId)}.creating`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      let file;
      try {
        file = await fs.open(filePath, "wx");
        await file.writeFile(JSON.stringify({ accountId }));
        await file.sync();
        return true;
      } catch (failure) { if (failure.code === "EEXIST") return false; throw failure; }
      finally { await file?.close(); }
    },
    async rememberThread(accountId, threadId) {
      if (error || !validBinding({ accountId, threadId }, accountId)) throw new Error("Invalid keep-alive thread binding");
      const filePath = bindingPath(accountId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      let file;
      try {
        file = await fs.open(filePath, "wx");
        await file.writeFile(JSON.stringify({ accountId, threadId }));
        await file.sync();
      } catch (failure) {
        if (failure.code !== "EEXIST" || await readBinding(accountId) !== threadId) throw failure;
      } finally { await file?.close(); }
    },
    async claim(row) {
      if (error) throw new Error("Daily keep-alive journal unavailable");
      normalizeState({ schemaVersion: 1, attempts: [row] });
      const directory = `${filePath}.claims`;
      await fs.mkdir(directory, { recursive: true });
      let file;
      try {
        // Replace/update can briefly leave two backends running, possibly on
        // different renderers. An exclusive persistent claim works across both
        // processes and survives crashes; renderer Maps alone cannot do that.
        file = await fs.open(path.join(directory, row.key), "wx");
        await file.writeFile(JSON.stringify(row));
        await file.sync();
        return true;
      } catch (failure) {
        if (failure.code === "EEXIST") return false;
        error = true;
        throw failure;
      } finally { await file?.close(); }
    },
    save(value) {
      if (error) return Promise.reject(new Error("Daily keep-alive journal unavailable"));
      const snapshot = normalizeState(value);
      pending = pending.then(async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${process.pid}.tmp`;
        try {
          const file = await fs.open(temporary, "w");
          try { await file.writeFile(JSON.stringify(snapshot)); await file.sync(); } finally { await file.close(); }
          await renameMonitorFileAtomic(temporary, filePath);
          current = snapshot;
        } catch (failure) { error = true; throw failure; }
        finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      });
      return pending;
    },
    flush() { return pending; },
  };
}

export class DailyKeepAliveController {
  constructor({ store, readContext, prepareThread, sendKeepAlive, readTurn, now = Date.now, onStatusChange = () => {} }) {
    Object.assign(this, { store, readContext, prepareThread, sendKeepAlive, readTurn, now, onStatusChange });
    this.settings = { dailyKeepAlive: false, dailyKeepAliveStart: "07:00", dailyKeepAliveModel: "gpt-6-luna" };
    this.status = { status: "disabled", reason: "disabled", nextAt: null, lastAttemptAt: null };
    this.busy = null;
    this.stopped = false;
    this.lastProbe = 0;
    this.quotaObservations = [];
    this.observationNode = null;
    this.observationAccount = null;
    this.observationTime = null;
    // These are process-local proof of ownership, never reconstructed from a
    // journal after restart. Durable claims and creation reservations stay put.
    this.ownedNodeClaims = new Set();
    this.ownedThreadReservations = new Set();
  }
  publish(status, reason, nextAt = null, lastAttemptAt = null) {
    const value = { status, reason, nextAt, lastAttemptAt };
    if (JSON.stringify(value) !== JSON.stringify(this.status)) {
      this.status = value;
      this.onStatusChange();
    }
  }
  settingsChanged(settings) {
    const changed = this.settings.dailyKeepAlive !== (settings?.dailyKeepAlive === true)
      || this.settings.dailyKeepAliveStart !== normalizeDailyStart(settings?.dailyKeepAliveStart);
    this.settings = { dailyKeepAlive: settings?.dailyKeepAlive === true, dailyKeepAliveStart: normalizeDailyStart(settings?.dailyKeepAliveStart),
      dailyKeepAliveModel: normalizeDailyKeepAliveModel(settings?.dailyKeepAliveModel) };
    if (changed) this.quotaObservations = [];
    if (!this.settings.dailyKeepAlive) this.publish("disabled", "disabled");
    else if (!this.busy) this.lastProbe = 0;
  }
  tick() {
    if (this.busy) return this.busy;
    this.busy = this.run().catch(() => this.publish("error", "state-unavailable")).finally(() => { this.busy = null; });
    return this.busy;
  }
  quotaBaseline(quota, now, node, accountId) {
    if (this.observationNode !== node || this.observationAccount !== accountId
      || (this.observationTime != null && now < this.observationTime)) this.quotaObservations = [];
    this.observationNode = node;
    this.observationAccount = accountId;
    this.observationTime = now;
    if (!quota || quota.accountId !== accountId || typeof accountId !== "string" || !accountId.trim()) {
      this.quotaObservations = [];
      return null;
    }
    const validWindow = (window) => window && Number.isFinite(window.usedPercent) && window.usedPercent >= 0
      && window.usedPercent <= 100 && Number.isFinite(window.resetsAt) && window.resetsAt > 0;
    if (!Number.isFinite(quota.capturedAt) || quota.capturedAt > now + 5000 || now - quota.capturedAt > 90_000
      || quota.ordinaryUsageAllowed !== true || !validWindow(quota.fiveHour) || !validWindow(quota.weekly)) return null;
    const previous = this.quotaObservations.at(-1);
    if (previous && quota.capturedAt < previous.capturedAt) this.quotaObservations = [];
    else if (previous && quota.capturedAt === previous.capturedAt) return null;
    // A real active sample separates observations from before its window.
    // Otherwise a later zero, rounded down, could reuse older idle evidence.
    if (quota.fiveHour.usedPercent > 0 && quota.fiveHour.resetsAt > now) this.quotaObservations = [];
    this.quotaObservations = this.quotaObservations.filter((row) => quota.capturedAt - row.capturedAt <= 180_000);
    const baseline = this.quotaObservations.findLast((row) => quota.capturedAt - row.capturedAt >= 60_000) || null;
    this.quotaObservations.push(structuredClone(quota));
    this.quotaObservations = this.quotaObservations.slice(-8);
    return baseline;
  }
  async run() {
    if (this.stopped || !this.settings.dailyKeepAlive) return;
    if (this.store.error) return this.publish("error", "state-unavailable");
    let now = this.now();
    const start = this.settings.dailyKeepAliveStart;
    const model = this.settings.dailyKeepAliveModel;
    const nodes = dailyKeepAliveNodes(now, start);
    const node = nodes.findLast((at) => at <= now && now - at <= NODE_GRACE_MS);
    const next = nodes.find((at) => at > now) || null;
    const state = this.store.current;
    const pending = state.attempts.findLast((row) => ["submitted", "submitting", "uncertain"].includes(row.status) && now - row.attemptedAt < 5 * HOUR);
    if (node == null && !pending) return this.publish("waiting", "next-node", next);
    if (now >= this.lastProbe && now - this.lastProbe < 30_000) return;
    this.lastProbe = now;
    const context = await this.readContext(model);
    now = this.now();
    if (this.stopped || !this.settings.dailyKeepAlive || this.settings.dailyKeepAliveStart !== start || this.settings.dailyKeepAliveModel !== model) return;
    if (!context?.ok) {
      const reason = String(context?.reason || "");
      return this.publish("waiting", /model|effort/.test(reason) ? "model-unavailable"
        : /account/.test(reason) ? "account-unavailable" : "desktop-unavailable", next);
    }
    const quota = context.quota;
    if (pending) {
      // An intent left by a crash or a timeout is a permanent barrier for its
      // node. Never infer failure from a lost acknowledgement and resend it.
      if (pending.accountId !== context.accountId) return this.publish("uncertain", "account-unavailable", next, pending.attemptedAt);
      if (pending.status === "submitted" && pending.threadId && pending.turnId && this.readTurn) {
        const turn = await this.readTurn(pending);
        now = this.now();
        const confirmationQuota = turn && Object.hasOwn(turn, "quota") ? turn.quota : quota;
        const baseline = this.quotaBaseline(confirmationQuota, now, pending.node, context.accountId);
        if (turn?.ok && turn.accountId === pending.accountId && turn.threadId === pending.threadId && turn.turnId === pending.turnId
          && turn.status === "completed" && /^OK[.!。！]?$/i.test(String(turn.outputText || "").trim())
          && confirmationQuota?.accountId === pending.accountId && Number.isFinite(confirmationQuota.capturedAt) && confirmationQuota.capturedAt <= now + 5000
          && now - confirmationQuota.capturedAt <= 90_000 && confirmationQuota.ordinaryUsageAllowed === true
          && classifyKeepAliveWindow(confirmationQuota, now, baseline) === "active"
          && confirmationQuota.capturedAt >= pending.attemptedAt && confirmationQuota.fiveHour?.resetsAt > pending.attemptedAt + 4 * HOUR
          && confirmationQuota.fiveHour?.resetsAt <= pending.attemptedAt + 6 * HOUR) {
          pending.status = "confirmed";
          await this.store.save(state);
          return this.publish("confirmed", "confirmed", next, pending.attemptedAt);
        }
        return this.publish("submitted", "awaiting-confirmation", next, pending.attemptedAt);
      }
      return this.publish("uncertain", "uncertain", next, pending.attemptedAt);
    }
    if (node == null || now - node > NODE_GRACE_MS) return this.publish("waiting", "next-node", dailyKeepAliveNodes(now, start).find((at) => at > now));
    const key = digest(`${context.accountId}|${node}`);
    const existing = state.attempts.find((row) => row.key === key);
    const retryExisting = existing?.status === "skipped" && existing.reason === "preflight-retry" && this.ownedNodeClaims.has(key);
    if (existing?.reason === "preflight-retry" && !retryExisting) return this.publish("uncertain", "uncertain", next, existing.attemptedAt);
    if (existing && !retryExisting) return this.publish(existing.status === "submitting" || existing.reason === "preflight-retry" ? "uncertain" : existing.status,
      existing.status === "confirmed" ? "confirmed" : existing.reason || (existing.status === "skipped" ? "active-window" : "uncertain"), next, existing.attemptedAt);
    const quotaBaseline = this.quotaBaseline(quota, now, node, context.accountId);
    const reason = keepAliveQuotaReason(quota, now, quotaBaseline);
    if (reason === "active-window" && quota.fiveHour.resetsAt <= node + NODE_GRACE_MS) {
      return this.publish("waiting", "window-expiring", quota.fiveHour.resetsAt);
    }
    if (reason) return this.publish(reason === "active-window" ? "skipped" : "waiting", reason, next);
    if (context.accountId !== quota.accountId) return this.publish("waiting", "account-unavailable", next);
    let reuseThreadId = this.store.getThread ? await this.store.getThread(context.accountId) : null;
    // Upgrade from 3.2.0: only conversations previously submitted by this
    // monitor qualify. The transport still verifies their isolated workspace.
    if (!reuseThreadId) {
      reuseThreadId = state.attempts.findLast((item) => item.accountId === context.accountId
        && item.threadId && ["submitted", "confirmed"].includes(item.status))?.threadId;
      // Pin legacy identity even if later validation rejects that conversation.
      // Trimming old attempts must never silently switch a deleted/busy chat.
      if (reuseThreadId && this.store.rememberThread) await this.store.rememberThread(context.accountId, reuseThreadId);
    }
    if (!reuseThreadId && state.attempts.some((item) => item.accountId === context.accountId
      && ["submitting", "uncertain"].includes(item.status))) return this.publish("uncertain", "uncertain", next);
    const row = retryExisting ? existing : { key, eventId: key.slice(0, 32), node, accountId: context.accountId };
    Object.assign(row, { attemptedAt: now, model, status: "submitting", ...(reuseThreadId ? { reuseThreadId } : {}) });
    delete row.reason;
    state.attempts = state.attempts.filter((item) => item.key !== key && now - item.attemptedAt < 7 * 24 * HOUR).slice(-127);
    state.attempts.push(row);
    if (this.store.claim && !this.ownedNodeClaims.has(key)) {
      if (!await this.store.claim(row)) return this.publish("uncertain", "uncertain", next, now);
      this.ownedNodeClaims.add(key);
    }
    await this.store.save(state); // Durable intent, including fsync, precedes I/O.
    if (this.stopped || !this.settings.dailyKeepAlive || this.settings.dailyKeepAliveStart !== start || this.settings.dailyKeepAliveModel !== model
      || this.now() - node > NODE_GRACE_MS || keepAliveQuotaReason(quota, this.now(), quotaBaseline)) {
      row.status = "skipped"; await this.store.save(state); return;
    }
    this.publish("submitting", "submitted", next, now);
    const retryablePreflight = (result) => result?.ok === false && result.uncertain === false && result.retryable === true
      && result.reason === "keep-alive-usage-not-ready";
    const savePreflightRetry = async () => {
      row.status = "skipped";
      row.reason = "preflight-retry";
      await this.store.save(state);
      this.publish("waiting", "window-observing", next, now);
    };
    if (this.prepareThread) {
      if (!row.reuseThreadId && this.store.reserveThread && !this.ownedThreadReservations.has(row.accountId)) {
        if (!await this.store.reserveThread(row.accountId)) {
          row.status = "uncertain"; row.reason = "thread-unavailable";
          await this.store.save(state);
          return this.publish("uncertain", "thread-unavailable", next, now);
        }
        this.ownedThreadReservations.add(row.accountId);
      }
      let prepared;
      try { prepared = await this.prepareThread({ ...row, quotaBaseline }); } catch { prepared = { ok: false, uncertain: true }; }
      if (retryablePreflight(prepared)) return savePreflightRetry();
      if (!prepared?.ok || prepared.accountId !== row.accountId || (reuseThreadId && prepared.threadId !== reuseThreadId)) {
        row.status = prepared?.uncertain === false ? "skipped" : "uncertain";
        row.reason = "thread-unavailable";
        await this.store.save(state);
        return this.publish(row.status, "thread-unavailable", next, now);
      }
      // Persist the one dedicated conversation BEFORE any model submission.
      // Binding is a separate exclusive file, shared by overlapping backends.
      await this.store.rememberThread(row.accountId, prepared.threadId);
      this.ownedThreadReservations.delete(row.accountId);
      row.reuseThreadId = prepared.threadId;
      await this.store.save(state);
      if (this.stopped || !this.settings.dailyKeepAlive || this.settings.dailyKeepAliveStart !== start || this.settings.dailyKeepAliveModel !== model
        || this.now() - node > NODE_GRACE_MS || keepAliveQuotaReason(quota, this.now(), quotaBaseline)) {
        row.status = "skipped"; await this.store.save(state); return;
      }
    }
    let result;
    try { result = await this.sendKeepAlive({ ...row, quotaBaseline }); }
    catch { result = { ok: false, uncertain: true }; }
    if (retryablePreflight(result)) return savePreflightRetry();
    row.status = result?.ok ? "submitted" : result?.uncertain === false ? "skipped" : "uncertain";
    if (result?.ok) {
      if (row.reuseThreadId && row.reuseThreadId !== result.threadId) row.status = "uncertain";
      row.threadId = result.threadId; row.turnId = result.turnId;
      if (this.store.rememberThread && row.status === "submitted") await this.store.rememberThread(row.accountId, result.threadId);
    }
    await this.store.save(state);
    this.publish(row.status, row.status === "submitted" ? "submitted" : row.status === "skipped" ? "desktop-unavailable" : "uncertain", next, now);
  }
  async stop() { this.stopped = true; await this.busy; await this.store.flush(); }
}
