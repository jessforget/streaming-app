/**
 * Windows Firewall and the gfx app: can the streaming PC reach it?
 *
 * Windows asks the first time an app listens on the network. If that was
 * missed, or answered "Cancel", Windows quietly blocks other PCs, and the
 * streaming app says "Can't reach". check() looks at the firewall's rules
 * for this program; allow() adds one rule letting PCs on the same network
 * (LocalSubnet) in, after Windows asks the person to confirm (admin).
 *
 * Only on Windows; elsewhere check() says 'unknown'.
 */
const { execFile } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const RULE = 'Gfx app (streaming PC on this network)'
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`

function ps(script, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout, windowsHide: true }, (err, out) =>
      err ? reject(err) : resolve(String(out).trim())
    )
  })
}

/**
 * 'allowed', 'blocked', or 'unknown' (not Windows, or the check failed).
 * Blocked = the firewall is on for this network and no enabled rule lets this program in (or one blocks it).
 */
async function check(exe = process.execPath) {
  if (process.platform !== 'win32') return 'unknown'
  const script = `
$ErrorActionPreference = 'Stop'
$exe = ${quote(exe)}
$cats = @(Get-NetConnectionProfile | ForEach-Object { $_.NetworkCategory.ToString() -replace 'DomainAuthenticated','Domain' })
$on = @(Get-NetFirewallProfile | Where-Object { $_.Enabled -and $cats -contains $_.Name }).Count
$rules = @(Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' })
$fits = { param($r) $p = $r.Profile.ToString(); $p -eq 'Any' -or @($cats | Where-Object { $p -match $_ }).Count -gt 0 }
$allow = @($rules | Where-Object { $_.Action -eq 'Allow' -and (& $fits $_) }).Count
$block = @($rules | Where-Object { $_.Action -eq 'Block' -and (& $fits $_) }).Count
if ($on -eq 0) { 'allowed' } elseif ($block -gt 0 -or $allow -eq 0) { 'blocked' } else { 'allowed' }
`
  try {
    const out = await ps(script)
    return out.endsWith('allowed') ? 'allowed' : out.endsWith('blocked') ? 'blocked' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Let PCs on this network in: turn off Windows' "block" rules for this program (made when its
 * question was cancelled) and add one "allow" rule for the local network only. Windows asks
 * the person to confirm (admin). Returns check() afterwards.
 */
async function allow(exe = process.execPath) {
  if (process.platform !== 'win32') return 'unknown'
  const file = join(os.tmpdir(), `gfx-app-firewall-${process.pid}.ps1`)
  writeFileSync(
    file,
    `$exe = ${quote(exe)}
Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Disable-NetFirewallRule
Get-NetFirewallRule -DisplayName ${quote(RULE)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName ${quote(RULE)} -Direction Inbound -Action Allow -Program $exe -Protocol TCP -RemoteAddress LocalSubnet -Profile Any | Out-Null
`
  )
  try {
    // Start-Process -Verb RunAs: Windows shows its "allow this app to make changes" question.
    await ps(`Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ${quote(`-NoProfile -ExecutionPolicy Bypass -File "${file}"`)}`, 120000)
  } catch {
    // Declined, or it failed: the check below says so.
  }
  return check(exe)
}

module.exports = { check, allow, RULE }
