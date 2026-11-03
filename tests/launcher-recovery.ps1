[CmdletBinding()]
param([ValidateRange(0, 600)][int]$LongDelaySeconds = 0)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $projectRoot 'scripts/monitor-utils.ps1')

function Assert-Recovery($Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Read-RecoveryAst([string]$Path) {
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
  Assert-Recovery ($parseErrors.Count -eq 0) "Recovery source must parse: $Path"
  return $ast
}

function Get-RecoveryFunction([Management.Automation.Language.ScriptBlockAst]$Ast, [string]$Name) {
  $definition = $Ast.Find({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $Name }.GetNewClosure(), $true)
  Assert-Recovery ($null -ne $definition) "Recovery function must exist: $Name"
  return $definition.Extent.Text
}

function Quote-RecoveryLiteral([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }

function Read-RecoveryRequestCount([string]$Path) {
  $stream = $null
  $reader = $null
  try {
    # The fixture server rewrites this counter while probes are in progress.
    # Sharing reads AND writes avoids a Windows sharing violation against an
    # active writer. Empty/partial writes are retried by the existing poll loop.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = [IO.StreamReader]::new($stream)
    $count = 0
    [void][int]::TryParse($reader.ReadToEnd(), [ref]$count)
    return $count
  } catch [IO.IOException] { return 0 }
  finally {
    if ($reader) { $reader.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

function Wait-RecoveryFile([string]$Path, [Diagnostics.Process]$Worker, [int]$TimeoutMilliseconds = 10000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return }
    $Worker.Refresh()
    if ($Worker.HasExited) { throw "Fixture process exited before producing $Path (exit $($Worker.ExitCode))." }
    Start-Sleep -Milliseconds 25
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Fixture process timed out producing $Path."
}

function Wait-RecoveryExit([Diagnostics.Process]$Worker, [string]$ErrorLog, [int]$TimeoutMilliseconds = 12000, [int]$ExpectedExitCode = 0) {
  Assert-Recovery ($Worker.WaitForExit($TimeoutMilliseconds)) 'Recovery fixture must finish within its bounded test deadline.'
  $Worker.Refresh()
  $details = if (Test-Path -LiteralPath $ErrorLog) { [IO.File]::ReadAllText($ErrorLog) } else { '' }
  Assert-Recovery ($Worker.ExitCode -eq $ExpectedExitCode) "Recovery fixture failed (exit $($Worker.ExitCode), expected $ExpectedExitCode): $details"
}

$runtimeHelper = Join-Path $projectRoot 'scripts/wait-monitor-ready.ps1'
$helperAst = Read-RecoveryAst $runtimeHelper
$utilsAst = Read-RecoveryAst (Join-Path $projectRoot 'scripts/monitor-utils.ps1')
$launcherAst = Read-RecoveryAst (Join-Path $projectRoot 'scripts/launch-codex-monitor.ps1')
$startAst = Read-RecoveryAst (Join-Path $projectRoot 'scripts/start-monitor.ps1')
$helperFunction = Get-RecoveryFunction $helperAst 'Invoke-CodexUsageReadinessWait'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-launcher-recovery-' + [Guid]::NewGuid().ToString('N'))
$utf8Bom = [Text.UTF8Encoding]::new($true)
$workers = [Collections.Generic.List[Diagnostics.Process]]::new()
$node = Resolve-CodexUsageNodePath
$shell = (Get-Process -Id $PID).Path
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
  # Deterministic coverage for a reader observing the fixture's open writer.
  $sharingFile = Join-Path $testRoot 'counter-sharing.txt'
  [IO.File]::WriteAllText($sharingFile, '12')
  $writer = [IO.File]::Open($sharingFile, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try {
    Assert-Recovery ((Read-RecoveryRequestCount $sharingFile) -eq 12) 'Polling must read the counter while its writer is still open.'
  } finally { $writer.Dispose() }
  [IO.File]::WriteAllText($sharingFile, '')
  Assert-Recovery ((Read-RecoveryRequestCount $sharingFile) -eq 0) 'An incomplete counter must wait for the next poll.'

  # Only a test-owned loopback HTTP server is launched. Its lifetime also acts as
  # the desktop identity fixture; no real Codex, credentials, or model is used.
  $serverSource = @'
const fs = require('node:fs');
const http = require('node:http');
const [portFile, readyFile, requestFile] = process.argv.slice(2);
let requests = 0;
const server = http.createServer((request, response) => {
  fs.writeFileSync(requestFile, String(++requests));
  const targets = fs.existsSync(readyFile)
    ? [{ id: 'fixture-main', type: 'page', url: 'app://codex/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1/fixture' }]
    : [{ id: 'fixture-login', type: 'page', url: 'about:blank' }];
  response.writeHead(200, {'Content-Type': 'application/json'});
  response.end(JSON.stringify(targets));
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
'@
  $serverPath = Join-Path $testRoot 'delayed-cdp.cjs'
  [IO.File]::WriteAllText($serverPath, $serverSource, $utf8Bom)

  # Additional dynamic scenarios below use the actual runtime helper body with
  # only the process-name/argument boundary and start-monitor side effect mocked.
  foreach ($scenario in @('delayed-ready', 'desktop-exits', 'identity-changed')) {
    $caseRoot = Join-Path $testRoot $scenario
    New-Item -ItemType Directory -Path $caseRoot | Out-Null
    $portFile = Join-Path $caseRoot 'port.txt'
    $readyFile = Join-Path $caseRoot 'app-ready.txt'
    $requestFile = Join-Path $caseRoot 'request-count.txt'
    $serverError = Join-Path $caseRoot 'server-error.log'
    $server = Start-Process -FilePath $node -ArgumentList @(('"' + $serverPath + '"'), ('"' + $portFile + '"'), ('"' + $readyFile + '"'), ('"' + $requestFile + '"')) -WindowStyle Hidden -PassThru -RedirectStandardError $serverError
    [void]$server.Handle
    $workers.Add($server)
    Wait-RecoveryFile $portFile $server
    $port = [int][IO.File]::ReadAllText($portFile)
    $identityTicks = $server.StartTime.ToUniversalTime().Ticks
    $targets = @(Get-CodexUsageTargets $port)
    Assert-Recovery ($targets.Count -eq 1 -and $targets[0].url -eq 'about:blank') 'CDP fixture responds even while the app renderer is missing.'
    Assert-Recovery (-not (Test-CodexUsageCdpPort $port)) 'An open CDP server without an app page is not ready for injection.'
    $marker = Join-Path $caseRoot 'monitor-started.txt'
    $identityLog = Join-Path $caseRoot 'identity-checks.txt'
    $resultFile = Join-Path $caseRoot 'result.txt'
    $helperError = Join-Path $caseRoot 'helper-error.log'
    $workerPath = Join-Path $caseRoot 'worker.ps1'
    $markerScript = @'
param([int]$Port)
[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'monitor-started.txt'), "$Port`n")
'@
    [IO.File]::WriteAllText((Join-Path $caseRoot 'start-monitor.ps1'), $markerScript, $utf8Bom)
    $identityFixture = @'
function Test-CodexUsageDesktopIdentity {
  param([int]$ProcessId, [long]$StartTimeUtcTicks, [int]$Port, [switch]$RequireCdpArguments)
  [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'identity-checks.txt'), "$([int][bool]$RequireCdpArguments)`n")
  $fixture = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  return [bool]($fixture -and $fixture.StartTime.ToUniversalTime().Ticks -eq $StartTimeUtcTicks)
}
function Write-CodexUsageReadinessLog { }
'@
    $workerSource = @(
      'param([int]$Port, [int]$CodexProcessId, [long]$CodexStartTimeUtcTicks)',
      '$ErrorActionPreference = ''Stop''',
      ('. ' + (Quote-RecoveryLiteral (Join-Path $projectRoot 'scripts/monitor-utils.ps1'))),
      $helperFunction,
      $identityFixture,
      '$result = Invoke-CodexUsageReadinessWait -Port $Port -CodexProcessId $CodexProcessId -CodexStartTimeUtcTicks $CodexStartTimeUtcTicks -PollMilliseconds 20',
      '[IO.File]::WriteAllText((Join-Path $PSScriptRoot ''result.txt''), [string]$result)'
    ) -join "`r`n"
    [IO.File]::WriteAllText($workerPath, $workerSource, $utf8Bom)
    $expectedTicks = if ($scenario -eq 'identity-changed') { $identityTicks + 1 } else { $identityTicks }
    $helper = Start-Process -FilePath $shell -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $workerPath + '"'), '-Port', $port, '-CodexProcessId', $server.Id, '-CodexStartTimeUtcTicks', $expectedTicks) -WindowStyle Hidden -PassThru -RedirectStandardError $helperError
    [void]$helper.Handle
    $workers.Add($helper)
    if ($scenario -ne 'identity-changed') {
      Wait-RecoveryFile $identityLog $helper
      # A responsive port plus repeated failed app-page probes must remain
      # pending. No fixed startup deadline may turn this into an error/restart.
      $probeDeadline = [DateTime]::UtcNow.AddSeconds(10)
      do {
        $count = Read-RecoveryRequestCount $requestFile
        if ($count -ge 8) { break }
        $helper.Refresh()
        Assert-Recovery (-not $helper.HasExited) 'The helper must keep waiting while the same desktop process is alive.'
        Start-Sleep -Milliseconds 30
      } while ([DateTime]::UtcNow -lt $probeDeadline)
      Assert-Recovery ($count -ge 8) 'Pending recovery must continue polling across multiple unsuccessful probes.'
      Assert-Recovery (-not (Test-Path -LiteralPath $marker)) 'The backend must not start before the real app page is ready.'
    }
    if ($scenario -eq 'delayed-ready') {
      if ($LongDelaySeconds -gt 0) {
        Write-Host "Holding the isolated CDP fixture without an app page for $LongDelaySeconds seconds."
        $delayedUntil = [DateTime]::UtcNow.AddSeconds($LongDelaySeconds)
        do {
          $helper.Refresh()
          Assert-Recovery (-not $helper.HasExited) 'Readiness recovery must survive the former 180-second startup deadline.'
          Assert-Recovery (-not (Test-Path -LiteralPath $marker)) 'Pending startup must not invoke the backend before an app page exists.'
          Start-Sleep -Seconds 1
        } while ([DateTime]::UtcNow -lt $delayedUntil)
      }
      [IO.File]::WriteAllText($readyFile, 'ready')
    } elseif ($scenario -eq 'desktop-exits') {
      $server.Kill()
      [void]$server.WaitForExit(5000)
    }
    Wait-RecoveryExit $helper $helperError
    $actualResult = [IO.File]::ReadAllText($resultFile).Trim()
    if ($scenario -eq 'delayed-ready') {
      Assert-Recovery ($actualResult -eq 'ready') 'A later app page must recover without relaunching Codex.'
      $calls = @([IO.File]::ReadAllLines($marker))
      Assert-Recovery ($calls.Count -eq 1 -and [int]$calls[0] -eq $port) 'Recovered readiness must start the backend exactly once on the original port.'
    } else {
      Assert-Recovery ($actualResult -eq 'exited') 'An exited or reused desktop identity must cancel recovery.'
      Assert-Recovery (-not (Test-Path -LiteralPath $marker)) 'An exited or reused process cannot start a backend.'
    }
    $checks = @([IO.File]::ReadAllLines($identityLog))
    Assert-Recovery ($checks[0] -eq '1') 'The initial identity check must require the original CDP arguments.'
    $expectedArgumentChecks = if ($scenario -eq 'delayed-ready') { 2 } else { 1 }
    Assert-Recovery (@($checks | Where-Object { $_ -eq '1' }).Count -eq $expectedArgumentChecks) 'Only initial validation and the final ready transition should require expensive argument discovery.'
    $server.Refresh()
    if (-not $server.HasExited) { $server.Kill(); [void]$server.WaitForExit(5000) }
  }

  # The unbounded wait is intentional: the former 180-second gate must not be
  # reintroduced. Behavioral polling above is accelerated via its public delay.
  Assert-Recovery ($helperFunction -notmatch 'Wait-CodexUsageCdpPort|\$\w*deadline|TimeoutSeconds|180') 'Readiness recovery must not retain the former fixed startup deadline.'

  # Helper reuse is keyed to all three pieces of desktop identity, never merely
  # a port or a stale PID. Mock only process discovery and child creation.
  & {
    # Creating an AST-derived scriptblock removes its source filename. Supply
    # only that script-directory dependency explicitly in this isolated unit.
    $startWaiterFunction = (Get-RecoveryFunction $utilsAst 'Start-CodexUsageReadinessWaiter').Replace('$waiterPath = Join-Path $PSScriptRoot', ('$waiterPath = Join-Path ' + (Quote-RecoveryLiteral (Join-Path $projectRoot 'scripts'))))
    . ([scriptblock]::Create($startWaiterFunction))
    $script:fixtureWaiterIdentity = $true
    $script:fixtureWaiterStarts = [Collections.Generic.List[object]]::new()
    $script:fixtureWaiterProcesses = @(
      [pscustomobject]@{ ProcessId=801; Port=9442; CodexProcessId=431; CodexStartTimeUtcTicks=638000000000000001 },
      [pscustomobject]@{ ProcessId=802; Port=9442; CodexProcessId=431; CodexStartTimeUtcTicks=638000000000000000 }
    )
    function Test-CodexUsageDesktopIdentity { param($ProcessId,$StartTimeUtcTicks,$Port,[switch]$RequireCdpArguments) Assert-Recovery $RequireCdpArguments 'Starting or reusing a helper requires full argument validation.'; return $script:fixtureWaiterIdentity }
    function Get-CodexUsageReadinessWaiterProcesses { return $script:fixtureWaiterProcesses }
    function Test-Path { param($LiteralPath,$PathType) return $true }
    function Get-Command { param($Name,$ErrorAction) return [pscustomobject]@{ Source='C:\fixture\pwsh.exe' } }
    function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru) $script:fixtureWaiterStarts.Add([pscustomobject]@{ FilePath=$FilePath; Arguments=$ArgumentList; WindowStyle=$WindowStyle }); return [pscustomobject]@{ Id=803 } }
    $reused = Start-CodexUsageReadinessWaiter -Port 9442 -CodexProcessId 431 -CodexStartTimeUtcTicks 638000000000000000
    Assert-Recovery ($reused.Status -eq 'Reused' -and $reused.ProcessId -eq 802 -and $script:fixtureWaiterStarts.Count -eq 0) 'A matching waiting helper must be reused without another child.'
    $script:fixtureWaiterProcesses = @($script:fixtureWaiterProcesses[0])
    $started = Start-CodexUsageReadinessWaiter -Port 9442 -CodexProcessId 431 -CodexStartTimeUtcTicks 638000000000000000
    Assert-Recovery ($started.Status -eq 'Started' -and $started.ProcessId -eq 803 -and $script:fixtureWaiterStarts.Count -eq 1) 'An old PID generation must not count as a reusable helper.'
    $call = $script:fixtureWaiterStarts[0]
    Assert-Recovery ($call.WindowStyle -eq 'Hidden' -and $call.Arguments -match '-Port 9442' -and $call.Arguments -match '-CodexProcessId 431' -and $call.Arguments -match '-CodexStartTimeUtcTicks 638000000000000000') 'A hidden helper must receive the exact validated identity.'
    $script:fixtureWaiterIdentity = $false
    $rejected = $false
    try { [void](Start-CodexUsageReadinessWaiter -Port 9442 -CodexProcessId 431 -CodexStartTimeUtcTicks 638000000000000000) }
    catch { $rejected = $true }
    Assert-Recovery ($rejected -and $script:fixtureWaiterStarts.Count -eq 1) 'An identity change before helper creation must fail closed.'
  }

  # Execute the helper's actual named-mutex wrapper twice. The first shell waits
  # for a flag; the competing shell must exit without entering the wait body.
  $caseRoot = Join-Path $testRoot 'waiter-mutex'
  New-Item -ItemType Directory -Path $caseRoot | Out-Null
  $workerPath = Join-Path $caseRoot 'worker.ps1'
  $workerError = Join-Path $caseRoot 'first-error.log'
  $duplicateError = Join-Path $caseRoot 'duplicate-error.log'
  $identityLog = Join-Path $caseRoot 'identity.txt'
  $readyFile = Join-Path $caseRoot 'ready.txt'
  $callsPath = Join-Path $caseRoot 'backend.txt'
  $helperMutexName = 'Local\CodexUsageReadinessTest-' + [Guid]::NewGuid().ToString('N')
  $helperWrapper = @($helperAst.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.TryStatementAst] -or $_.Extent.Text -match '^\$waiterMutex(?:Name|Acquired)?\s*='
  })
  Assert-Recovery ($helperWrapper.Count -eq 4) 'The actual helper lock creation, acquisition, and finally cleanup must be exercised.'
  $wrapperBody = (@($helperWrapper | ForEach-Object { $_.Extent.Text }) -join "`r`n").Replace('Local\CodexUsageMonitorReadiness-', ($helperMutexName + '-'))
  $helperMocks = @'
$Port=9442
$CodexProcessId=431
$CodexStartTimeUtcTicks=638000000000000000
function Write-CodexUsageReadinessLog { }
function Test-CodexUsageDesktopIdentity { param($ProcessId,$StartTimeUtcTicks,$Port,[switch]$RequireCdpArguments) if ($RequireCdpArguments) { [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'identity.txt'), 'full') }; return $true }
function Test-CodexUsageCdpPort { param($Port) return (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'ready.txt')) }
'@
  $mockStart = 'param([int]$Port)' + "`r`n" + '[IO.File]::AppendAllText((Join-Path $PSScriptRoot ''backend.txt''), "started`n")'
  [IO.File]::WriteAllText((Join-Path $caseRoot 'start-monitor.ps1'), $mockStart, $utf8Bom)
  [IO.File]::WriteAllText($workerPath, (@('$ErrorActionPreference = ''Stop''', $helperFunction, $helperMocks, $wrapperBody) -join "`r`n"), $utf8Bom)
  $first = Start-Process -FilePath $shell -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $workerPath + '"')) -WindowStyle Hidden -PassThru -RedirectStandardError $workerError
  [void]$first.Handle
  $workers.Add($first)
  Wait-RecoveryFile $identityLog $first
  $checksBefore = [IO.File]::ReadAllText($identityLog).Length
  $duplicate = Start-Process -FilePath $shell -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $workerPath + '"')) -WindowStyle Hidden -PassThru -RedirectStandardError $duplicateError
  [void]$duplicate.Handle
  $workers.Add($duplicate)
  Wait-RecoveryExit $duplicate $duplicateError
  Assert-Recovery (-not (Test-Path -LiteralPath $callsPath)) 'A duplicate helper must not invoke the backend while the first is pending.'
  Assert-Recovery ([IO.File]::ReadAllText($identityLog).Length -eq $checksBefore) 'The competing helper must not enter its waiting function.'
  [IO.File]::WriteAllText($readyFile, 'ready')
  Wait-RecoveryExit $first $workerError
  Assert-Recovery (@([IO.File]::ReadAllLines($callsPath)).Count -eq 1) 'The sole waiting owner must activate the backend once.'
  $fullHelperMutexName = "$helperMutexName-431-638000000000000000-9442"
  $releasedMutex = [Threading.Mutex]::new($false, $fullHelperMutexName)
  try {
    $released = $false
    try { $released = $releasedMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { throw 'The readiness helper abandoned its lock.' }
    Assert-Recovery $released 'A completed readiness helper must release its lock.'
    if ($released) { $releasedMutex.ReleaseMutex() }
  } finally { $releasedMutex.Dispose() }

  # Execute the launcher's real mutex, activation decision, error path, and
  # finally block in isolated child shells. Only process/activation/UI effects
  # and start-monitor are replaced with test-owned fixtures.
  $launcherStatements = @($launcherAst.EndBlock.Statements | Where-Object {
    ($_.Extent.Text -match '^\$launcherMutex(?:Acquired)?\s*=') -or $_ -is [Management.Automation.Language.TryStatementAst]
  })
  Assert-Recovery ($launcherStatements.Count -eq 3) 'The full launcher mutex/try/finally body must be exercised.'
  $launcherMutexName = 'Local\CodexUsageLauncherTest-' + [Guid]::NewGuid().ToString('N')
  $launcherBody = (@($launcherStatements | ForEach-Object { $_.Extent.Text }) -join "`r`n").Replace('Local\CodexUsageMonitorLauncher', $launcherMutexName)
  $launchPlanFunction = Get-RecoveryFunction $launcherAst 'Get-CodexMonitorLaunchPlan'
  foreach ($scenario in @('pending', 'native', 'cold-start', 'orphan-renderer', 'ready', 'start-fails', 'process-query-fails', 'already-launching')) {
    $caseRoot = Join-Path $testRoot ('launcher-' + $scenario)
    New-Item -ItemType Directory -Path $caseRoot | Out-Null
    $workerPath = Join-Path $caseRoot 'worker.ps1'
    $workerError = Join-Path $caseRoot 'worker-error.log'
    $mockStart = @'
param([int]$Port)
[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'backend.txt'), "$Port`n")
if ((Split-Path -Leaf $PSScriptRoot) -eq 'launcher-start-fails') { throw 'fixture backend failed' }
'@
    [IO.File]::WriteAllText((Join-Path $caseRoot 'start-monitor.ps1'), $mockStart, $utf8Bom)
    $launchMocks = @'
function Get-Process { param($Name, $ErrorAction) if ($script:scenario -ne 'cold-start') { return [pscustomobject]@{ Id = 431 } } }
function Get-CodexUsageDesktopProcesses { if ($script:scenario -eq 'process-query-fails') { throw 'fixture main-process discovery denied' }; if ($script:scenario -notin @('cold-start','orphan-renderer')) { return [pscustomobject]@{ ProcessId = 431; StartTimeUtcTicks = 638000000000000000; Port = 0 } } }
function Resolve-CodexUsageCdpPort { param($Port) if ($script:scenario -in @('ready','start-fails')) { return 9441 } return 0 }
function Get-CodexUsagePendingDesktop { param($PreferredPort) if ($script:scenario -in @('pending','cold-start','orphan-renderer')) { return [pscustomobject]@{ ProcessId = 431; StartTimeUtcTicks = 638000000000000000; Port = 9442 } } return $null }
function Resolve-CodexUsageAvailablePort { param($PreferredPort) return 9442 }
function Start-CodexUsagePackagedCodex { param($Port) [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'activated.txt'), "$Port`n") }
function Stop-Process { throw 'A launcher must never stop any Codex process.' }
function Show-CodexMonitorMessage { param($Message,$Icon) [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'message.txt'), "$Icon $Message`n") }
function Write-CodexMonitorLaunchError { param($Message) [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'error.txt'), $Message) }
'@
    $workerSource = @(
      '$ErrorActionPreference = ''Stop''',
      '$Port = 9335',
      ('$script:scenario = ' + (Quote-RecoveryLiteral $scenario)),
      $launchPlanFunction, $launchMocks, $launcherBody
    ) -join "`r`n"
    [IO.File]::WriteAllText($workerPath, $workerSource, $utf8Bom)
    $heldMutex = $null
    try {
      if ($scenario -eq 'already-launching') {
        $heldMutex = [Threading.Mutex]::new($false, $launcherMutexName)
        Assert-Recovery ($heldMutex.WaitOne(0)) 'The isolated launch lock must be available for the duplicate-click scenario.'
      }
      $worker = Start-Process -FilePath $shell -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $workerPath + '"')) -WindowStyle Hidden -PassThru -RedirectStandardError $workerError
      [void]$worker.Handle
      $workers.Add($worker)
      $expectedExit = if ($scenario -eq 'native') { 2 } elseif ($scenario -in @('start-fails','process-query-fails')) { 1 } else { 0 }
      Wait-RecoveryExit $worker $workerError 12000 $expectedExit
    } finally {
      if ($heldMutex) { $heldMutex.ReleaseMutex(); $heldMutex.Dispose() }
    }
    $activationPath = Join-Path $caseRoot 'activated.txt'
    $backendPath = Join-Path $caseRoot 'backend.txt'
    if ($scenario -in @('cold-start','orphan-renderer')) {
      Assert-Recovery (@([IO.File]::ReadAllLines($activationPath)).Count -eq 1) 'A cold start must activate exactly one desktop process.'
    } else {
      Assert-Recovery (-not (Test-Path -LiteralPath $activationPath)) 'Existing/native/pending desktops and duplicate clicks must never relaunch Codex.'
    }
    if ($scenario -in @('native','process-query-fails','already-launching')) {
      Assert-Recovery (-not (Test-Path -LiteralPath $backendPath)) 'A native non-CDP desktop or busy launcher must not start a backend.'
    } else {
      $calls = @([IO.File]::ReadAllLines($backendPath))
      $expectedPort = if ($scenario -in @('ready','start-fails')) { 9441 } else { 9442 }
      Assert-Recovery ($calls.Count -eq 1 -and [int]$calls[0] -eq $expectedPort) 'The actual selected/pending port must reach start-monitor exactly once.'
    }
    if ($scenario -eq 'native') {
      Assert-Recovery ([IO.File]::ReadAllText((Join-Path $caseRoot 'message.txt')) -match 'Warning') 'A native desktop must retain its safe manual-exit explanation.'
    }
    if ($scenario -eq 'start-fails') {
      Assert-Recovery ([IO.File]::ReadAllText((Join-Path $caseRoot 'error.txt')) -match 'fixture backend failed') 'The concrete startup error must survive launcher handling.'
    }
    if ($scenario -eq 'process-query-fails') {
      Assert-Recovery ([IO.File]::ReadAllText((Join-Path $caseRoot 'error.txt')) -match 'fixture main-process discovery denied') 'Failed process discovery must fail closed before desktop activation.'
    }
    $releasedMutex = [Threading.Mutex]::new($false, $launcherMutexName)
    try {
      $released = $false
      try { $released = $releasedMutex.WaitOne(0) }
      catch [Threading.AbandonedMutexException] { throw 'Launcher leaked its lock instead of releasing it in finally.' }
      Assert-Recovery $released 'Success, cancellation, and failure must release the launcher mutex.'
      if ($released) { $releasedMutex.ReleaseMutex() }
    } finally { $releasedMutex.Dispose() }
  }

  # The real start-monitor pending branch must return before resolving a CLI or
  # importing any credentials, so recovering native startup cannot be blocked
  # by the monitor's unrelated subscription/provider setup.
  $startStatements = @($startAst.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.TryStatementAst] -or
    ($_.Extent.Text -match '^\$(?:injector|mutexName|mutex|mutexAcquired)\s*=')
  })
  Assert-Recovery ($startStatements.Count -eq 5) 'The real start-monitor pending branch must include its entire mutex body.'
  $startBody = (@($startStatements | ForEach-Object { $_.Extent.Text }) -join "`r`n").Replace('Local\CodexUsageMonitor', ('Local\CodexUsageMonitorTest-' + [Guid]::NewGuid().ToString('N')))
  $caseRoot = Join-Path $testRoot 'start-monitor-pending'
  New-Item -ItemType Directory -Path $caseRoot | Out-Null
  $workerPath = Join-Path $caseRoot 'worker.ps1'
  $workerError = Join-Path $caseRoot 'worker-error.log'
  $pendingMocks = @'
$Port = 9335
function Resolve-CodexUsageCdpPort { param($Port) return 0 }
function Get-CodexUsagePendingDesktop { param($PreferredPort) return [pscustomobject]@{ ProcessId=431; StartTimeUtcTicks=638000000000000000; Port=9442 } }
function Start-CodexUsageReadinessWaiter { param($Port,$CodexProcessId,$CodexStartTimeUtcTicks) [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'waiter.txt'), "$Port,$CodexProcessId,$CodexStartTimeUtcTicks"); return [pscustomobject]@{ Status='Reused'; ProcessId=987 } }
function Resolve-CodexUsageNodePath { throw 'Pending startup must not launch or resolve Node.' }
function Resolve-CodexUsageCliPath { throw 'Pending startup must not resolve the usage CLI.' }
function Import-CodexUsagePersistedProvider { throw 'Pending startup must not import provider secrets.' }
function Import-CodexUsagePersistedAccount { throw 'Pending startup must not import account secrets.' }
function Stop-Process { throw 'Pending startup must never stop Codex.' }
'@
  [IO.File]::WriteAllText($workerPath, (@('$ErrorActionPreference = ''Stop''', $pendingMocks, $startBody) -join "`r`n"), $utf8Bom)
  $worker = Start-Process -FilePath $shell -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $workerPath + '"')) -WindowStyle Hidden -PassThru -RedirectStandardError $workerError
  [void]$worker.Handle
  $workers.Add($worker)
  Wait-RecoveryExit $worker $workerError
  Assert-Recovery ([IO.File]::ReadAllText((Join-Path $caseRoot 'waiter.txt')) -eq '9442,431,638000000000000000') 'The pending branch must bind recovery to the exact original desktop identity and actual port.'
  Write-Host 'PASS: delayed CDP recovery, exact desktop identity, helper reuse, launch decisions, duplicate locks, and exit cleanup.'
} finally {
  foreach ($worker in $workers) {
    try {
      $worker.Refresh()
      if (-not $worker.HasExited) { $worker.Kill(); [void]$worker.WaitForExit(5000) }
      $worker.Dispose()
    } catch {}
  }
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  Assert-Recovery ([IO.Path]::GetDirectoryName($resolvedTestRoot) -eq $expectedParent -and [IO.Path]::GetFileName($resolvedTestRoot) -match '^codex-launcher-recovery-[0-9a-f]{32}$') 'Only the exact owned test directory may be cleaned.'
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
