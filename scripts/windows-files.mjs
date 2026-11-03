import fs from "node:fs/promises";
import { renameSync, realpathSync } from "node:fs";
import path from "node:path";

// An older file can still live in the unvirtualized directory while a new
// temporary file is redirected to the Store cache. Atomically publish into
// that same overlay only for this monitor's verified Store mapping. Ordinary
// cross-volume paths must continue to fail.
function storeOverlayDestination(source, destination, physicalSource, physicalDestination, localAppData) {
  if (typeof localAppData !== "string" || !localAppData) return physicalDestination;
  const win = path.win32;
  const equal = (a, b) => win.normalize(a).toLowerCase() === win.normalize(b).toLowerCase();
  if (!equal(win.dirname(source), win.dirname(destination)) || !equal(destination, physicalDestination)) return physicalDestination;
  const relative = win.relative(localAppData, source);
  if (!/^CodexUsageMonitor\\/i.test(relative) || relative.split("\\").includes("..")) return physicalDestination;
  const mapping = /\\AppData\\Local\\Packages\\OpenAI\.Codex_[^\\]+\\LocalCache\\Local\\(.+)$/i.exec(physicalSource);
  if (!mapping || !equal(mapping[1], relative)) return physicalDestination;
  return win.join(win.dirname(physicalSource), win.basename(destination));
}

export function renameMonitorFileAtomicSync(source, destination, { rename = renameSync, realpath = realpathSync.native, localAppData = process.env.LOCALAPPDATA } = {}) {
  try { rename(source, destination); return; }
  catch (error) { if (error?.code !== "EXDEV") throw error; }
  const physicalSource = realpath(source);
  let physicalDestination;
  try { physicalDestination = realpath(destination); }
  catch (error) {
    if (error?.code !== "ENOENT" || path.resolve(path.dirname(source)) !== path.resolve(path.dirname(destination))) throw error;
    physicalDestination = path.join(path.dirname(physicalSource), path.basename(destination));
  }
  rename(physicalSource, storeOverlayDestination(source, destination, physicalSource, physicalDestination, localAppData));
}

export async function renameMonitorFileAtomic(source, destination, { rename = fs.rename, realpath = fs.realpath, localAppData = process.env.LOCALAPPDATA } = {}) {
  try { await rename(source, destination); return; }
  catch (error) { if (error?.code !== "EXDEV") throw error; }
  // Store/MSIX virtualization can expose C: aliases for files physically on
  // another drive. Resolve only after EXDEV; keep an atomic rename, never a
  // copy-and-delete fallback that could corrupt settings or a send journal.
  const physicalSource = await realpath(source);
  let physicalDestination;
  try { physicalDestination = await realpath(destination); }
  catch (error) {
    if (error?.code !== "ENOENT" || path.resolve(path.dirname(source)) !== path.resolve(path.dirname(destination))) throw error;
    physicalDestination = path.join(path.dirname(physicalSource), path.basename(destination));
  }
  await rename(physicalSource, storeOverlayDestination(source, destination, physicalSource, physicalDestination, localAppData));
}
