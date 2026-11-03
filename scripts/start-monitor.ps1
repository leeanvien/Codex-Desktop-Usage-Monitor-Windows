[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 9335,
  [switch]$LaunchCodex,
  [switch]$Replace,
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'monitor-utils.ps1')

$injector = Join-Path $PSScriptRoot 'injector.mjs'

$mutexName = 'Local\CodexUsageMonitor'
$mutex = [Threading.Mutex]::new($false, $mutexName)
$mutexAcquired = $false
try {
  try { $mutexAcquired = $mutex.WaitOne([TimeSpan]::FromSeconds(45)) }
  catch [Threading.AbandonedMutexException] { $mutexAcquired = $true }
  if (-not $mutexAcquired) { throw '另一个监视器启动操作仍在进行，请稍后再试。' }

function Test-MonitorInjection([int]$CandidatePort, [int]$ExpectedPid, [int]$TimeoutMs = 4000) {
  $probeTimeoutMs = [Math]::Min(120000, [Math]::Max(1000, $TimeoutMs + 2000))
  $argumentLine = "`"$injector`" --verify --port $CandidatePort --expected-pid $ExpectedPid --monitor-only --timeout-ms $TimeoutMs"
  try {
    $result = Invoke-CodexUsageProcessWithTimeout -FilePath $node -ArgumentLine $argumentLine -TimeoutMs $probeTimeoutMs
  } catch {
    Write-Warning "注入验证探针失败，将继续重试：$($_.Exception.Message)"
    return $false
  }
  if ($result.TimedOut) {
    Write-Warning "注入验证进程超过 $probeTimeoutMs 毫秒，已自动终止。"
    return $false
  }
  return $result.ExitCode -eq 0
}

$activePort = Resolve-CodexUsageCdpPort $Port
if (-not $activePort) {
  $pendingDesktop = Get-CodexUsagePendingDesktop -PreferredPort $Port
  if ($pendingDesktop) {
    $waiter = Start-CodexUsageReadinessWaiter -Port $pendingDesktop.Port -CodexProcessId $pendingDesktop.ProcessId -CodexStartTimeUtcTicks $pendingDesktop.StartTimeUtcTicks
    Write-Host "Codex 已启用监视端口 $($pendingDesktop.Port)，界面尚未就绪；后台将持续等待并自动连接（$($waiter.Status)，PID $($waiter.ProcessId)）。"
    return
  }
}
if (-not $activePort) {
  if (-not $LaunchCodex) { throw '没有找到带 CDP 的 Codex。请先使用“Codex Usage Monitor”快捷方式启动 Codex。' }
  if (@(Get-CodexUsageDesktopProcesses).Count -gt 0) {
    throw 'Codex 已经运行但未开放 CDP。请正常退出后再使用监视器启动器；脚本不会强制结束现有会话。'
  }
  $Port = Resolve-CodexUsageAvailablePort -PreferredPort $Port
  [void](Start-CodexUsagePackagedCodex -Port $Port)
  # Activation returns before the main process necessarily appears in CIM.
  # Wait only for its identity; the separate helper owns slow UI/network startup.
  $identityDeadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $pendingDesktop = Get-CodexUsagePendingDesktop -PreferredPort $Port
    if ($pendingDesktop) { break }
    if ([DateTime]::UtcNow -ge $identityDeadline) { throw 'Codex 启动请求已发送，但尚未确认主进程身份；未结束 Codex，请稍后重新点击监视器快捷方式。' }
    Start-Sleep -Milliseconds 400
  } while ($true)
  $waiter = Start-CodexUsageReadinessWaiter -Port $pendingDesktop.Port -CodexProcessId $pendingDesktop.ProcessId -CodexStartTimeUtcTicks $pendingDesktop.StartTimeUtcTicks
  Write-Host "Codex 正在启动；后台将等待界面就绪后自动连接（端口 $($pendingDesktop.Port)，PID $($waiter.ProcessId)）。"
  return
}
$Port = $activePort

$node = Resolve-CodexUsageNodePath
# Read the version from the actual CDP-enabled Store process path. The EXE's
# file version is Chromium's version; an installed but inactive update is not
# the running Codex version. Non-Store builds are tracked by renderer assets.
$env:CODEX_USAGE_DESKTOP_VERSION = ''
try {
  $activeDesktop = Get-CodexUsagePendingDesktop -PreferredPort $Port
  $versionMatch = [regex]::Match([string]$activeDesktop.ExecutablePath, '(?i)[\\/]WindowsApps[\\/]OpenAI\.Codex_(\d+(?:\.\d+){3})_[^\\/]+[\\/]')
  if ($versionMatch.Success) { $env:CODEX_USAGE_DESKTOP_VERSION = $versionMatch.Groups[1].Value }
} catch {}
$powerShellCommand = Get-Command pwsh -ErrorAction SilentlyContinue
if ($powerShellCommand) { $env:CODEX_USAGE_POWERSHELL_PATH = $powerShellCommand.Source }
else { $env:CODEX_USAGE_POWERSHELL_PATH = Get-CodexUsageWindowsPowerShellPath }
$cliPath = Resolve-CodexUsageCliPath
if ($cliPath) { $env:CODEX_USAGE_CODEX_PATH = Resolve-CodexUsageRunnableCliPath -CliPath $cliPath }
try {
  [void](Import-CodexUsagePersistedProvider)
} catch {
  Write-Warning $_.Exception.Message
}
try {
  [void](Import-CodexUsagePersistedAccount)
} catch {
  Write-Warning $_.Exception.Message
}
$env:CODEX_USAGE_ACCOUNT_COUNTER_PATH = $CodexUsageAccountCounterPath

$currentInjectorPath = [IO.Path]::GetFullPath($injector)
$owned = @(Get-CodexUsageInjectorProcesses)
$ownedOnPort = @($owned | Where-Object { $_.Port -eq $Port })
$state = Get-CodexUsageState
$reusable = @($ownedOnPort | Where-Object { Test-CodexUsageReusableInjector $state $_ $currentInjectorPath })
if (-not $Replace) {
  foreach ($candidate in $reusable) {
    $candidateVerified = Test-MonitorInjection $Port $candidate.ProcessId
    $liveCandidate = Get-CodexUsageInjectorById $candidate.ProcessId
    if (-not $liveCandidate -or $liveCandidate.InjectorPath -ne $currentInjectorPath -or $liveCandidate.Port -ne $Port) { continue }
    if ($candidateVerified) {
      $state | Add-Member -NotePropertyName startupPhase -NotePropertyValue 'ready' -Force
      $state | Add-Member -NotePropertyName startupVerifiedAt -NotePropertyValue (Get-Date).ToString('o') -Force
      Write-CodexUsageState $state
      Stop-CodexUsagePreviousInjectors $owned $candidate.ProcessId $true
      Write-Host "Codex 用量监视器已在端口 $Port 运行（PID $($candidate.ProcessId)）。"
      return
    }
    Write-Host "监视器后台正在等待 Codex 界面就绪（端口 $Port，PID $($candidate.ProcessId)）；已复用等待中的后台，不重复启动。"
    return
  }
}

if ($Foreground) {
  if ($owned.Count -gt 0) { throw '已有监视器后台正在运行；前台诊断不会结束它。如需更新，请使用不带 -Foreground 的 -Replace。' }
  & $node $injector --watch --port $Port --monitor-only
  exit $LASTEXITCODE
}

New-Item -ItemType Directory -Force -Path $CodexUsageStateRoot | Out-Null
$launchId = "$PID-$(Get-Date -Format 'yyyyMMddHHmmssfff')"
$stdoutPath = Join-Path $CodexUsageStateRoot "injector-$launchId.log"
$stderrPath = Join-Path $CodexUsageStateRoot "injector-$launchId-error.log"
$arguments = @("`"$injector`"", '--watch', '--port', "$Port", '--monitor-only')
$daemon = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

$verified = $false
$deadline = (Get-Date).AddSeconds(45)
do {
  Start-Sleep -Milliseconds 600
  $daemon.Refresh()
  if ($daemon.HasExited) { break }
  if (Test-MonitorInjection $Port $daemon.Id 5000) { $verified = $true; break }
} while ((Get-Date) -lt $deadline)

$daemon.Refresh()
$startupPhase = Get-CodexUsageStartupPhase (-not $daemon.HasExited) $verified
if ($startupPhase -eq 'failed') {
  throw (Get-CodexUsageStartupFailure $daemon.Id $daemon.ExitCode $stderrPath $stdoutPath)
}

try {
  Write-CodexUsageState ([ordered]@{
    schemaVersion = 2
    runtimeVersion = $CodexUsageVersion
    port = $Port
    injectorPid = $daemon.Id
    injectorPath = $currentInjectorPath
    startedAt = (Get-Date).ToString('o')
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    startupPhase = $startupPhase
    startupVerifiedAt = if ($verified) { (Get-Date).ToString('o') } else { $null }
    previousInjectors = @($owned | Select-Object ProcessId, InjectorPath, Port)
    providerConfigPath = if ($env:CODEX_USAGE_PROVIDER_CONFIG_PATH) { [IO.Path]::GetFullPath($env:CODEX_USAGE_PROVIDER_CONFIG_PATH) } else { $null }
  })
} catch {
  if (-not $daemon.HasExited) { Stop-Process -Id $daemon.Id -Force -ErrorAction SilentlyContinue }
  throw
}

Stop-CodexUsagePreviousInjectors $owned $daemon.Id $verified
if (-not $verified) {
  Write-Host "监视器后台已启动，正在等待 Codex 界面加载（端口 $Port，PID $($daemon.Id)）。后台会继续重试，原监视器暂时保留。"
  return
}
Write-Host "Codex 用量监视器已启动：端口 $Port，PID $($daemon.Id)。"
} finally {
  if ($mutexAcquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
