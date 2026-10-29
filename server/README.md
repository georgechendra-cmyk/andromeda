# Andromeda credits server

Lets people pay you for credits and use Andromeda with **your** AI keys, without ever seeing them.
It runs free on Cloudflare (the free plan is enough to start).

Nothing costs you money until someone pays. Your AI balance can start at **0**: when someone buys,
you top it up with part of what they paid and keep the rest.

---

## Where the models come from

Every request goes to the model that scores best on the leaderboards for that exact work, at the thinking effort it
scored best at. If one way to it says no before answering (it doesn't have that model, your balance is out, it's down),
the next way is asked, so people only ever see an answer.

- **WaveSpeed** (`WAVESPEED_KEY` alone; its address is built in). Every lab's big models under the same names the site
  uses (Claude Opus 5.5 and Fable 5.1, GPT-6 Astra, Gemini 3.1 Pro, Grok 4.7; 128 in all) at the labs' own list prices,
  topped up by card, PayPal or Alipay. Asked before everything else for every model it carries. With it, the studio
  (pictures, video, voice, music) runs on WaveSpeed too: the server reads each model's own request format from
  WaveSpeed's list, uploads pictures the browser sends, and has WaveSpeed price every request before it's made.
0. **A gateway you top up in rupiah** (`GATEWAY_URL` + `GATEWAY_KEY`). Any OpenAI-compatible gateway paid by QRIS (OVO,
   GoPay, DANA, ShopeePay, bank apps), no card: [Anoman](https://www.anoman.io) (`https://api.anoman.io/v1`, a Jakarta
   company, GPT, Claude, Gemini, Grok and hundreds more at the labs' prices), RouterKu, ModelRouter, OneAPI. It goes
   first for every model it carries; the server reads its model list and asks for each by the gateway's own name.
1. **Cloudflare AI Gateway with Unified Billing** (`CF_ACCOUNT_ID` + `CF_API_TOKEN`). GPT, Claude, Gemini and Grok at
   the labs' own prices, paid from one prepaid Cloudflare balance. Cloudflare adds 5% when you buy credits. No
   OpenRouter needed. Claude goes through Anthropic's own format, so its thinking, its own web search and its prompt
   caching all work (the start of a long conversation is billed at a tenth); GPT answers live questions with OpenAI's
   own web search.
2. **OpenRouter** (`OPENROUTER_KEY`, optional). Every other model (DeepSeek, Qwen, Kimi, GLM, Perplexity...), plus the
   studio: pictures, video, voice and music.
3. **Cloudflare's own free models** (nothing to set: the `[ai]` binding in wrangler.toml). GPT-OSS 120B and 20B, Llama
   3.3 70B, Llama 4 Scout, Mistral Small 3.1 and Qwen3 30B, free within the Cloudflare account's daily allowance (no
   card; on the Workers Free plan nothing is ever billed, it just says "busy" once the day's allowance is used). Tools
   work on all six, and Llama 4 Scout and Mistral Small see pictures. Asked last, so with nothing else set up Andromeda
   still answers, and with a gateway they catch what it can't.

The site only routes to models the server can reach. With Cloudflare alone it picks among OpenAI, Anthropic, Google and
xAI, which is where the top-rated models are anyway.

**Live web search:** GPT and Claude search the web themselves (each search about a cent), the way the search
leaderboard rated them. Gemini and Grok do it themselves through OpenRouter; through Cloudflare they get the server's own
search instead: `TAVILY_KEY` from [tavily.com](https://tavily.com) (1,000 free searches a month, no card needed).

## Setup, once (about 15 minutes)

Double-click **SET UP SERVER.bat**. It does everything below by itself and asks for each key, and any key can be
skipped. Run it again any time to add a key or put a new `worker.js` online.

By hand: you need Node.js installed and a free Cloudflare account. Open a terminal in this `server` folder and run:

```bash
npx wrangler login
npx wrangler d1 create andromeda
```

The second command prints a `database_id`. Paste it into `wrangler.toml` in place of `REPLACE_AFTER_CREATE`.

```bash
npx wrangler d1 execute andromeda --remote --file schema.sql
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put PEPPER
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put TAVILY_KEY
npx wrangler deploy
```

- **ADMIN_TOKEN**: a long password only you know. It opens your admin page.
- **PEPPER**: any long random text. Type it once and forget it. It makes stored passwords harder to crack.
- **CF_ACCOUNT_ID**: the Account ID that `npx wrangler whoami` prints.
- **CF_API_TOKEN**: at dash.cloudflare.com/profile/api-tokens, **Create Token** with the **Workers AI** template
  (it needs Workers AI Read). Then, in the Cloudflare dashboard under **AI > AI Gateway**, buy credits for Unified
  Billing. Requests go through once there's a balance, and you can set a spending limit there.
- **OPENROUTER_KEY** (optional): a key from openrouter.ai/keys. Give it a **credit limit** there, so even a bug can't
  spend more than that.
- **WAVESPEED_KEY**: an API key from the WaveSpeed dashboard (wavespeed.ai, signed in, **API Keys**).
- **GATEWAY_URL** and **GATEWAY_KEY** (the rupiah gateway): its API address (for Anoman, `https://api.anoman.io/v1`)
  and an API key from its dashboard, after topping up there with QRIS.
- **GOOGLE_CLIENT_ID** (the "Continue with Google" button): at console.cloud.google.com/apis/credentials, **Create
  credentials > OAuth client ID > Web application**, with `https://georgechendra-cmyk.github.io` as an authorized
  JavaScript origin. Copy the Client ID (it ends in `.apps.googleusercontent.com`).

`wrangler deploy` prints your server's address, like `https://andromeda-credits.yourname.workers.dev`.

## Connect the site to it

In `index.html`, find this line near the top of the script and paste your address in:

```js
const DEFAULT_SERVER = "https://andromeda-credits.yourname.workers.dev";
```

Upload `index.html` to GitHub again. The sidebar now shows **Sign in · Credits**.

## Open your shop

Go to `https://georgechendra-cmyk.github.io/andromeda/#admin` and type your ADMIN_TOKEN.

1. **QRIS**: upload your QRIS image next to `index.html` on GitHub (for example `qris.png`), then put `qris.png` in
   "QRIS image address" and your name in "Name shown on QRIS".
2. Tick **Credits are on sale** and press **Save settings**.

When someone pays with QRIS, it appears under **Waiting for confirmation** with the name they paid from.
**Check your e-wallet or bank first**, then press **Approve**, and their credits arrive at once.

## Card and PayPal for people abroad (optional, later)

1. Make an account at Lemon Squeezy (or Paddle / Gumroad). Check that it **pays out to Indonesia** and allows selling
   AI usage credits.
2. Create a product with 3 variants: Starter $5, Plus $10, Pro $20.
3. In the admin page, paste each variant's **checkout link** and **variant id**, then save.
4. In Lemon Squeezy, add a webhook to `https://YOUR-SERVER/api/webhooks/lemonsqueezy` for the event
   `order_created`, with a signing secret. Then run:

```bash
npx wrangler secret put LEMON_SECRET
```

Card payments then add credits automatically, even while you're asleep.

## Prices

In the admin page you can change, any time:

- **Mark-up** on the model's list price: cheap models ×3.5, mid ×2.5, top models ×2 by default.
- **Packs and prices** in each currency. Use round local prices, not exchange-rate conversions.

1 credit = $0.01 at your prices. Users only ever see credits: never tokens, never money per answer.

**Free credits.** Everyone with an account gets 32 free credits (about Rp5,000 at Starter prices). They're used before
bought credits, and once someone starts using them they're all back 24 hours later. Change both in the admin page (0
turns them off). When the free ones run out, people are told when more come back, or they buy credits.

**Videos, images, voice and music** (the studio) are marked up ×2 (`media` in the mark-ups). A video holds its worst
case when it starts and is charged its real cost when it finishes; a failed one costs nothing. A 15-20 second ad costs
about $0.70 at OpenRouter on Quick, $1 on Standard, $2.50 on Cinematic and $7 on Max (offered only to someone with a big
balance). People see the cost of each in credits before anything is made.

If you set the server up before free credits existed, add the new columns once, then deploy the worker again:

```
npx wrangler d1 execute andromeda --remote --command "ALTER TABLE users ADD COLUMN free_mc INTEGER NOT NULL DEFAULT 0"
npx wrangler d1 execute andromeda --remote --command "ALTER TABLE users ADD COLUMN free_reset_at INTEGER NOT NULL DEFAULT 0"
npx wrangler d1 execute andromeda --remote --file schema.sql
npx wrangler deploy
```

## Topping up without a credit card

Cloudflare asks for a payment method when you buy AI Gateway credits.
OpenRouter's top-up takes card or crypto. Ways to pay without a credit card:

1. **Virtual debit card**: many Indonesian digital banks (e.g. Jenius, Bank Jago) give a Visa/Mastercard debit
   card inside the app in minutes, linked to your balance. Easiest: every top-up is a couple of taps.
2. **Crypto**: buy USDC on a licensed Indonesian exchange (Indodax, Tokocrypto, Pintu) with a bank transfer or
   e-wallet, then pay OpenRouter's crypto checkout. Check which coins and networks OpenRouter accepts first, and
   send on exactly that network.
3. **Someone with a card** tops up for you and you pay them back from the sale.

The rule stays the same: top up only with money a customer has already paid you.

## Keeping it safe

- Your keys only live in Cloudflare's secrets: never in `index.html`, never on GitHub.
- A request's worst-case cost is set aside before it's sent, so nobody can spend more than they have, even with many
  requests at once. A user at 0 is refused before anything reaches a provider.
- If your own AI balance runs out, people see "that model can't be reached right now", never "you're out of credits".
- Only top up with money people have already paid you.
