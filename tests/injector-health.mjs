import assert from "node:assert/strict";
import vm from "node:vm";
import { backendHeartbeatExpression, backendVerificationExpression, CdpSession, nextEndpointLoss, refreshBackendHeartbeats, runOnce } from "../scripts/injector.mjs";

const now = Date.now();
const document = { getElementById: () => ({ shadowRoot: {} }) };
const window = { __CODEX_USAGE_MONITOR_STATE__: { usage: { currentThreadId: "preserve-me" } } };
const context = vm.createContext({ window, document });
const evaluate = (expression) => vm.runInContext(expression, context);
assert.equal(evaluate(backendVerificationExpression(123, now)).backendRunning, false, "leftover panel is not backend liveness");
evaluate(backendHeartbeatExpression(123, now));
assert.equal(evaluate(backendVerificationExpression(123, now + 1000)).backendRunning, true);
assert.equal(evaluate(backendVerificationExpression(456, now + 1000)).backendRunning, false, "old process cannot verify its replacement");
assert.equal(evaluate(backendVerificationExpression(123, now + 16000)).backendRunning, false);
document.getElementById = () => null;
evaluate(backendHeartbeatExpression(456, now));
assert.equal(evaluate(backendVerificationExpression(456, now + 1000)).phase, "waiting-composer");
assert.equal(evaluate(backendVerificationExpression(456, now + 1000)).backendRunning, true, "slow/absent Composer is not a stopped daemon");
assert.equal(evaluate(backendVerificationExpression(123, now + 1000)).backendRunning, true, "each candidate owns its own heartbeat");
assert.equal(nextEndpointLoss(null, true, now + 600000).shouldExit, false, "responsive desktop without a page can load arbitrarily slowly");
const loss = nextEndpointLoss(null, false, now);
assert.equal(nextEndpointLoss(loss.missingSince, false, now + 179999).shouldExit, false);
assert.equal(nextEndpointLoss(loss.missingSince, false, now + 180000).shouldExit, true, "closed desktop eventually releases daemon");
assert.deepEqual(nextEndpointLoss(loss.missingSince, true, now + 150000), { missingSince: null, shouldExit: false });

// Exercise the actual CLI verification route with an isolated CDP transport.
// Any injected code, settings writes or runtime bindings would fail these checks.
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const originalLog = console.log;
const originalExitCode = process.exitCode;
const methods = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor() { super(); this.readyState = 0; setTimeout(() => { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event("open")); }, 0); }
  send(text) {
    const message = JSON.parse(text);
    methods.push(message.method);
    let result = {};
    if (message.method === "Runtime.evaluate") result = { result: { value: evaluate(message.params.expression) } };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: message.id, result }) })));
  }
  close() { this.readyState = FakeSocket.CLOSING; queueMicrotask(() => { this.readyState = FakeSocket.CLOSED; this.dispatchEvent(new Event("close")); }); }
}
try {
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: "main", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/main" }] });
  const results = [];
  console.log = (text) => results.push(JSON.parse(text));
  const previousUsage = JSON.stringify(window.__CODEX_USAGE_MONITOR_STATE__);
  await runOnce({ mode: "verify", port: 9335, timeoutMs: 1000, expectedPid: 456 });
  assert.equal(results.at(-1).verified, true);
  assert.equal(JSON.stringify(window.__CODEX_USAGE_MONITOR_STATE__), previousUsage);
  assert.deepEqual([...new Set(methods)].sort(), ["Page.enable", "Runtime.enable", "Runtime.evaluate"]);
  methods.length = 0;
  await runOnce({ mode: "verify", port: 9335, timeoutMs: 1000, expectedPid: 999 });
  assert.equal(results.at(-1).verified, false);
  assert.equal(process.exitCode, 1);
  assert.equal(JSON.stringify(window.__CODEX_USAGE_MONITOR_STATE__), previousUsage);

  const session = new CdpSession({ webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/main" }, 1000);
  await session.open();
  session.ws.send = () => {}; // The renderer disappears with commands in flight.
  const pending = session.send("Runtime.evaluate").then(() => "resolved", (error) => error.message);
  await session.close();
  let timeout;
  const outcome = await Promise.race([pending, new Promise((resolve) => { timeout = setTimeout(() => resolve("still pending"), 100); })]);
  clearTimeout(timeout);
  assert.equal(outcome, "CDP session is closed", "closing a target must settle every in-flight command");
  assert.equal(session.pending.size, 0);
  await assert.rejects(session.send("Runtime.evaluate"), /session is closed/);
  await session.close(); // Idempotent close must preserve rejection semantics.

  const healthy = new CdpSession({ webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/healthy" }, 1000);
  const frozen = new CdpSession({ webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/frozen" }, 1000);
  await healthy.open();
  await frozen.open();
  frozen.ws.send = () => {}; // OPEN transport whose renderer no longer responds.
  const healthyEntry = { session: healthy, healthReady: true };
  const frozenEntry = { session: frozen, healthReady: true };
  const entries = new Map([["healthy", healthyEntry], ["frozen", frozenEntry]]);
  const alive = [];
  const failures = [];
  const callbacks = { pid: 801, timeoutMs: 40, onAlive: (entry) => alive.push(entry), onFailure: (error) => failures.push(error.message) };
  const firstProbe = refreshBackendHeartbeats(entries, callbacks);
  const duplicateProbe = refreshBackendHeartbeats(entries, callbacks);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(alive, [healthyEntry], "a frozen renderer must not delay another window's heartbeat");
  assert.equal(frozen.pending.size, 1, "repeated ticks must not pile up commands on a frozen session");
  await Promise.all([firstProbe, duplicateProbe]);
  assert.equal(entries.has("frozen"), false, "timeout must evict an OPEN but unresponsive connection so attachment can retry");
  assert.equal(frozen.closed, true);
  assert.equal(entries.get("healthy"), healthyEntry);
  assert.equal(failures.length, 1);
  const recovered = new CdpSession({ webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/frozen" }, 1000);
  await recovered.open();
  entries.set("frozen", { session: recovered, healthReady: true });
  await refreshBackendHeartbeats(entries, callbacks);
  assert.equal(alive.length, 3, "both windows must receive heartbeats after fresh attachment");
  await healthy.close();
  await recovered.close();

  let rejectPrevious;
  let previousClosed = false;
  const previous = { healthReady: true, session: { evaluate: () => new Promise((_, reject) => { rejectPrevious = reject; }), close: async () => { previousClosed = true; } } };
  const replacement = { healthReady: false, session: {} };
  const changing = new Map([["same-target", previous]]);
  const previousProbe = refreshBackendHeartbeats(changing);
  changing.set("same-target", replacement);
  rejectPrevious(new Error("old transport failed"));
  await previousProbe;
  assert.equal(changing.get("same-target"), replacement, "late failure must not remove a replacement connection");
  assert.equal(previousClosed, true);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  console.log = originalLog;
  process.exitCode = originalExitCode;
}
console.log("PASS: read-only PID heartbeat verification, slow Composer readiness, frozen renderer isolation/reconnection, endpoint recovery, and stale panel rejection.");
