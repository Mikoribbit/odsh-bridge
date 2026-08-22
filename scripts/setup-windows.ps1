# ============================================================================
# setup-windows.ps1 - one-shot, idempotent Windows-host setup for ODSH Bridge v1.1
# Windows host one-click setup for the SSH + Cua Driver desktop channel.
# Safe to re-run; each step skips already-done work.
#
# Usage (Administrator PowerShell):
#   .\scripts\setup-windows.ps1 -BridgePath C:\ODSH-bridge
#   .\scripts\setup-windows.ps1 -BridgePath C:\ODSH-bridge -PubKeyFile C:\ODSH-bridge\DSH-Workspace\dsh_ssh_pubkey.pub
#
# Steps: 1) Cua Driver install/verify + real path   2) OpenSSH Server + auto-start
#        3) firewall 22   4) place DSH public key   5) cua-driver serve running
#        6) write windows-connect.json into the bridge for the DSH side
# ============================================================================
[CmdletBinding()]
param(
  [string]$BridgePath = '',
  [string]$PubKeyFile = '',
  [switch]$SkipFirewall = $false,
  [switch]$NoAutoServe = $false
)

$ErrorActionPreference = 'Stop'
function Say($m){ Write-Host "[setup-windows] $m" -ForegroundColor Cyan }
function Ok ($m){ Write-Host "[setup-windows] OK: $m" -ForegroundColor Green }
function Skip($m){ Write-Host "[setup-windows] skip: $m" -ForegroundColor DarkGray }
function Warn($m){ Write-Host "[setup-windows] WARN: $m" -ForegroundColor Yellow }
function Fail($m){ Write-Host "[setup-windows] FAIL: $m" -ForegroundColor Red; exit 1 }

# ---- admin check (most steps need it; non-admin can only do user-level bits) ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $isAdmin){ Warn 'Not running as Administrator - ProgramData key placement / firewall / sshd enable need elevation. Run as admin if those fail.' }

# ---- bridge path detection ----
if([string]::IsNullOrWhiteSpace($BridgePath)){
  $candidates = @('H:\ODSH-bridge','C:\ODSH-bridge','C:\Users\'+$env:USERNAME+'\ODSH-bridge')
  foreach($c in $candidates){ if(Test-Path (Join-Path $c 'Input')){ $BridgePath=$c; break } }
}
if([string]::IsNullOrWhiteSpace($BridgePath)){ Say 'Bridge path not found; pass -BridgePath <path>.' } else { Say "Bridge: $BridgePath" }

# ---- 1) Cua Driver ----
$cuaCandidates = @(
  "$env:LOCALAPPDATA\Programs\Cua\cua-driver\bin\cua-driver.exe",
  "$env:USERPROFILE\.cua-driver\packages\current\cua-driver.exe"
)
$cuaExe = $cuaCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if(-not $cuaExe){
  Say 'Cua Driver not found - installing via official script (needs network)...'
  try { irm https://cua.ai/driver/install.ps1 | iex; Say 'installer returned' } catch { Warn ('installer failed: '+$_.Exception.Message) }
  # re-detect after install
  $cuaExe = @(
    "$env:LOCALAPPDATA\Programs\Cua\cua-driver\bin\cua-driver.exe",
    "$env:USERPROFILE\.cua-driver\packages\current\cua-driver.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if(-not $cuaExe){ Fail 'Cua Driver could not be located after install. Install it manually: irm https://cua.ai/driver/install.ps1 | iex, then re-run.' }
Ok "Cua Driver at: $cuaExe"
try { $v = & $cuaExe --version; Ok "cua-driver version: $v" } catch { Warn ('cua-driver --version failed: '+$_.Exception.Message) }

# ---- 5) cua-driver serve daemon (before script continues, ensure it runs) ----
if(-not $NoAutoServe){
  try { $srv = & $cuaExe status 2>$null; if($srv -match 'running'){ Ok 'cua-driver serving' } else { & $cuaExe serve | Out-Null; Ok 'cua-driver serve started' } }
  catch { Warn ('cua-driver serve start failed (manual start needed): '+$_.Exception.Message) }
}

# ---- 2) OpenSSH Server ----
$sshdExe = "$env:WINDIR\System32\OpenSSH\sshd.exe"
if(-not (Test-Path $sshdExe)){
  Say 'OpenSSH Server not installed - attempting automatic install (level 1: Windows capability)...'
  try {
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
    Ok 'OpenSSH installed via Add-WindowsCapability'
  } catch {
    Warn ('Add-WindowsCapability failed: ' + $_.Exception.Message)
    Say 'Level 2: trying winget (Microsoft OpenSSH Beta)...'
    try {
      winget install --id Microsoft.OpenSSH.Beta --source winget --accept-package-agreements --accept-source-agreements -e 2>$null | Out-Null
      Ok 'OpenSSH installed via winget (Microsoft.OpenSSH.Beta)'
    } catch {
      Warn ('winget install failed: ' + $_.Exception.Message)
      Say 'Level 3: manual step needed. Please install OpenSSH Server via:'
      Say '  Settings > Optional features > Add feature > "OpenSSH Server"'
      Say '  (or run as admin:  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0)'
      Say '  then re-run this script (it is idempotent and will continue).'
    }
  }
  # re-detect after install attempts
  $sshdExe = "$env:WINDIR\System32\OpenSSH\sshd.exe"
}
if(Test-Path $sshdExe){ Ok ('OpenSSH present: ' + $sshdExe) } else { Warn 'OpenSSH exe still not found after install attempts - manual GUI step required (see above), then re-run.' }

# ensure sshd runs (service manager with scheduled-task fallback)
if(Test-Path $sshdExe){
  $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
  if($svc -and $svc.Status -eq 'Running'){ Ok 'sshd service running' }
  else{
    # try service start
    try {
      if(-not $svc){ New-Service -Name sshd -BinaryPathName $sshdExe -StartupType Automatic -ErrorAction Stop | Out-Null; $svc = Get-Service sshd }
      Start-Service sshd; Set-Service sshd -StartupType Automatic; Ok 'sshd started via service manager'
    } catch {
      Warn ('service manager failed ('+$_.Exception.Message+') - falling back to scheduled task')
      try {
        schtasks /create /tn 'sshd-keepalive' /tr "$sshdExe" /sc onlogon /ru SYSTEM /rl HIGHEST /f | Out-Null
        Start-Process -WindowStyle Hidden $sshdExe
        Ok 'sshd started via scheduled-task fallback'
      } catch { Fail ('could not start sshd any way: '+$_.Exception.Message) }
    }
  }
}

# ---- 3) firewall 22 ----
if(-not $SkipFirewall -and $isAdmin){
  $rule = Get-NetFirewallRule -DisplayName 'ODSH sshd 22' -ErrorAction SilentlyContinue
  if($rule){ Ok 'firewall rule exists' } else {
    try { New-NetFirewallRule -Name 'ODSH-sshd-22' -DisplayName 'ODSH sshd 22' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null; Ok 'firewall rule added for 22' }
    catch { Warn ('firewall rule add failed: '+$_.Exception.Message) }
  }
}

# ---- 4) DSH public key ----
# resolve key file
if([string]::IsNullOrWhiteSpace($PubKeyFile) -and $BridgePath){ $PubKeyFile = Join-Path $BridgePath 'DSH-Workspace\dsh_ssh_pubkey.pub' }
if(Test-Path $PubKeyFile){
  $pub = (Get-Content $PubKeyFile -Raw).Trim()
  # determine if current user is in Administrators (then must use ProgramData file)
  $isAdminUser = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if($isAdminUser){
    $target = 'C:\ProgramData\ssh\administrators_authorized_keys'
    New-Item -ItemType Directory -Force -Path 'C:\ProgramData\ssh' | Out-Null
    if(-not (Test-Path $target)){ New-Item -ItemType File -Force -Path $target | Out-Null }
    $existing = if(Test-Path $target){ (Get-Content $target -Raw) } else { '' }
    if($existing -notmatch [regex]::Escape($pub)){ Add-Content -Path $target -Value $pub; Ok "key added to $target" } else { Skip 'key already present in administrators_authorized_keys' }
    if($isAdmin){ icacls $target /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null; Ok 'ACL set on administrators_authorized_keys' }
  } else {
    $sshDir = Join-Path $env:USERPROFILE '.ssh'
    New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
    $auth = Join-Path $sshDir 'authorized_keys'
    if(-not (Test-Path $auth)){ New-Item -ItemType File -Force -Path $auth | Out-Null }
    $existing = if(Test-Path $auth){ Get-Content $auth -Raw } else { '' }
    if($existing -notmatch [regex]::Escape($pub)){ Add-Content -Path $auth -Value $pub; Ok "key added to $auth" } else { Skip 'key already present in ~/.ssh/authorized_keys' }
    if($isAdmin){ icacls $sshDir /inheritance:r /grant 'Administrators:(OI)(CI)F' /grant 'SYSTEM:F' /grant "$env:USERNAME:(OI)(CI)F" | Out-Null; icacls $auth /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' /grant "$env:USERNAME:F" | Out-Null; Ok 'ACL set on user ssh dir' }
  }
} else { Warn "pubkey file not found at $PubKeyFile - first run DSH side: .\scripts\setup-dsh.sh , then re-run this." }

# ---- 6) write windows-connect.json into the bridge for DSH side ----
if($BridgePath){
  $wc = [ordered]@{
    schema = 'odsh-windows-connect/v1'
    by = 'windows-host'
    updatedMs = [int64](Get-Date -UFormat %s) * 1000
    sshUser = $env:USERNAME
    sshHost = 'host.docker.internal'
    sshPort = 22
    cuaBin = $cuaExe
    sshdReady = (& { if(Test-Path $sshdExe){ (Get-Service sshd -ErrorAction SilentlyContinue).Status } else { 'missing' } })
    keyPlaced = (Test-Path $PubKeyFile)
  }
  $wcDest = Join-Path $BridgePath 'DSH-Workspace\windows-connect.json'
  $wc | ConvertTo-Json -Depth 4 | Set-Content -Path $wcDest -Encoding UTF8
  Ok "wrote $wcDest"
}

# ---- summary ----
Say 'Setup complete. Next, on the DSH container run:'
Say '  .\scripts\setup-dsh.sh --bridge /root/ODSH-bridge --host host.docker.internal'
Say 'Then verify from DSH:'
Say "  node src/oc-cua.mjs get_screen_size   (uses CUA_BIN=$cuaExe)"