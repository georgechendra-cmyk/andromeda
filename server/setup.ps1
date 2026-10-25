# Puts the Andromeda credits server online, connects the site to it and uploads the site. Press Enter and wait.
# The only things you ever touch: "Allow" on Cloudflare's page the first time, and pasting each AI key once (any can be
# skipped, and running this again adds the ones you skipped). Keys go straight to Cloudflare; none is written into the
# site or this folder.
$ErrorActionPreference = "Continue"
# what's piped into wrangler goes as plain UTF-8: Windows PowerShell would put an invisible mark before it otherwise
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
Set-Location $PSScriptRoot
$REPO = "https://github.com/georgechendra-cmyk/andromeda.git"
$SITE = "https://georgechendra-cmyk.github.io/andromeda/"
function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host ""; Write-Host $t -ForegroundColor Red; Write-Host "Send Claude a photo of this window."; exit 1 }
# npx.cmd, not npx: PowerShell's npx.ps1 drops every argument (wrangler only ever saw "wrangler" and printed its help)
function W { & npx.cmd --yes wrangler@4 @args }

Write-Host "Andromeda server setup. It does everything by itself." -ForegroundColor Green
Read-Host "Press Enter to start" | Out-Null

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Start-Process "https://nodejs.org"; Fail "Node.js isn't installed: the download page just opened. Install it (the LTS button), then run this again." }

Step "1/8 Cloudflare (first time only: a browser page opens, click Allow)"
$who = (W whoami 2>&1 | Out-String)
if ($who -notmatch "logged in") { W login; $who = (W whoami 2>&1 | Out-String) }
if ($who -notmatch "logged in") { Write-Host $who; Fail "Cloudflare sign-in didn't finish." }
Write-Host "Signed in."

Step "2/8 The database"
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

Step "3/8 Putting the server online"
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

Step "4/8 Where the AI models come from"
$have = (W secret list 2>&1 | Out-String)
function Has($name) { return $have -match ('"' + $name + '"') }
function Yes($q) { return (Read-Host "$q Type y and press Enter for yes, or just press Enter to skip") -match '^\s*y' }
Write-Host "Each key is pasted with right-click, then Enter. It goes straight to Cloudflare and isn't saved anywhere else."

# A gateway topped up in rupiah: its address, then its key (n is "" for the first, "2" for a second one)
function AddGateway($n, $suggest) {
	Write-Host "Sign up there, top up with QRIS (in OVO: Scan / Bayar, then scan the QR the gateway shows), then make an API key."
	$ask = if ($suggest) { "The gateway's API address, from its dashboard (it ends in /v1; press Enter for $suggest)" } else { "The gateway's API address, copied from its dashboard (it ends in /v1)" }
	$gw = (Read-Host $ask).Trim()
	if (-not $gw) { $gw = $suggest }
	if ($gw -notmatch '^https://') { Fail "The address should start with https:// and come from the gateway's dashboard (for example https://api.anoman.io/v1)." }
	$f = Join-Path $env:TEMP ("andromeda-" + [guid]::NewGuid().ToString("N") + ".json")
	[IO.File]::WriteAllText($f, (@{ ("GATEWAY" + $n + "_URL") = $gw } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
	W secret bulk $f 2>&1 | Out-Null
	$ok = $LASTEXITCODE -eq 0
	Remove-Item $f -Force -ErrorAction SilentlyContinue
	if (-not $ok) { Fail "The gateway's address wasn't saved." }
	Write-Host "Now paste its API key:"
	W secret put ("GATEWAY" + $n + "_KEY")
	if ($LASTEXITCODE -ne 0) { Fail "The gateway's key wasn't saved." }
}
if (-not (Has "WAVESPEED_KEY")) {
	Write-Host ""
	Write-Host "WAVESPEED: every lab's big models at the labs' own prices (Claude Opus 5.5 and Fable 5.1, GPT-6 Astra, Gemini 3.1 Pro, Grok 4.7), asked first, and it makes the pictures, videos, voices and music too." -ForegroundColor Yellow
	Write-Host "Topped up by card, PayPal or Alipay (no OVO). If you have a WaveSpeed API key, paste it here."
	if (Yes "Use WaveSpeed?") {
		Write-Host "The key is in your WaveSpeed dashboard, under API Keys (wavespeed.ai, signed in). Paste it:"
		W secret put WAVESPEED_KEY
		if ($LASTEXITCODE -ne 0) { Fail "The WaveSpeed key wasn't saved." }
	}
} else { Write-Host "WaveSpeed: already there." }

if (-not (Has "GATEWAY_KEY")) {
	Write-Host ""
	Write-Host "A GATEWAY YOU TOP UP IN RUPIAH (QRIS: OVO, GoPay, DANA, ShopeePay, bank apps; no card, no subscription)." -ForegroundColor Yellow
	Write-Host "RouterKu has the big models pay-as-you-go from Rp20.000: Claude Opus 5 and Fable 5, GPT-6 Astra, GPT-5.6 Sol, Gemini 3.1 Pro, Grok 4.5. Any OpenAI-compatible gateway works the same way."
	if (Yes "Set it up?") {
		Start-Process "https://routerku.com"
		AddGateway "" ""
		Write-Host ""
		Write-Host "A SECOND GATEWAY (optional): asked for the models the first doesn't have (Anoman: https://api.anoman.io/v1, hundreds of models)." -ForegroundColor Yellow
		if (Yes "Add a second one?") { AddGateway "2" "https://api.anoman.io/v1" }
	}
} else { Write-Host "Rupiah gateway: already there." }

if (-not (Has "CF_API_TOKEN")) {
	Write-Host ""
	Write-Host "CLOUDFLARE AI GATEWAY: GPT, Claude, Gemini and Grok at the labs' own prices, paid from one prepaid Cloudflare balance (no OpenRouter needed)." -ForegroundColor Yellow
	if (Yes "Set it up?") {
		$acct = [regex]::Match((W whoami 2>&1 | Out-String), "\b[0-9a-f]{32}\b").Value
		if (-not $acct) { Fail "Couldn't read your Cloudflare account ID." }
		$f = Join-Path $env:TEMP ("andromeda-" + [guid]::NewGuid().ToString("N") + ".json")
		[IO.File]::WriteAllText($f, (@{ CF_ACCOUNT_ID = $acct } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
		W secret bulk $f 2>&1 | Out-Null
		$ok = $LASTEXITCODE -eq 0
		Remove-Item $f -Force -ErrorAction SilentlyContinue
		if (-not $ok) { Fail "The account ID wasn't saved." }
		Start-Process "https://dash.cloudflare.com/profile/api-tokens"
		Write-Host "Cloudflare's API tokens page just opened: Create Token, then 'Use template' next to Workers AI, then Continue to summary, then Create Token. Copy it, come back here and paste it."
		W secret put CF_API_TOKEN
		if ($LASTEXITCODE -ne 0) { Fail "The Cloudflare token wasn't saved." }
		Start-Process "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
		Write-Host "Last: on the AI Gateway page that just opened, buy credits (Unified Billing). Requests go through once there's a balance. You can set a spending limit there too." -ForegroundColor Yellow
		Read-Host "Press Enter when that's done (or to do it later)" | Out-Null
	}
} else { Write-Host "Cloudflare AI Gateway: already there." }

if (-not (Has "TAVILY_KEY")) {
	Write-Host ""
	Write-Host "WEB SEARCH already works through WaveSpeed's models (about 2 credits a search, paid by whoever searches). Optional: a free Tavily key (1,000 searches a month, no card) does it for free instead." -ForegroundColor Yellow
	if (Yes "Add a Tavily key?") {
		Start-Process "https://app.tavily.com/home"
		Write-Host "Tavily just opened: sign up, copy your API key (it starts with tvly-), come back here and paste it."
		W secret put TAVILY_KEY
		if ($LASTEXITCODE -ne 0) { Fail "The Tavily key wasn't saved." }
	}
} else { Write-Host "Web search: already there." }

if (-not (Has "OPENROUTER_KEY")) {
	Write-Host ""
	Write-Host "OPENROUTER (optional): every other model (DeepSeek, Qwen, Kimi...) and pictures, video and voice. Needs a card or crypto to top up." -ForegroundColor Yellow
	if (Yes "Add an OpenRouter key?") {
		Start-Process "https://openrouter.ai/keys"
		Write-Host "The OpenRouter keys page just opened: Create Key (give it a credit limit), copy it, come back here and paste it."
		W secret put OPENROUTER_KEY
		if ($LASTEXITCODE -ne 0) { Fail "The OpenRouter key wasn't saved." }
	}
} else { Write-Host "OpenRouter: already there." }

$have = (W secret list 2>&1 | Out-String)
if (-not ((Has "GATEWAY_KEY") -or (Has "CF_API_TOKEN") -or (Has "OPENROUTER_KEY"))) {
	Write-Host "No AI key yet: Andromeda can't answer until one is added. Run this again to add one." -ForegroundColor Red
}

Step "5/8 Sign in with Google"
if (-not (Has "GOOGLE_CLIENT_ID")) {
	Write-Host "A 'Continue with Google' button on the site. Google has to know the site first (about two minutes, free)." -ForegroundColor Yellow
	if (Yes "Set it up?") {
		Start-Process "https://console.cloud.google.com/apis/credentials"
		Write-Host "On the Google Cloud page that just opened:"
		Write-Host "  1. Pick a project, or make one (any name, for example Andromeda)."
		Write-Host "  2. Create credentials > OAuth client ID. If it asks to set up the consent screen first: app name Andromeda, your email, Audience External, Save, then back to Credentials."
		Write-Host "  3. Application type: Web application."
		Write-Host "  4. Authorized JavaScript origins > Add URI: https://georgechendra-cmyk.github.io   (add http://localhost too, to try it on this computer)"
		Write-Host "  5. Create, then copy the Client ID (it ends in .apps.googleusercontent.com)."
		$cid = (Read-Host "Paste the Client ID here").Trim()
		if ($cid -match '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$') {
			$f = Join-Path $env:TEMP ("andromeda-" + [guid]::NewGuid().ToString("N") + ".json")
			[IO.File]::WriteAllText($f, (@{ GOOGLE_CLIENT_ID = $cid } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
			W secret bulk $f 2>&1 | Out-Null
			$ok = $LASTEXITCODE -eq 0
			Remove-Item $f -Force -ErrorAction SilentlyContinue
			if ($ok) { Write-Host "Google sign-in is on." } else { Fail "The Client ID wasn't saved." }
		} else { Write-Host "That doesn't look like a Client ID (it ends in .apps.googleusercontent.com). Run this again to add it." -ForegroundColor Red }
	}
} else { Write-Host "Google sign-in: already there." }

Step "6/8 Your admin password (made for you)"
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

Step "7/8 Connecting the site to the server"
$page = Join-Path (Split-Path $PSScriptRoot -Parent) "index.html"
$html = [IO.File]::ReadAllText($page)
$html = [regex]::Replace($html, 'const DEFAULT_SERVER = "[^"]*";', "const DEFAULT_SERVER = `"$url`";")
[IO.File]::WriteAllText($page, $html, (New-Object Text.UTF8Encoding $false))
Write-Host "Done."

Step "8/8 Uploading the site to GitHub (first time: a GitHub sign-in may pop up)"
$tmp = Join-Path $env:TEMP ("andromeda-upload-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
git clone --depth 1 $REPO $tmp 2>&1 | Out-Null
if (-not (Test-Path (Join-Path $tmp ".git"))) {
	Write-Host "Couldn't reach the GitHub repo. Upload andromeda\index.html to it yourself; everything else is done." -ForegroundColor Yellow
} else {
	# the site, the leaderboards it routes by, the tool that refreshes them, and what makes it an app (installs, opens offline)
	$root = Split-Path $PSScriptRoot -Parent
	foreach ($f in @("index.html", "README.md", "arena.json", "tools\arena.mjs", "manifest.webmanifest", "sw.js", "icons\icon.svg", "icons\icon-192.png", "icons\icon-512.png", "icons\icon-maskable-512.png", "icons\apple-touch-icon.png", "docs\welcome.png", "docs\mobile.png", "server\worker.js", "server\setup.ps1", "server\README.md", "server\wrangler.toml", "server\schema.sql", "tools\connector.mjs", "tools\connections.example.json", "CONNECT APPS.bat")) {
		$from = Join-Path $root $f
		if (Test-Path $from) {
			$to = Join-Path $tmp $f
			New-Item -ItemType Directory -Force (Split-Path $to -Parent) | Out-Null
			Copy-Item $from $to -Force
		}
	}
	git -C $tmp add -A
	git -C $tmp -c user.name="Andromeda setup" -c user.email="setup@andromeda.invalid" commit -m "Update the site and connect the credits server" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" 2>&1 | Out-Null
	git -C $tmp push 2>&1 | Out-Host
	if ($LASTEXITCODE -eq 0) { Write-Host "Uploaded. GitHub takes about a minute to show it." } else { Write-Host "The upload didn't go through. Upload andromeda\index.html and arena.json to GitHub yourself; everything else is done." -ForegroundColor Yellow }
	# the daily leaderboard refresh, on its own: GitHub asks for an extra permission to change it, and if it says no,
	# everything above is still up
	$wf = Join-Path $root ".github\workflows\arena.yml"
	if (Test-Path $wf) {
		$to = Join-Path $tmp ".github\workflows\arena.yml"
		New-Item -ItemType Directory -Force (Split-Path $to -Parent) | Out-Null
		Copy-Item $wf $to -Force
		git -C $tmp add -A
		git -C $tmp -c user.name="Andromeda setup" -c user.email="setup@andromeda.invalid" commit -m "Refresh the leaderboards every day" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" 2>&1 | Out-Null
		if ($LASTEXITCODE -eq 0) {
			git -C $tmp push 2>&1 | Out-Host
			if ($LASTEXITCODE -ne 0) { Write-Host "The daily leaderboard refresh wasn't uploaded (GitHub wants the 'workflow' permission). On github.com, add .github\workflows\arena.yml to the repo yourself." -ForegroundColor Yellow }
		}
	}
	Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "All done." -ForegroundColor Green
Write-Host "In a minute: open $SITE , make your account, and send."
Write-Host "To give yourself credits: $($SITE)#admin with the password on your Desktop."
Start-Sleep -Seconds 60
Start-Process $SITE
