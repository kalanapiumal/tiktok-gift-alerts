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
  button{margin-top:10px;padding:12px 28px;border:none;border-radius:10px;color:#fff;font-size:15px;font-family:monospace;cursor:pointer;letter-spacing:1px;display:block;width:100%}
  .testbtn{background:linear-gradient(135deg,#ff2d55,#ff6b00)}
  .streakbtn{background:linear-gradient(135deg,#5c35cc,#ff6b00)}
  button:hover{opacity:0.85}
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
<button class="testbtn" onclick="sendTest()">🎭 Send Single Gift</button>
<button class="streakbtn" onclick="sendStreak()">🔥 Simulate Streak x50</button>
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
      ? 'Sent! — ' + d.sent.nickname + ' sent ' + d.sent.giftName
      : 'No OBS clients connected yet!';
  } catch(e){ r.textContent = 'Error: ' + e.message; }
}
async function sendStreak(){
  const r = document.getElementById('result');
  r.textContent = 'Streaming streak...';
  try {
    const res = await fetch('/test-streak');
    const d = await res.json();
    r.textContent = 'Streaking x' + d.finalCount + ' over ' + (d.finalCount * 80) + 'ms!';
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

// ── Single test gift
app.get('/test', (req, res) => {
  const gifts = [
    { nickname: 'NightOwl_Stream',  giftName: 'Rose',     coins: 5,     pictureUrl: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.png' },
    { nickname: 'xXDragonSlayerXx', giftName: 'Lion',     coins: 29999, pictureUrl: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/77f6ab69b0b03bda98a0a3d2bfdeb46f.png~tplv-obj.png' },
    { nickname: 'TikTokQueen99',    giftName: 'Diamond',  coins: 5000,  pictureUrl: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/3f02fa9594bd1495ff4e8aa5ae265eef~tplv-obj.png' },
    { nickname: 'CosmicVibes',      giftName: 'Universe', coins: 34999, pictureUrl: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/e9cafce8279220ed26016a71076d6a8a.png~tplv-obj.png' },
  ];
  const g = gifts[Math.floor(Math.random() * gifts.length)];
  broadcast('gift', {
    streakKey: '', uniqueId: g.nickname, nickname: g.nickname,
    giftName: g.giftName, count: 1, coins: g.coins, pictureUrl: g.pictureUrl, isStreak: false,
  });
  console.log(`[Test] Single gift: ${g.giftName}`);
  res.json({ ok: true, sent: g, obsClients: clients.size });
});

// ── Streak simulation: creates card then streams live updates to it
app.get('/test-streak', (req, res) => {
  const streakKey  = `test_${Date.now()}`;
  const nickname   = 'StreakMaster';
  const giftName   = 'Rose';
  const pictureUrl = 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.png';
  const coinsPer   = 1;
  const finalCount = 50;

  // Step 1: create the card with count=1
  broadcast('gift', {
    streakKey, uniqueId: nickname, nickname, giftName,
    count: 1, coins: coinsPer, pictureUrl, isStreak: true,
  });

  // Step 2: stream count updates every 80ms
  let step = 2;
  const iv = setInterval(() => {
    if (step > finalCount) {
      clearInterval(iv);
      broadcast('gift_end', { streakKey, count: finalCount, coins: coinsPer * finalCount });
      return;
    }
    broadcast('gift_update', {
      streakKey, nickname, giftName, pictureUrl,
      count: step, coins: coinsPer * step,
    });
    step++;
  }, 80);

  res.json({ ok: true, finalCount, obsClients: clients.size });
});

// ── Overlay HTML
app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'tiktok-gift-alert.html'));
});

// ── Dashboard HTML
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
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

  /*
    HOW TIKTOK STREAKS WORK:
    ─────────────────────────
    giftType === 2  → streakable (Rose, Heart, etc.)
      - Fires an event every gift in the streak with repeatCount incrementing
      - Fires a FINAL event with repeatEnd = true when streak ends
      - We: send 'gift' for count=1 (creates card), 'gift_update' for each
        increment (updates card live), 'gift_end' on repeatEnd (locks it in)

    giftType !== 2  → non-streakable (Diamond, Lion, etc.)
      - Fires once. We send a single 'gift' event, with dedup.
  */

  const activeStreaks = new Map(); // streakKey → { count, timer }
  const recentSingles = new Map(); // dedupKey  → timestamp

  tiktok.on('gift', data => {
    const now          = Date.now();
    const isStreakable = data.giftType === 2;
    const streakKey    = `${data.uniqueId}:${data.giftId}`;
    const pictureUrl   = data.giftPictureUrl || data.giftImageUrl || '';
    const count        = data.repeatCount || 1;

    if (isStreakable) {

      if (!data.repeatEnd) {
        // Mid-streak event
        const existing = activeStreaks.get(streakKey);

        if (!existing) {
          // First event — create the card
          broadcast('gift', {
            streakKey,
            uniqueId:  data.uniqueId,
            nickname:  data.nickname || data.uniqueId || 'Someone',
            giftName:  data.giftName || 'Gift',
            count:     1,
            coins:     data.diamondCount || 1,
            pictureUrl,
            isStreak:  true,
          });
          console.log(`[Gift] 🔴 Streak START  ${data.nickname} "${data.giftName}"`);
        } else {
          // Update event — only if count moved forward
          if (count <= existing.count) return;
          if (existing.timer) clearTimeout(existing.timer);

          broadcast('gift_update', {
            streakKey,
            nickname:  data.nickname || data.uniqueId || 'Someone',
            giftName:  data.giftName || 'Gift',
            count,
            coins:     (data.diamondCount || 1) * count,
            pictureUrl,
          });
        }

        // Set/reset fallback end timer (in case repeatEnd never fires)
        const timer = setTimeout(() => {
          const cur = activeStreaks.get(streakKey);
          if (cur) {
            broadcast('gift_end', { streakKey, count: cur.count, coins: (data.diamondCount || 1) * cur.count });
            activeStreaks.delete(streakKey);
            console.log(`[Gift] ⌛ Streak TIMEOUT "${data.giftName}" x${cur.count}`);
          }
        }, 3500);

        activeStreaks.set(streakKey, { count, timer });

      } else {
        // repeatEnd = true — streak finished
        const s = activeStreaks.get(streakKey);
        if (s?.timer) clearTimeout(s.timer);
        activeStreaks.delete(streakKey);

        // Push final count update then end
        broadcast('gift_update', {
          streakKey,
          nickname:  data.nickname || data.uniqueId || 'Someone',
          giftName:  data.giftName || 'Gift',
          count,
          coins:     (data.diamondCount || 1) * count,
          pictureUrl,
        });
        broadcast('gift_end', {
          streakKey,
          count,
          coins: (data.diamondCount || 1) * count,
        });
        console.log(`[Gift] ✅ Streak END  ${data.nickname} x${count} "${data.giftName}"`);
      }

    } else {
      // Non-streakable: simple dedup
      const dedupKey = `${data.uniqueId}:${data.giftId}`;
      const lastSeen = recentSingles.get(dedupKey);
      if (lastSeen && (now - lastSeen) < 4000) {
        console.log(`[Gift] ⛔ Duplicate blocked: ${dedupKey}`);
        return;
      }
      recentSingles.set(dedupKey, now);
      if (recentSingles.size > 100) {
        for (const [k, t] of recentSingles)
          if (now - t > 10000) recentSingles.delete(k);
      }

      broadcast('gift', {
        streakKey:  '',
        uniqueId:   data.uniqueId,
        nickname:   data.nickname || data.uniqueId || 'Someone',
        giftName:   data.giftName || 'Gift',
        count:      1,
        coins:      data.diamondCount || 1,
        pictureUrl,
        isStreak:   false,
      });
      console.log(`[Gift] ✅ Single  ${data.nickname} "${data.giftName}" — ${data.diamondCount} coins`);
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

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT} — @${TIKTOK_USERNAME}`);
  connectTikTok();
});
