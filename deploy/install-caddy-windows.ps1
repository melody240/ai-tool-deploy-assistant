param(
  [Parameter(Mandatory = $true)]
  [string]$Domain,
  [string]$InstallRoot = 'C:\caddy',
  [string]$ApiAddress = '127.0.0.1:8080',
  [string]$TaskName = 'AIToolCaddy',
  [string]$AdminAllowedIp = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$version = '2.11.4'
$archiveUrls = @(
  "https://ai-tool-installer.oss-cn-hangzhou.aliyuncs.com/releases/vendor/caddy/$version/caddy_${version}_windows_amd64.zip",
  "https://github.com/caddyserver/caddy/releases/download/v$version/caddy_${version}_windows_amd64.zip",
  "https://ghproxy.net/https://github.com/caddyserver/caddy/releases/download/v$version/caddy_${version}_windows_amd64.zip"
)
$expectedSha512 = 'cd5ccfd86a4b40732cf715890d0dca5bf3f63adefec5a7914de85adf240c60ce7e5d2791631b88ef9758e46b23bb1730e020b9c5d696889740b284ffd4788e35'
$temporary = Join-Path $env:TEMP "caddy-$version.zip"
$caddy = Join-Path $InstallRoot 'caddy.exe'

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Get-Process -Name 'caddy' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $caddy } |
  Stop-Process -Force
$downloaded = $false
$failures = @()
foreach ($archiveUrl in $archiveUrls) {
  try {
    Remove-Item -Force $temporary -ErrorAction SilentlyContinue
    Invoke-WebRequest `
      -UseBasicParsing `
      -Uri $archiveUrl `
      -OutFile $temporary `
      -TimeoutSec 300
    $actualSha512 = (Get-FileHash $temporary -Algorithm SHA512).Hash.ToLowerInvariant()
    if ($actualSha512 -ne $expectedSha512) {
      throw "Checksum mismatch. Expected $expectedSha512, got $actualSha512."
    }
    $downloaded = $true
    break
  } catch {
    $failures += "$archiveUrl : $($_.Exception.Message)"
  }
}
if (-not $downloaded) {
  throw "Unable to download a verified Caddy archive.`n$($failures -join "`n")"
}
Expand-Archive -Path $temporary -DestinationPath $InstallRoot -Force
Remove-Item -Force $temporary

$caddyfile = Join-Path $InstallRoot 'Caddyfile'
$logDirectory = 'C:\ai-tool-installer\.data\caddy'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$adminRoutes = @'
  @admin path /admin* /v1/admin*
  respond @admin 404
'@
if ($AdminAllowedIp) {
  if ($AdminAllowedIp -notmatch '^[0-9a-fA-F:./]+$') {
    throw 'AdminAllowedIp must be an IPv4/IPv6 address or CIDR range.'
  }
  $adminRoutes = @"
  @admin {
    path /admin* /v1/admin*
    remote_ip $AdminAllowedIp
  }
  handle @admin {
    reverse_proxy $ApiAddress
  }

  @blockedAdmin path /admin* /v1/admin*
  respond @blockedAdmin 404
"@
}
@"
$Domain {
  encode zstd gzip

  @public path /live /health /v1/activate /v1/renew /tutorial /downloads
  handle @public {
    reverse_proxy $ApiAddress
  }

$adminRoutes
  respond 404

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "no-referrer"
    -Server
  }

  log {
    output file $logDirectory\access.log
    format json
  }
}
"@ | Set-Content -Encoding UTF8 $caddyfile

& $caddy validate --config $caddyfile
if ($LASTEXITCODE -ne 0) {
  throw 'Caddy configuration validation failed.'
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
$action = New-ScheduledTaskAction `
  -Execute $caddy `
  -Argument "run --config `"$caddyfile`"" `
  -WorkingDirectory $InstallRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal `
  -UserId 'SYSTEM' `
  -LogonType ServiceAccount `
  -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
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

foreach ($port in @(80, 443)) {
  $ruleName = "AI Tool Installer HTTPS $port"
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $port | Out-Null
}

Start-ScheduledTask -TaskName $TaskName
Write-Output "CADDY_VERSION=$version"
Write-Output "HTTPS_URL=https://$Domain/health"
