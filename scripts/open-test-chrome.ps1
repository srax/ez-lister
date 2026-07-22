$extensionPath = $args[0]
if (-not $extensionPath) {
  $extensionPath = "\\wsl.localhost\Ubuntu\home\hasnatrao\projects\auto_listing\extension"
}
$profileName = $args[1]
if (-not $profileName) {
  $profileName = "carxpert-local-e2e-profile"
}
$debugPort = $args[2]
if (-not $debugPort) {
  $debugPort = 9222
}

$ErrorActionPreference = "Stop"

$profilePath = Join-Path $env:USERPROFILE $profileName
New-Item -ItemType Directory -Force -Path $profilePath | Out-Null

$candidates = @(
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
  (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
)

$chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
  throw "Could not find chrome.exe. Install Google Chrome or update scripts/open-test-chrome.ps1."
}

$chromeArgs = @(
  "--user-data-dir=`"$profilePath`"",
  "--remote-debugging-port=$debugPort",
  "--remote-debugging-address=127.0.0.1",
  "--remote-allow-origins=*",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-background-mode",
  "--load-extension=`"$extensionPath`"",
  "--new-window",
  "chrome://extensions"
)

Start-Process -FilePath $chrome -ArgumentList ($chromeArgs -join " ")
Write-Host "Opened Chrome with dedicated ezlist profile:"
Write-Host $profilePath
Write-Host "CDP port: $debugPort"
Write-Host ""
Write-Host "Load unpacked extension from:"
Write-Host $extensionPath
