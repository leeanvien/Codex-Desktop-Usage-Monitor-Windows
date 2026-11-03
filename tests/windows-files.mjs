import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { renameMonitorFileAtomic, renameMonitorFileAtomicSync } from "../scripts/windows-files.mjs";
import { LocalCodexTokenTracker } from "../scripts/usage-client.mjs";
import { UsageHistory } from "../scripts/usage/history.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-monitor-atomic-sync-"));
const source = path.join(root, "alias", "state.tmp");
const destination = path.join(root, "alias", "state.json");
const physicalSource = path.join(root, "physical", "state.tmp");
const physicalDestination = path.join(root, "physical", "state.json");
const failure = (code) => Object.assign(new Error(code), { code });
try {
  const normal = [];
  renameMonitorFileAtomicSync(source, destination, {
    rename: (...args) => normal.push(args),
    realpath: () => assert.fail("successful renames must not resolve aliases"),
  });
  assert.deepEqual(normal, [[source, destination]]);
  for (const exists of [true, false]) {
    const calls = [];
    renameMonitorFileAtomicSync(source, destination, {
      rename: (...args) => { calls.push(args); if (calls.length === 1) throw failure("EXDEV"); },
      realpath: (file) => {
        if (file === source) return physicalSource;
        assert.equal(file, destination);
        if (!exists) throw failure("ENOENT");
        return physicalDestination;
      },
    });
    assert.deepEqual(calls, [[source, destination], [physicalSource, physicalDestination]]);
  }
  for (const code of ["EACCES", "EPERM", "ENOENT", "EIO"]) {
    const error = failure(code);
    assert.throws(() => renameMonitorFileAtomicSync(source, destination, {
      rename: () => { throw error; },
      realpath: () => assert.fail("only EXDEV may resolve aliases"),
    }), (value) => value === error);
  }
  for (const failed of [source, destination]) {
    const error = failure("EACCES");
    assert.throws(() => renameMonitorFileAtomicSync(source, destination, {
      rename: () => { throw failure("EXDEV"); },
      realpath: (file) => { if (file === failed) throw error; return physicalSource; },
    }), (value) => value === error);
  }
  assert.throws(() => renameMonitorFileAtomicSync(source, path.join(root, "elsewhere", "state.json"), {
    rename: () => { throw failure("EXDEV"); },
    realpath: (file) => { if (file === source) return physicalSource; throw failure("ENOENT"); },
  }), { code: "ENOENT" });
  let attempts = 0;
  assert.throws(() => renameMonitorFileAtomicSync(source, destination, {
    rename: () => { attempts += 1; throw failure("EXDEV"); },
    realpath: (file) => file === source ? physicalSource : physicalDestination,
  }), { code: "EXDEV" });
  assert.equal(attempts, 2, "genuine cross-volume moves remain failures");

  // A real preexisting C: file must be shadowed in the same verified MSIX
  // overlay as the new D: temporary file. Never generalize that exception to
  // another application, another requested directory, or another state root.
  const localAppData = "C:\\Users\\fixture\\AppData\\Local";
  const alias = `${localAppData}\\CodexUsageMonitor\\counter.json`;
  const mirror = "D:\\WpSystem\\fixture\\AppData\\Local\\Packages\\OpenAI.Codex_test\\LocalCache\\Local\\CodexUsageMonitor\\counter.json";
  for (const operation of [renameMonitorFileAtomicSync, renameMonitorFileAtomic]) {
    for (const allowed of [true, false]) {
      const calls = [];
      const physical = allowed ? mirror : mirror.replace("OpenAI.Codex_", "AnotherApp_");
      await operation(`${alias}.tmp`, alias, {
        localAppData,
        rename: (...args) => { calls.push(args); if (calls.length === 1) throw failure("EXDEV"); },
        realpath: (file) => file === `${alias}.tmp` ? `${physical}.tmp` : alias,
      });
      assert.deepEqual(calls[1], [`${physical}.tmp`, allowed ? mirror : alias]);
    }
    const calls = [];
    await operation(`${alias}.tmp`, alias, {
      localAppData: "C:\\Users\\another\\AppData\\Local",
      rename: (...args) => { calls.push(args); if (calls.length === 1) throw failure("EXDEV"); },
      realpath: (file) => file === `${alias}.tmp` ? `${mirror}.tmp` : alias,
    });
    assert.deepEqual(calls[1], [`${mirror}.tmp`, alias], "another user's alias cannot use the overlay exception");
  }

  // Exercise the real counter/history writers when their first atomic rename
  // reports the Store alias error. No Codex or account connection is used.
  const originalRename = fs.renameSync;
  const retried = new Set();
  let fallbackCount = 0;
  fs.renameSync = (from, to) => {
    if (from.startsWith(root) && !retried.has(from)) {
      retried.add(from); fallbackCount += 1; throw failure("EXDEV");
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const now = Date.now();
    const historyPath = path.join(root, "history.json");
    fs.writeFileSync(historyPath, JSON.stringify({ schemaVersion: 1, tokenBuckets: [], seen: [], quotaSamples: [] }));
    const history = new UsageHistory({ filePath: historyPath, now: () => now });
    history.recordToken({ timestamp: now, tokens: 9 }, "maintenance-fixture");
    history.flush(true);
    assert.equal(history.error, null);
    assert.equal(JSON.parse(fs.readFileSync(historyPath, "utf8")).tokenBuckets[0].totalTokens, 9);
    assert.equal(fs.existsSync(`${historyPath}.${process.pid}.tmp`), false);

    const sessionRoot = path.join(root, "sessions");
    fs.mkdirSync(sessionRoot);
    const counterPath = path.join(root, "counter.json");
    const tracker = new LocalCodexTokenTracker({ sessionRoot, counterPath, now: () => now });
    await tracker.refresh();
    tracker.saveCounter(now);
    assert.equal(JSON.parse(fs.readFileSync(counterPath, "utf8")).schemaVersion, 8);
    assert.equal(fs.existsSync(`${counterPath}.${process.pid}.tmp`), false);
    assert.equal(fallbackCount, 2, "both real writers recover from EXDEV");
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("PASS: synchronous atomic persistence, Store alias recovery, error boundaries, token counters and history.");
