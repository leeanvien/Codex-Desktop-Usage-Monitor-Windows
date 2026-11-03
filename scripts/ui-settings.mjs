import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renameMonitorFileAtomic } from "./windows-files.mjs";
import { AUTO_RESUME_MESSAGE, normalizeAutoResumeMessage } from "./auto-resume.mjs";

export const UI_SETTINGS_SCHEMA_VERSION = 2;
export const UI_SETTINGS_FILE_NAME = "ui-settings.json";
// All 128 per-thread messages can contain 500 UTF-16 characters, including
// characters JSON escapes to six bytes. Keep the read/binding limit large
// enough to round-trip every settings object accepted by the normalizer.
export const MAX_UI_SETTINGS_BYTES = 512 * 1024;

const SOURCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
const METRIC_ID_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_FIELDS = ["apiKeyMetricsVersion", "officialMetricsVersion", "unifiedMetricsVersion"];
const BOOLEAN_FIELDS = ["minimalMode", "countdownVisualization", "refreshEvery30Seconds", "englishUi", "updateNotifications", "autoResume", "autoResumeSharedMessage"];

export const normalizeDailyKeepAliveStart = (value) => typeof value === "string" && value.length === 5 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
  ? value : "07:00";
export const normalizeDailyKeepAliveModel = (value) => typeof value === "string" && value === value.trim() && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value)
  ? value : "gpt-6-luna";

const safeVersion = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0
  ? Math.min(1000, Number(value))
  : 0;

export function normalizeUiSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metrics = {};
  if (value.metrics && typeof value.metrics === "object" && !Array.isArray(value.metrics)) {
    for (const [sourceId, ids] of Object.entries(value.metrics).slice(0, 16)) {
      if (!SOURCE_ID_PATTERN.test(sourceId) || sourceId === "quota-token" || !Array.isArray(ids)) continue;
      metrics[sourceId] = [...new Set(ids
        .filter((id) => typeof id === "string" && METRIC_ID_PATTERN.test(id))
        .map((id) => ["session", "official"].includes(sourceId) && id === "currentStatus" ? "executionTime" : id))]
        .slice(0, 14);
    }
  }
  const metricOrder = Array.isArray(value.metricOrder)
    ? [...new Set(value.metricOrder.filter((key) => {
        if (typeof key !== "string" || key.length > 82) return false;
        const separator = key.indexOf(":");
        if (separator <= 0 || separator !== key.lastIndexOf(":")) return false;
        return key.slice(0, separator) !== "quota-token"
          && SOURCE_ID_PATTERN.test(key.slice(0, separator)) && METRIC_ID_PATTERN.test(key.slice(separator + 1));
      }).map((key) => key.replace(/^(session|official):currentStatus$/, "$1:executionTime")))].slice(0, 64)
    : [];
  const normalized = { schemaVersion: UI_SETTINGS_SCHEMA_VERSION, metrics, metricOrder };
  for (const field of VERSION_FIELDS) normalized[field] = safeVersion(value[field]);
  for (const field of BOOLEAN_FIELDS) normalized[field] = Boolean(value[field]);
  normalized.dailyKeepAlive = value.dailyKeepAlive === true;
  normalized.dailyKeepAliveStart = normalizeDailyKeepAliveStart(value.dailyKeepAliveStart);
  normalized.dailyKeepAliveModel = normalizeDailyKeepAliveModel(value.dailyKeepAliveModel);
  // Preserve the optional API-column layout for existing settings files. A genuinely
  // new installation has no settings object and the renderer starts with the
  // optional API columns hidden until the user enables them.
  normalized.showApiColumns = Object.prototype.hasOwnProperty.call(value, "showApiColumns")
    ? Boolean(value.showApiColumns)
    : true;
  normalized.showResetForecast = Object.prototype.hasOwnProperty.call(value, "showResetForecast")
    ? Boolean(value.showResetForecast)
    : true;
  normalized.autoResumeMessage = normalizeAutoResumeMessage(value.autoResumeMessage, AUTO_RESUME_MESSAGE);
  normalized.autoResumeThreads = {};
  if (value.autoResumeThreads && typeof value.autoResumeThreads === "object" && !Array.isArray(value.autoResumeThreads)) {
    for (const [threadId, config] of Object.entries(value.autoResumeThreads).slice(0, 128)) {
      const normalizedThreadId = String(threadId).toLowerCase();
      if (!THREAD_ID_PATTERN.test(normalizedThreadId) || !config || typeof config !== "object" || Array.isArray(config)) continue;
      normalized.autoResumeThreads[normalizedThreadId] = {
        enabled: config.enabled === true,
        message: normalizeAutoResumeMessage(config.message, AUTO_RESUME_MESSAGE),
      };
    }
  }
  return normalized;
}

export function resolveUiSettingsPath(environment = process.env) {
  if (environment.CODEX_USAGE_UI_SETTINGS_PATH) return path.resolve(environment.CODEX_USAGE_UI_SETTINGS_PATH);
  // AppData can be virtualized differently inside a Store Codex process and a
  // normal desktop launcher. Keep user preferences outside that boundary.
  if (environment.USERPROFILE) return path.join(environment.USERPROFILE, ".codex-usage-monitor", UI_SETTINGS_FILE_NAME);
  if (!environment.LOCALAPPDATA) throw new Error("USERPROFILE and LOCALAPPDATA are unavailable; cannot persist monitor UI settings.");
  return path.join(environment.LOCALAPPDATA, "CodexUsageMonitor", UI_SETTINGS_FILE_NAME);
}

export async function readUiSettingsFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_UI_SETTINGS_BYTES) return null;
    return normalizeUiSettings(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "SyntaxError"].includes(error?.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export { renameMonitorFileAtomic as renameUiSettingsAtomic };

export async function writeUiSettingsFile(filePath, value) {
  const normalized = normalizeUiSettings(value);
  if (!normalized) throw new TypeError("Invalid monitor UI settings payload.");
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await renameMonitorFileAtomic(temporaryPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return normalized;
}

export async function createUiSettingsStore(filePath, { environment = process.env } = {}) {
  const isDefaultPath = filePath === undefined && !environment.CODEX_USAGE_UI_SETTINGS_PATH;
  if (filePath === undefined) filePath = resolveUiSettingsPath(environment);
  let current;
  if (isDefaultPath) {
    let missing = false;
    try { await fs.stat(filePath); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing = true;
    }
    if (!missing) {
      current = await readUiSettingsFile(filePath);
      // Never turn an invalid authoritative file into defaults or overwrite it
      // with a stale pre-migration copy. Leave it available for recovery.
      if (!current) throw new Error(`Existing monitor UI settings are invalid: ${filePath}. The file has been preserved; restore or repair it before starting the monitor.`);
    } else {
      const legacyPath = environment.LOCALAPPDATA
        ? path.join(environment.LOCALAPPDATA, "CodexUsageMonitor", UI_SETTINGS_FILE_NAME)
        : null;
      current = legacyPath && path.resolve(legacyPath) !== path.resolve(filePath)
        ? await readUiSettingsFile(legacyPath) : null;
      // Complete the migration before exposing settings to the renderer. Only
      // UI preferences cross this boundary; credentials and other state stay put.
      if (current) current = await writeUiSettingsFile(filePath, current);
    }
  } else {
    // Explicit file paths retain their isolated test/custom-storage behavior.
    current = await readUiSettingsFile(filePath);
  }
  let serialized = current ? JSON.stringify(current) : null;
  let pending = Promise.resolve();
  return {
    filePath,
    get current() { return current; },
    save(value) {
      const normalized = normalizeUiSettings(value);
      if (!normalized) return Promise.reject(new TypeError("Invalid monitor UI settings payload."));
      const nextSerialized = JSON.stringify(normalized);
      if (nextSerialized === serialized) return pending;
      current = normalized;
      serialized = nextSerialized;
      const write = pending.catch(() => {}).then(() => writeUiSettingsFile(filePath, normalized)).catch((error) => {
        // A failed attempt is not a persisted value. Let the same settings be
        // retried after a transient filesystem error, without invalidating a
        // newer save already queued behind this one.
        if (pending === write) serialized = null;
        throw error;
      });
      pending = write;
      return write;
    },
    flush() { return pending; },
  };
}
