$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = "exports\aura-export-$timestamp.zip"
New-Item -ItemType Directory -Force -Path "exports" | Out-Null

$items = @(
  "index.html",
  "styles.css",
  "app.js",
  "realtime.js",
  "package.json",
  ".env.example",
  ".gitignore",
  "README.md",
  "ARCHITECTURE.md",
  "ROADMAP.md",
  "server",
  "scripts",
  "docs"
)

Compress-Archive -Path $items -DestinationPath $target -Force
Write-Host "Exported $target"
