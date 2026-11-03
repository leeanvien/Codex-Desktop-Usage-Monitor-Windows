[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'VERSION') -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root "dist\github-share-v$version" }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Share output already exists. Choose a new -OutputDirectory.' }
if (-not $SkipTests) {
  & (Join-Path $root 'tests\run-tests.ps1')
  if (-not $?) { throw 'Tests failed; no share package was created.' }
}

# Export only explicitly reviewed source files. Never copy the working tree,
# Git history, versioned installations or user runtime state recursively.
$files = @(Get-Content -LiteralPath (Join-Path $root 'config\package-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
$files += @('scripts/build-release.ps1', 'scripts/build-github-share.ps1', '.github/workflows/ci.yml', '.github/workflows/release.yml')
$rootPrefix = [IO.Path]::GetFullPath($root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$profilePath = [Environment]::GetFolderPath('UserProfile')
$secretPatterns = @('sk-[A-Za-z0-9_-]{20,}', 'ghp_[A-Za-z0-9]{30,}', 'github_pat_[A-Za-z0-9_]{40,}', 'Bearer\s+[A-Za-z0-9._-]{16,}', '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
foreach ($relative in $files) {
  if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or
      $relative -match '(^|[\\/])\.\.([\\/]|$)' -or -not $seen.Add($relative) -or
      $relative -match '(?i)(^|[\\/])(?:\.git|node_modules|artifacts|output|dist|\d+\.\d+\.\d+)(?:[\\/]|$)|\.local\.json$|\.dpapi$|\.log$|(^|[\\/])\.env(?:\.|$)') {
    throw "Unsafe or duplicate share file: $relative"
  }
  $sourcePath = [IO.Path]::GetFullPath((Join-Path $root $relative))
  if (-not $sourcePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $sourcePath -PathType Leaf) -or
      ((Get-Item -LiteralPath $sourcePath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Share file is missing or outside the source tree: $relative"
  }
  if ($relative -match '\.(?:js|mjs|json|md|ps1|yml)$') {
    $text = [IO.File]::ReadAllText($sourcePath)
    foreach ($pattern in $secretPatterns) {
      if ($text -match $pattern) { throw "Potential credential in selected share file: $relative" }
    }
    if ($profilePath -and ($text.Contains($profilePath) -or $text.Contains($profilePath.Replace('\', '\\')) -or $text.Contains($profilePath.Replace('\', '/')))) {
      throw "Personal profile path in selected share file: $relative"
    }
  }
}

New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$sourceRoot = Join-Path $OutputDirectory 'source\Codex-Desktop-Usage-Monitor-Windows'
New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
foreach ($relative in $files) {
  $destination = Join-Path $sourceRoot $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath (Join-Path $root $relative) -Destination $destination
}

& (Join-Path $root 'scripts\build-release.ps1') -SkipTests -OutputDirectory $OutputDirectory
if (-not $?) { throw 'Runtime ZIP build failed.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceZip = Join-Path $OutputDirectory "codex-usage-monitor-windows-$version-source.zip"
[IO.Compression.ZipFile]::CreateFromDirectory((Split-Path -Parent $sourceRoot), $sourceZip, [IO.Compression.CompressionLevel]::Optimal, $false)

$utf8 = [Text.UTF8Encoding]::new($false)
$runtimeZip = Join-Path $OutputDirectory "codex-usage-monitor-windows-$version.zip"
$hashes = foreach ($archive in @($runtimeZip, $sourceZip)) {
  "{0}  {1}" -f (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant(), [IO.Path]::GetFileName($archive)
}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'SHA256SUMS.txt'), ($hashes -join "`n") + "`n", $utf8)
Copy-Item -LiteralPath (Join-Path $root 'docs\publishing.md') -Destination (Join-Path $OutputDirectory '上传说明.md')
$notes = @"
# Codex Usage Monitor for Windows v$version

基于 JiaYang-BUAA/Codex-Desktop-Usage-Monitor-Windows 的社区修改版，保留 MIT License 与来源声明。

- Windows 输入区域内显示官方额度、本地会话统计及可选 API 用量。
- 支持按对话的额度恢复续跑、可选 low 模型的每日定时保活与功能自检。
- 保留 Codex 26.1027 本机 RPC 与队列读取适配，修复长时间闲置后的统计误报。
- 面板仅显示产品名及版本，自动更新来源为 leeanvien 的本仓库。

下载 codex-usage-monitor-windows-$version.zip，解压后运行 pwsh -NoProfile -File .\install.ps1，再从桌面 Codex Usage Monitor 启动。

需要 Windows 10/11、可正常登录的 Codex Desktop，以及 Node.js 22+；推荐 PowerShell 7。没有捆绑 Codex、Node.js、用户配置、日志或凭据。

请保持电脑不休眠，并让 Codex 和监视器持续运行。实际额度刷新以服务端为准；内部兼容性依赖 Codex 版本。
"@
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'RELEASE_NOTES.md'), $notes + "`n", $utf8)

# Check exact ZIP contents, including dotfiles needed by GitHub Actions.
foreach ($pair in @(@($runtimeZip, @(Get-Content -LiteralPath (Join-Path $root 'config\package-files.json') -Raw | ConvertFrom-Json)), @($sourceZip, $files))) {
  $archive = [IO.Compression.ZipFile]::OpenRead($pair[0])
  try {
    $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object {
      $name = $_.FullName.Replace('\', '/')
      if ($name -notmatch '^[^/]+/(.+)$') { throw 'ZIP entry is missing its package root.' }
      $Matches[1]
    } | Sort-Object)
    $expected = @($pair[1] | ForEach-Object { ([string]$_).Replace('\', '/') } | Sort-Object)
    if (Compare-Object $expected $entries) { throw "ZIP contents differ from the selected file list: $($pair[0])" }
  } finally { $archive.Dispose() }
}
Write-Host "Share bundle ready: $OutputDirectory"
Write-Host "Clean source files: $($files.Count); runtime ZIP, source ZIP and SHA-256 list verified."
