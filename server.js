const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'hackystreaming';

app.use(cors({ origin: '*' }));

let tiktokStatus   = 'disconnected';
let tiktok         = null;
let reconnectTimer = null;
const clients      = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

// ── Status page
app.get('/', (req, res) => {
  const color = tiktokStatus === 'connected' ? '#00d26a' : tiktokStatus === 'connecting' ? '#ffd700' : '#ff2d55';
  res.send(`<!DOCTYPE html>
<html><head><title>TikTok Gift Proxy</title><meta charset="UTF-8"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0f;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh}
  .box{text-align:center;padding:48px 56px;border:1px solid rgba(255,255,255,0.08);border-radius:20px;background:rgba(255,255,255,0.03)}
  h1{font-size:26px;margin-bottom:20px}
  p{color:rgba(255,255,255,0.5);margin:8px 0;font-size:14px}
  b{color:#fff}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:8px;vertical-align:middle}
  a{color:#69c9d0;text-decoration:none}
  .links{margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06)}
  .testbtn{margin-top:20px;padding:12px 28px;background:linear-gradient(135deg,#ff2d55,#ff6b00);border:none;border-radius:10px;color:#fff;font-size:15px;font-family:monospace;cursor:pointer;letter-spacing:1px}
  .testbtn:hover{opacity:0.85}
  #result{margin-top:10px;font-size:12px;color:#00d26a;min-height:18px}
</style>
</head><body><div class="box">
<h1>🎁 TikTok Gift Alert Proxy</h1>
<p>Username: <b>@${TIKTOK_USERNAME}</b></p>
<p><span class="dot"></span>TikTok: <b>${tiktokStatus}</b></p>
<p>OBS clients connected: <b>${clients.size}</b></p>
<div class="links">
  <p><a href="/overlay">🖥 Overlay page (OBS source)</a></p>
  <p><a href="/status">/status JSON</a></p>
</div>
<button class="testbtn" onclick="sendTest()">🎭 Send Test Alert to OBS</button>
<div id="result"></div>
</div>
<script>
async function sendTest(){
  const r = document.getElementById('result');
  r.textContent = 'Sending...';
  try {
    const res = await fetch('/test');
    const d = await res.json();
    r.textContent = d.obsClients > 0
      ? 'Alert sent to OBS! (' + d.obsClients + ' client) — ' + d.sent.nickname + ' sent ' + d.sent.giftName
      : 'No OBS clients connected yet!';
  } catch(e){ r.textContent = 'Error: ' + e.message; }
}
</script>
</body></html>`);
});

// ── SSE stream
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

// ── Status JSON
app.get('/status', (req, res) => {
  res.json({ status: tiktokStatus, username: TIKTOK_USERNAME, clients: clients.size });
});

// ── Test endpoint — sends a fake gift to ALL connected OBS clients
app.get('/test', (req, res) => {
  const gifts = [
    { nickname: 'TestViewer',       giftName: 'Rose',     count: 5, coins: 5     },
    { nickname: 'xXDragonSlayerXx', giftName: 'Lion',     count: 1, coins: 29999 },
    { nickname: 'TikTokQueen99',    giftName: 'Diamond',  count: 3, coins: 15000 },
    { nickname: 'CosmicVibes',      giftName: 'Universe', count: 1, coins: 34999 },
    { nickname: 'PixelPrincess',    giftName: 'Crown',    count: 2, coins: 1000  },
  ];
  const gift = gifts[Math.floor(Math.random() * gifts.length)];
  broadcast('gift', { ...gift, uniqueId: gift.nickname, timestamp: Date.now() });
  console.log(`[Test] Sent fake gift to ${clients.size} OBS client(s):`, gift.giftName);
  res.json({ ok: true, sent: gift, obsClients: clients.size });
});

// ── Overlay HTML
app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'tiktok-gift-alert.html'));
});

// ── Static files (after all routes)
app.use(express.static(__dirname, { index: false }));

// ── TikTok connection
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

  // Dedup map: key = "uniqueId:giftId:repeatCount" → timestamp
  // Blocks any identical event arriving within 4 seconds
  const recentGifts = new Map();

  tiktok.on('gift', data => {
    /*
      DUAL PROTECTION against duplicates:

      Layer 1 — giftType check:
        giftType === 2  → streakable (Rose, Heart etc.)  → only fire on repeatEnd = true
        giftType !== 2  → non-streakable (Diamond, Lion) → fire immediately

      Layer 2 — dedup map:
        Key = userId + giftId + repeatCount
        If same key seen within 4s → drop it (catches edge cases Layer 1 misses)
    */

    const isStreakable = data.giftType === 2;
    if (isStreakable && !data.repeatEnd) return; // mid-streak, wait for final event

    // Build dedup key
    const dedupKey = `${data.uniqueId}:${data.giftId}:${data.repeatCount || 1}`;
    const now = Date.now();
    const lastSeen = recentGifts.get(dedupKey);

    if (lastSeen && (now - lastSeen) < 4000) {
      console.log(`[Gift] ⛔ Duplicate blocked: ${dedupKey}`);
      return;
    }

    recentGifts.set(dedupKey, now);

    // Clean up old entries every 100 gifts to avoid memory leak
    if (recentGifts.size > 100) {
      for (const [k, t] of recentGifts) {
        if (now - t > 10000) recentGifts.delete(k);
      }
    }

    const payload = {
      uniqueId:   data.uniqueId,
      nickname:   data.nickname      || data.uniqueId || 'Someone',
      giftName:   data.giftName      || 'Gift',
      giftId:     data.giftId,
      count:      data.repeatCount   || 1,
      coins:      (data.diamondCount || 1) * (data.repeatCount || 1),
      pictureUrl: data.giftPictureUrl || data.giftImageUrl || '',
      timestamp:  now,
    };

    console.log(`[Gift] ✅ ${payload.nickname} x${payload.count} "${payload.giftName}" — ${payload.coins} coins`);
    broadcast('gift', payload);
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

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT} — @${TIKTOK_USERNAME}`);
  connectTikTok();
});
