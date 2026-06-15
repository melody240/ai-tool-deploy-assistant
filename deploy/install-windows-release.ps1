param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSha256,
  [string]$InstallRoot = 'C:\ai-tool-installer',
  [string]$TaskName = 'AIToolAPI',
  [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this deployment from an elevated PowerShell session.'
  }
}

function Copy-IfPresent {
  param([string]$Source, [string]$Destination)
  if (Test-Path $Source) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Destination) | Out-Null
    Copy-Item -Recurse -Force $Source $Destination
  }
}

function Stop-Api {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
      Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

Assert-Administrator
$PackagePath = (Resolve-Path $PackagePath).Path
$actualHash = (Get-FileHash $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $ExpectedSha256.ToLowerInvariant()) {
  throw "Server package checksum mismatch. Expected $ExpectedSha256, got $actualHash."
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $node) {
  $node = 'C:\Program Files\nodejs\node.exe'
}
if (-not (Test-Path $node)) {
  throw 'Node.js 22 or newer is required.'
}
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) {
  throw "Node.js 22 or newer is required. Found $(& $node --version)."
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$staging = Join-Path $env:TEMP "ai-tool-installer-$timestamp"
$backup = "$InstallRoot-backups\$timestamp"
$taskXml = Join-Path $backup 'scheduled-task.xml'
New-Item -ItemType Directory -Force -Path $staging, $backup | Out-Null
Expand-Archive -Path $PackagePath -DestinationPath $staging -Force
$payload = Join-Path $staging 'payload'
if (-not (Test-Path (Join-Path $payload 'services\api\dist\server.js'))) {
  throw 'The release package does not contain the production API build.'
}
$releaseVersion = (& $node -p "require(process.argv[1]).version" (Join-Path $payload 'package.json')).Trim()
if (-not $releaseVersion) {
  throw 'The release package does not contain a valid version.'
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Export-ScheduledTask -TaskName $TaskName | Set-Content -Encoding Unicode $taskXml
}

foreach ($relative in @(
  'package.json',
  '.env',
  'start-api.bat',
  'services\api',
  'packages\shared'
)) {
  Copy-IfPresent `
    -Source (Join-Path $InstallRoot $relative) `
    -Destination (Join-Path $backup $relative)
}

try {
  Stop-Api
  foreach ($databaseFile in @(
    'license.sqlite3',
    'license.sqlite3-wal',
    'license.sqlite3-shm'
  )) {
    Copy-IfPresent `
      -Source (Join-Path $InstallRoot ".data\$databaseFile") `
      -Destination (Join-Path $backup ".data\$databaseFile")
  }

  foreach ($relative in @(
    'services\api\dist',
    'services\api\public',
    'packages\shared\dist'
  )) {
    Remove-Item -Recurse -Force (Join-Path $InstallRoot $relative) `
      -ErrorAction SilentlyContinue
  }
  foreach ($relative in @(
    'package.json',
    'services\api\package.json',
    'services\api\dist',
    'services\api\public',
    'packages\shared\package.json',
    'packages\shared\dist',
    'scripts\configure-windows-production.mjs',
    'config\license-public-key.b64'
  )) {
    Copy-IfPresent `
      -Source (Join-Path $payload $relative) `
      -Destination (Join-Path $InstallRoot $relative)
  }

  Push-Location $InstallRoot
  try {
    foreach ($module in @(
      'fastify',
      'pg',
      'zod',
      'dotenv',
      '@fastify/multipart',
      '@fastify/rate-limit',
      '@ai-tool-installer/shared'
    )) {
      & $node -e "import('$module').catch(error=>{console.error(error);process.exit(1)})"
      if ($LASTEXITCODE -ne 0) {
        throw "Existing node_modules is missing the required module: $module"
      }
    }
  } finally {
    Pop-Location
  }

  & $node (Join-Path $InstallRoot 'scripts\configure-windows-production.mjs') `
    --root $InstallRoot `
    --expected-public-key (Join-Path $InstallRoot 'config\license-public-key.b64') `
    --host 127.0.0.1 `
    --port $Port
  if ($LASTEXITCODE -ne 0) {
    throw 'Production configuration failed.'
  }

  Remove-Item -Force (Join-Path $InstallRoot '.env') -ErrorAction SilentlyContinue
  $batchPath = Join-Path $InstallRoot 'start-api.bat'
  @"
@echo off
cd /d "$InstallRoot"
set "NODE_ENV=production"
set "DOTENV_CONFIG_PATH=$InstallRoot\services\api\.env"
"$node" "$InstallRoot\services\api\dist\server.js" >> "$InstallRoot\.data\api.log" 2>&1
"@ | Set-Content -Encoding Ascii $batchPath

  $action = New-ScheduledTaskAction `
    -Execute $batchPath `
    -WorkingDirectory $InstallRoot
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

  icacls (Join-Path $InstallRoot 'services\api\.env') `
    /inheritance:r /grant:r 'SYSTEM:(F)' 'Administrators:(F)' | Out-Null
  icacls (Join-Path $InstallRoot '.secrets') `
    /inheritance:r /grant:r 'SYSTEM:(OI)(CI)(F)' 'Administrators:(OI)(CI)(F)' | Out-Null
  icacls (Join-Path $InstallRoot '.data') `
    /inheritance:r /grant:r 'SYSTEM:(OI)(CI)(F)' 'Administrators:(OI)(CI)(F)' | Out-Null

  Start-ScheduledTask -TaskName $TaskName
  $healthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      $response = Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "http://127.0.0.1:$Port/health" `
        -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        $healthy = $true
        break
      }
    } catch {}
  }
  if (-not $healthy) {
    throw "The production API did not become healthy on 127.0.0.1:$Port."
  }

  Write-Output "DEPLOYED_VERSION=$releaseVersion"
  Write-Output "BACKUP=$backup"
  Write-Output "HEALTH=http://127.0.0.1:$Port/health"
  Write-Output "ADMIN_CREDENTIALS=$InstallRoot\.secrets\admin-token.txt"
} catch {
  $deploymentError = $_
  Stop-Api
  foreach ($relative in @(
    'package.json',
    'start-api.bat',
    'services\api',
    'packages\shared'
  )) {
    $saved = Join-Path $backup $relative
    if (Test-Path $saved) {
      Remove-Item -Recurse -Force (Join-Path $InstallRoot $relative) `
        -ErrorAction SilentlyContinue
      Copy-IfPresent -Source $saved -Destination (Join-Path $InstallRoot $relative)
    }
  }
  if (Test-Path (Join-Path $backup '.env')) {
    Copy-Item -Force (Join-Path $backup '.env') (Join-Path $InstallRoot '.env')
  }
  if (Test-Path $taskXml) {
    Register-ScheduledTask `
      -TaskName $TaskName `
      -Xml (Get-Content -Raw $taskXml) `
      -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  throw $deploymentError
} finally {
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
}
