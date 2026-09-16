'use strict';

/**
 * SynthTrade Pro — headless server bot
 * ------------------------------------
 * Same connection flow, strategy, martingale, and risk logic as the browser
 * dashboard, but running as a plain Node.js process. No browser tab needed,
 * so nothing gets throttled or backgrounded.
 *
 * Run with: node bot.js
 * (See README.md for a plain VPS + pm2 setup, or DEPLOY_NO_CODE.md for a
 * zero-command-line deploy via GitHub + Render.)
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG = {
  appId: process.env.DERIV_APP_ID || '',
  apiToken: process.env.DERIV_API_TOKEN || '',
  accountType: (process.env.DERIV_ACCOUNT_TYPE || 'demo').toLowerCase(), // 'demo' | 'real'
  asset: process.env.ASSET || 'R_75',
  stake: Number(process.env.STAKE) || 0.5,
  durationTicks: Number(process.env.DURATION_TICKS) || 5,

  martingale: {
    enabled: String(process.env.MARTINGALE_ENABLED || 'true') === 'true',
    maxLevels: Number(process.env.MARTINGALE_MAX_LEVELS) || 4,
    multiplier: Number(process.env.MARTINGALE_MULTIPLIER) || 2.1,
  },
  risk: {
    enabled: String(process.env.RISK_ENABLED || 'true') === 'true',
    maxDailyLoss: Number(process.env.MAX_DAILY_LOSS) || 150,
    dailyWinTarget: Number(process.env.DAILY_WIN_TARGET) || 75,
    maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES) || 4,
    cooldownSeconds: Number(process.env.COOLDOWN_SECONDS) || 60,
  },

  // Render (and most PaaS hosts) inject their own PORT env var — always
  // respect that first so "no PORT set in dashboard" just works.
  port: Number(process.env.PORT) || 8787,
  dashboardToken: process.env.DASHBOARD_TOKEN || '',
};

if (!CONFIG.appId || !CONFIG.apiToken) {
  console.error('[FATAL] DERIV_APP_ID and DERIV_API_TOKEN must be set (see .env.example). Exiting.');
  process.exit(1);
}
if (!CONFIG.dashboardToken) {
  console.warn('[WARN] DASHBOARD_TOKEN is not set — the status page will be unprotected. Set one in .env / dashboard env vars.');
}

const REST_BASE = 'https://api.derivws.com';
const LOG_FILE = path.join(__dirname, 'trades.log.jsonl');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  connectionState: 'disconnected', // disconnected | connecting | connected | authenticated | error
  account: null,                    // { accountId, balance, currency, accountType, status }
  currentPrice: 0,
  ticks: [],                        // recent prices, bounded
  trades: [],                       // recent trades, bounded (also appended to LOG_FILE)
  stats: { totalTrades: 0, wins: 0, losses: 0, netProfit: 0, winRate: 0 },
  pingMs: null,
  error: null,
  startedAt: Date.now(),
};

let ws = null;
let reqIdCounter = 1;
const nextReqId = () => reqIdCounter++;

let lastTradeTime = 0;
let consecutiveLosses = 0;
let dailyLoss = 0;
let dailyProfit = 0;
let martingaleLevel = 0;
let cooldownUntil = 0;
let openContractCount = 0;
let currentDayKey = new Date().toISOString().slice(0, 10);

const pendingByReqId = new Map();
const pendingByContractId = new Map();

let pingInterval = null;
let lastPingAt = 0;
let reconnectAttempt = 0;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function appendTradeLog(trade) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(trade) + '\n');
  } catch (e) {
    log('[WARN] Could not write trades.log.jsonl:', e.message);
  }
}

function resetDailyCountersIfNewDay() {
  const todayKey = new Date().toISOString().slice(0, 10);
  if (todayKey !== currentDayKey) {
    log(`New day (${todayKey}) — resetting daily risk counters (was loss=${dailyLoss.toFixed(2)}, profit=${dailyProfit.toFixed(2)})`);
    currentDayKey = todayKey;
    dailyLoss = 0;
    dailyProfit = 0;
  }
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getStake() {
  if (!CONFIG.martingale.enabled) return CONFIG.stake;
  return CONFIG.stake * Math.pow(CONFIG.martingale.multiplier, martingaleLevel);
}

function shouldTrade() {
  if (state.connectionState !== 'authenticated') return false;
  if (openContractCount > 0) return false; // wait for real settlement before next trade
  const now = Date.now();
  if (now < cooldownUntil) return false;
  if (!CONFIG.risk.enabled) return true;
  resetDailyCountersIfNewDay();
  if (dailyLoss >= CONFIG.risk.maxDailyLoss) return false;
  if (dailyProfit >= CONFIG.risk.dailyWinTarget) return false;
  if (consecutiveLosses >= CONFIG.risk.maxConsecutiveLosses) return false;
  return true;
}

function settleContract(pending, won, profit) {
  state.trades = state.trades.map(t =>
    t.id === pending.tradeId ? { ...t, result: won ? 'win' : 'loss', profit } : t
  );
  const settled = state.trades.find(t => t.id === pending.tradeId);
  if (settled) appendTradeLog(settled);

  if (won) {
    consecutiveLosses = 0;
    martingaleLevel = 0;
    dailyProfit += profit;
  } else {
    consecutiveLosses++;
    dailyLoss += pending.stake;
    if (CONFIG.martingale.enabled && martingaleLevel < CONFIG.martingale.maxLevels - 1) {
      martingaleLevel++;
    } else {
      martingaleLevel = 0;
      if (CONFIG.risk.enabled && CONFIG.risk.cooldownSeconds > 0) {
        cooldownUntil = Date.now() + CONFIG.risk.cooldownSeconds * 1000;
      }
    }
  }

  state.stats.totalTrades++;
  if (won) state.stats.wins++;
  else state.stats.losses++;
  state.stats.netProfit = Math.round((state.stats.netProfit + profit) * 100) / 100;
  state.stats.winRate = state.stats.totalTrades > 0
    ? Math.round((state.stats.wins / state.stats.totalTrades) * 1000) / 10
    : 0;

  openContractCount = Math.max(0, openContractCount - 1);
  pendingByContractId.delete(pending.contractId);

  log(`Settled ${won ? 'WIN ' : 'LOSS'} | stake=$${pending.stake.toFixed(2)} profit=${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | net=$${state.stats.netProfit.toFixed(2)} | level=${martingaleLevel}`);
}

async function parseJsonSafe(res, step) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Deriv returned an unexpected response during ${step} (HTTP ${res.status})`);
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function connect() {
  if (shuttingDown) return;
  state.connectionState = 'connecting';
  state.error = null;
  log('Connecting to Deriv...');

  try {
    const accRes = await fetch(`${REST_BASE}/trading/v1/options/accounts`, {
      headers: { 'Deriv-App-ID': CONFIG.appId, 'Authorization': `Bearer ${CONFIG.apiToken}` },
    });
    const accJson = await parseJsonSafe(accRes, 'account lookup');
    if (!accRes.ok) {
      throw new Error(accJson?.errors?.[0]?.message || `Failed to fetch Deriv accounts (HTTP ${accRes.status})`);
    }
    const accounts = accJson.data || [];
    const match = accounts.find(a => a.account_type === CONFIG.accountType && a.status === 'active')
      ?? accounts.find(a => a.account_type === CONFIG.accountType);
    if (!match) {
      throw new Error(`No ${CONFIG.accountType} account found for this token/app ID`);
    }

    state.account = {
      accountId: match.account_id,
      balance: Number(match.balance) || 0,
      currency: match.currency,
      accountType: match.account_type,
      status: match.status,
    };
    log(`Account found: ${match.account_id} (${match.account_type}) balance=${match.currency} ${state.account.balance.toFixed(2)}`);

    const otpRes = await fetch(`${REST_BASE}/trading/v1/options/accounts/${match.account_id}/otp`, {
      method: 'POST',
      headers: { 'Deriv-App-ID': CONFIG.appId, 'Authorization': `Bearer ${CONFIG.apiToken}` },
    });
    const otpJson = await parseJsonSafe(otpRes, 'WebSocket session setup');
    if (!otpRes.ok) {
      throw new Error(otpJson?.errors?.[0]?.message || `Failed to obtain WebSocket session (HTTP ${otpRes.status})`);
    }
    const wsUrl = otpJson.data?.url;
    if (!wsUrl) throw new Error('Deriv did not return a WebSocket URL');

    ws = new WebSocket(wsUrl);
    state.connectionState = 'connected';

    pingInterval = setInterval(() => {
      lastPingAt = Date.now();
      send({ ping: 1, req_id: nextReqId() });
    }, 20000);

    ws.on('open', () => {
      reconnectAttempt = 0;
      state.connectionState = 'authenticated';
      log('WebSocket authenticated. Subscribing to balance + ticks...');
      send({ balance: 1, subscribe: 1, req_id: nextReqId() });
      send({ ticks: CONFIG.asset, subscribe: 1, req_id: nextReqId() });
    });

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (e) {
        log('[WARN] Non-JSON message from Deriv, ignoring.');
        return;
      }
      handleMessage(data);
    });

    ws.on('error', (err) => {
      log('[ERROR] WebSocket error:', err.message);
      state.error = err.message;
    });

    ws.on('close', (code, reason) => {
      state.connectionState = 'disconnected';
      if (pingInterval) clearInterval(pingInterval);
      log(`WebSocket closed (code=${code}${reason ? `, reason=${reason}` : ''}).`);
      scheduleReconnect();
    });
  } catch (e) {
    state.connectionState = 'error';
    state.error = e.message;
    log('[ERROR]', e.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (shuttingDown) return;
  reconnectAttempt++;
  const delayMs = Math.min(30000, 2000 * reconnectAttempt); // backoff up to 30s
  log(`Reconnecting in ${(delayMs / 1000).toFixed(0)}s (attempt ${reconnectAttempt})...`);
  setTimeout(connect, delayMs);
}

function handleMessage(data) {
  if (data.pong) {
    state.pingMs = Date.now() - lastPingAt;
    return;
  }

  if (data.error) {
    log('[Deriv error]', data.error.message);
    state.error = data.error.message;
    return;
  }

  if (data.balance) {
    const newBalance = Number(data.balance.balance) || 0;
    if (state.account) state.account.balance = newBalance;
    return;
  }

  if (data.tick) {
    const price = data.tick.quote;
    state.currentPrice = price;
    state.ticks.push({ price, ts: data.tick.epoch * 1000 });
    if (state.ticks.length > 300) state.ticks.shift();

    const now = Date.now();
    if (now - lastTradeTime > 3000 && shouldTrade()) {
      const prices = state.ticks.map(t => t.price);
      if (prices.length >= 20) {
        const isCall = prices[prices.length - 1] > prices[prices.length - 2];
        const stake = getStake();
        const level = martingaleLevel;
        const tradeId = crypto.randomUUID();
        const signalPrice = price;

        const trade = {
          id: tradeId,
          time: new Date().toISOString(),
          type: isCall ? 'CALL' : 'PUT',
          asset: CONFIG.asset,
          stake: Math.round(stake * 100) / 100,
          result: 'pending',
          profit: 0,
          level,
          signalPrice,
        };
        state.trades.unshift(trade);
        if (state.trades.length > 200) state.trades.length = 200;
        openContractCount += 1;

        const buyReqId = nextReqId();
        const buySentAt = Date.now();
        pendingByReqId.set(buyReqId, { tradeId, contractId: -1, stake, level, signalPrice, buySentAt });

        log(`Placing ${trade.type} $${trade.stake.toFixed(2)} (level ${level}) on ${CONFIG.asset} @ ${signalPrice}`);

        send({
          buy: '1',
          price: stake,
          parameters: {
            underlying_symbol: CONFIG.asset,
            contract_type: isCall ? 'CALL' : 'PUT',
            duration: CONFIG.durationTicks,
            duration_unit: 't',
            currency: state.account?.currency || 'USD',
            basis: 'stake',
            amount: stake,
          },
          req_id: buyReqId,
        });

        lastTradeTime = now;
      }
    }
    return;
  }

  if (data.buy && data.req_id != null) {
    const pending = pendingByReqId.get(data.req_id);
    if (pending) {
      pendingByReqId.delete(data.req_id);
      const contractId = data.buy.contract_id;
      const latencyMs = Date.now() - pending.buySentAt;
      const entryPrice = Number(data.buy.buy_price_spot ?? data.buy.entry_spot);
      const resolved = { ...pending, contractId };
      pendingByContractId.set(contractId, resolved);

      state.trades = state.trades.map(t => t.id === pending.tradeId ? {
        ...t,
        latencyMs,
        ...(Number.isFinite(entryPrice) ? { entryPrice, slippage: Math.round((entryPrice - pending.signalPrice) * 100000) / 100000 } : {}),
      } : t);

      log(`Buy confirmed: contract=${contractId} latency=${latencyMs}ms`);
      send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1, req_id: nextReqId() });
    }
    return;
  }

  if (data.proposal_open_contract) {
    const poc = data.proposal_open_contract;
    const contractId = poc.contract_id;
    const pending = pendingByContractId.get(contractId);
    if (pending) {
      const entrySpot = Number(poc.entry_spot);
      if (Number.isFinite(entrySpot)) {
        state.trades = state.trades.map(t => (t.id === pending.tradeId && t.entryPrice == null) ? {
          ...t,
          entryPrice: entrySpot,
          slippage: Math.round((entrySpot - pending.signalPrice) * 100000) / 100000,
        } : t);
      }
      if (poc.is_sold) {
        const won = poc.status === 'won';
        const profit = Math.round(Number(poc.profit) * 100) / 100;
        settleContract(pending, won, profit);
        const subId = poc.subscription?.id || data.subscription?.id;
        if (subId) send({ forget: subId, req_id: nextReqId() });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal read-only status dashboard (no build step, single HTTP handler)
// ---------------------------------------------------------------------------
function renderDashboardHtml() {
  const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
  const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
  const rows = state.trades.slice(0, 30).map(t => `
    <tr>
      <td>${new Date(t.time).toLocaleTimeString()}</td>
      <td><span class="pill ${t.type === 'CALL' ? 'call' : 'put'}">${t.type}</span></td>
      <td>${t.asset}</td>
      <td class="num">$${t.stake.toFixed(2)}</td>
      <td class="num">${t.latencyMs != null ? t.latencyMs + 'ms' : '…'}${t.slippage != null ? `<div class="sub">${t.slippage >= 0 ? '+' : ''}${t.slippage.toFixed(3)}</div>` : ''}</td>
      <td class="center">${t.result === 'pending' ? '⏳' : t.result === 'win' ? '✅' : '❌'}</td>
      <td class="num ${t.result === 'pending' ? '' : t.profit >= 0 ? 'pos' : 'neg'}">${t.result === 'pending' ? '…' : (t.profit >= 0 ? '+' : '') + '$' + t.profit.toFixed(2)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SynthTrade Pro — Server Status</title>
<meta http-equiv="refresh" content="5">
<style>
  body { background:#0d1117; color:#e2e8f0; font-family: ui-monospace, monospace; margin:0; padding:16px; }
  h1 { font-size:15px; color:#2563eb; margin:0 0 12px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap:8px; margin-bottom:16px; }
  .card { background:#1c2128; border:1px solid #2a2f36; border-radius:8px; padding:10px; }
  .card .label { font-size:10px; color:#475569; }
  .card .value { font-size:16px; font-weight:600; }
  .pos { color:#22c55e; } .neg { color:#ef4444; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { text-align:left; color:#475569; font-weight:500; padding:6px 8px; border-bottom:1px solid #2a2f36; }
  td { padding:6px 8px; border-bottom:1px solid #2a2f36; }
  .num { text-align:right; } .center { text-align:center; }
  .sub { font-size:9px; color:#475569; }
  .pill { font-size:10px; padding:2px 6px; border-radius:4px; }
  .pill.call { background:rgba(37,99,235,0.2); color:#2563eb; }
  .pill.put { background:rgba(245,158,11,0.2); color:#f59e0b; }
  .status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
  .status-dot.ok { background:#22c55e; } .status-dot.bad { background:#ef4444; } .status-dot.mid { background:#f59e0b; }
</style></head>
<body>
  <h1>⚡ SYNTHTRADE PRO — headless server status (auto-refreshes every 5s)</h1>
  <div class="grid">
    <div class="card"><div class="label">CONNECTION</div><div class="value"><span class="status-dot ${state.connectionState === 'authenticated' ? 'ok' : state.connectionState === 'error' ? 'bad' : 'mid'}"></span>${state.connectionState}</div></div>
    <div class="card"><div class="label">ACCOUNT</div><div class="value">${state.account ? state.account.accountId + ' (' + state.account.accountType + ')' : '—'}</div></div>
    <div class="card"><div class="label">BALANCE</div><div class="value">${state.account ? state.account.currency + ' ' + state.account.balance.toFixed(2) : '—'}</div></div>
    <div class="card"><div class="label">PING</div><div class="value">${state.pingMs != null ? state.pingMs + 'ms' : '—'}</div></div>
    <div class="card"><div class="label">NET P/L</div><div class="value ${state.stats.netProfit >= 0 ? 'pos' : 'neg'}">${state.stats.netProfit >= 0 ? '+' : ''}$${state.stats.netProfit.toFixed(2)}</div></div>
    <div class="card"><div class="label">WIN RATE</div><div class="value">${state.stats.totalTrades > 0 ? state.stats.winRate + '%' : '—'} (${state.stats.wins}W/${state.stats.losses}L)</div></div>
    <div class="card"><div class="label">UPTIME</div><div class="value">${uptimeStr}</div></div>
  </div>
  ${state.error ? `<div class="card" style="border-color:#ef4444;margin-bottom:16px;"><div class="label neg">LAST ERROR</div><div>${state.error}</div></div>` : ''}
  <table>
    <thead><tr><th>Time</th><th>Type</th><th>Asset</th><th>Stake</th><th>Lag</th><th>Result</th><th>Profit</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#475569;padding:20px;">Waiting for trades...</td></tr>'}</tbody>
  </table>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/status.json') {
    const token = url.searchParams.get('token');
    if (CONFIG.dashboardToken && token !== CONFIG.dashboardToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  const token = url.searchParams.get('token');
  if (CONFIG.dashboardToken && token !== CONFIG.dashboardToken) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized. Append ?token=YOUR_DASHBOARD_TOKEN to the URL.');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(renderDashboardHtml());
});

server.listen(CONFIG.port, () => {
  log(`Status dashboard listening on port ${CONFIG.port}${CONFIG.dashboardToken ? ' (token protected)' : ''}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown() {
  shuttingDown = true;
  log('Shutting down...');
  if (pingInterval) clearInterval(pingInterval);
  if (ws) ws.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
log(`Starting SynthTrade Pro server bot — ${CONFIG.asset}, stake $${CONFIG.stake}, account type: ${CONFIG.accountType}`);
connect();
