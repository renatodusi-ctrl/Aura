$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$nodeVersion = node --version
$major = [int]($nodeVersion.TrimStart("v").Split(".")[0])
if ($major -lt 22) {
  throw "AURA requires Node.js 22 or newer. Current: $nodeVersion"
}

npm run verify
Write-Host "Verification passed."
