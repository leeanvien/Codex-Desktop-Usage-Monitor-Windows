// These functions are also serialized into the desktop read/send expressions.
// Keep them self-contained: no imports, module constants or mutable globals.
export function classifyKeepAliveWindow(quota, now = Date.now(), baseline = null) {
  const validSample = (value, maxAge) => value && typeof value.accountId === "string" && value.accountId.trim()
    && value.accountId === value.accountId.trim() && Number.isFinite(value.capturedAt)
    && value.capturedAt <= now + 5000 && now - value.capturedAt <= maxAge
    && Number.isFinite(value.fiveHour?.usedPercent) && value.fiveHour.usedPercent >= 0 && value.fiveHour.usedPercent <= 100
    && Number.isFinite(value.fiveHour?.resetsAt) && value.fiveHour.resetsAt > 0;
  if (!Number.isFinite(now) || !validSample(quota, 90_000)) return "unknown";
  const current = quota.fiveHour;
  if (current.resetsAt <= now) return "expired";
  if (current.usedPercent > 0) return "active";
  if (!validSample(baseline, 180_000) || baseline.accountId !== quota.accountId) return "unknown";
  const elapsed = quota.capturedAt - baseline.capturedAt;
  if (elapsed < 60_000 || elapsed > 180_000) return "unknown";
  const previous = baseline.fiveHour;
  const resetChange = current.resetsAt - previous.resetsAt;
  // Zero can be a rounded used percentage. A fixed future reset is still an
  // active window; only advancing near-five-hour estimates qualify as idle.
  if (Math.abs(resetChange) <= 2000) return "active";
  const nearFiveHours = (value) => Math.abs(value.fiveHour.resetsAt - value.capturedAt - 18_000_000) <= 15_000;
  if (previous.usedPercent === 0 && quota.ordinaryUsageAllowed === true && baseline.ordinaryUsageAllowed === true
    && nearFiveHours(quota) && nearFiveHours(baseline) && Math.abs(resetChange - elapsed) <= 5000) return "idle";
  return "unknown";
}

export function keepAliveQuotaReason(quota, now = Date.now(), baseline = null) {
  if (!quota || typeof quota.accountId !== "string" || !quota.accountId.trim() || quota.accountId !== quota.accountId.trim()
    || !Number.isFinite(now) || !Number.isFinite(quota.capturedAt) || quota.capturedAt > now + 5000
    || now - quota.capturedAt > 90_000 || quota.ordinaryUsageAllowed !== true) return "quota-unavailable";
  const valid = (window) => window && Number.isFinite(window.usedPercent) && window.usedPercent >= 0
    && window.usedPercent <= 100 && Number.isFinite(window.resetsAt) && window.resetsAt > 0;
  if (!valid(quota.fiveHour) || !valid(quota.weekly)) return "quota-unavailable";
  // A stale percentage belonging to an expired window cannot override the
  // server's fresh ordinaryUsageAllowed=true after the reset.
  if ([quota.fiveHour, quota.weekly].some((window) => window.usedPercent >= 100 && window.resetsAt > now)) return "quota-exhausted";
  const state = classifyKeepAliveWindow(quota, now, baseline);
  if (state === "active") return "active-window";
  if (state === "expired" || state === "idle") return null;
  return "window-observing";
}
