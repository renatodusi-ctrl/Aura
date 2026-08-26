$ErrorActionPreference = "Stop"

Write-Host "AURA setup"
$nodeVersion = node --version
Write-Host "Node: $nodeVersion"

$major = [int]($nodeVersion.TrimStart("v").Split(".")[0])
if ($major -lt 22) {
  throw "AURA requires Node.js 22 or newer."
}

if (!(Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example"
}

New-Item -ItemType Directory -Force -Path "data" | Out-Null
New-Item -ItemType Directory -Force -Path "exports" | Out-Null

Write-Host "Setup complete. Run scripts/run.ps1"
