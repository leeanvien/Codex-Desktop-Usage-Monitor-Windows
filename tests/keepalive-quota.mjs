import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { classifyKeepAliveWindow, keepAliveQuotaReason } from "../scripts/keepalive-quota.mjs";

const NOW = Date.UTC(2026, 9, 18, 2, 30);
const HOUR = 3_600_000;
const sample = (at, changes = {}) => ({
  accountId: "fixture-account", capturedAt: at, ordinaryUsageAllowed: true,
  fiveHour: { usedPercent: 0, resetsAt: at + 5 * HOUR },
  weekly: { usedPercent: 25, resetsAt: at + 7 * 24 * HOUR }, ...changes,
});

test("a future reset or rounded zero alone is not permission to send", () => {
  const quota = sample(NOW);
  assert.equal(classifyKeepAliveWindow(quota, NOW), "unknown");
  assert.equal(keepAliveQuotaReason(quota, NOW), "window-observing");
  assert.equal(classifyKeepAliveWindow({ ...quota, activeFiveHour: false }, NOW), "unknown");
});

test("only fresh same-account observations of a moving five-hour estimate prove idle", () => {
  for (const span of [60_000, 90_000, 180_000]) {
    const quota = sample(NOW + span);
    assert.equal(classifyKeepAliveWindow(quota, NOW + span, sample(NOW)), "idle");
    assert.equal(keepAliveQuotaReason(quota, NOW + span, sample(NOW)), null);
  }
  for (const span of [0, 30_000, 59_999, 180_001]) {
    assert.equal(classifyKeepAliveWindow(sample(NOW + span), NOW + span, sample(NOW)), "unknown");
  }
  assert.equal(classifyKeepAliveWindow(sample(NOW + 60_000), NOW + 60_000,
    sample(NOW, { accountId: "other" })), "unknown");
});

test("a fixed future window remains active even with zero reported usage", () => {
  const quota = sample(NOW + 60_000, { fiveHour: { usedPercent: 0, resetsAt: NOW + 5 * HOUR } });
  assert.equal(classifyKeepAliveWindow(quota, NOW + 60_000, sample(NOW)), "active");
  assert.equal(keepAliveQuotaReason(quota, NOW + 60_000, sample(NOW)), "active-window");
  assert.equal(classifyKeepAliveWindow(sample(NOW, { fiveHour: { usedPercent: 0.1, resetsAt: NOW + HOUR } }), NOW), "active");
});

test("unrelated reset changes and backwards samples cannot prove idle", () => {
  const baseline = sample(NOW);
  for (const reset of [NOW + 5 * HOUR - 30_000, NOW + 5 * HOUR + 30_000, NOW + 6 * HOUR]) {
    assert.equal(classifyKeepAliveWindow(sample(NOW + 60_000, { fiveHour: { usedPercent: 0, resetsAt: reset } }), NOW + 60_000, baseline), "unknown");
  }
  assert.equal(classifyKeepAliveWindow(sample(NOW), NOW, sample(NOW + 60_000)), "unknown");
  assert.equal(classifyKeepAliveWindow(sample(NOW + 60_000), NOW + 60_000,
    sample(NOW, { fiveHour: { usedPercent: 1, resetsAt: NOW + 5 * HOUR } })), "unknown");
});

test("sampling jitter has explicit bounds and cannot allow arbitrary future horizons", () => {
  const baseline = sample(NOW);
  const at = NOW + 60_000;
  assert.equal(classifyKeepAliveWindow(sample(at, { fiveHour: { usedPercent: 0, resetsAt: at + 5 * HOUR + 5000 } }), at, baseline), "idle");
  assert.equal(classifyKeepAliveWindow(sample(at, { fiveHour: { usedPercent: 0, resetsAt: at + 5 * HOUR + 5001 } }), at, baseline), "unknown");
  assert.equal(classifyKeepAliveWindow(sample(at, { fiveHour: { usedPercent: 0, resetsAt: at + 6 * HOUR } }), at,
    sample(NOW, { fiveHour: { usedPercent: 0, resetsAt: NOW + 6 * HOUR } })), "unknown");
});

test("expired counters may recover while genuinely exhausted windows still block", () => {
  const quota = sample(NOW, { fiveHour: { usedPercent: 100, resetsAt: NOW } });
  assert.equal(classifyKeepAliveWindow(quota, NOW), "expired");
  assert.equal(keepAliveQuotaReason(quota, NOW), null);
  assert.equal(keepAliveQuotaReason(sample(NOW, { fiveHour: { usedPercent: 100, resetsAt: NOW + 1 } }), NOW), "quota-exhausted");
  assert.equal(keepAliveQuotaReason({ ...quota, weekly: { usedPercent: 100, resetsAt: NOW + 1 } }, NOW), "quota-exhausted");
  assert.equal(keepAliveQuotaReason({ ...quota, weekly: { usedPercent: 100, resetsAt: NOW } }, NOW), null);
});

test("freshness, malformed data and missing server permission remain closed", () => {
  const quota = sample(NOW, { fiveHour: { usedPercent: 0, resetsAt: NOW - 1 } });
  for (const patch of [{ ordinaryUsageAllowed: false }, { ordinaryUsageAllowed: null }, { accountId: "" },
    { capturedAt: NOW - 90_001 }, { capturedAt: NOW + 5001 }, { fiveHour: null }, { weekly: null },
    { fiveHour: { usedPercent: NaN, resetsAt: NOW } }, { weekly: { usedPercent: 101, resetsAt: NOW } }]) {
    assert.equal(keepAliveQuotaReason({ ...quota, ...patch }, NOW), "quota-unavailable");
  }
});

test("the exact same classifier and quota gate can run in the desktop expression", () => {
  const expression = `(${classifyKeepAliveWindow.toString()});`;
  assert.equal(typeof vm.runInNewContext(expression), "function");
  const context = vm.createContext({ quota: sample(NOW + 60_000), baseline: sample(NOW), now: NOW + 60_000 });
  assert.equal(vm.runInContext(`${classifyKeepAliveWindow.toString()}\n${keepAliveQuotaReason.toString()}\nkeepAliveQuotaReason(quota, now, baseline)`, context), null);
});
