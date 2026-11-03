import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renameMonitorFileAtomic } from "./windows-files.mjs";

// PowerShell's Move-Item can fail to replace state.json across a Store/MSIX
// overlay. Accept only the launcher's own state temporary file, then use the
// same atomic real-path compatibility as the monitor's other file writers.
export async function replaceRuntimeState(source, destination) {
  if (typeof source !== "string" || typeof destination !== "string" || !source || !destination) {
    throw new TypeError("Monitor runtime state paths are required.");
  }
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  const sameDirectory = process.platform === "win32"
    ? path.dirname(sourcePath).toLowerCase() === path.dirname(destinationPath).toLowerCase()
    : path.dirname(sourcePath) === path.dirname(destinationPath);
  if (!sameDirectory || path.basename(destinationPath) !== "state.json"
    || !/^state\.json\.[1-9]\d*\.tmp$/.test(path.basename(sourcePath))) {
    throw new Error("Only a monitor runtime state temporary file in the same directory may be replaced.");
  }
  const sourceStat = await fs.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("Runtime state source must be a regular file.");
  try {
    const destinationStat = await fs.lstat(destinationPath);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) throw new Error("Runtime state destination must be a regular file.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await fs.open(sourcePath, "r+");
  try { await handle.sync(); }
  finally { await handle.close(); }
  await renameMonitorFileAtomic(sourcePath, destinationPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Invalid arguments.");
    await replaceRuntimeState(process.argv[2], process.argv[3]);
  } catch {
    // Never print runtime state contents or other private payloads.
    process.stderr.write("Failed to atomically save monitor runtime state.\n");
    process.exitCode = 1;
  }
}
