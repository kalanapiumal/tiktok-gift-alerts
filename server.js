const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'hackystreaming';

app.use(cors({ origin: '*' }));

// ─── STATE ──────────────────────────────────────────────────────────────────
let tiktokStatus   = 'disconnected';
let tiktok         = null;
let reconnectTimer = null;
const clients      = new Set();

// ─── SSE BROADCAST ──────────────────────────────────────────────────────────
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

// ─── ROUTES (must come BEFORE static middleware) ─────────────────────────────

app.get('/', (req, res) => {
  const color = tiktokStatus === 'connected' ? '#00d26a' : tiktokStatus === 'connecting' ? '#ffd700' : '#ff2d55';
  res.send(`<!DOCTYPE html>
<html><head><title>TikTok Gift Proxy</title><meta charset="UTF-8"/>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh}.box{text-align:center;padding:48px 56px;border:1px solid rgba(255,255,255,0.08);border-radius:20px;background:rgba(255,255,255,0.03)}h1{font-size:26px;margin-bottom:20px}p{color:rgba(255,255,255,0.5);margin:8px 0;font-size:14px}b{color:#fff}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:8px;vertical-align:middle}a{color:#69c9d0;text-decoration:none}.links{margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06)}</style>
</head><body><div class="box">
<h1>🎁 TikTok Gift Alert Proxy</h1>
<p>Username: <b>@${TIKTOK_USERNAME}</b></p>
<p><span class="dot"></span>TikTok: <b>${tiktokStatus}</b></p>
<p>OBS clients: <b>${clients.size}</b></p>
<div class="links">
<p><a href="/overlay">🖥 Overlay (add this to OBS)</a></p>
<p><a href="/status">/status JSON</a></p>
</div></div></body></html>`);
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 20000);

  clients.add(res);
  console.log(`[SSE] +client total=${clients.size}`);

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[SSE] -client total=${clients.size}`);
  });
});

app.get('/status', (req, res) => {
  res.json({ status: tiktokStatus, username: TIKTOK_USERNAME, clients: clients.size });
});

app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'tiktok-gift-alert.html'));
});

// Static AFTER routes so it never shadows /
app.use(express.static(__dirname, { index: false }));

// ─── TIKTOK CONNECTION ───────────────────────────────────────────────────────
function connectTikTok() {
  let WebcastPushConnection;
  try {
    ({ WebcastPushConnection } = require('tiktok-live-connector'));
  } catch (err) {
    tiktokStatus = 'error';
    console.error('[TikTok] Package missing:', err.message);
    scheduleReconnect(60000);
    return;
  }

  if (tiktok) { try { tiktok.disconnect(); } catch (_) {} tiktok = null; }

  console.log(`[TikTok] Connecting to @${TIKTOK_USERNAME}...`);
  tiktokStatus = 'connecting';

  try {
    tiktok = new WebcastPushConnection(TIKTOK_USERNAME, {
      processInitialData: false,
      enableExtendedGiftInfo: true,
      enableWebsocketUpgrade: true,
      requestPollingIntervalMs: 2000,
    });
  } catch (err) {
    console.error('[TikTok] Init error:', err.message);
    tiktokStatus = 'error';
    scheduleReconnect(60000);
    return;
  }

  tiktok.connect()
    .then(state => {
      tiktokStatus = 'connected';
      console.log(`[TikTok] Connected! roomId=${state.roomId}`);
      broadcast('connected', { username: TIKTOK_USERNAME, roomId: state.roomId });
    })
    .catch(err => {
      tiktokStatus = 'offline';
      console.warn(`[TikTok] Not live: ${err.message}`);
      broadcast('offline', { username: TIKTOK_USERNAME });
      scheduleReconnect(30000);
    });

  tiktok.on('gift', data => {
    if (data.repeatEnd || data.repeatCount <= 1) {
      const payload = {
        uniqueId:   data.uniqueId,
        nickname:   data.nickname    || data.uniqueId || 'Someone',
        giftName:   data.giftName    || 'Gift',
        count:      data.repeatCount || 1,
        coins:      (data.diamondCount || 1) * (data.repeatCount || 1),
        pictureUrl: data.giftPictureUrl || '',
        timestamp:  Date.now(),
      };
      console.log(`[Gift] ${payload.nickname} x${payload.count} ${payload.giftName}`);
      broadcast('gift', payload);
    }
  });

  tiktok.on('disconnected', () => {
    tiktokStatus = 'disconnected';
    console.log('[TikTok] Stream ended.');
    broadcast('offline', { username: TIKTOK_USERNAME });
    scheduleReconnect(30000);
  });

  tiktok.on('error', err => {
    console.error('[TikTok] Error:', err.message || err);
  });
}

function scheduleReconnect(ms = 30000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[TikTok] Retry in ${ms / 1000}s`);
  reconnectTimer = setTimeout(connectTikTok, ms);
}

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n[Server] TikTok Gift Proxy running on port ${PORT}`);
  console.log(`[Server] @${TIKTOK_USERNAME}`);
  connectTikTok();
});
