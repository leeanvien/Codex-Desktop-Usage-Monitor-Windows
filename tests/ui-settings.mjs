import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createUiSettingsStore,
  MAX_UI_SETTINGS_BYTES,
  normalizeDailyKeepAliveModel,
  normalizeDailyKeepAliveStart,
  normalizeUiSettings,
  readUiSettingsFile,
  renameUiSettingsAtomic,
  resolveUiSettingsPath,
  writeUiSettingsFile,
} from "../scripts/ui-settings.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-ui-settings-"));
const settingsPath = path.join(root, "state", "ui-settings.json");
const threadId = "019fb3b1-2638-7bb0-9a90-ec83b5bca0f2";
try {
  const virtualSource = path.join(root, "virtual", "ui-settings.json.probe.tmp");
  const virtualDestination = path.join(root, "virtual", "ui-settings.json");
  const physicalSource = path.join(root, "physical", "ui-settings.json.probe.tmp");
  const physicalDestination = path.join(root, "physical", "ui-settings.json");
  const renameError = (code) => Object.assign(new Error(code), { code });
  {
    let resolved = false;
    const renamed = [];
    await renameUiSettingsAtomic(virtualSource, virtualDestination, {
      rename: async (...args) => { renamed.push(args); },
      realpath: async () => { resolved = true; throw new Error("unneeded resolution"); },
    });
    assert.deepEqual(renamed, [[virtualSource, virtualDestination]]);
    assert.equal(resolved, false, "ordinary atomic renames keep their existing behavior");
  }
  for (const existingDestination of [true, false]) {
    const renamed = [];
    const resolved = [];
    await renameUiSettingsAtomic(virtualSource, virtualDestination, {
      rename: async (...args) => {
        renamed.push(args);
        if (renamed.length === 1) throw renameError("EXDEV");
      },
      realpath: async (filePath) => {
        resolved.push(filePath);
        if (filePath === virtualSource) return physicalSource;
        assert.equal(filePath, virtualDestination);
        if (!existingDestination) throw renameError("ENOENT");
        return physicalDestination;
      },
    });
    assert.deepEqual(renamed, [[virtualSource, virtualDestination], [physicalSource, physicalDestination]],
      existingDestination ? "virtualized existing settings are replaced atomically by real paths"
        : "first creation derives the missing destination only within the source's requested directory");
    assert.deepEqual(resolved, [virtualSource, virtualDestination]);
  }
  for (const code of ["EACCES", "EPERM", "ENOENT", "EIO"]) {
    const failure = renameError(code);
    let attempts = 0;
    await assert.rejects(renameUiSettingsAtomic(virtualSource, virtualDestination, {
      rename: async () => { attempts += 1; throw failure; },
      realpath: async () => { throw new Error("non-EXDEV errors must not fall back"); },
    }), (error) => error === failure);
    assert.equal(attempts, 1);
  }
  for (const failingPath of [virtualSource, virtualDestination]) {
    const failure = renameError("EACCES");
    let attempts = 0;
    await assert.rejects(renameUiSettingsAtomic(virtualSource, virtualDestination, {
      rename: async () => { attempts += 1; throw renameError("EXDEV"); },
      realpath: async (filePath) => {
        if (filePath === failingPath) throw failure;
        return physicalSource;
      },
    }), (error) => error === failure, "realpath failures remain visible and never trigger a non-atomic write");
    assert.equal(attempts, 1);
  }
  {
    const missingDestination = renameError("ENOENT");
    let attempts = 0;
    await assert.rejects(renameUiSettingsAtomic(virtualSource, path.join(root, "different", "ui-settings.json"), {
      rename: async () => { attempts += 1; throw renameError("EXDEV"); },
      realpath: async (filePath) => {
        if (filePath === virtualSource) return physicalSource;
        throw missingDestination;
      },
    }), (error) => error === missingDestination, "a missing target in a different requested directory is never guessed");
    assert.equal(attempts, 1);
  }
  {
    const crossVolumeError = renameError("EXDEV");
    const renamed = [];
    await assert.rejects(renameUiSettingsAtomic(virtualSource, virtualDestination, {
      rename: async (...args) => {
        renamed.push(args);
        throw renamed.length === 1 ? renameError("EXDEV") : crossVolumeError;
      },
      realpath: async (filePath) => filePath === virtualSource ? physicalSource : physicalDestination,
    }), (error) => error === crossVolumeError, "a genuine cross-volume failure remains a failure after the single atomic retry");
    assert.deepEqual(renamed, [[virtualSource, virtualDestination], [physicalSource, physicalDestination]]);
  }
  assert.equal(resolveUiSettingsPath({ CODEX_USAGE_UI_SETTINGS_PATH: settingsPath }), settingsPath);
  assert.equal(resolveUiSettingsPath({ USERPROFILE: root, LOCALAPPDATA: path.join(root, "virtual-appdata") }),
    path.join(root, ".codex-usage-monitor", "ui-settings.json"));
  assert.equal(resolveUiSettingsPath({ CODEX_USAGE_UI_SETTINGS_PATH: settingsPath, USERPROFILE: root }), settingsPath);
  assert.equal(resolveUiSettingsPath({ LOCALAPPDATA: root }), path.join(root, "CodexUsageMonitor", "ui-settings.json"));
  assert.throws(() => resolveUiSettingsPath({}), /USERPROFILE and LOCALAPPDATA/);
  assert.equal(normalizeUiSettings(null), null);
  assert.equal(normalizeUiSettings({}).dailyKeepAlive, false);
  assert.equal(normalizeUiSettings({}).dailyKeepAliveStart, "07:00");
  assert.equal(normalizeUiSettings({}).dailyKeepAliveModel, "gpt-6-luna", "existing schedules migrate to the previous model");
  for (const value of [null, false, 42, "", " gpt-6-luna", "gpt-6-luna\n", "model name", "模型", "model/id", "<script>", "x".repeat(101)]) {
    assert.equal(normalizeDailyKeepAliveModel(value), "gpt-6-luna");
    assert.equal(normalizeUiSettings({ dailyKeepAliveModel: value }).dailyKeepAliveModel, "gpt-6-luna");
  }
  for (const value of ["gpt-6-luna", "gpt-6.1-sol", "custom_model:v2", "A", "x".repeat(100)]) {
    assert.equal(normalizeDailyKeepAliveModel(value), value);
    assert.equal(normalizeUiSettings({ dailyKeepAliveModel: value }).dailyKeepAliveModel, value);
  }
  for (const value of [false, 1, "true", "false", null]) {
    assert.equal(normalizeUiSettings({ dailyKeepAlive: value }).dailyKeepAlive, false, "keep-alive requires an explicit boolean opt-in");
  }
  for (const value of [null, "7:00", "24:00", "07:60", "07:00\n", 700, "not-a-time"]) {
    assert.equal(normalizeDailyKeepAliveStart(value), "07:00");
  }
  for (const value of ["00:00", "07:00", "13:48", "23:59"]) {
    assert.equal(normalizeDailyKeepAliveStart(value), value);
  }
  const migratedDuration = normalizeUiSettings({
    metrics: { session: ["currentStatus", "autoResume", "executionTime"], official: ["currentStatus"] },
    metricOrder: ["session:currentStatus", "session:autoResume", "session:executionTime", "official:currentStatus"],
  });
  assert.deepEqual(migratedDuration.metrics.session, ["executionTime", "autoResume"]);
  assert.deepEqual(migratedDuration.metrics.official, ["executionTime"]);
  assert.deepEqual(migratedDuration.metricOrder, ["session:executionTime", "session:autoResume", "official:executionTime"]);
  assert.deepEqual(normalizeUiSettings(migratedDuration), migratedDuration, "duration selection migration is idempotent");
  assert.deepEqual(normalizeUiSettings({
    metrics: {
      official: ["secondaryRemaining", "currentTaskTokens", "secondaryRemaining", "bad metric"],
      "../unsafe": ["todayTokens"],
    },
    apiKeyMetricsVersion: -1,
    officialMetricsVersion: 2,
    unifiedMetricsVersion: 1,
    minimalMode: true,
    countdownVisualization: false,
    refreshEvery30Seconds: false,
    englishUi: true,
    updateNotifications: false,
    metricOrder: ["official:secondaryRemaining", "bad", "official:secondaryRemaining", "api-account:balance"],
    secret: "must-not-persist",
  }), {
    schemaVersion: 2,
    metrics: { official: ["secondaryRemaining", "currentTaskTokens"] },
    metricOrder: ["official:secondaryRemaining", "api-account:balance"],
    apiKeyMetricsVersion: 0,
    officialMetricsVersion: 2,
    unifiedMetricsVersion: 1,
    minimalMode: true,
    countdownVisualization: false,
    refreshEvery30Seconds: false,
    englishUi: true,
    updateNotifications: false,
    autoResume: false,
    autoResumeSharedMessage: false,
    dailyKeepAlive: false,
    dailyKeepAliveStart: "07:00",
    dailyKeepAliveModel: "gpt-6-luna",
    showApiColumns: true,
    showResetForecast: true,
    autoResumeMessage: "继续",
    autoResumeThreads: {},
  });

  const first = await createUiSettingsStore(settingsPath);
  assert.equal(first.current, null);
  await first.save({
    metrics: { official: ["secondaryRemaining", "currentTaskTokens"], "api-account": [], "quota-token": ["wholeEstimateTokens"] },
    unifiedMetricsVersion: 1,
    minimalMode: false,
    countdownVisualization: true,
    refreshEvery30Seconds: true,
    englishUi: false,
    updateNotifications: true,
    autoResume: true,
    dailyKeepAlive: true,
    dailyKeepAliveStart: "13:48",
    dailyKeepAliveModel: "gpt-6.1-sol",
    showApiColumns: false,
    showResetForecast: false,
    showQuotaToken: false,
    metricOrder: ["official:secondaryRemaining", "quota-token:wholeEstimateTokens", "api-account:balance"],
    autoResumeMessage: "请继续完成当前任务",
    autoResumeThreads: { [threadId]: { enabled: true, message: "请继续完成当前任务" }, invalid: { enabled: true, message: "bad" } },
  });
  await first.flush();

  const restarted = await createUiSettingsStore(settingsPath);
  assert.deepEqual(restarted.current.metrics, {
    official: ["secondaryRemaining", "currentTaskTokens"],
    "api-account": [],
  });
  assert.equal(restarted.current.countdownVisualization, true);
  assert.equal(restarted.current.refreshEvery30Seconds, true);
  assert.equal(restarted.current.updateNotifications, true);
  assert.equal(restarted.current.autoResume, true);
  assert.equal(restarted.current.dailyKeepAlive, true);
  assert.equal(restarted.current.dailyKeepAliveStart, "13:48");
  assert.equal(restarted.current.dailyKeepAliveModel, "gpt-6.1-sol", "the selected model survives monitor restarts");
  assert.equal(restarted.current.showApiColumns, false);
  assert.equal(restarted.current.showResetForecast, false);
  assert.equal(Object.hasOwn(restarted.current, "showQuotaToken"), false, "the retired feature switch is dropped while loading old settings");
  assert.deepEqual(restarted.current.metricOrder, ["official:secondaryRemaining", "api-account:balance"]);
  assert.equal(restarted.current.autoResumeMessage, "请继续完成当前任务");
  await restarted.save({ ...restarted.current, autoResumeSharedMessage: true });
  assert.equal((await createUiSettingsStore(settingsPath)).current.autoResumeSharedMessage, true);
  assert.deepEqual(restarted.current.autoResumeThreads, { [threadId]: { enabled: true, message: "请继续完成当前任务" } });
  assert.equal(normalizeUiSettings({ autoResumeMessage: "\n" }).autoResumeMessage, "继续");
  assert.equal(normalizeUiSettings({ autoResumeMessage: "x".repeat(501) }).autoResumeMessage, "继续");
  assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).secret, undefined);

  // Simulate the two actual Windows launch contexts using distinct AppData roots
  // and one user profile. Only settings, never credentials or runtime state, move.
  const profile = path.join(root, "shared-user");
  const packagedEnvironment = { USERPROFILE: profile, LOCALAPPDATA: path.join(root, "store-appdata") };
  const desktopEnvironment = { USERPROFILE: profile, LOCALAPPDATA: path.join(root, "desktop-appdata") };
  const canonicalPath = resolveUiSettingsPath(packagedEnvironment);
  const legacyPath = path.join(packagedEnvironment.LOCALAPPDATA, "CodexUsageMonitor", "ui-settings.json");
  const desktopLegacyPath = path.join(desktopEnvironment.LOCALAPPDATA, "CodexUsageMonitor", "ui-settings.json");
  const migrationValue = normalizeUiSettings({
    ...restarted.current,
    metrics: { official: ["secondaryRemaining", "primaryRemaining", "resetAt"], session: ["autoResume"] },
    metricOrder: ["official:secondaryRemaining", "official:primaryRemaining", "official:resetAt", "session:autoResume"],
    apiKeyMetricsVersion: 4,
    officialMetricsVersion: 3,
    unifiedMetricsVersion: 2,
    minimalMode: true,
    englishUi: true,
    autoResumeSharedMessage: true,
    dailyKeepAliveStart: "05:30",
    dailyKeepAliveModel: "gpt-5.6-luna",
  });
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  const originalLegacyText = JSON.stringify({ ...migrationValue, secret: "must-not-migrate" });
  await fs.writeFile(legacyPath, originalLegacyText);
  await fs.writeFile(path.join(path.dirname(legacyPath), "unrelated-test-secret.dpapi"), "fixture-only");
  const migratedStore = await createUiSettingsStore(undefined, { environment: packagedEnvironment });
  assert.equal(migratedStore.filePath, canonicalPath);
  assert.deepEqual(migratedStore.current, migrationValue, "first migration preserves the complete settings schema");
  assert.deepEqual(await readUiSettingsFile(canonicalPath), migrationValue, "migration is persisted before use");
  assert.equal(await fs.readFile(legacyPath, "utf8"), originalLegacyText, "the legacy copy remains unchanged");
  assert.deepEqual(await fs.readdir(path.dirname(canonicalPath)), ["ui-settings.json"], "only UI settings migrate");
  assert.equal(JSON.parse(await fs.readFile(canonicalPath, "utf8")).secret, undefined);

  const latestValue = normalizeUiSettings({ ...migrationValue, minimalMode: false, dailyKeepAliveStart: "06:35" });
  await migratedStore.save(latestValue);
  await writeUiSettingsFile(legacyPath, { dailyKeepAlive: false });
  await writeUiSettingsFile(desktopLegacyPath, { dailyKeepAlive: false, englishUi: false });
  const desktopRestart = await createUiSettingsStore(undefined, { environment: desktopEnvironment });
  assert.deepEqual(desktopRestart.current, latestValue, "an existing authoritative file always wins over either legacy copy");
  assert.deepEqual((await createUiSettingsStore(undefined, { environment: packagedEnvironment })).current, latestValue,
    "migration is not repeated after a restart");

  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../scripts/ui-settings.mjs")).href;
  const runIsolatedStore = (environment, replacement) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import { createUiSettingsStore } from ${JSON.stringify(moduleUrl)};
    const store = await createUiSettingsStore(undefined, { environment: ${JSON.stringify(environment)} });
    const replacement = ${JSON.stringify(replacement ?? null)};
    if (replacement) await store.save(replacement);
    await store.flush();
    console.log(JSON.stringify({ filePath: store.filePath, settings: store.current }));
  `], { encoding: "utf8", windowsHide: true }));
  const childValue = normalizeUiSettings({ ...latestValue, countdownVisualization: false, dailyKeepAliveModel: "gpt-6.1-sol" });
  assert.deepEqual(runIsolatedStore(packagedEnvironment, childValue), { filePath: canonicalPath, settings: childValue });
  assert.deepEqual(runIsolatedStore(desktopEnvironment), { filePath: canonicalPath, settings: childValue },
    "a separate process with different AppData restores every setting from the shared profile");

  const isolatedPath = path.join(root, "explicit-file", "ui-settings.json");
  const isolatedStore = await createUiSettingsStore(isolatedPath, { environment: packagedEnvironment });
  assert.equal(isolatedStore.current, null, "an explicit file path never imports environment settings");
  await assert.rejects(fs.stat(isolatedPath), { code: "ENOENT" });
  const overridePath = path.join(root, "explicit-environment", "ui-settings.json");
  const overrideStore = await createUiSettingsStore(undefined, {
    environment: { ...packagedEnvironment, CODEX_USAGE_UI_SETTINGS_PATH: overridePath },
  });
  assert.equal(overrideStore.filePath, overridePath);
  assert.equal(overrideStore.current, null, "an environment override never imports legacy or canonical settings");
  await overrideStore.save({ dailyKeepAliveStart: "11:20" });
  assert.deepEqual(await readUiSettingsFile(canonicalPath), childValue);

  for (const invalidText of ["not-json", "[]", "null", "", " ".repeat(MAX_UI_SETTINGS_BYTES + 1)]) {
    await fs.writeFile(canonicalPath, invalidText);
    await assert.rejects(createUiSettingsStore(undefined, { environment: packagedEnvironment }), /Existing monitor UI settings are invalid/);
    assert.equal(await fs.readFile(canonicalPath, "utf8"), invalidText,
      "invalid authoritative settings are preserved rather than replaced by stale legacy data or defaults");
  }
  const invalidLegacyEnvironment = {
    USERPROFILE: path.join(root, "invalid-legacy-user"), LOCALAPPDATA: path.join(root, "invalid-legacy-appdata"),
  };
  const invalidLegacyPath = path.join(invalidLegacyEnvironment.LOCALAPPDATA, "CodexUsageMonitor", "ui-settings.json");
  await fs.mkdir(path.dirname(invalidLegacyPath), { recursive: true });
  await fs.writeFile(invalidLegacyPath, "not-json");
  assert.equal((await createUiSettingsStore(undefined, { environment: invalidLegacyEnvironment })).current, null);
  await assert.rejects(fs.stat(resolveUiSettingsPath(invalidLegacyEnvironment)), { code: "ENOENT" });

  const syncPath = path.join(root, "atomic-sync", "ui-settings.json");
  const syncStore = await createUiSettingsStore(syncPath);
  const originalSyncValue = normalizeUiSettings({ dailyKeepAliveStart: "09:15" });
  await syncStore.save(originalSyncValue);
  const originalOpen = fs.open;
  const originalRename = fs.rename;
  const syncFailure = Object.assign(new Error("injected settings sync failure"), { code: "EIO" });
  const replacementValue = normalizeUiSettings({ ...originalSyncValue, dailyKeepAliveStart: "10:30" });
  try {
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(`${syncPath}.`)) handle.sync = async () => { throw syncFailure; };
      return handle;
    };
    await assert.rejects(syncStore.save(replacementValue), (error) => error === syncFailure);
    assert.deepEqual(await readUiSettingsFile(syncPath), originalSyncValue, "sync failure preserves the prior complete settings");
    assert.deepEqual(await fs.readdir(path.dirname(syncPath)), ["ui-settings.json"], "failed writes leave no temporary files");
    const operations = [];
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(`${syncPath}.`)) {
        const sync = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        handle.sync = async () => { await sync(); operations.push("synced"); };
        handle.close = async () => { await close(); operations.push("closed"); };
      }
      return handle;
    };
    fs.rename = async (...args) => {
      if (args[1] === syncPath) assert.deepEqual(operations, ["synced", "closed"], "durable content is closed before atomic replacement");
      return originalRename(...args);
    };
    await syncStore.save(replacementValue);
    assert.deepEqual(await readUiSettingsFile(syncPath), replacementValue, "the identical save retries after a sync failure");
  } finally {
    fs.open = originalOpen;
    fs.rename = originalRename;
  }

  await fs.writeFile(settingsPath, "not-json", "utf8");
  assert.equal(await readUiSettingsFile(settingsPath), null);

  const blockedDirectory = path.join(root, "blocked");
  await fs.writeFile(blockedDirectory, "temporarily unavailable directory");
  const retryPath = path.join(blockedDirectory, "ui-settings.json");
  const retryStore = await createUiSettingsStore(retryPath);
  const retryValue = { englishUi: true };
  await assert.rejects(retryStore.save(retryValue));
  await fs.unlink(blockedDirectory);
  await fs.mkdir(blockedDirectory);
  await retryStore.save(retryValue);
  assert.equal((await readUiSettingsFile(retryPath)).englishUi, true,
    "an identical save retries after a transient persistence failure");
  await Promise.all([retryStore.save({ englishUi: false }), retryStore.save({ englishUi: true })]);
  assert.equal((await readUiSettingsFile(retryPath)).englishUi, true,
    "queued saves still persist the newest settings");

  // Exercise both ordinary Chinese and the longest possible JSON encoding of
  // a valid 500-character message, rather than relying on ASCII fixtures.
  for (const message of ["继".repeat(500), "\ud800".repeat(500)]) {
    const autoResumeThreads = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [
      `019fb3b1-2638-7bb0-9a90-${String(index).padStart(12, "0")}`,
      { enabled: true, message },
    ]));
    const largeSettings = normalizeUiSettings({ autoResumeThreads, autoResumeMessage: message });
    assert.ok(Buffer.byteLength(JSON.stringify(largeSettings, null, 2), "utf8") <= MAX_UI_SETTINGS_BYTES);
    await writeUiSettingsFile(settingsPath, largeSettings);
    assert.deepEqual(await readUiSettingsFile(settingsPath), largeSettings,
      "every accepted per-thread message survives a restart at maximum capacity");
  }
  await fs.writeFile(settingsPath, " ".repeat(MAX_UI_SETTINGS_BYTES + 1));
  assert.equal(await readUiSettingsFile(settingsPath), null, "oversized input is still rejected");
  console.log("PASS: monitor-owned UI settings validation, atomic persistence, and restart recovery.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
