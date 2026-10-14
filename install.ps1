# Wave installer for Windows.
#
#   irm https://raw.githubusercontent.com/190Q/Wave/main/install.ps1 | iex
#
# Pin a version:  $env:WAVE_VERSION = "0.1.1"; irm https://raw.githubusercontent.com/190Q/Wave/main/install.ps1 | iex
#
# Save the file to use the switches:
#   pwsh -File install.ps1 -NoLaunch
[CmdletBinding()]
param(
  [string]$Version = $env:WAVE_VERSION,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$repo = "190Q/Wave"
$product = "Wave"

function Say($message) { Write-Host $message }

if ($Version) {
  $tag = "v" + $Version.TrimStart("v")
  $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/tags/$tag"
} else {
  Say "Looking up the latest release..."
  $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
}
$tag = $release.tag_name

# The installer name is read from the release.
$asset = $release.assets |
  Where-Object { $_.name -like "*-setup.exe" } |
  Select-Object -First 1
if (-not $asset) { throw "the $tag release has no Windows installer" }

$file = Join-Path $env:TEMP $asset.name
Say "Downloading $($asset.name)"
Invoke-WebRequest $asset.browser_download_url -OutFile $file

# The NSIS installer takes /S for a silent, current-user install.
Say "Installing $product $tag"
$install = Start-Process -FilePath $file -ArgumentList "/S" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "the installer exited with code $($install.ExitCode)" }
Remove-Item $file -Force -ErrorAction SilentlyContinue

Say "$product $tag installed."
Say "Uninstall it later from Settings > Apps."

if (-not $NoLaunch) {
  $exe = Join-Path $env:LOCALAPPDATA "$product\$product.exe"
  if (Test-Path $exe) {
    Start-Process $exe
  } else {
    Say "Launch it from the Start menu."
  }
}
