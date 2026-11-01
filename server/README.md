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
npx wrangler secret put PEPPER
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put TAVILY_KEY
npx wrangler deploy
```

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

## Run your shop

There's no admin page: prices, plans, packs, free credits and how the shop runs are all in `worker.js`
(`DEFAULT_CONFIG`). Ask Claude to change them, then deploy. What the owner does by hand runs on this computer with
`owner.mjs` (signed in to Cloudflare with `npx wrangler login`):

```bash
node owner.mjs pending                     # payments waiting to be confirmed
node owner.mjs approve <payment id>        # after you've seen the money arrive: the plan starts, or the credits are added
node owner.mjs reject <payment id>
node owner.mjs plan <email> <plan> [days]  # give a plan by hand (nova, pulsar, quasar)
node owner.mjs credits <email> <n>         # add (or, negative, take) pack credits
node owner.mjs stats                       # sold, AI cost, free use by day
```

1. **QRIS**: put your QRIS image next to `index.html` on GitHub (for example `qris.png`), then set
   `qris: { image: "qris.png", name: "Your name" }` and `open: true` in `DEFAULT_CONFIG`, and deploy.
2. When someone pays with QRIS, `node owner.mjs pending` lists it with the name they paid from. **Check your e-wallet or
   bank first**, then approve it.

The owner's own account has no limits (`OWNERS` in `worker.js`: the SHA-256 of the email, so the address isn't in the
public code).

## Card and PayPal for people abroad (optional, later)

1. Make an account at Lemon Squeezy (or Paddle / Gumroad). Check that it **pays out to Indonesia** and allows selling
   AI usage credits.
2. Create a product with a variant per plan and per pack.
3. Put each variant's **checkout link** and **variant id** in `checkout.links` and `checkout.variants` in
   `DEFAULT_CONFIG` (keys `plan:nova`, `plan:pulsar`, `plan:quasar`, and each pack's id), then deploy.
4. In Lemon Squeezy, add a webhook to `https://YOUR-SERVER/api/webhooks/lemonsqueezy` for the event
   `order_created`, with a signing secret. Then run:

```bash
npx wrangler secret put LEMON_SECRET
```

Card payments then start plans and add credits automatically, even while you're asleep.

## Prices and plans

All in `DEFAULT_CONFIG` in `worker.js`:

- **Mark-up** on the model's list price: 3x on everything (media too). 1 credit = $0.01 at those prices, so a credit
  costs the owner at most about Rp69. Users only ever see credits: never tokens, never money per answer.
- **Plans**: each has a window of credits that all comes back 5 hours after it's first used, a week's limit and a
  month's limit. The month's limit is the safety cap: nobody can cost the owner more than about twice what they paid.
- **Free**: a small window every 5 hours and a small week, inside a daily budget (`free.budgetIdr`) for all free use
  together.
- **Packs**: credits that never expire, used once a plan's limits are reached.

**Videos, images, voice and music** (the studio) hold their worst case when they start and are charged their real
cost when they finish; a failed one costs nothing.

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
