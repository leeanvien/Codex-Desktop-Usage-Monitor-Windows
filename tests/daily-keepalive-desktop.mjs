import assert from "node:assert/strict";
import vm from "node:vm";
import {
  readKeepAliveContextThroughDesktop,
  readKeepAliveModelsThroughDesktop,
  readKeepAliveTurnThroughDesktop,
  prepareKeepAliveThreadThroughDesktop,
  sendKeepAliveThroughDesktop,
} from "../scripts/desktop-request.mjs";

const THREAD_ID = "019fb3b1-2638-7bb0-9a90-ec83b5bca0f2";
const EVENT_ID = "0123456789abcdef0123456789abcdef";
const TURN_ID = "019fb3b1-2638-7bb0-9a90-ec83b5bca0f3";

// Daily keep-alive exercises the renderer request channel entirely inside a VM.
// No real account, desktop connection, model request, or project files are used.
const NOW = 1_800_000_000_000;
const KEEP_ALIVE_ACCOUNT = "fixture-subscription-account";
const WORKSPACE_PATH = "D:\\monitor-fixture\\keep-alive-workspace";
function keepAliveHarness(overrides = {}) {
  const state = {
    calls: [],
    account: { account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" } },
    usage: {
      accountId: KEEP_ALIVE_ACCOUNT,
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: "codex",
        primary: { usedPercent: 0, resetsAt: NOW / 1000 - 1, windowDurationMins: 300 },
        secondary: { usedPercent: 25, resetsAt: NOW / 1000 + 86400, windowDurationMins: 10080 } },
    },
    catalog: { data: [{ model: "gpt-6-luna", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] },
    threadSettings: {},
    turnResult: { turn: { id: TURN_ID } },
    readThread: { thread: { id: THREAD_ID, cwd: WORKSPACE_PATH, modelProvider: "openai", status: { type: "idle" },
      turns: [{ id: TURN_ID, status: "completed", items: [
      { type: "userMessage", content: [{ type: "text", text: "只回复 OK。" }] },
      { type: "agentMessage", text: "OK" },
    ] }] } },
    ...overrides,
  };
  const fixtureContext = vm.createContext({ state });
  vm.runInContext(`
    Date.now = () => state.now || ${NOW};
    const originalComposer = { value: "未发送的用户草稿", queued: [{ id: "user-queued" }] };
    window = { originalComposer, __codexRoot: { _internalRoot: { current: { nested: {
      hostId: "local", requestPromises: new Map(),
      async sendRequest(method, params, options) {
        state.calls.push({ method, params, options });
        if (state.failMethod === method) throw new Error("private exception must not be returned");
        if (method === "account/read") return state.account;
        if (method === "account/rateLimits/read") {
          state.usageReads = (state.usageReads || 0) + 1;
          if (state.advanceClockAt === state.usageReads) state.now = ${NOW} + 60000;
          if (state.usageAtRead?.[state.usageReads]) return state.usageAtRead[state.usageReads];
          if (state.changeAccountAt === state.usageReads)
            return { ...state.usage, accountId: "another-account" };
          if (state.activateWindowAt === state.usageReads) return { ...state.usage,
            rateLimits: { ...state.usage.rateLimits, primary: { ...state.usage.rateLimits.primary,
              resetsAt: Date.now() / 1000 + 18000 } } };
          return state.usage;
        }
        if (method === "model/list") return state.catalogPages ? state.catalogPages[params.cursor || "first"] : state.catalog;
        if (method === "thread/start") return { thread: { id: ${JSON.stringify(THREAD_ID)} },
          model: params.model, modelProvider: "openai", approvalPolicy: "never", sandbox: { type: "readOnly" },
          cwd: ${JSON.stringify(WORKSPACE_PATH)}, ...state.threadSettings };
        if (method === "thread/name/set") return {};
        if (method === "thread/list") return state.listPages ? state.listPages[params.cursor || "first"]
          : { data: state.threadListed === false ? [] : [state.readThread.thread] };
        if (method === "thread/resume") {
          if (state.busyAfterResume) state.readThread.thread.status = { type: "active" };
          if (state.queuedAfterResume) state.queuedByThread = { [params.threadId]: [{ id: "human-queued" }] };
          return { ...state.readThread, model: params.model, modelProvider: "openai", approvalPolicy: "never",
            sandbox: { type: "readOnly" }, cwd: ${JSON.stringify(WORKSPACE_PATH)}, ...state.threadSettings };
        }
        if (method === "turn/start") return state.turnResult;
        if (method === "thread/read") {
          if (params.includeTurns && state.unmaterializedFullRead)
            throw new Error(state.fullReadError || "thread " + params.threadId
              + " is not materialized yet; includeTurns is unavailable before first user message");
          return state.readThread;
        }
        if (method === "thread/loaded/list") return { data: state.loadedThreadIds || [${JSON.stringify(THREAD_ID)}] };
        throw new Error("Unexpected fixture RPC " + method);
      },
      queryClient: { getQueryCache() { return { getAll() { return state.queryAvailable === false ? [] : [{
        queryKey: ["get-global-state", "queued-follow-ups"], state: { data: {
          value: state.queueMalformed ? null : state.queuedByThread || {},
        } },
      }]; } }; } },
    } } } } };
  `, fixtureContext);
  return { state, fixtureContext, session: {
    async evaluate(expression) {
      return JSON.parse(JSON.stringify(await vm.runInContext(expression, fixtureContext)));
    },
  } };
}

const keepAliveArguments = { eventId: EVENT_ID, expectedAccountId: KEEP_ALIVE_ACCOUNT, workspacePath: WORKSPACE_PATH };
const keepAlive = keepAliveHarness();
const keepAliveContext = await readKeepAliveContextThroughDesktop(keepAlive.session);
assert.equal(keepAliveContext.ok, true);
assert.equal(keepAliveContext.accountId, KEEP_ALIVE_ACCOUNT);
assert.equal(keepAliveContext.model, "gpt-6-luna");
assert.equal(keepAliveContext.effort, "low");
assert.deepEqual(keepAliveContext.quota, {
  capturedAt: NOW, accountId: KEEP_ALIVE_ACCOUNT, ordinaryUsageAllowed: true,
  fiveHour: { usedPercent: 0, resetsAt: NOW - 1000 },
  weekly: { usedPercent: 25, resetsAt: NOW + 86400000 }, activeFiveHour: false,
});
assert.equal(keepAlive.state.calls.some(({ method }) => method === "turn/start" || method === "thread/start"), false);
const submitted = await sendKeepAliveThroughDesktop(keepAlive.session, keepAliveArguments);
assert.deepEqual(submitted, { ok: true, accountId: KEEP_ALIVE_ACCOUNT, threadId: THREAD_ID, turnId: TURN_ID });
assert.equal(Object.hasOwn(submitted, "completed"), false);
const startCalls = keepAlive.state.calls.filter(({ method }) => method === "thread/start" || method === "turn/start");
assert.deepEqual(startCalls.map(({ method }) => method), ["thread/start", "turn/start"]);
assert.equal(startCalls[0].params.cwd, WORKSPACE_PATH);
assert.equal(startCalls[0].params.sandbox, "read-only");
assert.equal(startCalls[0].params.approvalPolicy, "never");
assert.equal(startCalls[0].params.modelProvider, "openai");
assert.equal(startCalls[0].params.historyMode, "legacy");
assert.equal(startCalls[1].params.model, "gpt-6-luna");
assert.equal(startCalls[1].params.effort, "low");
assert.equal(startCalls[1].params.threadId, THREAD_ID);
assert.deepEqual(JSON.parse(JSON.stringify(startCalls[1].params.input)), [{ type: "text", text: "只回复 OK。" }]);
assert.equal(startCalls[1].params.clientUserMessageId, `codex-usage-monitor-keep-alive-${EVENT_ID}`);
assert.equal(keepAlive.state.calls.some(({ method }) => method === "thread/resume" || method.startsWith("config/")), false);
assert.equal(vm.runInContext("window.originalComposer.value", keepAlive.fixtureContext), "未发送的用户草稿");
assert.equal(vm.runInContext("window.originalComposer.queued.length", keepAlive.fixtureContext), 1);
const beforeDuplicateKeepAlive = keepAlive.state.calls.length;
await Promise.all([sendKeepAliveThroughDesktop(keepAlive.session, keepAliveArguments), sendKeepAliveThroughDesktop(keepAlive.session, keepAliveArguments)]);
assert.equal(keepAlive.state.calls.length, beforeDuplicateKeepAlive);
const turnRead = await readKeepAliveTurnThroughDesktop(keepAlive.session, {
  threadId: THREAD_ID, turnId: TURN_ID, expectedAccountId: KEEP_ALIVE_ACCOUNT,
});
assert.equal(turnRead.ok, true);
assert.equal(turnRead.status, "completed");
assert.equal(turnRead.outputText, "OK");
assert.equal(turnRead.quota.activeFiveHour, false); // completed alone is not proof of a new quota window
assert.equal(keepAlive.state.calls.filter(({ method }) => method === "turn/start").length, 1);

// A future reset on a fully unused response is not an active-window signal by
// itself. Only two appropriately separated same-account rolling observations
// can authorize the dedicated keep-alive turn.
async function rollingKeepAliveHarness() {
  const fixture = keepAliveHarness();
  fixture.state.now = NOW - 60_000;
  fixture.state.usage.rateLimits.primary.resetsAt = (NOW - 60_000) / 1000 + 18000;
  const baseline = (await readKeepAliveContextThroughDesktop(fixture.session)).quota;
  assert.equal(baseline.activeFiveHour, null);
  fixture.state.now = NOW;
  fixture.state.usage.rateLimits.primary.resetsAt = NOW / 1000 + 18000;
  return { ...fixture, baseline, args: { ...keepAliveArguments, quotaBaseline: baseline } };
}

const unprovenFuture = await rollingKeepAliveHarness();
assert.equal((await readKeepAliveContextThroughDesktop(unprovenFuture.session)).quota.activeFiveHour, null);
assert.equal((await sendKeepAliveThroughDesktop(unprovenFuture.session, keepAliveArguments)).reason,
  "keep-alive-usage-not-ready");
assert.equal(unprovenFuture.state.calls.some(({ method }) => method === "thread/start" || method === "turn/start"), false);

const retryPrepared = await rollingKeepAliveHarness();
const firstPreparation = await prepareKeepAliveThreadThroughDesktop(retryPrepared.session, keepAliveArguments);
assert.equal(firstPreparation.reason, "keep-alive-usage-not-ready");
assert.equal(firstPreparation.retryable, true);
assert.equal(firstPreparation.uncertain, false);
assert.equal(retryPrepared.state.calls.some(({ method }) => method === "thread/start" || method === "turn/start"), false);
const secondPreparation = await prepareKeepAliveThreadThroughDesktop(retryPrepared.session, retryPrepared.args);
assert.equal(secondPreparation.ok, true, "same event can retry quota preflight with a newer validated baseline");
assert.equal(retryPrepared.state.calls.filter(({ method }) => method === "thread/start").length, 1);
const preparedRetryArgs = { ...keepAliveArguments, threadId: secondPreparation.threadId };
const firstSubmission = await sendKeepAliveThroughDesktop(retryPrepared.session, preparedRetryArgs);
assert.equal(firstSubmission.reason, "keep-alive-usage-not-ready");
assert.equal(firstSubmission.retryable, true);
assert.equal(firstSubmission.uncertain, false);
assert.equal(retryPrepared.state.calls.some(({ method }) => method === "turn/start"), false);
assert.equal((await sendKeepAliveThroughDesktop(retryPrepared.session, {
  ...preparedRetryArgs, quotaBaseline: retryPrepared.baseline,
})).ok, true);
assert.equal(retryPrepared.state.calls.filter(({ method }) => method === "thread/start").length, 1);
assert.equal(retryPrepared.state.calls.filter(({ method }) => method === "turn/start").length, 1);

for (const operation of [prepareKeepAliveThreadThroughDesktop, sendKeepAliveThroughDesktop]) {
  const createdBeforeQuotaChanged = keepAliveHarness({ activateWindowAt: 3 });
  const first = await operation(createdBeforeQuotaChanged.session, keepAliveArguments);
  assert.equal(first.reason, "keep-alive-usage-not-ready");
  assert.equal(first.retryable, false, "a created thread must retain its event barrier");
  assert.equal(first.uncertain, false);
  assert.equal(createdBeforeQuotaChanged.state.calls.filter(({ method }) => method === "thread/start").length, 1);
  assert.equal(createdBeforeQuotaChanged.state.calls.some(({ method }) => method === "turn/start"), false);
  const previousCalls = createdBeforeQuotaChanged.state.calls.length;
  createdBeforeQuotaChanged.state.activateWindowAt = null;
  assert.deepEqual(await operation(createdBeforeQuotaChanged.session, keepAliveArguments), first);
  assert.equal(createdBeforeQuotaChanged.state.calls.length, previousCalls,
    "a later ready response cannot recreate a thread after a side effect");
}

const rollingFuture = await rollingKeepAliveHarness();
const rollingPrepared = await prepareKeepAliveThreadThroughDesktop(rollingFuture.session, rollingFuture.args);
assert.equal(rollingPrepared.ok, true);
assert.equal(rollingFuture.state.calls.some(({ method }) => method === "turn/start"), false);
assert.equal((await sendKeepAliveThroughDesktop(rollingFuture.session, {
  ...rollingFuture.args, threadId: rollingPrepared.threadId,
})).ok, true);
assert.equal(rollingFuture.state.calls.filter(({ method }) => method === "thread/start").length, 1);
assert.equal(rollingFuture.state.calls.filter(({ method }) => method === "turn/start").length, 1);
const stillRollingTurn = await readKeepAliveTurnThroughDesktop(rollingFuture.session, {
  threadId: THREAD_ID, turnId: TURN_ID, expectedAccountId: KEEP_ALIVE_ACCOUNT,
});
assert.equal(stillRollingTurn.status, "completed");
assert.equal(stillRollingTurn.outputText, "OK");
assert.equal(stillRollingTurn.quota.activeFiveHour, null); // OK plus another placeholder is not quota confirmation.

for (const [label, change] of [
  ["fixed zero-use reset", (fixture) => { fixture.state.usage.rateLimits.primary.resetsAt = fixture.baseline.fiveHour.resetsAt / 1000; }],
  ["actual usage with rounded future", (fixture) => { fixture.state.usage.rateLimits.primary.usedPercent = 1; }],
  ["baseline from another account", (fixture) => { fixture.args.quotaBaseline.accountId = "another-account"; }],
  ["baseline too recent", (fixture) => { fixture.args.quotaBaseline.capturedAt = NOW - 30_000; }],
  ["baseline too old", (fixture) => { fixture.args.quotaBaseline.capturedAt = NOW - 181_000; }],
  ["baseline has previous usage", (fixture) => { fixture.args.quotaBaseline.fiveHour.usedPercent = 1; }],
  ["arbitrary reset drift", (fixture) => { fixture.state.usage.rateLimits.primary.resetsAt -= 20; }],
]) {
  const fixture = await rollingKeepAliveHarness();
  change(fixture);
  const result = await sendKeepAliveThroughDesktop(fixture.session, fixture.args);
  assert.equal(result.reason, "keep-alive-usage-not-ready", label);
  assert.equal(result.uncertain, false, label);
  assert.equal(fixture.state.calls.some(({ method }) => method === "thread/start" || method === "turn/start"), false, label);
}

// The baseline is revalidated on every fresh quota read, including after thread
// preparation and the extra inspection of an existing dedicated conversation.
for (const [label, mutate] of [
  ["new actual usage", (usage) => { usage.rateLimits.primary.usedPercent = 1; }],
  ["fixed zero-use window", (usage) => { usage.rateLimits.primary.resetsAt -= 60; }],
  ["ordinary usage denied", (usage) => { usage.ordinaryUsageAllowed = false; }],
  ["weekly exhaustion", (usage) => { usage.rateLimits.secondary.usedPercent = 100; }],
  ["account switched", (usage) => { usage.accountId = "another-account"; }],
]) {
  for (const readOffset of [1, 2, 3, 4]) {
    const fixture = await rollingKeepAliveHarness();
    const usage = structuredClone(fixture.state.usage);
    mutate(usage);
    fixture.state.usageAtRead = { [fixture.state.usageReads + readOffset]: usage };
    const result = await sendKeepAliveThroughDesktop(fixture.session, {
      ...fixture.args, threadId: THREAD_ID,
    });
    assert.equal(result.ok, false, `${label}, fresh read ${readOffset}`);
    assert.equal(result.uncertain, false, `${label}, fresh read ${readOffset}`);
    assert.equal(fixture.state.calls.some(({ method }) => method === "turn/start"), false,
      `${label}, fresh read ${readOffset}`);
  }
}

const expiredPreviouslyExhausted = keepAliveHarness();
expiredPreviouslyExhausted.state.usage.rateLimits.primary.usedPercent = 100;
assert.equal((await sendKeepAliveThroughDesktop(expiredPreviouslyExhausted.session, keepAliveArguments)).ok, true,
  "expired old-window consumption must not permanently block ordinary usage");

for (const [label, changes, reason] of [
  ["API auth", { account: { account: { type: "apiKey" } } }, "keep-alive-official-subscription-required"],
  ["missing small model", { catalog: { data: [{ model: "gpt-6", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] } }, "keep-alive-low-model-unavailable"],
  ["missing low effort", { catalog: { data: [{ model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] } }, "keep-alive-low-model-unavailable"],
  ["changed account before thread", { changeAccountAt: 2 }, "keep-alive-account-changed"],
  ["changed account after thread", { changeAccountAt: 3 }, "keep-alive-account-changed"],
  ["window activated during preflight", { activateWindowAt: 3 }, "keep-alive-usage-not-ready"],
  ["stale preflight after sleep", { advanceClockAt: 3 }, "keep-alive-preflight-expired"],
  ["wrong server model", { threadSettings: { model: "gpt-6" } }, "keep-alive-thread-settings-mismatch"],
  ["wrong server workspace", { threadSettings: { cwd: "D:\\other-project" } }, "keep-alive-workspace-mismatch"],
]) {
  const fixture = keepAliveHarness(changes);
  const result = await sendKeepAliveThroughDesktop(fixture.session, keepAliveArguments);
  assert.equal(result.ok, false, label);
  assert.equal(result.uncertain, false, label);
  assert.equal(result.reason, reason, label);
  assert.equal(fixture.state.calls.some(({ method }) => method === "turn/start"), false, label);
}
for (const change of [
  (usage) => { delete usage.accountId; },
  (usage) => { usage.ordinaryUsageAllowed = null; },
  (usage) => { usage.rateLimits.primary.resetsAt = NOW / 1000 + 100; },
  (usage) => { usage.rateLimits.primary.windowDurationMins = 60; },
  (usage) => { usage.rateLimits.primary.usedPercent = -1; },
  (usage) => { usage.rateLimits.secondary.usedPercent = 100; },
  (usage) => { usage.rateLimits.limitId = "codex-spark"; },
]) {
  const fixture = keepAliveHarness();
  change(fixture.state.usage);
  const result = await sendKeepAliveThroughDesktop(fixture.session, keepAliveArguments);
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, false);
  assert.equal(fixture.state.calls.some(({ method }) => method === "thread/start" || method === "turn/start"), false);
}
const byLimit = keepAliveHarness();
byLimit.state.usage.rateLimitsByLimitId = { codex: { ...byLimit.state.usage.rateLimits }, spark: {
  primary: { usedPercent: 100, resetsAt: NOW / 1000 + 100, windowDurationMins: 300 },
} };
byLimit.state.usage.rateLimits = byLimit.state.usage.rateLimitsByLimitId.spark;
assert.equal((await readKeepAliveContextThroughDesktop(byLimit.session)).quota.fiveHour.usedPercent, 0);

const paginatedModel = keepAliveHarness({ catalogPages: {
  first: { data: [], nextCursor: "next" },
  next: { data: [{ model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] },
} });
assert.equal((await readKeepAliveContextThroughDesktop(paginatedModel.session)).ok, true);
const changedContext = keepAliveHarness({ changeAccountAt: 2 });
assert.equal((await readKeepAliveContextThroughDesktop(changedContext.session)).reason, "keep-alive-account-changed");
const hiddenModel = keepAliveHarness();
hiddenModel.state.catalog.data[0].hidden = true;
assert.equal((await readKeepAliveContextThroughDesktop(hiddenModel.session)).reason, "keep-alive-low-model-unavailable");
const malformedQuota = keepAliveHarness();
malformedQuota.state.usage.rateLimits.primary.resetsAt = "1800000000";
const unknownWindow = await readKeepAliveContextThroughDesktop(malformedQuota.session);
assert.equal(unknownWindow.quota.fiveHour, null);
assert.equal(unknownWindow.quota.activeFiveHour, null);

for (const changes of [{ failMethod: "turn/start" }, { turnResult: {} }]) {
  const fixture = keepAliveHarness(changes);
  const unknown = await sendKeepAliveThroughDesktop(fixture.session, keepAliveArguments);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.uncertain, true);
  assert.equal(unknown.threadId, THREAD_ID);
  const attemptsBefore = fixture.state.calls.length;
  await sendKeepAliveThroughDesktop(fixture.session, keepAliveArguments);
  assert.equal(fixture.state.calls.length, attemptsBefore); // unknown send must not be retried
}
const lostRenderer = { async evaluate() { throw new Error("Runtime.evaluate timed out"); } };
assert.deepEqual(await sendKeepAliveThroughDesktop(lostRenderer, keepAliveArguments), {
  ok: false, uncertain: true, reason: "keep-alive-send-uncertain",
});
assert.deepEqual(await readKeepAliveContextThroughDesktop(lostRenderer), {
  ok: false, uncertain: false, reason: "keep-alive-context-unavailable",
});
const invalidKeepAlive = keepAliveHarness();
for (const args of [{ ...keepAliveArguments, eventId: "bad" }, { ...keepAliveArguments, expectedAccountId: "" },
  { ...keepAliveArguments, workspacePath: undefined }]) {
  assert.equal((await sendKeepAliveThroughDesktop(invalidKeepAlive.session, args)).uncertain, false);
}
assert.equal(invalidKeepAlive.state.calls.length, 0);
const mismatchedRead = keepAliveHarness({ readThread: { thread: { id: "other-thread", turns: [] } } });
assert.equal((await readKeepAliveTurnThroughDesktop(mismatchedRead.session, {
  threadId: THREAD_ID, turnId: TURN_ID, expectedAccountId: KEEP_ALIVE_ACCOUNT,
})).ok, false);
const summarizedRead = keepAliveHarness();
summarizedRead.state.readThread.thread.turns[0].itemsView = "summary";
assert.equal((await readKeepAliveTurnThroughDesktop(summarizedRead.session, {
  threadId: THREAD_ID, turnId: TURN_ID, expectedAccountId: KEEP_ALIVE_ACCOUNT,
})).outputText, "");
const switchedDuringRead = keepAliveHarness({ changeAccountAt: 2 });
assert.equal((await readKeepAliveTurnThroughDesktop(switchedDuringRead.session, {
  threadId: THREAD_ID, turnId: TURN_ID, expectedAccountId: KEEP_ALIVE_ACCOUNT,
})).reason, "keep-alive-account-changed");

// The controller persists the returned reference before ever calling send.
const preparedFixture = keepAliveHarness();
const prepared = await prepareKeepAliveThreadThroughDesktop(preparedFixture.session, keepAliveArguments);
assert.deepEqual(prepared, { ok: true, threadId: THREAD_ID, accountId: KEEP_ALIVE_ACCOUNT });
assert.equal(preparedFixture.state.calls.some(({ method }) => method === "turn/start"), false);
assert.equal(preparedFixture.state.calls.filter(({ method }) => method === "thread/start").length, 1);
const nameCall = preparedFixture.state.calls.find(({ method }) => method === "thread/name/set");
assert.deepEqual(JSON.parse(JSON.stringify(nameCall.params)), { threadId: THREAD_ID, name: "Codex 定时保活" });
const preparedCallCount = preparedFixture.state.calls.length;
await prepareKeepAliveThreadThroughDesktop(preparedFixture.session, keepAliveArguments);
assert.equal(preparedFixture.state.calls.length, preparedCallCount);
const savedThreadArguments = { ...keepAliveArguments, threadId: prepared.threadId };
assert.equal((await sendKeepAliveThroughDesktop(preparedFixture.session, savedThreadArguments)).ok, true);
const nextEvent = { ...savedThreadArguments, eventId: "1123456789abcdef0123456789abcdef" };
assert.equal((await prepareKeepAliveThreadThroughDesktop(preparedFixture.session, nextEvent)).ok, true);
assert.equal((await sendKeepAliveThroughDesktop(preparedFixture.session, nextEvent)).ok, true);
assert.equal(preparedFixture.state.calls.filter(({ method }) => method === "thread/start").length, 1);
assert.equal(preparedFixture.state.calls.filter(({ method }) => method === "thread/name/set").length, 1);
assert.equal(preparedFixture.state.calls.filter(({ method }) => method === "turn/start").length, 2);
for (const call of preparedFixture.state.calls.filter(({ method }) => method === "thread/resume")) {
  assert.equal(call.params.threadId, THREAD_ID);
  assert.equal(call.params.cwd, WORKSPACE_PATH);
  assert.equal(call.params.model, "gpt-6-luna");
  assert.equal(call.params.modelProvider, "openai");
  assert.equal(call.params.sandbox, "read-only");
  assert.equal(call.params.approvalPolicy, "never");
  assert.equal(call.params.config.model_reasoning_effort, "low");
  assert.equal(call.params.baseInstructions, "Reply only OK. Do not use tools, read files, or carry out any other task.");
}
const duplicateReuseCount = preparedFixture.state.calls.length;
await Promise.all([sendKeepAliveThroughDesktop(preparedFixture.session, nextEvent),
  sendKeepAliveThroughDesktop(preparedFixture.session, nextEvent)]);
assert.equal(preparedFixture.state.calls.length, duplicateReuseCount);
assert.equal(vm.runInContext("window.originalComposer.value", preparedFixture.fixtureContext), "未发送的用户草稿");
assert.equal(vm.runInContext("window.originalComposer.queued.length", preparedFixture.fixtureContext), 1);

for (const [label, alter, reason] of [
  ["foreign workspace", (s) => { s.readThread.thread.cwd = "D:\\real-user-project"; }, "keep-alive-workspace-mismatch"],
  ["foreign provider", (s) => { s.readThread.thread.modelProvider = "another-provider"; }, "keep-alive-thread-settings-mismatch"],
  ["wrong thread", (s) => { s.readThread.thread.id = TURN_ID; }, "keep-alive-thread-id-mismatch"],
  ["active thread", (s) => { s.readThread.thread.status = { type: "active", activeFlags: [] }; }, "keep-alive-thread-busy"],
  ["missing runtime state", (s) => { delete s.readThread.thread.status; }, "keep-alive-thread-busy"],
  ["active turn", (s) => { s.readThread.thread.turns[0].status = "inProgress"; }, "keep-alive-thread-busy"],
  ["human task", (s) => { s.readThread.thread.turns[0].items[0].content[0].text = "继续修改我的项目"; }, "keep-alive-thread-content-changed"],
  ["image attachment", (s) => { s.readThread.thread.turns[0].items[0].content.push({ type: "image", url: "fixture" }); }, "keep-alive-thread-content-changed"],
  ["other assistant task", (s) => { s.readThread.thread.turns[0].items[1].text = "I have edited your source"; }, "keep-alive-thread-content-changed"],
  ["summary-only history", (s) => { s.readThread.thread.turns[0].itemsView = "summary"; }, "keep-alive-history-unverified"],
  ["unloaded history", (s) => { s.readThread.thread.turns[0].itemsView = "notLoaded"; }, "keep-alive-history-unverified"],
  ["no items", (s) => { delete s.readThread.thread.turns[0].items; }, "keep-alive-history-unverified"],
  ["no turns", (s) => { delete s.readThread.thread.turns; }, "keep-alive-history-unverified"],
  ["tool execution history", (s) => { s.readThread.thread.turns[0].items.push({ type: "commandExecution" }); }, "keep-alive-history-unverified"],
  ["archived path", (s) => { s.readThread.thread.path = "C:\\fixture\\archived_sessions\\rollout.jsonl"; }, "keep-alive-thread-unavailable"],
  ["not in unarchived list", (s) => { s.threadListed = false; }, "keep-alive-thread-unavailable"],
  ["missing queue cache", (s) => { s.queryAvailable = false; }, "keep-alive-thread-queue-unverified"],
  ["malformed queue cache", (s) => { s.queueMalformed = true; }, "keep-alive-thread-queue-unverified"],
  ["human queued message", (s) => { s.queuedByThread = { [THREAD_ID]: [{ id: "human" }] }; }, "keep-alive-thread-queue-unverified"],
  ["became busy while resuming", (s) => { s.busyAfterResume = true; }, "keep-alive-thread-busy"],
  ["queued while resuming", (s) => { s.queuedAfterResume = true; }, "keep-alive-thread-queue-unverified"],
  ["changed resume model", (s) => { s.threadSettings = { model: "gpt-6" }; }, "keep-alive-thread-settings-mismatch"],
  ["changed resume permissions", (s) => { s.threadSettings = { sandbox: { type: "readOnly", networkAccess: true } }; }, "keep-alive-thread-settings-mismatch"],
]) {
  for (const operation of [prepareKeepAliveThreadThroughDesktop, sendKeepAliveThroughDesktop]) {
    const fixture = keepAliveHarness();
    alter(fixture.state);
    const result = await operation(fixture.session, savedThreadArguments);
    assert.equal(result.ok, false, label);
    assert.equal(result.uncertain, false, label);
    assert.equal(result.reason, reason, label);
    assert.equal(fixture.state.calls.some(({ method }) => method === "thread/start" || method === "turn/start"), false, label);
  }
}
for (const method of ["thread/read", "thread/list", "thread/resume"]) {
  const fixture = keepAliveHarness({ failMethod: method });
  const result = await sendKeepAliveThroughDesktop(fixture.session, savedThreadArguments);
  assert.deepEqual(result, { ok: false, uncertain: false, reason: "keep-alive-preflight-failed" });
  assert.equal(fixture.state.calls.some(({ method }) => method === "thread/start" || method === "turn/start"), false);
}
const createFailure = keepAliveHarness({ failMethod: "thread/start" });
assert.deepEqual(await prepareKeepAliveThreadThroughDesktop(createFailure.session, keepAliveArguments), {
  ok: false, uncertain: true, reason: "keep-alive-prepare-uncertain",
});
const failedCreateCount = createFailure.state.calls.length;
await prepareKeepAliveThreadThroughDesktop(createFailure.session, keepAliveArguments);
assert.equal(createFailure.state.calls.length, failedCreateCount);
assert.equal(createFailure.state.calls.filter(({ method }) => method === "thread/start").length, 1);
assert.deepEqual(await prepareKeepAliveThreadThroughDesktop(lostRenderer, keepAliveArguments), {
  ok: false, uncertain: true, reason: "keep-alive-prepare-uncertain",
});
const noNaming = keepAliveHarness({ failMethod: "thread/name/set" });
assert.equal((await prepareKeepAliveThreadThroughDesktop(noNaming.session, keepAliveArguments)).ok, true);
assert.equal(noNaming.state.calls.some(({ method }) => method === "turn/start"), false);
const invalidReference = keepAliveHarness();
assert.deepEqual(await sendKeepAliveThroughDesktop(invalidReference.session, { ...keepAliveArguments, threadId: "" }), {
  ok: false, uncertain: false, reason: "invalid-keep-alive-thread-id",
});
assert.equal(invalidReference.state.calls.length, 0);
const emptyPrepared = keepAliveHarness({ threadListed: false });
emptyPrepared.state.readThread.thread.turns = [];
const emptyCreated = await prepareKeepAliveThreadThroughDesktop(emptyPrepared.session, keepAliveArguments);
assert.equal(emptyCreated.ok, true);
assert.equal((await sendKeepAliveThroughDesktop(emptyPrepared.session, savedThreadArguments)).ok, true);
assert.equal(emptyPrepared.state.calls.some(({ method }) => method === "thread/list"), false);
const unknownEmptyThread = keepAliveHarness({ threadListed: false });
unknownEmptyThread.state.readThread.thread.turns = [];
assert.equal((await sendKeepAliveThroughDesktop(unknownEmptyThread.session, savedThreadArguments)).reason, "keep-alive-thread-unavailable");
const reuseChangedAccount = keepAliveHarness({ changeAccountAt: 3 });
assert.equal((await sendKeepAliveThroughDesktop(reuseChangedAccount.session, savedThreadArguments)).reason, "keep-alive-account-changed");
assert.equal(reuseChangedAccount.state.calls.some(({ method }) => method === "turn/start" || method === "thread/start"), false);
const reusePaged = keepAliveHarness({ listPages: {
  first: { data: [], nextCursor: "second" }, second: { data: [{ id: THREAD_ID }] },
} });
assert.equal((await sendKeepAliveThroughDesktop(reusePaged.session, savedThreadArguments)).ok, true);
assert.equal(reusePaged.state.calls.filter(({ method }) => method === "thread/list").length, 2);

// Installed-CLI protocol probe: empty legacy threads can be read as metadata,
// but their rollout/full history and resume are unavailable until first input.
const unmaterialized = keepAliveHarness({ unmaterializedFullRead: true });
unmaterialized.state.readThread.thread.turns = [];
assert.equal((await prepareKeepAliveThreadThroughDesktop(unmaterialized.session, keepAliveArguments)).ok, true);
assert.equal((await sendKeepAliveThroughDesktop(unmaterialized.session, savedThreadArguments)).ok, true);
assert.equal(unmaterialized.state.calls.filter(({ method }) => method === "thread/start").length, 1);
assert.equal(unmaterialized.state.calls.some(({ method }) => method === "thread/resume"), false);
assert.equal(unmaterialized.state.calls.filter(({ method }) => method === "thread/loaded/list").length, 2);
const loadedReadsBeforeIssued = unmaterialized.state.calls.filter(({ method }) => method === "thread/loaded/list").length;
assert.equal((await sendKeepAliveThroughDesktop(unmaterialized.session, nextEvent)).reason, "keep-alive-preflight-failed");
assert.equal(unmaterialized.state.calls.filter(({ method }) => method === "thread/loaded/list").length, loadedReadsBeforeIssued);
assert.equal(unmaterialized.state.calls.filter(({ method }) => method === "turn/start").length, 1);
const freshRenderer = keepAliveHarness({ unmaterializedFullRead: true });
freshRenderer.state.readThread.thread.turns = [];
assert.equal((await sendKeepAliveThroughDesktop(freshRenderer.session, savedThreadArguments)).reason, "keep-alive-preflight-failed");
assert.equal(freshRenderer.state.calls.some(({ method }) => method === "thread/loaded/list" || method === "thread/start"), false);
for (const [label, changes, reason] of [
  ["unrelated full-read error", { fullReadError: "list_turns is not supported yet" }, "keep-alive-preflight-failed"],
  ["thread no longer loaded", { loadedThreadIds: [] }, "keep-alive-thread-unavailable"],
  ["cannot check loaded threads", { failMethod: "thread/loaded/list" }, "keep-alive-preflight-failed"],
  ["queue state absent", { queryAvailable: false }, "keep-alive-thread-queue-unverified"],
]) {
  const fixture = keepAliveHarness({ unmaterializedFullRead: true });
  fixture.state.readThread.thread.turns = [];
  assert.equal((await prepareKeepAliveThreadThroughDesktop(fixture.session, keepAliveArguments)).ok, true);
  Object.assign(fixture.state, changes);
  const result = await sendKeepAliveThroughDesktop(fixture.session, savedThreadArguments);
  assert.equal(result.ok, false, label);
  assert.equal(result.uncertain, false, label);
  assert.equal(result.reason, reason, label);
  assert.equal(fixture.state.calls.filter(({ method }) => method === "thread/start").length, 1, label);
  assert.equal(fixture.state.calls.some(({ method }) => method === "thread/resume" || method === "turn/start"), false, label);
}
const unmaterializedUnknown = keepAliveHarness({ unmaterializedFullRead: true });
unmaterializedUnknown.state.readThread.thread.turns = [];
await prepareKeepAliveThreadThroughDesktop(unmaterializedUnknown.session, keepAliveArguments);
unmaterializedUnknown.state.failMethod = "turn/start";
assert.equal((await sendKeepAliveThroughDesktop(unmaterializedUnknown.session, savedThreadArguments)).uncertain, true);
assert.equal((await sendKeepAliveThroughDesktop(unmaterializedUnknown.session, nextEvent)).reason, "keep-alive-preflight-failed");
assert.equal(unmaterializedUnknown.state.calls.filter(({ method }) => method === "turn/start").length, 1);
const changedBeforeReuseTurn = keepAliveHarness({ changeAccountAt: 4 });
assert.equal((await sendKeepAliveThroughDesktop(changedBeforeReuseTurn.session, savedThreadArguments)).reason, "keep-alive-account-changed");
assert.equal(changedBeforeReuseTurn.state.calls.some(({ method }) => method === "turn/start" || method === "thread/start"), false);

// Catalog options are supplied by the desktop server, filtered to models that
// actually support low effort; the monitor must not silently choose a fallback.
const CHOSEN_MODEL = "fixture-selected-model";
const selectedModelCatalog = { data: [
  { model: "gpt-6-luna", displayName: "Luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  { model: CHOSEN_MODEL, displayName: "Selected fixture model", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
] };
const optionsFixture = keepAliveHarness({ catalog: { data: [
  ...selectedModelCatalog.data,
  { model: "hidden-model", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  { model: "high-only", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { model: "missing-efforts" },
  { model: "not a model", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
] } });
assert.deepEqual(await readKeepAliveModelsThroughDesktop(optionsFixture.session), {
  ok: true, accountId: KEEP_ALIVE_ACCOUNT,
  models: [{ id: "gpt-6-luna", label: "Luna" }, { id: CHOSEN_MODEL, label: "Selected fixture model" }],
});
assert.equal(optionsFixture.state.calls.some(({ method }) => method === "thread/start" || method === "turn/start"), false);
const optionsWithoutLuna = keepAliveHarness({ catalog: { data: [selectedModelCatalog.data[1]] } });
assert.deepEqual((await readKeepAliveModelsThroughDesktop(optionsWithoutLuna.session)).models,
  [{ id: CHOSEN_MODEL, label: "Selected fixture model" }]);
assert.equal((await readKeepAliveContextThroughDesktop(optionsWithoutLuna.session, { model: CHOSEN_MODEL })).model, CHOSEN_MODEL);
assert.equal((await readKeepAliveContextThroughDesktop(optionsWithoutLuna.session)).reason, "keep-alive-low-model-unavailable");
const optionsPaged = keepAliveHarness({ catalogPages: {
  first: { data: [selectedModelCatalog.data[0]], nextCursor: "second" },
  second: { data: selectedModelCatalog.data },
} });
assert.deepEqual((await readKeepAliveModelsThroughDesktop(optionsPaged.session)).models,
  [{ id: "gpt-6-luna", label: "Luna" }, { id: CHOSEN_MODEL, label: "Selected fixture model" }]);
for (const changes of [
  { catalogPages: { first: { data: selectedModelCatalog.data, nextCursor: "first" } } },
  { catalog: { data: null } },
  { account: { account: { type: "apiKey" } } },
  { changeAccountAt: 2 },
  { failMethod: "model/list" },
]) {
  const result = await readKeepAliveModelsThroughDesktop(keepAliveHarness(changes).session);
  assert.equal(result.ok === false || result.models.length === 0, true, "unverified catalog must expose no model choices");
  assert.deepEqual(result.models, []);
}
assert.deepEqual(await readKeepAliveModelsThroughDesktop(lostRenderer), { ok: false, models: [] });

const selectedModel = keepAliveHarness({ catalog: selectedModelCatalog });
const selectedContext = await readKeepAliveContextThroughDesktop(selectedModel.session, { model: CHOSEN_MODEL });
assert.equal(selectedContext.ok, true);
assert.equal(selectedContext.model, CHOSEN_MODEL);
assert.equal(selectedContext.effort, "low");
const selectedArgs = { ...keepAliveArguments, model: CHOSEN_MODEL };
assert.equal((await prepareKeepAliveThreadThroughDesktop(selectedModel.session, selectedArgs)).ok, true);
assert.equal((await sendKeepAliveThroughDesktop(selectedModel.session, { ...selectedArgs, threadId: THREAD_ID })).ok, true);
for (const call of selectedModel.state.calls.filter(({ method }) => ["thread/start", "thread/resume", "turn/start"].includes(method))) {
  assert.equal(call.params.model, CHOSEN_MODEL, `${call.method} must preserve the selected model`);
  assert.equal(call.params.effort || call.params.config.model_reasoning_effort, "low");
}
assert.equal(selectedModel.state.calls.filter(({ method }) => method === "thread/start").length, 1);
assert.equal(vm.runInContext("window.originalComposer.value", selectedModel.fixtureContext), "未发送的用户草稿");

// The next node can change models while keeping the same dedicated thread.
const changedModelArgs = { ...nextEvent, model: "gpt-6-luna" };
assert.equal((await prepareKeepAliveThreadThroughDesktop(selectedModel.session, changedModelArgs)).ok, true);
assert.equal((await sendKeepAliveThroughDesktop(selectedModel.session, changedModelArgs)).ok, true);
const selectedTurns = selectedModel.state.calls.filter(({ method }) => method === "turn/start");
assert.deepEqual(selectedTurns.map(({ params }) => [params.threadId, params.model, params.effort]),
  [[THREAD_ID, CHOSEN_MODEL, "low"], [THREAD_ID, "gpt-6-luna", "low"]]);
assert.equal(selectedModel.state.calls.filter(({ method }) => method === "thread/start").length, 1);

// A user can change their selection after metadata-only creation but before
// the first message materializes its rollout. Keep the same empty conversation
// and explicitly override the selected model on its first turn.
const selectedBeforeFirstTurn = keepAliveHarness({ unmaterializedFullRead: true });
selectedBeforeFirstTurn.state.readThread.thread.turns = [];
assert.equal((await prepareKeepAliveThreadThroughDesktop(selectedBeforeFirstTurn.session, keepAliveArguments)).ok, true);
selectedBeforeFirstTurn.state.catalog = selectedModelCatalog;
assert.equal((await sendKeepAliveThroughDesktop(selectedBeforeFirstTurn.session,
  { ...selectedArgs, threadId: THREAD_ID })).ok, true);
assert.equal(selectedBeforeFirstTurn.state.calls.filter(({ method }) => method === "thread/start").length, 1);
assert.equal(selectedBeforeFirstTurn.state.calls.some(({ method }) => method === "thread/resume"), false);
const firstSelectedTurn = selectedBeforeFirstTurn.state.calls.find(({ method }) => method === "turn/start");
assert.equal(firstSelectedTurn.params.threadId, THREAD_ID);
assert.equal(firstSelectedTurn.params.model, CHOSEN_MODEL);
assert.equal(firstSelectedTurn.params.effort, "low");

for (const [label, modelRow] of [
  ["not in catalog", null],
  ["not low capable", { model: CHOSEN_MODEL, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
  ["hidden model", { model: CHOSEN_MODEL, hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }],
]) {
  for (const operation of [prepareKeepAliveThreadThroughDesktop, sendKeepAliveThroughDesktop]) {
    const rejected = keepAliveHarness({ catalog: { data: [selectedModelCatalog.data[0], ...(modelRow ? [modelRow] : [])] } });
    assert.equal((await readKeepAliveContextThroughDesktop(rejected.session, { model: CHOSEN_MODEL })).reason,
      "keep-alive-low-model-unavailable", label);
    const result = await operation(rejected.session, selectedArgs);
    assert.equal(result.ok, false, label);
    assert.equal(result.uncertain, false, label);
    assert.equal(result.reason, "keep-alive-low-model-unavailable", label);
    assert.equal(rejected.state.calls.some(({ method }) => ["thread/start", "thread/resume", "turn/start"].includes(method)), false,
      `${label}: must not fallback to the available Luna model`);
  }
}
const selectedMismatch = keepAliveHarness({ catalog: selectedModelCatalog, threadSettings: { model: "gpt-6-luna" } });
assert.equal((await sendKeepAliveThroughDesktop(selectedMismatch.session, selectedArgs)).reason,
  "keep-alive-thread-settings-mismatch");
assert.equal(selectedMismatch.state.calls.some(({ method }) => method === "turn/start"), false);
for (const model of [null, "", " model ", "model\n", "a".repeat(101), {}]) {
  const invalidModel = keepAliveHarness();
  assert.equal((await sendKeepAliveThroughDesktop(invalidModel.session, { ...keepAliveArguments, model })).reason,
    "invalid-keep-alive-model");
  assert.equal(invalidModel.state.calls.length, 0);
}

// Model changes never reset the renderer's permanent send barrier for a node.
const changedAfterUnknown = keepAliveHarness({ catalog: selectedModelCatalog, failMethod: "turn/start" });
assert.equal((await sendKeepAliveThroughDesktop(changedAfterUnknown.session, selectedArgs)).uncertain, true);
const callsAfterUnknown = changedAfterUnknown.state.calls.length;
assert.equal((await sendKeepAliveThroughDesktop(changedAfterUnknown.session, keepAliveArguments)).uncertain, true);
assert.equal(changedAfterUnknown.state.calls.length, callsAfterUnknown);

console.log("PASS: daily keep-alive distinguishes rolling quota estimates at every preflight, filters low-effort models, reuses the dedicated thread, and retains account/permission/non-retry guards.");
