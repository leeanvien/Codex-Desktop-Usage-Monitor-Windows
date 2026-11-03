import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DailyKeepAliveController,
  NODE_GRACE_MS,
  createDailyKeepAliveStore,
  dailyKeepAliveNodes,
  keepAliveQuotaReason,
  normalizeDailyStart,
} from "../scripts/daily-keepalive.mjs";

// Fixtures only: none of these callbacks connect to Codex or submit a real turn.
const HOUR = 3_600_000;
const START = new Date(2026, 9, 17, 7, 0).getTime();
const THREAD_ID = "019fb3b1-2638-7bb0-9a90-ec83b5bca0f2";
const TURN_ID = "019fb3b1-2638-7bb0-9a90-ec83b5bca0f3";
const OTHER_ID = "019fb3b1-2638-7bb0-9a90-ec83b5bca0f4";
const SETTINGS = { dailyKeepAlive: true, dailyKeepAliveStart: "07:00" };

function quota(now = START, changes = {}) {
  return {
    accountId: "fixture-account", capturedAt: now, ordinaryUsageAllowed: true,
    activeFiveHour: false,
    fiveHour: { usedPercent: 0, resetsAt: now - 1 },
    weekly: { usedPercent: 25, resetsAt: now + 7 * 24 * HOUR },
    ...changes,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-daily-keepalive-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = options.file ?? path.join(directory, "state.json");
  const store = options.store ?? await createDailyKeepAliveStore(file);
  const f = {
    now: options.now ?? START, file, store, sends: [], preparations: [], contextModels: [], reads: 0, turnReads: 0,
    context: { ok: true, accountId: "fixture-account", quota: quota(options.now ?? START) },
    turn: { ok: true, accountId: "fixture-account", threadId: THREAD_ID, turnId: TURN_ID,
      status: "completed", outputText: "OK" },
  };
  f.controller = new DailyKeepAliveController({
    store,
    now: () => f.now,
    readContext: async (model) => {
      f.reads += 1;
      f.contextModels.push(model);
      return options.readContext ? options.readContext(f, model) : structuredClone(f.context);
    },
    ...(options.prepareThread ? { prepareThread: async (row) => {
      f.preparations.push(structuredClone(row));
      return options.prepareThread(row, f);
    } } : {}),
    sendKeepAlive: async (row) => {
      f.sends.push(structuredClone(row));
      return options.sendKeepAlive ? options.sendKeepAlive(row, f)
        : { ok: true, threadId: THREAD_ID, turnId: TURN_ID };
    },
    readTurn: async (row) => {
      f.turnReads += 1;
      return options.readTurn ? options.readTurn(row, f) : structuredClone(f.turn);
    },
  });
  if (options.enabled !== false) f.controller.settingsChanged(options.settings ?? SETTINGS);
  return f;
}
async function submittedFixture(t, options = {}) {
  const f = await fixture(t, options);
  await f.controller.tick();
  assert.equal(f.store.current.attempts[0].status, "submitted");
  f.now += 31_000;
  f.context.quota = quota(f.now, {
    activeFiveHour: true,
    fiveHour: { usedPercent: 1, resetsAt: START + 5 * HOUR },
  });
  return f;
}

test("daily start is strict and defaults to 07:00", () => {
  for (const value of [null, "7:00", "24:00", "07:60", "07:00:00", " 08:00 ", {}, true]) {
    assert.equal(normalizeDailyStart(value), "07:00");
  }
  assert.equal(normalizeDailyStart("00:00"), "00:00");
  assert.equal(normalizeDailyStart("23:59"), "23:59");
});

test("07:00 produces the four local daily nodes, each five hours apart", () => {
  const nodes = dailyKeepAliveNodes(START, "07:00")
    .filter((at) => new Date(at).getDate() === new Date(START).getDate());
  assert.deepEqual(nodes.map((at) => new Date(at).getHours()), [7, 12, 17, 22]);
  assert.deepEqual(nodes.slice(1).map((at, index) => at - nodes[index]), [5 * HOUR, 5 * HOUR, 5 * HOUR]);
});

test("22:00 includes yesterday's nodes that cross midnight", () => {
  const afterMidnight = new Date(2026, 9, 18, 3, 0).getTime();
  const nodes = dailyKeepAliveNodes(afterMidnight, "22:00");
  assert.ok(nodes.includes(afterMidnight));
  assert.deepEqual(nodes.filter((at) => at >= afterMidnight).slice(0, 4)
    .map((at) => [new Date(at).getDate(), new Date(at).getHours()]), [[18, 3], [18, 8], [18, 13], [18, 22]]);
});

test("default disabled never reads account context or sends", async (t) => {
  const f = await fixture(t, { enabled: false });
  await f.controller.tick();
  assert.equal(f.reads, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.status, "disabled");
});

test("waits for the next node and does not catch up an expired node", async (t) => {
  const f = await fixture(t, { now: START - 1 });
  await f.controller.tick();
  assert.equal(f.controller.status.nextAt, START);
  f.now = START + NODE_GRACE_MS + 1;
  await f.controller.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(f.reads, 0);
  assert.equal(f.controller.status.nextAt, START + 5 * HOUR);
});

test("at a due node, fsynced submitting intent precedes the one send", async (t) => {
  const f = await fixture(t, {
    sendKeepAlive: async (row, current) => {
      const onDisk = JSON.parse(await fs.readFile(current.file, "utf8"));
      assert.equal(onDisk.attempts[0].status, "submitting");
      assert.equal(onDisk.attempts[0].eventId, row.eventId);
      return { ok: true, threadId: THREAD_ID, turnId: TURN_ID };
    },
  });
  await f.controller.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.store.current.attempts[0].status, "submitted");
  assert.equal(f.controller.status.reason, "submitted");
  f.now += 31_000;
  await f.controller.tick();
  assert.equal(f.sends.length, 1);
});

test("22:00 schedule sends the next calendar day's 03:00 node", async (t) => {
  const at = new Date(2026, 9, 18, 3, 0).getTime();
  const f = await fixture(t, { now: at });
  f.controller.settingsChanged({ dailyKeepAlive: true, dailyKeepAliveStart: "22:00" });
  await f.controller.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].node, at);
  assert.equal(new Date(f.controller.status.nextAt).getHours(), 8);
});

test("concurrent ticks share a single in-flight read and send", async (t) => {
  const gate = deferred();
  const f = await fixture(t, { readContext: async (current) => { await gate.promise; return current.context; } });
  const first = f.controller.tick();
  const second = f.controller.tick();
  assert.equal(first, second);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.reads, 1);
  assert.equal(f.sends.length, 1);
});

test("disabling while context is loading cancels before intent or send", async (t) => {
  const gate = deferred();
  const f = await fixture(t, { readContext: async (current) => { await gate.promise; return current.context; } });
  const pending = f.controller.tick();
  f.controller.settingsChanged({ ...SETTINGS, dailyKeepAlive: false });
  gate.resolve();
  await pending;
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.current.attempts.length, 0);
  assert.equal(f.controller.status.status, "disabled");
});

test("changing anchor while context is loading cancels the obsolete node", async (t) => {
  const gate = deferred();
  const f = await fixture(t, { readContext: async (current) => { await gate.promise; return current.context; } });
  const pending = f.controller.tick();
  f.controller.settingsChanged({ dailyKeepAlive: true, dailyKeepAliveStart: "08:00" });
  gate.resolve();
  await pending;
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.current.attempts.length, 0);
  await f.controller.tick();
  assert.equal(f.controller.status.nextAt, START + HOUR);
});

test("stopping while context is loading prevents a send", async (t) => {
  const gate = deferred();
  const f = await fixture(t, { readContext: async (current) => { await gate.promise; return current.context; } });
  const pending = f.controller.tick();
  const stopped = f.controller.stop();
  gate.resolve();
  await Promise.all([pending, stopped]);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.current.attempts.length, 0);
});

test("slow context cannot submit after the node's grace period expires", async (t) => {
  const f = await fixture(t, { readContext: async (current) => {
    current.now += NODE_GRACE_MS + 1;
    current.context.quota = quota(current.now);
    return current.context;
  } });
  await f.controller.tick();
  assert.equal(f.sends.length, 0);
});

const blockedQuotas = [
  ["missing", null, "quota-unavailable"],
  ["active", quota(START, { activeFiveHour: true, fiveHour: { usedPercent: 5, resetsAt: START + HOUR } }), "active-window"],
  ["active reset without flag", quota(START, { fiveHour: { usedPercent: 5, resetsAt: START + HOUR } }), "active-window"],
  ["zero-use future window needs observation", quota(START, { activeFiveHour: true, fiveHour: { usedPercent: 0, resetsAt: START + 5 * HOUR } }), "window-observing"],
  ["five-hour exhausted", quota(START, { fiveHour: { usedPercent: 100, resetsAt: START + HOUR } }), "quota-exhausted"],
  ["weekly exhausted", quota(START, { weekly: { usedPercent: 100, resetsAt: START + HOUR } }), "quota-exhausted"],
  ["ordinary usage disallowed", quota(START, { ordinaryUsageAllowed: false }), "quota-unavailable"],
  ["ordinary permission absent", quota(START, { ordinaryUsageAllowed: undefined }), "quota-unavailable"],
  ["stale", quota(START - 90_001), "quota-unavailable"],
  ["future snapshot", quota(START + 5_001), "quota-unavailable"],
  ["invalid window", quota(START, { fiveHour: { usedPercent: NaN, resetsAt: START - 1 } }), "quota-unavailable"],
  ["invalid weekly", quota(START, { weekly: { usedPercent: -1, resetsAt: START + HOUR } }), "quota-unavailable"],
  ["missing identity", quota(START, { accountId: "" }), "quota-unavailable"],
];
for (const [label, value, reason] of blockedQuotas) {
  test(`${label} quota blocks model sends`, async (t) => {
    assert.equal(keepAliveQuotaReason(value, START), reason);
    const f = await fixture(t);
    f.context.quota = value;
    await f.controller.tick();
    assert.equal(f.sends.length, 0);
    assert.equal(f.controller.status.reason, reason);
  });
}

test("account mismatch blocks despite usable quota", async (t) => {
  const f = await fixture(t);
  f.context.accountId = "other-account";
  await f.controller.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.reason, "account-unavailable");
});

test("unsupported desktop/model context remains pending without sends", async (t) => {
  const f = await fixture(t);
  for (const [reason, expected] of [["model-missing", "model-unavailable"], ["account-missing", "account-unavailable"], ["offline", "desktop-unavailable"]]) {
    f.context = { ok: false, reason };
    f.now += 31_000;
    await f.controller.tick();
    assert.equal(f.controller.status.reason, expected);
  }
  assert.equal(f.sends.length, 0);
});

test("a persisted pre-send intent survives a restart and never resubmits", async (t) => {
  const f = await fixture(t);
  await f.controller.tick();
  const state = f.store.current;
  state.attempts[0].status = "submitting";
  delete state.attempts[0].threadId;
  delete state.attempts[0].turnId;
  await f.store.save(state);
  const reopened = await createDailyKeepAliveStore(f.file);
  const second = new DailyKeepAliveController({ store: reopened, now: () => START + 31_000,
    readContext: async () => f.context, sendKeepAlive: async () => { assert.fail("persisted intent must never be retried"); } });
  second.settingsChanged(SETTINGS);
  await second.tick();
  assert.equal(second.status.status, "uncertain");
  assert.equal(reopened.current.attempts.length, 1);
});

test("a timed-out send records uncertainty and never retries", async (t) => {
  const f = await fixture(t, { sendKeepAlive: async () => { throw new Error("fixture timeout"); } });
  await f.controller.tick();
  assert.equal(f.store.current.attempts[0].status, "uncertain");
  f.now += 31_000;
  await f.controller.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.controller.status.status, "uncertain");
});

test("confirmed requires exact completed turn, OK, matching account and a new five-hour reset", async (t) => {
  const f = await submittedFixture(t);
  await f.controller.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.turnReads, 1);
  assert.equal(f.controller.status.status, "confirmed");
  assert.equal(f.store.current.attempts[0].status, "confirmed");
  const reopened = await createDailyKeepAliveStore(f.file);
  assert.equal(reopened.current.attempts[0].status, "confirmed");
});

const unconfirmedTurns = [
  ["turn still running", { status: "inProgress" }],
  ["turn failed", { status: "failed", outputText: "OK" }],
  ["wrong thread", { threadId: OTHER_ID }],
  ["wrong turn", { turnId: OTHER_ID }],
  ["wrong account", { accountId: "other-account" }],
  ["not exact OK", { outputText: "OK, task complete" }],
  ["request failure", { ok: false }],
];
for (const [label, changes] of unconfirmedTurns) {
  test(`${label} never reports keep-alive confirmation`, async (t) => {
    const f = await submittedFixture(t);
    Object.assign(f.turn, changes);
    await f.controller.tick();
    assert.notEqual(f.controller.status.status, "confirmed");
    assert.equal(f.store.current.attempts[0].status, "submitted");
    assert.equal(f.sends.length, 1);
  });
}

for (const [label, changes] of [
  ["old window", { fiveHour: { usedPercent: 1, resetsAt: START - 1 } }],
  ["wrong quota account", { accountId: "other-account" }],
  ["stale confirmation", { capturedAt: START - 120_000 }],
  ["future confirmation", { capturedAt: START + HOUR }],
  ["permission absent", { ordinaryUsageAllowed: undefined }],
  ["invalid quota percentage", { fiveHour: { usedPercent: NaN, resetsAt: START + 5 * HOUR } }],
]) {
  test(`${label} quota never falsely confirms a successful turn`, async (t) => {
    const f = await submittedFixture(t);
    Object.assign(f.context.quota, changes);
    await f.controller.tick();
    assert.notEqual(f.controller.status.status, "confirmed");
    assert.equal(f.sends.length, 1);
  });
}

test("corrupt existing journal blocks both account reads and sends", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, "{broken json");
  const broken = await createDailyKeepAliveStore(f.file);
  assert.equal(broken.error, true);
  const controller = new DailyKeepAliveController({ store: broken, now: () => START,
    readContext: async () => { assert.fail("corrupt state must pause before reading context"); },
    sendKeepAlive: async () => { assert.fail("corrupt state must pause before model submission"); } });
  controller.settingsChanged(SETTINGS);
  await controller.tick();
  assert.equal(controller.status.reason, "state-unavailable");
  assert.equal(await fs.readFile(f.file, "utf8"), "{broken json");
});

test("failed durable intent write prevents sending", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-daily-write-failure-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const blockedParent = path.join(directory, "not-a-directory");
  // Loading the absent journal succeeds; only the later durable write fails.
  const store = await createDailyKeepAliveStore(path.join(blockedParent, "state.json"));
  assert.equal(store.error, false);
  await fs.writeFile(blockedParent, "fixture");
  const f = await fixture(t, { store });
  await f.controller.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.reason, "state-unavailable");
});

test("disabling while durable intent is being written prevents sending", async (t) => {
  const gate = deferred();
  const started = deferred();
  let stored = { schemaVersion: 1, attempts: [] };
  let writes = 0;
  const store = {
    error: false,
    get current() { return structuredClone(stored); },
    async save(value) {
      if (writes++ === 0) { started.resolve(); await gate.promise; }
      stored = structuredClone(value);
    },
    async flush() {},
  };
  const f = await fixture(t, { store });
  const running = f.controller.tick();
  await started.promise;
  f.controller.settingsChanged({ ...SETTINGS, dailyKeepAlive: false });
  gate.resolve();
  await running;
  assert.equal(f.sends.length, 0);
  assert.equal(store.current.attempts[0].status, "skipped");
});

test("slow durable intent write cannot send past the grace period", async (t) => {
  let stored = { schemaVersion: 1, attempts: [] };
  let f;
  let writes = 0;
  const store = {
    error: false,
    get current() { return structuredClone(stored); },
    async save(value) {
      stored = structuredClone(value);
      if (writes++ === 0) f.now += NODE_GRACE_MS + 1;
    },
    async flush() {},
  };
  f = await fixture(t, { store });
  await f.controller.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(store.current.attempts[0].status, "skipped");
});

test("time configuration changes recalculate the next daily plan", async (t) => {
  const f = await fixture(t, { now: START - 60_000 });
  await f.controller.tick();
  assert.equal(f.controller.status.nextAt, START);
  f.controller.settingsChanged({ dailyKeepAlive: true, dailyKeepAliveStart: "08:30" });
  await f.controller.tick();
  assert.equal(f.controller.status.nextAt, START + 90 * 60_000);
  assert.equal(f.sends.length, 0);
});

test("overlapping backends with separately loaded state cannot both send a node", async (t) => {
  const first = await fixture(t);
  const secondStore = await createDailyKeepAliveStore(first.file);
  const second = await fixture(t, { store: secondStore });
  await Promise.all([first.controller.tick(), second.controller.tick()]);
  assert.equal(first.sends.length + second.sends.length, 1);
  assert.equal([first.controller.status.status, second.controller.status.status].filter((status) => status === "uncertain").length, 1);
});

test("durable node claim survives a lost or older journal snapshot", async (t) => {
  const first = await fixture(t);
  await first.controller.tick();
  await fs.writeFile(first.file, JSON.stringify({ schemaVersion: 1, attempts: [] }));
  const secondStore = await createDailyKeepAliveStore(first.file);
  const second = await fixture(t, { store: secondStore });
  await second.controller.tick();
  assert.equal(second.sends.length, 0);
  assert.equal(second.controller.status.status, "uncertain");
});

const preparedThread = (row) => ({ ok: true, accountId: row.accountId,
  threadId: row.reuseThreadId || THREAD_ID });

function advanceNode(f, now) {
  f.now = now;
  f.context.quota = quota(now);
}

test("a newly prepared dedicated conversation is durable before its first model send", async (t) => {
  const f = await fixture(t, {
    prepareThread: async (row) => {
      assert.equal(row.reuseThreadId, undefined);
      return preparedThread(row);
    },
    sendKeepAlive: async (row, current) => {
      const reopened = await createDailyKeepAliveStore(current.file);
      assert.equal(await reopened.getThread(row.accountId), THREAD_ID);
      assert.equal(reopened.current.attempts[0].reuseThreadId, THREAD_ID);
      assert.equal(reopened.current.attempts[0].status, "submitting");
      return { ok: true, threadId: THREAD_ID, turnId: TURN_ID };
    },
  });
  await f.controller.tick();
  assert.equal(f.preparations.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].reuseThreadId, THREAD_ID);
});

test("subsequent nodes and a restarted controller reuse the same durable conversation", async (t) => {
  const first = await fixture(t, { prepareThread: preparedThread });
  await first.controller.tick();
  advanceNode(first, START + 5 * HOUR);
  await first.controller.tick();
  assert.deepEqual(first.preparations.map((row) => row.reuseThreadId), [undefined, THREAD_ID]);
  assert.deepEqual(first.sends.map((row) => row.reuseThreadId), [THREAD_ID, THREAD_ID]);

  const reopened = await createDailyKeepAliveStore(first.file);
  const restarted = await fixture(t, { file: first.file, store: reopened, now: START + 10 * HOUR,
    prepareThread: preparedThread });
  await restarted.controller.tick();
  assert.equal(restarted.preparations[0].reuseThreadId, THREAD_ID);
  assert.equal(restarted.sends[0].reuseThreadId, THREAD_ID);
  assert.equal(await reopened.getThread("fixture-account"), THREAD_ID);
});

test("dedicated conversation binding survives seven-day attempt history pruning", async (t) => {
  const f = await fixture(t, { prepareThread: preparedThread });
  await f.controller.tick();
  advanceNode(f, START + 8 * 24 * HOUR);
  await f.controller.tick();
  assert.equal(f.store.current.attempts.length, 1);
  assert.equal(f.store.current.attempts[0].node, f.now);
  assert.equal(f.preparations[1].reuseThreadId, THREAD_ID);
  assert.equal(await f.store.getThread("fixture-account"), THREAD_ID);
});

test("an unavailable legacy conversation remains pinned after its old evidence is pruned", async (t) => {
  const f = await fixture(t, { prepareThread: async (row) => {
    assert.equal(row.reuseThreadId, THREAD_ID);
    return { ok: false, uncertain: false, reason: "keep-alive-thread-unavailable" };
  } });
  await f.store.save({ schemaVersion: 1, attempts: [{ key: "a".repeat(64), eventId: "a".repeat(32),
    node: START - 8 * 24 * HOUR, attemptedAt: START - 8 * 24 * HOUR,
    accountId: "fixture-account", status: "confirmed", threadId: THREAD_ID, turnId: TURN_ID }] });
  await f.controller.tick();
  assert.equal(await f.store.getThread("fixture-account"), THREAD_ID);
  assert.equal(f.store.current.attempts.length, 1);
  advanceNode(f, START + 8 * 24 * HOUR);
  await f.controller.tick();
  assert.equal(f.preparations.length, 2);
  assert.equal(f.sends.length, 0);
  assert.equal(await f.store.getThread("fixture-account"), THREAD_ID);
});

test("a backend loaded before thread creation observes another backend's durable binding", async (t) => {
  const first = await fixture(t, { prepareThread: preparedThread });
  const warmStore = await createDailyKeepAliveStore(first.file);
  const second = await fixture(t, { file: first.file, store: warmStore, now: START + 5 * HOUR,
    prepareThread: preparedThread });
  assert.equal(await warmStore.getThread("fixture-account"), null);
  await first.controller.tick();
  assert.equal(warmStore.current.attempts.length, 0, "the second backend still has its old journal snapshot");
  await second.controller.tick();
  assert.equal(second.preparations[0].reuseThreadId, THREAD_ID);
  assert.equal(second.sends[0].reuseThreadId, THREAD_ID);
});

test("unknown first thread creation is never repeated, including after journal loss", async (t) => {
  const first = await fixture(t, { prepareThread: async () => { throw new Error("fixture lost acknowledgement"); } });
  const warmStore = await createDailyKeepAliveStore(first.file);
  await first.controller.tick();
  assert.equal(first.preparations.length, 1);
  assert.equal(first.sends.length, 0);
  assert.equal(first.store.current.attempts[0].status, "uncertain");
  advanceNode(first, START + 5 * HOUR);
  await first.controller.tick();
  assert.equal(first.preparations.length, 1, "an unresolved previous creation blocks the next node");

  const second = await fixture(t, { file: first.file, store: warmStore, now: START + 10 * HOUR,
    prepareThread: () => assert.fail("the permanent account creation claim must survive a stale journal") });
  await second.controller.tick();
  assert.equal(second.preparations.length, 0);
  assert.equal(second.sends.length, 0);
  assert.equal(second.controller.status.status, "uncertain");
});

test("preparation cannot replace an already bound conversation with a different thread", async (t) => {
  const f = await fixture(t, { prepareThread: (row) => ({ ...preparedThread(row), threadId: OTHER_ID }) });
  await f.store.rememberThread("fixture-account", THREAD_ID);
  await f.controller.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(await f.store.getThread("fixture-account"), THREAD_ID);
  assert.notEqual(f.controller.status.status, "submitted");
});

test("a corrupt conversation binding stops before preparation or model send", async (t) => {
  const f = await fixture(t, { prepareThread: () => assert.fail("invalid binding must never reach transport") });
  await f.store.rememberThread("fixture-account", THREAD_ID);
  const directory = `${f.file}.threads`;
  const [binding] = (await fs.readdir(directory)).filter((name) => !name.endsWith(".creating"));
  await fs.writeFile(path.join(directory, binding), "{invalid binding");
  await f.controller.tick();
  assert.equal(f.preparations.length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.reason, "state-unavailable");
});

test("disabling while thread preparation is in progress prevents a model send", async (t) => {
  const began = deferred();
  const gate = deferred();
  const f = await fixture(t, { prepareThread: async (row) => {
    began.resolve();
    await gate.promise;
    return preparedThread(row);
  } });
  const pending = f.controller.tick();
  await began.promise;
  f.controller.settingsChanged({ ...SETTINGS, dailyKeepAlive: false });
  gate.resolve();
  await pending;
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.current.attempts[0].status, "skipped");
  assert.equal(await f.store.getThread("fixture-account"), THREAD_ID, "safe prepared thread is retained for later opt-in");
});

test("a lost turn acknowledgement retains the prepared binding for later nodes", async (t) => {
  const f = await fixture(t, { prepareThread: preparedThread,
    sendKeepAlive: async () => { throw new Error("fixture turn/start timeout"); } });
  await f.controller.tick();
  assert.equal(f.store.current.attempts[0].status, "uncertain");
  assert.equal(await f.store.getThread("fixture-account"), THREAD_ID);
  advanceNode(f, START + 5 * HOUR);
  await f.controller.tick();
  assert.deepEqual(f.preparations.map((row) => row.reuseThreadId), [undefined, THREAD_ID]);
  assert.equal(await f.store.getThread("fixture-account"), THREAD_ID);
});

test("default model is Luna low and the selected model is durable before sending", async (t) => {
  const f = await fixture(t, { sendKeepAlive: async (row, current) => {
    assert.equal(row.model, "gpt-6-luna");
    assert.equal(JSON.parse(await fs.readFile(current.file, "utf8")).attempts[0].model, row.model);
    return { ok: true, threadId: THREAD_ID, turnId: TURN_ID };
  } });
  await f.controller.tick();
  assert.deepEqual(f.contextModels, ["gpt-6-luna"]);
});

test("chosen model reaches context, preparation and send and survives journal reload", async (t) => {
  const model = "fixture-selected-model";
  const f = await fixture(t, { settings: { ...SETTINGS, dailyKeepAliveModel: model },
    prepareThread: (row) => { assert.equal(row.model, model); return preparedThread(row); } });
  await f.controller.tick();
  assert.deepEqual(f.contextModels, [model]);
  assert.equal(f.sends[0].model, model);
  assert.equal((await createDailyKeepAliveStore(f.file)).current.attempts[0].model, model);
});

test("changing model while context is loading cancels the old attempt before intent", async (t) => {
  const gate = deferred();
  const f = await fixture(t, { readContext: async (current) => { await gate.promise; return current.context; } });
  const pending = f.controller.tick();
  f.controller.settingsChanged({ ...SETTINGS, dailyKeepAliveModel: "fixture-selected-model" });
  gate.resolve();
  await pending;
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.current.attempts.length, 0);
  f.now += 31_000;
  f.context.quota = quota(f.now);
  await f.controller.tick();
  assert.deepEqual(f.contextModels, ["gpt-6-luna", "fixture-selected-model"]);
  assert.equal(f.sends[0].model, "fixture-selected-model");
});

test("changing model during thread preparation retains the thread and cancels the old send", async (t) => {
  const began = deferred();
  const gate = deferred();
  const f = await fixture(t, { prepareThread: async (row) => {
    began.resolve();
    await gate.promise;
    return preparedThread(row);
  } });
  const pending = f.controller.tick();
  await began.promise;
  f.controller.settingsChanged({ ...SETTINGS, dailyKeepAliveModel: "fixture-selected-model" });
  gate.resolve();
  await pending;
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.current.attempts[0].status, "skipped");
  assert.equal(await f.store.getThread("fixture-account"), THREAD_ID);
  advanceNode(f, START + 5 * HOUR);
  await f.controller.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].reuseThreadId, THREAD_ID);
  assert.equal(f.sends[0].model, "fixture-selected-model");
});

test("changing model during durable intent write prevents the obsolete send", async (t) => {
  const began = deferred();
  const gate = deferred();
  let stored = { schemaVersion: 1, attempts: [] };
  let writes = 0;
  const store = {
    error: false,
    get current() { return structuredClone(stored); },
    async save(value) {
      if (writes++ === 0) { began.resolve(); await gate.promise; }
      stored = structuredClone(value);
    },
    async flush() {},
  };
  const f = await fixture(t, { store });
  const pending = f.controller.tick();
  await began.promise;
  f.controller.settingsChanged({ ...SETTINGS, dailyKeepAliveModel: "fixture-selected-model" });
  gate.resolve();
  await pending;
  assert.equal(f.sends.length, 0);
  assert.equal(store.current.attempts[0].status, "skipped");
});

test("changing models at later nodes preserves the same dedicated conversation after restart", async (t) => {
  const f = await fixture(t, { prepareThread: preparedThread });
  await f.controller.tick();
  advanceNode(f, START + 5 * HOUR);
  f.controller.settingsChanged({ ...SETTINGS, dailyKeepAliveModel: "fixture-selected-model" });
  await f.controller.tick();
  assert.deepEqual(f.sends.map((row) => [row.model, row.reuseThreadId]),
    [["gpt-6-luna", THREAD_ID], ["fixture-selected-model", THREAD_ID]]);
  const reopened = await createDailyKeepAliveStore(f.file);
  const restarted = await fixture(t, { store: reopened, now: START + 10 * HOUR,
    settings: { ...SETTINGS, dailyKeepAliveModel: "fixture-selected-model" }, prepareThread: preparedThread });
  await restarted.controller.tick();
  assert.equal(restarted.sends[0].model, "fixture-selected-model");
  assert.equal(restarted.sends[0].reuseThreadId, THREAD_ID);
});

test("an unavailable chosen model cannot fall back to Luna or consume a node claim", async (t) => {
  const f = await fixture(t, { settings: { ...SETTINGS, dailyKeepAliveModel: "fixture-unavailable-model" },
    readContext: async (current, model) => model === "fixture-unavailable-model"
      ? { ok: false, reason: "keep-alive-low-model-unavailable" } : current.context });
  await f.controller.tick();
  assert.deepEqual(f.contextModels, ["fixture-unavailable-model"]);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.current.attempts.length, 0);
  assert.equal(f.controller.status.reason, "model-unavailable");
  f.now += 31_000;
  f.context.quota = quota(f.now);
  f.controller.settingsChanged(SETTINGS);
  await f.controller.tick();
  assert.equal(f.sends[0].model, "gpt-6-luna");
});

test("changing model cannot bypass a persisted unknown send for the same node", async (t) => {
  const f = await fixture(t, { sendKeepAlive: () => { throw new Error("fixture timeout"); } });
  await f.controller.tick();
  assert.equal(f.sends.length, 1);
  const reopened = await createDailyKeepAliveStore(f.file);
  const restarted = await fixture(t, { store: reopened, now: START + 31_000,
    settings: { ...SETTINGS, dailyKeepAliveModel: "fixture-selected-model" } });
  await restarted.controller.tick();
  assert.equal(restarted.sends.length, 0);
  assert.equal(restarted.controller.status.status, "uncertain");
  assert.equal(reopened.current.attempts[0].model, "gpt-6-luna");
});

function rollingQuota(now, changes = {}) {
  return quota(now, { activeFiveHour: true,
    fiveHour: { usedPercent: 0, resetsAt: now + 5 * HOUR }, ...changes });
}

async function observe(f, now, value = rollingQuota(now)) {
  f.now = now;
  f.context.quota = value;
  await f.controller.tick();
}

test("rolling full quota waits for distinct observations then sends once within the node", async (t) => {
  const f = await fixture(t, { prepareThread: preparedThread });
  await observe(f, START);
  assert.equal(f.controller.status.reason, "window-observing");
  assert.equal(f.store.current.attempts.length, 0, "observation must not claim the node");
  await observe(f, START + 30_000);
  assert.equal(f.sends.length, 0, "thirty seconds cannot establish a rolling reset");
  await observe(f, START + 60_000);
  assert.equal(f.sends.length, 1);
  assert.equal(f.preparations[0].quotaBaseline.capturedAt, START);
  assert.equal(f.sends[0].quotaBaseline.capturedAt, START);
  assert.equal(f.sends[0].node, START);
  assert.equal(Object.hasOwn(f.store.current.attempts[0], "quotaBaseline"), false);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(f.file, "utf8")).attempts[0], "quotaBaseline"), false);
  await observe(f, START + 90_000);
  assert.equal(f.sends.length, 1);
});

test("zero used percent with a fixed reset is active despite rounding to full remaining", async (t) => {
  const f = await fixture(t);
  const reset = START + 5 * HOUR;
  await observe(f, START, quota(START, { fiveHour: { usedPercent: 0, resetsAt: reset } }));
  await observe(f, START + 60_000, quota(START + 60_000, { fiveHour: { usedPercent: 0, resetsAt: reset } }));
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.reason, "active-window");
  assert.equal(f.store.current.attempts.length, 0);
});

test("real positive usage after an idle-looking sample prevents a keep-alive send", async (t) => {
  const f = await fixture(t);
  await observe(f, START);
  await observe(f, START + 60_000, quota(START + 60_000, {
    activeFiveHour: false, fiveHour: { usedPercent: 1, resetsAt: START + 5 * HOUR },
  }));
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.reason, "active-window");
});

test("an intervening active sample separates older idle observations", async (t) => {
  const f = await fixture(t);
  await observe(f, START);
  await observe(f, START + 30_000, quota(START + 30_000, {
    fiveHour: { usedPercent: 1, resetsAt: START + 5 * HOUR },
  }));
  await observe(f, START + 60_000);
  assert.equal(f.sends.length, 0, "a zero rounded after actual usage cannot reuse the pre-usage baseline");
  assert.equal(f.controller.status.reason, "window-observing");
});

test("a window ending one minute after the node waits then sends after rolling-idle evidence", async (t) => {
  const f = await fixture(t);
  await observe(f, START, quota(START, {
    fiveHour: { usedPercent: 20, resetsAt: START + 60_000 },
  }));
  assert.equal(f.controller.status.status, "waiting");
  assert.equal(f.controller.status.reason, "window-expiring");
  assert.equal(f.controller.status.nextAt, START + 60_000);
  assert.equal(f.store.current.attempts.length, 0);
  await observe(f, START + 60_000);
  assert.equal(f.sends.length, 0);
  await observe(f, START + 120_000);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].node, START);
  assert.equal(f.sends[0].attemptedAt, START + 120_000);
});

test("expired five-hour and weekly usage percentages cannot block renewed ordinary usage", async (t) => {
  const f = await fixture(t);
  f.context.quota = quota(START, { activeFiveHour: true,
    fiveHour: { usedPercent: 100, resetsAt: START - 1 },
    weekly: { usedPercent: 100, resetsAt: START - 1 },
  });
  await f.controller.tick();
  assert.equal(f.sends.length, 1);
});

test("an expired old window still requires explicit ordinary usage permission", async (t) => {
  const f = await fixture(t);
  f.context.quota = quota(START, { ordinaryUsageAllowed: false,
    fiveHour: { usedPercent: 100, resetsAt: START - 1 },
    weekly: { usedPercent: 100, resetsAt: START - 1 },
  });
  await f.controller.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.reason, "quota-unavailable");
});

test("the ten-minute boundary can send but the next instant does not catch up", async (t) => {
  const inside = await fixture(t);
  await observe(inside, START, quota(START, { fiveHour: { usedPercent: 1, resetsAt: START + NODE_GRACE_MS } }));
  await observe(inside, START + NODE_GRACE_MS, quota(START + NODE_GRACE_MS, {
    fiveHour: { usedPercent: 100, resetsAt: START + NODE_GRACE_MS },
  }));
  assert.equal(inside.sends.length, 1);
  const outside = await fixture(t);
  await observe(outside, START, quota(START, { fiveHour: { usedPercent: 1, resetsAt: START + NODE_GRACE_MS + 1 } }));
  const reads = outside.reads;
  await observe(outside, START + NODE_GRACE_MS + 1, quota(START + NODE_GRACE_MS + 1));
  assert.equal(outside.sends.length, 0);
  assert.equal(outside.reads, reads, "an expired node must not query or submit");
  assert.equal(outside.controller.status.nextAt, START + 5 * HOUR);
});

test("replayed snapshots are not independent evidence of a rolling reset", async (t) => {
  const f = await fixture(t);
  await observe(f, START);
  await observe(f, START + 60_000, rollingQuota(START));
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.reason, "window-observing");
  await observe(f, START + 90_000);
  assert.equal(f.sends.length, 1, "a later distinct capture can establish the rolling reset");
});

test("observations older than three minutes cannot establish idle", async (t) => {
  const f = await fixture(t);
  await observe(f, START);
  await observe(f, START + 181_000);
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.reason, "window-observing");
  await observe(f, START + 241_000);
  assert.equal(f.sends.length, 1);
});

test("account changes start observation again instead of combining two accounts", async (t) => {
  const f = await fixture(t);
  await observe(f, START);
  f.context.accountId = "other-account";
  await observe(f, START + 60_000, rollingQuota(START + 60_000, { accountId: "other-account" }));
  assert.equal(f.sends.length, 0);
  await observe(f, START + 120_000, rollingQuota(START + 120_000, { accountId: "other-account" }));
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].accountId, "other-account");
});

test("a quota-account mismatch discards prior observations", async (t) => {
  const f = await fixture(t);
  await observe(f, START);
  await observe(f, START + 30_000, rollingQuota(START + 30_000, { accountId: "other-account" }));
  await observe(f, START + 60_000);
  assert.equal(f.sends.length, 0);
  await observe(f, START + 120_000);
  assert.equal(f.sends.length, 1);
});

test("captured-time rollback invalidates earlier observation evidence", async (t) => {
  const f = await fixture(t);
  await observe(f, START);
  await observe(f, START + 30_000);
  await observe(f, START + 60_000, rollingQuota(START + 15_000));
  assert.equal(f.sends.length, 0);
  await observe(f, START + 90_000, rollingQuota(START + 45_000));
  assert.equal(f.sends.length, 0, "only thirty seconds have elapsed since the replacement baseline");
});

test("wall-clock rollback invalidates observations and does not stall probing", async (t) => {
  const f = await fixture(t);
  await observe(f, START);
  await observe(f, START + 30_000);
  await observe(f, START + 15_000);
  assert.equal(f.reads, 3, "rollback must not leave the throttle waiting for the old wall time");
  await observe(f, START + 61_000);
  assert.equal(f.sends.length, 0);
  await observe(f, START + 91_000);
  assert.equal(f.sends.length, 1);
});

test("restart discards uncommitted observation history and obtains fresh evidence", async (t) => {
  const first = await fixture(t);
  await observe(first, START);
  const reopened = await createDailyKeepAliveStore(first.file);
  const restarted = await fixture(t, { file: first.file, store: reopened, now: START + 60_000 });
  await observe(restarted, START + 60_000);
  assert.equal(restarted.sends.length, 0);
  await observe(restarted, START + 120_000);
  assert.equal(restarted.sends.length, 1);
  const third = await fixture(t, { file: first.file, store: await createDailyKeepAliveStore(first.file), now: START + 150_000 });
  await observe(third, START + 150_000);
  assert.equal(third.sends.length, 0, "the durable submitted intent still prevents restart duplication");
});

test("OK plus rolling quota remains submitted instead of falsely confirming", async (t) => {
  const f = await fixture(t);
  await f.controller.tick();
  await observe(f, START + 31_000);
  assert.equal(f.controller.status.status, "submitted");
  await observe(f, START + 91_000);
  assert.equal(f.controller.status.status, "submitted");
  assert.equal(f.store.current.attempts[0].status, "submitted");
  assert.equal(f.sends.length, 1);
});

test("fresh turn quota takes precedence over apparently active context quota", async (t) => {
  const f = await submittedFixture(t);
  f.turn.quota = rollingQuota(f.now);
  await f.controller.tick();
  assert.equal(f.controller.status.status, "submitted");
  f.now += 60_000;
  f.context.quota = quota(f.now, { fiveHour: { usedPercent: 3, resetsAt: START + 5 * HOUR } });
  f.turn.quota = rollingQuota(f.now);
  await f.controller.tick();
  assert.equal(f.controller.status.status, "submitted");
});

test("fresh turn quota can confirm despite a stale pre-read context", async (t) => {
  const f = await fixture(t);
  await f.controller.tick();
  f.now += 31_000;
  f.context.quota = quota(START - 120_000);
  f.turn.quota = quota(f.now, { activeFiveHour: false,
    fiveHour: { usedPercent: 1, resetsAt: START + 5 * HOUR },
  });
  await f.controller.tick();
  assert.equal(f.controller.status.status, "confirmed");
});

test("two fresh zero-use fixed turn quotas can confirm a completed turn", async (t) => {
  const f = await fixture(t);
  await f.controller.tick();
  const reset = START + 31_000 + 5 * HOUR;
  f.now = START + 31_000;
  f.turn.quota = quota(f.now, { fiveHour: { usedPercent: 0, resetsAt: reset } });
  await f.controller.tick();
  assert.equal(f.controller.status.status, "submitted");
  f.now = START + 91_000;
  f.turn.quota = quota(f.now, { fiveHour: { usedPercent: 0, resetsAt: reset } });
  await f.controller.tick();
  assert.equal(f.controller.status.status, "confirmed");
});

test("an explicitly missing fresh turn quota does not fall back to active context", async (t) => {
  const f = await submittedFixture(t);
  f.turn.quota = null;
  await f.controller.tick();
  assert.equal(f.controller.status.status, "submitted");
});

const safePreflightRetry = () => ({ ok: false, uncertain: false,
  reason: "keep-alive-usage-not-ready", retryable: true });

test("an owned creation reservation can retry a proved side-effect-free preparation failure", async (t) => {
  let prepares = 0;
  const f = await fixture(t, { prepareThread: (row) => ++prepares === 1 ? safePreflightRetry() : preparedThread(row) });
  await f.controller.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.status.status, "waiting");
  assert.equal(f.controller.status.reason, "window-observing");
  const first = f.store.current.attempts[0];
  assert.equal(first.reason, "preflight-retry");
  assert.equal(await f.store.getThread(first.accountId), null);
  await observe(f, START + 30_000);
  assert.equal(prepares, 1, "new rolling quota requires its own observation interval");
  await observe(f, START + 90_000);
  assert.equal(prepares, 2);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].eventId, first.eventId);
  assert.equal(f.store.current.attempts.length, 1, "retries update one durable row");
  assert.equal(f.store.current.attempts[0].status, "submitted");
  assert.equal(await f.store.getThread(first.accountId), THREAD_ID);
  assert.equal((await fs.readdir(`${f.file}.claims`)).length, 1);
  assert.equal((await fs.readdir(`${f.file}.threads`)).filter((name) => name.endsWith(".creating")).length, 1,
    "the persistent creation reservation is retained");
});

test("a proved send preflight failure retries with the same bound conversation and event", async (t) => {
  let calls = 0;
  const f = await fixture(t, { prepareThread: preparedThread,
    sendKeepAlive: () => ++calls === 1 ? safePreflightRetry() : { ok: true, threadId: THREAD_ID, turnId: TURN_ID } });
  await f.controller.tick();
  assert.equal(f.store.current.attempts[0].reason, "preflight-retry");
  assert.equal(await f.store.getThread("fixture-account"), THREAD_ID);
  await observe(f, START + 30_000);
  await observe(f, START + 90_000);
  assert.equal(f.sends.length, 2, "first callback only performed a side-effect-free preflight");
  assert.deepEqual(f.preparations.map((row) => row.reuseThreadId), [undefined, THREAD_ID]);
  assert.deepEqual(f.sends.map((row) => row.reuseThreadId), [THREAD_ID, THREAD_ID]);
  assert.equal(f.sends[0].eventId, f.sends[1].eventId);
  assert.equal(f.store.current.attempts.length, 1);
  assert.equal(f.store.current.attempts[0].status, "submitted");
});

test("a proved preflight failure is never retried beyond the node grace period", async (t) => {
  const f = await fixture(t, { prepareThread: () => safePreflightRetry() });
  await f.controller.tick();
  const reads = f.reads;
  await observe(f, START + NODE_GRACE_MS + 1);
  assert.equal(f.reads, reads);
  assert.equal(f.preparations.length, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.current.attempts[0].reason, "preflight-retry");
  assert.equal(f.controller.status.nextAt, START + 5 * HOUR);
});

test("a restarted controller cannot inherit a proved preflight retry claim", async (t) => {
  const first = await fixture(t, { prepareThread: () => safePreflightRetry() });
  await first.controller.tick();
  const restarted = await fixture(t, { file: first.file, store: await createDailyKeepAliveStore(first.file),
    now: START + 31_000, prepareThread: () => assert.fail("restart must not repeat preparation") });
  await restarted.controller.tick();
  assert.equal(restarted.preparations.length, 0);
  assert.equal(restarted.sends.length, 0);
  assert.equal(restarted.controller.status.status, "uncertain");
  assert.equal(restarted.store.current.attempts[0].reason, "preflight-retry");
});

test("another backend with an older journal cannot inherit in-memory preflight ownership", async (t) => {
  const first = await fixture(t, { prepareThread: () => safePreflightRetry() });
  const olderStore = await createDailyKeepAliveStore(first.file);
  await first.controller.tick();
  const second = await fixture(t, { file: first.file, store: olderStore, now: START + 31_000,
    prepareThread: () => assert.fail("a second backend must lose the persistent claim") });
  await second.controller.tick();
  assert.equal(second.preparations.length, 0);
  assert.equal(second.sends.length, 0);
  assert.equal(second.controller.status.status, "uncertain");
  await observe(first, START + 60_000, quota(START + 60_000));
  assert.equal(first.preparations.length, 2, "the original owner can still retry");
  assert.equal(first.sends.length, 0);
});

for (const [label, changes] of [
  ["uncertain", { uncertain: true }],
  ["uncertainty missing", { uncertain: undefined }],
  ["retry permission missing", { retryable: undefined }],
  ["different failure", { reason: "keep-alive-thread-unavailable" }],
]) {
  test(`${label} preflight failure cannot use the narrow retry exception`, async (t) => {
    const f = await fixture(t, { prepareThread: () => ({ ...safePreflightRetry(), ...changes }) });
    await f.controller.tick();
    await observe(f, START + 60_000, quota(START + 60_000));
    assert.equal(f.preparations.length, 1);
    assert.equal(f.sends.length, 0);
    assert.notEqual(f.store.current.attempts[0].reason, "preflight-retry");
  });
}

test("an uncertain send stays blocked even if a retryable flag is present", async (t) => {
  const f = await fixture(t, { prepareThread: preparedThread,
    sendKeepAlive: () => ({ ...safePreflightRetry(), uncertain: true }) });
  await f.controller.tick();
  await observe(f, START + 60_000, quota(START + 60_000));
  assert.equal(f.sends.length, 1);
  assert.equal(f.store.current.attempts[0].status, "uncertain");
});
