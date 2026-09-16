# SynthTrade Pro — headless server bot

This runs the exact same connection, strategy, martingale, and risk logic as
the browser dashboard, but as a plain Node.js process. No browser tab, no
phone screen to keep on, no risk of the app being throttled/backgrounded.

**If a terminal/SSH feels like too much:** see `DEPLOY_NO_CODE.md` instead —
it deploys this same code using only GitHub's website and Render's dashboard,
no command line at all.

The instructions below are for a plain VPS (DigitalOcean/Hetzner/Vultr/etc.),
useful if you want full control or lower long-term cost.

## 1. Get a small always-on server

Any cheap VPS works (~$4-6/month, 1 vCPU / 1GB RAM). Pick a datacenter region
in **Europe** if you can — Deriv's infrastructure is EU-based, so this keeps
the network path short and ping steady. Choose Ubuntu 22.04 or 24.04.

## 2. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node -v
```

## 3. Upload this folder

```bash
scp -r synthtrade-server root@YOUR_SERVER_IP:/root/
```

## 4. Configure

```bash
cd /root/synthtrade-server
npm install
cp .env.example .env
nano .env
```

Fill in `DERIV_APP_ID`, `DERIV_API_TOKEN` (same as the browser version),
`DERIV_ACCOUNT_TYPE=demo` (start here), and a long random `DASHBOARD_TOKEN`.

## 5. Run it

```bash
node bot.js
```

Watch for `WebSocket authenticated` in the log. Ctrl+C to stop.

## 6. Keep it running (pm2)

```bash
sudo npm install -g pm2
pm2 start bot.js --name synthtrade
pm2 save
pm2 startup    # run the one command it prints
```

```bash
pm2 logs synthtrade      # live logs
pm2 restart synthtrade   # after editing .env
pm2 stop synthtrade
```

## 7. Check on it

```
http://YOUR_SERVER_IP:8787/?token=YOUR_DASHBOARD_TOKEN
```

Open your VPS provider's firewall for that port if needed.

## Trade history

Every settled trade is appended to `trades.log.jsonl` — one JSON object per
line — independent of the in-memory dashboard, surviving restarts.

## What did NOT change from the browser version

The connection flow (REST account lookup → OTP → WebSocket), the "trade the
direction of the last tick" signal, martingale sizing, risk limits, and real
settlement tracking (via `proposal_open_contract`, never simulated) are
identical. This is a change of *where it runs*, not *what it does*.
