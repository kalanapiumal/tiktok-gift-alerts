const express = require('express');
const cors    = require('cors');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── YOUR TIKTOK USERNAME ───────────────────────────────────────────────────
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'hackystreaming';

// ─── CORS — allow your Vercel alert page to connect ────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.static(__dirname));

// ─── STATE ──────────────────────────────────────────────────────────────────
let tiktokStatus = 'disconnected';
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

// ─── SSE ENDPOINT  /events ──────────────────────────────────────────────────
// The alert HTML connects here to receive real-time gift events.
app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // important for Vercel/nginx proxies
  res.flushHeaders();

  // Send a heartbeat every 25s to keep the connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25000);

  clients.add(res);
  console.log(`[SSE] Client connected. Total: ${clients.size}`);

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[SSE] Client disconnected. Total: ${clients.size}`);
  });
});

// ─── ROOT ROUTE ─────────────────────────────────────────────────────────────
app.get('/', (_, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🎁 TikTok Gift Proxy — @${TIKTOK_USERNAME}</title>
      <style>
        body { background:#0a0a0f; color:#fff; font-family:monospace; display:flex;
               align-items:center; justify-content:center; height:100vh; margin:0; }
        .box { text-align:center; padding:40px; border:1px solid rgba(255,255,255,0.1);
               border-radius:16px; background:rgba(255,255,255,0.04); }
        h1 { font-size:28px; margin-bottom:8px; }
        p  { color:rgba(255,255,255,0.5); margin:6px 0; }
        .dot { display:inline-block; width:10px; height:10px; border-radius:50%;
               background:${tiktokStatus === 'connected' ? '#00d26a' : '#ff2d55'};
               margin-right:8px; vertical-align:middle; }
        a { color:#69c9d0; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>🎁 TikTok Gift Alert Proxy</h1>
        <p>Username: <b>@${TIKTOK_USERNAME}</b></p>
        <p><span class="dot"></span>Status: <b>${tiktokStatus}</b></p>
        <p>Connected clients: <b>${clients.size}</b></p>
        <p style="margin-top:20px">SSE endpoint: <a href="/events">/events</a></p>
        <p>Status JSON: <a href="/status">/status</a></p>
      </div>
    </body>
    </html>
  `);
});

// ─── STATUS ENDPOINT ────────────────────────────────────────────────────────
app.get('/status', (_, res) => {
  res.json({ status: tiktokStatus, username: TIKTOK_USERNAME, clients: clients.size });
});

// ─── TIKTOK LIVE CONNECTION ─────────────────────────────────────────────────
let tiktok = null;
let reconnectTimer = null;

function connectTikTok() {
  if (tiktok) {
    try { tiktok.disconnect(); } catch (_) {}
    tiktok = null;
  }

  console.log(`[TikTok] Connecting to @${TIKTOK_USERNAME}…`);
  tiktokStatus = 'connecting';

  tiktok = new WebcastPushConnection(TIKTOK_USERNAME, {
    processInitialData: false,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000,
    clientParams: {
      app_language: 'en-US',
      device_platform: 'web',
    },
  });

  // ── Connected to live stream
  tiktok.connect()
    .then(state => {
      tiktokStatus = 'connected';
      console.log(`[TikTok] ✅ Connected! Room ID: ${state.roomId}`);
      broadcast('connected', { username: TIKTOK_USERNAME, roomId: state.roomId });
    })
    .catch(err => {
      tiktokStatus = 'offline';
      console.warn(`[TikTok] ⚠️  Not live or connection failed: ${err.message}`);
      broadcast('offline', { username: TIKTOK_USERNAME, message: err.message });
      scheduleReconnect();
    });

  // ── 🎁 GIFT EVENT — this is what fires your alerts!
  tiktok.on('gift', data => {
    /*
      data structure from tiktok-live-connector:
      {
        uniqueId:      "viewer123",
        nickname:      "Viewer Display Name",
        giftId:        123,
        giftName:      "Rose",
        giftPictureUrl: "https://…",
        diamondCount:  1,
        repeatCount:   5,       ← how many gifts sent in one streak
        repeatEnd:     true,    ← true = streak finished, show the alert
      }
    */

    // Only fire alert when the gift streak ends (repeatEnd: true)
    // This prevents duplicate alerts during multi-gift streaks
    if (data.repeatEnd || data.repeatCount <= 1) {
      console.log(`[Gift] 🎁 ${data.nickname} sent ${data.repeatCount}x ${data.giftName} (${data.diamondCount * data.repeatCount} coins)`);

      broadcast('gift', {
        uniqueId:    data.uniqueId,
        nickname:    data.nickname    || data.uniqueId,
        giftName:    data.giftName    || 'Gift',
        giftId:      data.giftId,
        count:       data.repeatCount || 1,
        coins:       (data.diamondCount || 1) * (data.repeatCount || 1),
        pictureUrl:  data.giftPictureUrl || '',
        timestamp:   Date.now(),
      });
    }
  });

  // ── Like events (optional — nice to show too)
  tiktok.on('like', data => {
    // Batch likes — only broadcast every 50 likes to avoid spam
    if (data.totalLikeCount % 50 === 0) {
      broadcast('like', {
        nickname: data.nickname,
        total:    data.totalLikeCount,
      });
    }
  });

  // ── Stream disconnected
  tiktok.on('disconnected', () => {
    tiktokStatus = 'disconnected';
    console.log('[TikTok] Disconnected from live stream.');
    broadcast('offline', { username: TIKTOK_USERNAME });
    scheduleReconnect();
  });

  // ── Errors
  tiktok.on('error', err => {
    console.error('[TikTok] Error:', err);
  });
}

function scheduleReconnect(ms = 30000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[TikTok] Reconnecting in ${ms / 1000}s…`);
  reconnectTimer = setTimeout(connectTikTok, ms);
}

// ─── START SERVER ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎁 TikTok Gift Alert Proxy`);
  console.log(`   Username : @${TIKTOK_USERNAME}`);
  console.log(`   Server   : http://localhost:${PORT}`);
  console.log(`   SSE feed : http://localhost:${PORT}/events\n`);
  connectTikTok();
});
