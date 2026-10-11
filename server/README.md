# Andromeda credits server

Lets people pay you for credits and use Andromeda with **your** OpenRouter key, without ever seeing it.
It runs free on Cloudflare (the free plan is enough to start).

Nothing costs you money until someone pays. Your OpenRouter balance can start at **0**: when someone buys,
you top up OpenRouter with part of what they paid and keep the rest.

---

## Setup, once (about 15 minutes)

You need Node.js installed and a free Cloudflare account.

Open a terminal in this `server` folder and run:

```bash
npx wrangler login
npx wrangler d1 create andromeda
```

The second command prints a `database_id`. Paste it into `wrangler.toml` in place of `REPLACE_AFTER_CREATE`.

```bash
npx wrangler d1 execute andromeda --remote --file schema.sql
npx wrangler secret put OPENROUTER_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put PEPPER
npx wrangler deploy
```

- **OPENROUTER_KEY**: a key from openrouter.ai/keys. Give it a **credit limit** there, so even a bug can't spend more than that.
- **ADMIN_TOKEN**: a long password only you know. It opens your admin page.
- **PEPPER**: any long random text. Type it once and forget it. It makes stored passwords harder to crack.

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

- **Mark-up** on OpenRouter's cost: cheap models ×3.5, mid ×2.5, top models ×2 by default.
- **Packs and prices** in each currency. Use round local prices, not exchange-rate conversions.

1 credit = $0.01 at your prices. Every answer shows the user how many credits it used.

## Topping up OpenRouter without a credit card

Cloudflare, GitHub, QRIS, PayPal and Lemon Squeezy payouts need no card. Only OpenRouter's top-up does
(it takes card or crypto). Ways to do it without a credit card:

1. **Virtual debit card**: many Indonesian digital banks (e.g. Jenius, Bank Jago) give a Visa/Mastercard debit
   card inside the app in minutes, linked to your balance. Easiest: every top-up is a couple of taps.
2. **Crypto**: buy USDC on a licensed Indonesian exchange (Indodax, Tokocrypto, Pintu) with a bank transfer or
   e-wallet, then pay OpenRouter's crypto checkout. Check which coins and networks OpenRouter accepts first, and
   send on exactly that network.
3. **Someone with a card** tops up for you and you pay them back from the sale.

The rule stays the same: top up only with money a customer has already paid you.

## Keeping it safe

- Your OpenRouter key only lives in Cloudflare's secrets: never in `index.html`, never on GitHub.
- A request's worst-case cost is set aside before it's sent, so nobody can spend more than they have, even with many
  requests at once. A user at 0 is refused before anything reaches OpenRouter.
- Only top up OpenRouter with money people have already paid you.
