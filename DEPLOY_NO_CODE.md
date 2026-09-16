# Deploying with zero command line (GitHub + Render)

This gets the bot running 24/7 using only two websites — no terminal, no SSH,
no CLI tools. Everything is clicking buttons and filling in forms.

Total time: ~15 minutes. Cost: $7/month (Render's smallest "Starter" plan —
the free tier exists but pauses the bot after 15 minutes of no visitors,
which defeats the point of an always-on bot).

---

## Part 1 — Put the code on GitHub (just a file upload)

1. Go to **github.com** and sign up (free) if you don't have an account.
2. Click the **+** icon top-right → **New repository**.
3. Name it anything, e.g. `synthtrade-bot`. Set it to **Private** (recommended,
   since anyone could otherwise see your code — though your actual secrets
   never go in here, see below). Click **Create repository**.
4. On the new repo's page, click **"uploading an existing file"** (or
   **Add file → Upload files**).
5. Drag in these files from the `synthtrade-server` folder you already have:
   - `bot.js`
   - `package.json`
   - `package-lock.json`
   - `.env.example`
   - `README.md`

   **Do not upload a `.env` file** — that would put your real API token on
   GitHub. Secrets go into Render's dashboard instead, in Part 2.
6. Scroll down, click **Commit changes**. Done — your code is now on GitHub.

---

## Part 2 — Deploy it on Render (forms, not commands)

1. Go to **render.com** and sign up — choose **"Sign up with GitHub"** so the
   two are connected automatically.
2. Click **New +** → **Web Service**.
3. Pick the `synthtrade-bot` repository you just created. Click **Connect**.
4. Fill in the form:
   - **Name**: anything, e.g. `synthtrade-bot`
   - **Region**: pick one in **Europe** if offered (Frankfurt/Amsterdam) —
     Deriv's servers are EU-based, so this keeps the network path short.
   - **Build Command**: `npm install`
   - **Start Command**: `node bot.js`
   - **Instance Type**: choose **Starter** ($7/month). Skip Free — it pauses
     after 15 minutes of inactivity, which would stop the bot along with it.
5. Scroll to **Environment Variables**. Click **Add Environment Variable**
   for each of these (values from your own Deriv account):

   | Key | Value |
   |---|---|
   | `DERIV_APP_ID` | your app ID |
   | `DERIV_API_TOKEN` | your token |
   | `DERIV_ACCOUNT_TYPE` | `demo` (start here) |
   | `ASSET` | `R_75` |
   | `STAKE` | `0.5` |
   | `DURATION_TICKS` | `5` |
   | `MARTINGALE_ENABLED` | `true` |
   | `MARTINGALE_MAX_LEVELS` | `4` |
   | `MARTINGALE_MULTIPLIER` | `2.1` |
   | `RISK_ENABLED` | `true` |
   | `MAX_DAILY_LOSS` | `150` |
   | `DAILY_WIN_TARGET` | `75` |
   | `MAX_CONSECUTIVE_LOSSES` | `4` |
   | `COOLDOWN_SECONDS` | `60` |
   | `DASHBOARD_TOKEN` | a long random string you make up |

   **Do not add a `PORT` variable** — Render sets that automatically and the
   bot already respects it.

6. Click **Create Web Service**.

Render will now build and start it automatically. You'll see live logs right
there in the browser — watch for `WebSocket authenticated`. That's it, no
terminal involved anywhere in this process.

---

## Checking on it

Render gives you a URL like `https://synthtrade-bot-xxxx.onrender.com`.
Open, in any browser, on any device:

```
https://synthtrade-bot-xxxx.onrender.com/?token=YOUR_DASHBOARD_TOKEN
```

(the token is whatever you typed in as `DASHBOARD_TOKEN` above)

This shows live balance, connection status, ping, and the trade log —
closing this tab doesn't stop the bot, it just stops you looking at it.

## Changing settings later

Render dashboard → your service → **Environment** tab → edit any value →
**Save Changes**. Render automatically restarts the bot with the new
settings. Still zero command line.

## Logs / troubleshooting

Render dashboard → your service → **Logs** tab shows the same output you'd
see running it locally — connection attempts, trades, errors — in real time,
right in the browser.
