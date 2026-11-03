[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "codex-auto-update-validation-$PID"
$originalLocalAppData = $env:LOCALAPPDATA
$originalInstallMarker = $env:CODEX_USAGE_TEST_INSTALL_MARKER
$utf8Bom = [Text.UTF8Encoding]::new($true)

function New-TestArchive([string]$Version, [string]$Destination, [string]$Compatibility = 'None', [switch]$SelfChecks) {
  $staging = Join-Path $testRoot 'staging'
  $testPrefix = [IO.Path]::GetFullPath($testRoot).TrimEnd('\') + '\'
  if (-not [IO.Path]::GetFullPath($staging).StartsWith($testPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test staging path escaped its temporary root.' }
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  $package = Join-Path $staging "codex-usage-monitor-windows-$Version"
  foreach ($relative in @('config', 'scripts')) { New-Item -ItemType Directory -Force -Path (Join-Path $package $relative) | Out-Null }
  Set-Content -LiteralPath (Join-Path $package 'VERSION') -Value $Version -Encoding ascii
  [IO.File]::WriteAllText((Join-Path $package 'install.ps1'), '[IO.File]::WriteAllText($env:CODEX_USAGE_TEST_INSTALL_MARKER, "installer ran"); throw "Fixture installer must never execute."', $utf8Bom)
  [IO.File]::WriteAllText((Join-Path $package 'scripts\start-monitor.ps1'), "Write-Host 'fixture'", $utf8Bom)
  [IO.File]::WriteAllText((Join-Path $package 'scripts\auto-update.ps1'), "Write-Host 'fixture'", $utf8Bom)
  $manifest = @()
  if ($Compatibility -ne 'None') {
    $capabilities = @('daily-keep-alive-model-selection-v1')
    if ($SelfChecks) { $capabilities += 'post-update-compatibility-check-v1' }
    if ($Compatibility -eq 'NoCapability') { $capabilities = @('unrelated-feature') }
    $marker = @{ schemaVersion = 1; capabilities = $capabilities } | ConvertTo-Json -Depth 3
    [IO.File]::WriteAllText((Join-Path $package 'config\local-features.json'), $marker, $utf8Bom)
    foreach ($relative in @('scripts/daily-keepalive.mjs', 'scripts/desktop-request.mjs')) {
      [IO.File]::WriteAllText((Join-Path $package $relative), '// compatible fixture', $utf8Bom)
    }
    $manifest = @('config/local-features.json', 'scripts/daily-keepalive.mjs', 'scripts/desktop-request.mjs')
    if ($SelfChecks) {
      $manifest += 'scripts/compatibility.mjs'
      $manifest += 'scripts/desktop-version.ps1'
      [IO.File]::WriteAllText((Join-Path $package 'scripts\compatibility.mjs'), '// self-check fixture', $utf8Bom)
      [IO.File]::WriteAllText((Join-Path $package 'scripts\desktop-version.ps1'), '# version fixture', $utf8Bom)
    }
    foreach ($relative in @($manifest)) {
      if ($Compatibility -eq ('MissingManifest:' + $relative)) { $manifest = @($manifest | Where-Object { $_ -ne $relative }) }
      if ($Compatibility -eq ('MissingFile:' + $relative)) { Remove-Item -LiteralPath (Join-Path $package $relative) -Force }
    }
  }
  [IO.File]::WriteAllText((Join-Path $package 'config\package-files.json'), (ConvertTo-Json -InputObject @($manifest)), $utf8Bom)
  Compress-Archive -LiteralPath $package -DestinationPath $Destination -CompressionLevel Optimal
}

try {
  New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
  $env:LOCALAPPDATA = Join-Path $testRoot 'local'
  $env:CODEX_USAGE_TEST_INSTALL_MARKER = Join-Path $testRoot 'installer-executed.txt'
  $archivePath = Join-Path $testRoot 'valid.zip'
  New-TestArchive '9.8.7' $archivePath
  $digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  & (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $archivePath -ExpectedSha256 $digest -Version '9.8.7' -ValidateOnly
  if (Test-Path -LiteralPath $archivePath) { throw 'Validated update archive was not cleaned up.' }

  # Exercise real signed-by-digest ZIP contents, before any candidate installer
  # can run or a background monitor can be replaced.
  $existingInstall = Join-Path $testRoot 'installed-current'
  New-Item -ItemType Directory -Force -Path $existingInstall | Out-Null
  $existingMarker = Join-Path $existingInstall 'running-monitor.txt'
  [IO.File]::WriteAllText($existingMarker, 'current monitor remains running', $utf8Bom)
  $incompatible = @('None', 'NoCapability')
  foreach ($requiredFile in @('config/local-features.json', 'scripts/daily-keepalive.mjs', 'scripts/desktop-request.mjs')) {
    $incompatible += 'MissingManifest:' + $requiredFile
    $incompatible += 'MissingFile:' + $requiredFile
  }
  $caseNumber = 0
  foreach ($compatibility in $incompatible) {
    $caseNumber += 1
    $candidate = Join-Path $testRoot "incompatible-$caseNumber.zip"
    New-TestArchive '9.8.7' $candidate $compatibility
    $candidateDigest = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    $guardRejected = $false
    try {
      & (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $candidate -ExpectedSha256 $candidateDigest -Version '9.8.7' -InstallRoot $existingInstall -RequireDailyKeepAlive
    } catch { $guardRejected = $_.Exception.Message -match 'Update rejected:.*daily keep-alive' }
    if (-not $guardRejected) { throw "Incompatible keep-alive update was not rejected: $compatibility" }
    if (Test-Path -LiteralPath $env:CODEX_USAGE_TEST_INSTALL_MARKER) { throw 'An incompatible candidate installer executed before rejection.' }
    if ((Get-Content -LiteralPath $existingMarker -Raw).Trim() -ne 'current monitor remains running') { throw 'Incompatible update changed the existing monitor.' }
    if (@(Get-ChildItem -LiteralPath $existingInstall).Count -ne 1) { throw 'Incompatible update installed files into the existing monitor root.' }
    if ((Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'CodexUsageMonitor\update-state.json') -Raw | ConvertFrom-Json).status -ne 'error') { throw 'Incompatible update did not persist its error state.' }
    if (Test-Path -LiteralPath $candidate) { throw 'Rejected incompatible archive was not cleaned up.' }
  }
  $compatibleArchive = Join-Path $testRoot 'compatible.zip'
  New-TestArchive '9.8.7' $compatibleArchive 'Compatible'
  $compatibleDigest = (Get-FileHash -LiteralPath $compatibleArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  & (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $compatibleArchive -ExpectedSha256 $compatibleDigest -Version '9.8.7' -RequireDailyKeepAlive -ValidateOnly
  if (Test-Path -LiteralPath $compatibleArchive) { throw 'Compatible validated archive was not cleaned up.' }
  if (Test-Path -LiteralPath $env:CODEX_USAGE_TEST_INSTALL_MARKER) { throw 'ValidateOnly executed the candidate installer.' }

  # The launcher supports machines without PowerShell 7. Validate a real ZIP
  foreach ($case in @('Compatible', 'MissingManifest:scripts/compatibility.mjs', 'MissingFile:scripts/compatibility.mjs', 'MissingFile:scripts/desktop-version.ps1')) {
    $candidate = Join-Path $testRoot ('self-check-' + [Guid]::NewGuid().ToString('N') + '.zip')
    New-TestArchive '9.8.7' $candidate $case -SelfChecks
    $candidateDigest = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    $accepted = $true
    try {
      & (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $candidate -ExpectedSha256 $candidateDigest -Version '9.8.7' -RequireDailyKeepAlive -RequireCompatibilityChecks -ValidateOnly
    } catch { $accepted = $false; if ($_.Exception.Message -notmatch 'compatibility checks') { throw } }
    if ($accepted -ne ($case -eq 'Compatible')) { throw 'Self-check update preservation guard failed.' }
    if (Test-Path -LiteralPath $env:CODEX_USAGE_TEST_INSTALL_MARKER) { throw 'Self-check validation executed the installer.' }
  }
  $missingChecks = Join-Path $testRoot 'missing-self-check-marker.zip'
  New-TestArchive '9.8.7' $missingChecks 'Compatible'
  $missingDigest = (Get-FileHash -LiteralPath $missingChecks -Algorithm SHA256).Hash.ToLowerInvariant()
  $missingRejected = $false
  try { & (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $missingChecks -ExpectedSha256 $missingDigest -Version '9.8.7' -RequireCompatibilityChecks -ValidateOnly }
  catch { $missingRejected = $_.Exception.Message -match 'compatibility checks' }
  if (-not $missingRejected) { throw 'An update removing self-checks was not rejected.' }

  # The launcher supports machines without PowerShell 7. Validate a real ZIP
  # with the actual Windows PowerShell runtime, not a mocked installer script.
  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf) {
    $legacyArchivePath = Join-Path $testRoot 'windows-powershell.zip'
    New-TestArchive '9.8.7' $legacyArchivePath
    $legacyDigest = (Get-FileHash -LiteralPath $legacyArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $legacyArchivePath -ExpectedSha256 $legacyDigest -Version '9.8.7' -ValidateOnly
    if ($LASTEXITCODE -ne 0) { throw 'Update ZIP validation failed under Windows PowerShell.' }
    if (Test-Path -LiteralPath $legacyArchivePath) { throw 'Windows PowerShell did not clean up the validated archive.' }
    $legacyCompatibleArchive = Join-Path $testRoot 'windows-powershell-compatible.zip'
    New-TestArchive '9.8.7' $legacyCompatibleArchive 'Compatible'
    $legacyCompatibleDigest = (Get-FileHash -LiteralPath $legacyCompatibleArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $legacyCompatibleArchive -ExpectedSha256 $legacyCompatibleDigest -Version '9.8.7' -RequireDailyKeepAlive -ValidateOnly
    if ($LASTEXITCODE -ne 0) { throw 'Keep-alive compatibility validation failed under Windows PowerShell.' }
    if (Test-Path -LiteralPath $legacyCompatibleArchive) { throw 'Windows PowerShell did not clean up the compatible archive.' }
    $legacyIncompatibleArchive = Join-Path $testRoot 'windows-powershell-incompatible.zip'
    New-TestArchive '9.8.7' $legacyIncompatibleArchive
    $legacyIncompatibleDigest = (Get-FileHash -LiteralPath $legacyIncompatibleArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    try {
      $ErrorActionPreference = 'Continue'
      $legacyGuardOutput = & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $legacyIncompatibleArchive -ExpectedSha256 $legacyIncompatibleDigest -Version '9.8.7' -InstallRoot $existingInstall -RequireDailyKeepAlive 2>&1
      $legacyGuardExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = 'Stop' }
    if ($legacyGuardExitCode -eq 0 -or ($legacyGuardOutput -join "`n") -notmatch 'Update rejected: package would remove local daily keep-alive') { throw 'Windows PowerShell did not reject the upstream package before installation.' }
    if (Test-Path -LiteralPath $env:CODEX_USAGE_TEST_INSTALL_MARKER) { throw 'Windows PowerShell executed an incompatible candidate installer.' }
    if (Test-Path -LiteralPath $legacyIncompatibleArchive) { throw 'Windows PowerShell did not clean up the incompatible archive.' }
    $global:LASTEXITCODE = 0
  }

  $badArchivePath = Join-Path $testRoot 'bad-hash.zip'
  New-TestArchive '9.8.7' $badArchivePath
  $rejected = $false
  try {
    & (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $badArchivePath -ExpectedSha256 ('0' * 64) -Version '9.8.7' -ValidateOnly
  } catch { $rejected = $_.Exception.Message -match 'SHA-256' }
  if (-not $rejected) { throw 'A mismatched update SHA-256 was not rejected.' }
  if ((Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'CodexUsageMonitor\update-state.json') -Raw | ConvertFrom-Json).status -ne 'error') {
    throw 'Failed automatic update did not persist an error status.'
  }

  $unsafeArchivePath = Join-Path $testRoot 'unsafe-path.zip'
  New-TestArchive '9.8.7' $unsafeArchivePath
  Add-Type -AssemblyName System.IO.Compression
  $unsafeStream = [IO.File]::Open($unsafeArchivePath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $unsafeZip = $null
  try {
    $unsafeZip = [IO.Compression.ZipArchive]::new($unsafeStream, [IO.Compression.ZipArchiveMode]::Update, $false)
    $unsafeEntry = $unsafeZip.CreateEntry('codex-usage-monitor-windows-9.8.7/scripts/payload.ps1:stream')
    $unsafeWriter = [IO.StreamWriter]::new($unsafeEntry.Open())
    try { $unsafeWriter.Write('fixture') } finally { $unsafeWriter.Dispose() }
  } finally {
    if ($unsafeZip) { $unsafeZip.Dispose() }
    $unsafeStream.Dispose()
  }
  $unsafeDigest = (Get-FileHash -LiteralPath $unsafeArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $unsafeRejected = $false
  try {
    & (Join-Path $root 'scripts\auto-update.ps1') -ArchivePath $unsafeArchivePath -ExpectedSha256 $unsafeDigest -Version '9.8.7' -ValidateOnly
  } catch { $unsafeRejected = $_.Exception.Message -match 'Unsafe update archive path' }
  if (-not $unsafeRejected) { throw 'A Windows alternate-data-stream update path was not rejected.' }

  # Evaluate only the restart command against a mock. Start-Process joins its
  # argument array into a command line, so the script path must retain quotes.
  & {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts\auto-update.ps1'), [ref]$tokens, [ref]$errors)
    $restart = $ast.Find({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Start-Process' }, $true)
    $installedRoot = Join-Path $testRoot 'installed with spaces\9.8.7'
    $pwsh = 'mock-powershell'
    $Port = 9345
    function Start-Process {
      param($FilePath, $ArgumentList, $WindowStyle)
      if ($FilePath -ne 'mock-powershell' -or $WindowStyle -ne 'Hidden') { throw 'Update restart must stay hidden.' }
      $index = [Array]::IndexOf($ArgumentList, '-File')
      $expected = '"' + (Join-Path $installedRoot 'scripts\start-monitor.ps1') + '"'
      if ($index -lt 0 -or $ArgumentList[$index + 1] -ne $expected) { throw 'Update restart lost the quoted script path.' }
      if (($ArgumentList -join ' ') -notmatch '-Port 9345 -Replace$') { throw 'Update restart lost the selected port or replacement flag.' }
    }
    & ([scriptblock]::Create($restart.Extent.Text))
  }
  Write-Host 'PASS: automatic update ZIP validation, digest verification, keep-alive compatibility guard, cleanup, and failure state.'
} finally {
  $env:LOCALAPPDATA = $originalLocalAppData
  $env:CODEX_USAGE_TEST_INSTALL_MARKER = $originalInstallMarker
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
