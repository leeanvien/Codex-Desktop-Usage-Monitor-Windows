[CmdletBinding()]
param([ValidateRange(1024, 65535)][int]$Port = 9335)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'monitor-utils.ps1')
$desktop = Get-CodexUsagePendingDesktop -PreferredPort $Port
$version = ''
if ($desktop -and $desktop.Port -eq $Port) {
  $match = [regex]::Match([string]$desktop.ExecutablePath, '(?i)[\\/]WindowsApps[\\/]OpenAI\.Codex_(\d+(?:\.\d+){3})_[^\\/]+[\\/]')
  if ($match.Success) { $version = $match.Groups[1].Value }
}
@{ version = $version } | ConvertTo-Json -Compress
