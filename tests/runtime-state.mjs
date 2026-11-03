import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { replaceRuntimeState } from "../scripts/replace-runtime-state.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(projectRoot, "scripts", "replace-runtime-state.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-state-"));
const statePath = path.join(root, "state.json");
const temporaryPath = path.join(root, "state.json." + process.pid + ".tmp");
const originalText = JSON.stringify({ injectorPid: 123, startupPhase: "ready" });
const replacementText = JSON.stringify({ injectorPid: 456, startupPhase: "waiting-ui" });
try {
  await fs.writeFile(statePath, originalText);
  await fs.writeFile(temporaryPath, replacementText);
  await replaceRuntimeState(temporaryPath, statePath);
  assert.equal(await fs.readFile(statePath, "utf8"), replacementText);
  await assert.rejects(fs.stat(temporaryPath), { code: "ENOENT" });

  await fs.unlink(statePath);
  await fs.writeFile(temporaryPath, originalText);
  await replaceRuntimeState(temporaryPath, statePath);
  assert.equal(await fs.readFile(statePath, "utf8"), originalText, "first creation is supported");

  const otherDirectory = path.join(root, "other");
  await fs.mkdir(otherDirectory);
  const outsidePath = path.join(otherDirectory, "state.json");
  await fs.writeFile(outsidePath, "outside fixture remains unchanged");
  for (const [source, destination] of [
    [temporaryPath, outsidePath],
    [temporaryPath, path.join(root, "provider.json")],
    [path.join(root, "unrelated.tmp"), statePath],
    [path.join(root, "state.json.0.tmp"), statePath],
    [path.join(root, "state.json.12.extra.tmp"), statePath],
  ]) {
    await fs.writeFile(source, replacementText);
    await assert.rejects(replaceRuntimeState(source, destination), /Only a monitor runtime state/);
    assert.equal(await fs.readFile(source, "utf8"), replacementText, "rejected input is preserved");
    assert.equal(await fs.readFile(statePath, "utf8"), originalText, "rejected paths cannot change runtime state");
    assert.equal(await fs.readFile(outsidePath, "utf8"), "outside fixture remains unchanged");
  }
  await assert.rejects(replaceRuntimeState(null, statePath), /paths are required/);
  await assert.rejects(replaceRuntimeState(temporaryPath, ""), /paths are required/);
  await fs.rm(temporaryPath);
  await fs.mkdir(temporaryPath);
  await assert.rejects(replaceRuntimeState(temporaryPath, statePath), /source must be a regular file/);
  await fs.rmdir(temporaryPath);
  await fs.writeFile(temporaryPath, replacementText);
  await fs.unlink(statePath);
  await fs.mkdir(statePath);
  await assert.rejects(replaceRuntimeState(temporaryPath, statePath), /destination must be a regular file/);
  assert.equal(await fs.readFile(temporaryPath, "utf8"), replacementText);
  await fs.rmdir(statePath);

  const cliSuccess = spawnSync(process.execPath, [helperPath, temporaryPath, statePath], { encoding: "utf8", windowsHide: true });
  assert.equal(cliSuccess.status, 0, cliSuccess.stderr);
  assert.equal(cliSuccess.stdout, "", "the helper does not print state data");
  assert.equal(cliSuccess.stderr, "");
  const cliFailure = spawnSync(process.execPath, [helperPath, outsidePath, statePath], { encoding: "utf8", windowsHide: true });
  assert.equal(cliFailure.status, 1);
  assert.equal(cliFailure.stdout, "");
  assert.equal(cliFailure.stderr.trim(), "Failed to atomically save monitor runtime state.");
  assert.equal(await fs.readFile(outsidePath, "utf8"), "outside fixture remains unchanged");
  assert.equal(await fs.readFile(statePath, "utf8"), replacementText);

  if (process.platform === "win32") {
    const psLiteral = (value) => "'" + value.replaceAll("'", "''") + "'";
    const psTestRoot = path.join(root, "powershell");
    const scriptPath = path.join(root, "fallback-test.ps1");
    await fs.writeFile(scriptPath, [
      "$ErrorActionPreference = 'Stop'",
      ". " + psLiteral(path.join(projectRoot, "scripts", "monitor-utils.ps1")),
      "$CodexUsageStateRoot = " + psLiteral(psTestRoot),
      "$CodexUsageStatePath = Join-Path $CodexUsageStateRoot 'state.json'",
      "$script:runtimeStateNode = " + psLiteral(process.execPath),
      "$script:fallbacks = 0",
      "function Resolve-CodexUsageNodePath { $script:fallbacks++; return $script:runtimeStateNode }",
      "function Move-Item { param($LiteralPath, $Destination, [switch]$Force, $ErrorAction) throw 'simulated Store overlay Move-Item failure' }",
      "New-Item -ItemType Directory -Path $CodexUsageStateRoot -Force | Out-Null",
      "[IO.File]::WriteAllText($CodexUsageStatePath, '{\"injectorPid\":111}')",
      "Write-CodexUsageState ([pscustomobject]@{ injectorPid = 222; startupPhase = 'ready' })",
      "$actual = Get-Content -LiteralPath $CodexUsageStatePath -Raw | ConvertFrom-Json",
      "if ($actual.injectorPid -ne 222 -or $actual.startupPhase -ne 'ready') { throw 'Fallback failed to atomically replace the existing state.' }",
      "if ($script:fallbacks -ne 1) { throw 'Move-Item failure must resolve and invoke the Node fallback exactly once.' }",
      'if (Test-Path -LiteralPath "$CodexUsageStatePath.$PID.tmp") { throw "Successful fallback left a temporary file." }',
      "Remove-Item -LiteralPath $CodexUsageStatePath -Force",
      "New-Item -ItemType Directory -Path $CodexUsageStatePath | Out-Null",
      "$rejected = $false",
      "try { Write-CodexUsageState ([pscustomobject]@{ injectorPid = 333 }) }",
      "catch { $rejected = $true }",
      "if (-not $rejected) { throw 'A failing atomic fallback must be surfaced to the launcher.' }",
      "if (-not (Test-Path -LiteralPath $CodexUsageStatePath -PathType Container)) { throw 'A rejected destination must remain unchanged.' }",
      'if (Test-Path -LiteralPath "$CodexUsageStatePath.$PID.tmp") { throw "Failed fallback left the launcher temporary file." }',
      "Write-Output 'PASS: PowerShell runtime state fallback and failure propagation.'",
    ].join("\n"), "utf8");
    const shells = ["pwsh.exe"];
    if (process.env.SystemRoot) shells.push(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    for (const shell of shells) {
      const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        encoding: "utf8", windowsHide: true,
      });
      if (result.error?.code === "ENOENT" && shell === "pwsh.exe") continue;
      assert.equal(result.status, 0, shell + ": " + result.stdout + "\n" + result.stderr);
      assert.match(result.stdout, /PASS: PowerShell runtime state fallback/);
      await fs.rm(psTestRoot, { recursive: true, force: true });
    }
  }
  console.log("PASS: atomic runtime state replacement, path boundaries, and PowerShell fallback.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
