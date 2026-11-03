[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateRange(1024, 65535)][int]$Port,
  [Parameter(Mandatory = $true)][ValidateRange(1, [int]::MaxValue)][int]$CodexProcessId,
  [Parameter(Mandatory = $true)][ValidateRange(1, [long]::MaxValue)][long]$CodexStartTimeUtcTicks
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'monitor-utils.ps1')

function Write-CodexUsageReadinessLog {
  param(
    [ValidateSet('waiting', 'startup-failed', 'ready', 'exited')][string]$Stage,
    [int]$ProcessId,
    [int]$Port,
    [ValidateSet('none', 'identity-changed', 'runtime-unavailable', 'backend-exited', 'state-write-failed', 'other-startup-error')][string]$Detail = 'none'
  )
  # Log only fixed labels and process/port identifiers. Exception messages can
  # contain private paths or provider data and are deliberately never written.
  try {
    New-Item -ItemType Directory -Force -Path $CodexUsageStateRoot | Out-Null
    $logPath = Join-Path $CodexUsageStateRoot 'readiness-wait.log'
    if ([IO.File]::Exists($logPath) -and ([IO.FileInfo]$logPath).Length -gt 65536) {
      $previous = [IO.File]::ReadAllText($logPath)
      if ($previous.Length -gt 32768) { $previous = $previous.Substring($previous.Length - 32768) }
      [IO.File]::WriteAllText($logPath, $previous, $CodexUsageUtf8)
    }
    $line = "[$([DateTime]::UtcNow.ToString('o'))] $Stage codexPid=$ProcessId port=$Port detail=$Detail`r`n"
    [IO.File]::AppendAllText($logPath, $line, $CodexUsageUtf8)
  } catch {}
}

function Invoke-CodexUsageReadinessWait {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][int]$CodexProcessId,
    [Parameter(Mandatory = $true)][long]$CodexStartTimeUtcTicks,
    [ValidateRange(0, 60000)][int]$PollMilliseconds = 1000
  )
  if (-not (Test-CodexUsageDesktopIdentity -ProcessId $CodexProcessId -StartTimeUtcTicks $CodexStartTimeUtcTicks -Port $Port -RequireCdpArguments)) {
    Write-CodexUsageReadinessLog -Stage exited -ProcessId $CodexProcessId -Port $Port -Detail identity-changed
    return 'exited'
  }
  Write-CodexUsageReadinessLog -Stage waiting -ProcessId $CodexProcessId -Port $Port
  $retryAfter = [DateTime]::MinValue
  while (Test-CodexUsageDesktopIdentity -ProcessId $CodexProcessId -StartTimeUtcTicks $CodexStartTimeUtcTicks -Port $Port) {
    if ([DateTime]::UtcNow -ge $retryAfter -and (Test-CodexUsageCdpPort $Port)) {
      # The identity is checked again after the HTTP probe: the desktop may have
      # exited while a response was in flight. Never activate or restart it here.
      if (-not (Test-CodexUsageDesktopIdentity -ProcessId $CodexProcessId -StartTimeUtcTicks $CodexStartTimeUtcTicks -Port $Port -RequireCdpArguments)) {
        Write-CodexUsageReadinessLog -Stage exited -ProcessId $CodexProcessId -Port $Port -Detail identity-changed
        return 'exited'
      }
      try {
        & (Join-Path $PSScriptRoot 'start-monitor.ps1') -Port $Port
        # If readiness disappeared just before start-monitor acquired its lock,
        # it will preserve this helper. Keep waiting instead of abandoning it.
        if (Test-CodexUsageCdpPort $Port) {
          Write-CodexUsageReadinessLog -Stage ready -ProcessId $CodexProcessId -Port $Port
          return 'ready'
        }
      } catch {
        $failureKind = if ($_.Exception.Message -match '(?i)node|runtime|路径|不存在') { 'runtime-unavailable' }
          elseif ($_.Exception.Message -match '后台已退出') { 'backend-exited' }
          elseif ($_.Exception.Message -match '(?i)state|状态') { 'state-write-failed' }
          else { 'other-startup-error' }
        Write-CodexUsageReadinessLog -Stage startup-failed -ProcessId $CodexProcessId -Port $Port -Detail $failureKind
        Write-Warning "Codex 界面已出现，监视器尚未就绪，后台会继续重试：$($_.Exception.Message)"
        $retryAfter = [DateTime]::UtcNow.AddSeconds(15)
      }
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  }
  Write-CodexUsageReadinessLog -Stage exited -ProcessId $CodexProcessId -Port $Port -Detail identity-changed
  return 'exited'
}

# A repeated shortcut click may start another short-lived helper before CIM can
# enumerate the first one. Only one helper is allowed to wait for this identity.
$waiterMutexName = "Local\CodexUsageMonitorReadiness-$CodexProcessId-$CodexStartTimeUtcTicks-$Port"
$waiterMutex = [Threading.Mutex]::new($false, $waiterMutexName)
$waiterMutexAcquired = $false
try {
  try { $waiterMutexAcquired = $waiterMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $waiterMutexAcquired = $true }
  if (-not $waiterMutexAcquired) { return }
  [void](Invoke-CodexUsageReadinessWait -Port $Port -CodexProcessId $CodexProcessId -CodexStartTimeUtcTicks $CodexStartTimeUtcTicks)
} finally {
  if ($waiterMutexAcquired) { try { $waiterMutex.ReleaseMutex() } catch {} }
  $waiterMutex.Dispose()
}
