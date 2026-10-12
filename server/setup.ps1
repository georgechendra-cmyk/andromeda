# Puts the Andromeda credits server online, connects the site to it and uploads the site. Press Enter and wait.
# The only things you ever touch: "Allow" on Cloudflare's page the first time, and pasting your OpenRouter key once.
# Keys go straight to Cloudflare; none is written into the site or this folder.
$ErrorActionPreference = "Continue"
# what's piped into wrangler goes as plain UTF-8: Windows PowerShell would put an invisible mark before it otherwise
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
Set-Location $PSScriptRoot
$REPO = "https://github.com/georgechendra-cmyk/andromeda.git"
$SITE = "https://georgechendra-cmyk.github.io/andromeda/"
function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host ""; Write-Host $t -ForegroundColor Red; Write-Host "Send Claude a photo of this window."; exit 1 }
function W { if ($MyInvocation.ExpectingInput) { $input | npx --yes wrangler@4 @args } else { npx --yes wrangler@4 @args } }

Write-Host "Andromeda server setup. It does everything by itself." -ForegroundColor Green
Read-Host "Press Enter to start" | Out-Null

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Start-Process "https://nodejs.org"; Fail "Node.js isn't installed: the download page just opened. Install it (the LTS button), then run this again." }

Step "1/7 Cloudflare (first time only: a browser page opens, click Allow)"
$who = (W whoami 2>&1 | Out-String)
if ($who -match "not authenticated") { W login; $who = (W whoami 2>&1 | Out-String) }
if ($who -match "not authenticated") { Fail "Cloudflare sign-in didn't finish." }
Write-Host "Signed in."

Step "2/7 The database"
$toml = Get-Content wrangler.toml -Raw
$uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
if ($toml -notmatch "database_id = `"$uuid`"") {
	$out = (W d1 create andromeda 2>&1 | Out-String)
	$id = [regex]::Match($out, $uuid).Value
	if (-not $id) {
		$list = (W d1 list --json 2>&1 | Out-String)
		try { $id = ((ConvertFrom-Json $list) | Where-Object { $_.name -eq "andromeda" } | Select-Object -First 1).uuid } catch {}
	}
	if (-not $id) { Write-Host $out; Fail "Couldn't make the database." }
	$toml = [regex]::Replace($toml, 'database_id = "[^"]*"', "database_id = `"$id`"")
	[IO.File]::WriteAllText((Join-Path $PSScriptRoot "wrangler.toml"), $toml)
}
W d1 execute andromeda --remote --file schema.sql --yes 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { W d1 execute andromeda --remote --file schema.sql --yes; Fail "Couldn't make the tables." }
Write-Host "Ready."

Step "3/7 Putting the server online"
$dep = (W deploy 2>&1 | Out-String)
$url = [regex]::Match($dep, "https://[a-z0-9.-]+\.workers\.dev").Value
if (-not $url) {
	# a brand-new Cloudflare account needs a workers.dev name first: Cloudflare asks for it here, once
	Write-Host "Cloudflare wants a name for your server address. Type any name (letters only) and press Enter if it asks." -ForegroundColor Yellow
	W deploy
	$dep = (W deploy 2>&1 | Out-String)
	$url = [regex]::Match($dep, "https://[a-z0-9.-]+\.workers\.dev").Value
}
if (-not $url) { Write-Host $dep; Fail "The server didn't go online." }
Write-Host "Online at $url"

Step "4/7 Your OpenRouter key (the one thing to paste)"
$have = (W secret list 2>&1 | Out-String)
if ($have -notmatch '"OPENROUTER_KEY"') {
	Start-Process "https://openrouter.ai/keys"
	Write-Host "The OpenRouter keys page just opened: Create Key, copy it, come back here, right-click to paste, press Enter." -ForegroundColor Yellow
	Write-Host "(It goes straight to Cloudflare and isn't saved anywhere else.)"
	W secret put OPENROUTER_KEY
	if ($LASTEXITCODE -ne 0) { Fail "The key wasn't saved." }
} else { Write-Host "Already there." }

Step "5/7 Your admin password (made for you)"
$made = @{}
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
if ($have -notmatch '"ADMIN_TOKEN"') {
	$chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray()
	$bytes = New-Object byte[] 20
	$rng.GetBytes($bytes)
	$made.ADMIN_TOKEN = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}
if ($have -notmatch '"PEPPER"') {
	$bytes = New-Object byte[] 32
	$rng.GetBytes($bytes)
	$made.PEPPER = [Convert]::ToBase64String($bytes)
}
if ($made.Count) {
	# through a file, not a pipe (Windows PowerShell would slip an invisible character in), deleted straight after
	$f = Join-Path $env:TEMP ("andromeda-" + [guid]::NewGuid().ToString("N") + ".json")
	[IO.File]::WriteAllText($f, ($made | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
	W secret bulk $f 2>&1 | Out-Null
	$ok = $LASTEXITCODE -eq 0
	Remove-Item $f -Force -ErrorAction SilentlyContinue
	if (-not $ok) { Fail "The admin password wasn't saved." }
}
if ($made.ADMIN_TOKEN) {
	$note = Join-Path ([Environment]::GetFolderPath("Desktop")) "Andromeda admin password.txt"
	"Andromeda admin page: $($SITE)#admin`r`nPassword: $($made.ADMIN_TOKEN)`r`n(Keep this file private. Don't upload it anywhere.)" | Set-Content -Path $note -Encoding UTF8
	Write-Host "Saved on your Desktop: Andromeda admin password.txt"
} else { Write-Host "Already there." }

Step "6/7 Connecting the site to the server"
$page = Join-Path (Split-Path $PSScriptRoot -Parent) "index.html"
$html = [IO.File]::ReadAllText($page)
$html = [regex]::Replace($html, 'const DEFAULT_SERVER = "[^"]*";', "const DEFAULT_SERVER = `"$url`";")
[IO.File]::WriteAllText($page, $html, (New-Object Text.UTF8Encoding $false))
Write-Host "Done."

Step "7/7 Uploading the site to GitHub (first time: a GitHub sign-in may pop up)"
$tmp = Join-Path $env:TEMP ("andromeda-upload-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
git clone --depth 1 $REPO $tmp 2>&1 | Out-Null
if (-not (Test-Path (Join-Path $tmp ".git"))) {
	Write-Host "Couldn't reach the GitHub repo. Upload andromeda\index.html to it yourself; everything else is done." -ForegroundColor Yellow
} else {
	Copy-Item $page (Join-Path $tmp "index.html") -Force
	Copy-Item (Join-Path (Split-Path $PSScriptRoot -Parent) "README.md") (Join-Path $tmp "README.md") -Force
	git -C $tmp add index.html README.md
	git -C $tmp -c user.name="Andromeda setup" -c user.email="setup@andromeda.invalid" commit -m "Connect the credits server" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" 2>&1 | Out-Null
	git -C $tmp push 2>&1 | Out-Host
	if ($LASTEXITCODE -eq 0) { Write-Host "Uploaded. GitHub takes about a minute to show it." } else { Write-Host "The upload didn't go through. Upload andromeda\index.html to GitHub yourself; everything else is done." -ForegroundColor Yellow }
	Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "All done." -ForegroundColor Green
Write-Host "In a minute: open $SITE , make your account, and send."
Write-Host "To give yourself credits: $($SITE)#admin with the password on your Desktop."
Start-Sleep -Seconds 60
Start-Process $SITE
