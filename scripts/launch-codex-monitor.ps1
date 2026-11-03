[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 9335,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'monitor-utils.ps1')

function Get-CodexMonitorLaunchPlan([bool]$DebugReady, [bool]$CodexRunning, [bool]$CdpPending = $false) {
  if ($DebugReady) { return 'reuse-codex' }
  if ($CdpPending) { return 'wait-codex' }
  if ($CodexRunning) { return 'blocked-running-without-cdp' }
  return 'launch-codex'
}

if ($SelfTest) {
  $cases = @(
    @{ DebugReady = $true; CodexRunning = $true; CdpPending = $false; Expected = 'reuse-codex' },
    @{ DebugReady = $true; CodexRunning = $false; CdpPending = $false; Expected = 'reuse-codex' },
    @{ DebugReady = $false; CodexRunning = $true; CdpPending = $false; Expected = 'blocked-running-without-cdp' },
    @{ DebugReady = $false; CodexRunning = $true; CdpPending = $true; Expected = 'wait-codex' },
    @{ DebugReady = $false; CodexRunning = $false; CdpPending = $false; Expected = 'launch-codex' }
  )
  foreach ($case in $cases) {
    if ((Get-CodexMonitorLaunchPlan $case.DebugReady $case.CodexRunning $case.CdpPending) -ne $case.Expected) { throw '监视器启动决策测试失败。' }
  }
  $injectorPath = Join-Path $PSScriptRoot 'injector.mjs'
  $injectorProcess = [pscustomobject]@{ ProcessId = 42; InjectorPath = $injectorPath }
  $legacyState = [pscustomobject]@{ injectorPid = 42; injectorPath = $injectorPath }
  $currentState = [pscustomobject]@{ injectorPid = 42; injectorPath = $injectorPath; runtimeVersion = $CodexUsageVersion }
  if (Test-CodexUsageReusableInjector $legacyState $injectorProcess $injectorPath) { throw '旧版状态不应复用新版监视器进程。' }
  if (-not (Test-CodexUsageReusableInjector $currentState $injectorProcess $injectorPath)) { throw '当前版本状态应允许复用监视器进程。' }
  $testListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $testListener.Server.ExclusiveAddressUse = $true
    $testListener.Start()
    $occupiedPort = ([Net.IPEndPoint]$testListener.LocalEndpoint).Port
    if (Test-CodexUsageTcpPortAvailable $occupiedPort) { throw '已占用端口不应被识别为可用。' }
    $searchCount = [Math]::Min(32, 65536 - $occupiedPort)
    $availablePort = Resolve-CodexUsageAvailablePort -PreferredPort $occupiedPort -SearchCount $searchCount
    if ($availablePort -le $occupiedPort -or -not (Test-CodexUsageTcpPortAvailable $availablePort)) { throw '端口冲突时应选择后续可用端口。' }
  } finally {
    $testListener.Stop()
  }
  if (-not (Test-CodexUsageTcpPortAvailable $occupiedPort)) { throw '监听器关闭后端口应恢复可用。' }
  $orderedPorts = @(Get-CodexUsageCdpCandidates -PreferredPort 9335 -ProcessPorts @(9338, 9338) -ActiveFilePort 9337 -StatePort 9336)
  if (($orderedPorts -join ',') -ne '9338,9337,9336,9335,9229') { throw 'CDP 端口候选顺序测试失败。' }
  Write-Host 'PASS: Codex monitor launcher decisions.'
  return
}

function Show-CodexMonitorMessage([string]$Message, [string]$Icon = 'Information') {
  try {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($Message, 'Codex 用量监视器', [System.Windows.MessageBoxButton]::OK, [System.Windows.MessageBoxImage]::$Icon)
  } catch { Write-Error $Message }
}

function Write-CodexMonitorLaunchError([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $CodexUsageStateRoot | Out-Null
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    [IO.File]::WriteAllText((Join-Path $CodexUsageStateRoot 'launcher-error.log'), $line, $CodexUsageUtf8)
  } catch {}
}

$launcherMutex = [Threading.Mutex]::new($false, 'Local\CodexUsageMonitorLauncher')
$launcherMutexAcquired = $false
try {
  try { $launcherMutexAcquired = $launcherMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $launcherMutexAcquired = $true }
  if (-not $launcherMutexAcquired) {
    Write-Host '监视器启动操作已在进行，已复用该操作；不会重复启动 Codex。'
    return
  }
  $codexRunning = @(Get-CodexUsageDesktopProcesses).Count -gt 0
  $activePort = if ($codexRunning) { Resolve-CodexUsageCdpPort $Port } else { 0 }
  $debugReady = [bool]$activePort
  $pendingDesktop = if ($codexRunning -and -not $debugReady) { Get-CodexUsagePendingDesktop -PreferredPort $Port } else { $null }
  $plan = Get-CodexMonitorLaunchPlan $debugReady $codexRunning ([bool]$pendingDesktop)
  if ($plan -eq 'blocked-running-without-cdp') {
    Show-CodexMonitorMessage 'Codex 已通过原生入口运行，无法在不中断会话的情况下补加监视端口。请先正常退出 Codex，再点击“Codex Usage Monitor”。' 'Warning'
    exit 2
  }
  if ($debugReady) { $Port = $activePort }
  if ($pendingDesktop) { $Port = $pendingDesktop.Port }
  if ($plan -eq 'launch-codex') {
    $Port = Resolve-CodexUsageAvailablePort -PreferredPort $Port
    [void](Start-CodexUsagePackagedCodex -Port $Port)
    # Confirm the activated process, not the renderer/network. A separate hidden
    # helper owns slow desktop startup and survives the old 180-second deadline.
    $identityDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      $pendingDesktop = Get-CodexUsagePendingDesktop -PreferredPort $Port
      if ($pendingDesktop) { $Port = $pendingDesktop.Port; break }
      if ([DateTime]::UtcNow -ge $identityDeadline) { throw 'Codex 启动请求已发送，但尚未确认主进程身份；未结束 Codex，请稍后重新点击监视器快捷方式。' }
      Start-Sleep -Milliseconds 400
    } while ($true)
  }
  & (Join-Path $PSScriptRoot 'start-monitor.ps1') -Port $Port
  # start-monitor.ps1 throws on failure. LASTEXITCODE may still contain a failed
  # readiness probe while the daemon is legitimately waiting for the renderer.
} catch {
  $message = "启动失败。`n`n$($_.Exception.Message)"
  Write-CodexMonitorLaunchError $message
  Show-CodexMonitorMessage $message 'Error'
  exit 1
} finally {
  if ($launcherMutexAcquired) { try { $launcherMutex.ReleaseMutex() } catch {} }
  $launcherMutex.Dispose()
}
