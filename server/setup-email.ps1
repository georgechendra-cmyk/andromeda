# Celestin's sign-in codes and password resets, sent from your Gmail (celestinsupportai@gmail.com) by a small Google
# script: free, about 100 emails a day. This makes a secret key, puts the script (with the key in it) on your Desktop,
# and saves the key and the script's address on Celestin's server. Nothing else changes.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray()
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
$script = @"
// Celestin's mail: sends the sign-in codes Celestin's server asks for. Paste all of this into script.google.com.
const KEY = "$key";
function doPost(e) {
  const b = JSON.parse(e.postData.contents);
  if (b.key !== KEY || !b.to) return ContentService.createTextOutput(JSON.stringify({ ok: false })).setMimeType(ContentService.MimeType.JSON);
  MailApp.sendEmail({ to: b.to, subject: b.subject, body: b.text, htmlBody: b.html, name: "Celestin" });
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}
"@
$file = Join-Path ([Environment]::GetFolderPath("Desktop")) "celestin-mail-script.txt"
Set-Content -Path $file -Value $script -Encoding UTF8
Write-Host ""
Write-Host "1. Open https://script.google.com signed in as celestinsupportai@gmail.com, and press New project." -ForegroundColor Cyan
Write-Host "2. Delete what's there, and paste everything from 'celestin-mail-script.txt' on your Desktop."
Write-Host "3. Press Deploy > New deployment > the gear > Web app."
Write-Host "   Execute as: Me.  Who has access: Anyone.  Press Deploy, then Authorize access and allow it."
Write-Host "   (Google may say the app isn't verified: Advanced > Go to the project. It's your own script.)"
Write-Host "4. Copy the Web app URL (it ends in /exec) and paste it here."
Write-Host ""
$url = (Read-Host "Web app URL").Trim()
if ($url -notmatch '^https://script\.google\.com/macros/s/[^/]+/exec$') { Write-Host "That doesn't look like a Web app URL (https://script.google.com/macros/s/.../exec). Nothing was saved." -ForegroundColor Red; exit 1 }
# through a file, not a pipe (Windows PowerShell would slip an invisible character in), deleted straight after
$f = Join-Path $env:TEMP ("celestin-" + [guid]::NewGuid().ToString("N") + ".json")
[IO.File]::WriteAllText($f, (@{ MAIL_URL = $url; MAIL_KEY = $key } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
npx --yes wrangler@4 secret bulk $f 2>&1 | Out-Null
$ok = $LASTEXITCODE -eq 0
Remove-Item $f -Force -ErrorAction SilentlyContinue
if (-not $ok) { Write-Host "It wasn't saved. Run this again." -ForegroundColor Red; exit 1 }
Remove-Item $file -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Done. Signing in with a password now asks for a code sent to the email, and 'Forgot your password?' works." -ForegroundColor Green
