const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'hackystreaming';

app.use(cors({ origin: '*' }));

let tiktokStatus = 'disconnected';
let tiktok = null;
let reconnectTimer = null;
const clients = new Set();

// ── SECURITY ──
const ADMIN_PIN = process.env.ADMIN_PIN || '1122'; // Change this or set in Railway env
const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL || "kalanapiumal258@gmail.com";
// ── Unknown gift tracker
// Gifts whose names are NOT in the HTML GIFT_DATA will be logged here
const KNOWN_GIFTS = new Set([
  'rose', 'finger heart', 'tiktok', 'sunglasses', 'diamond', 'universe',
  'lion', 'interstellar', 'heart me', 'ice cream', 'balloon', 'confetti',
  'star', 'crown', 'heart', 'galaxy',
  // extended set (keep in sync with HTML)
  'hand heart', 'tiny diny', 'small diny', 'diny', 'soccer goal', 'sports car',
  'boxing gloves', 'perfume', 'corgi', 'lucky cat', 'airplane', 'fire',
  'camera', 'football', 'basketball', 'cap', 'hat', 'doughnut', 'pizza',
  'cat', 'puppy', 'rainbow', 'ship', 'rocket', 'knight', 'castle',
  'gaming', 'guitar', 'microphone', 'music', 'birthday cake', 'cake',
  'gem', 'ruby', 'sapphire', 'emerald', 'trophy', 'medal',
  'planet', 'meteor', 'comet', 'dragon', 'phoenix', 'unicorn',
  'money gun', 'money bag', 'gold bar', 'treasure', 'chest',
  'wishing bottle', 'magic hat', 'fantasy', 'vip', 'luxury',
]);
const unknownGifts = new Map(); // giftName → { data, count, firstSeen }

// ── Live gift DB (populated by fetchAvailableGifts after connect)
// Keyed by giftId (string) AND by lowercase name for fast lookup
const liveGiftDb = new Map();
let giftDbFetched = false;
let giftDbFetchTimer = null;

async function fetchGiftDb() {
  if (!tiktok) return;
  try {
    const gifts = await tiktok.fetchAvailableGifts();
    if (!Array.isArray(gifts) || gifts.length === 0) {
      console.warn('[GiftDB] fetchAvailableGifts returned empty, will retry in 30s');
      scheduleGiftDbFetch(30000);
      return;
    }
    liveGiftDb.clear();
    for (const g of gifts) {
      const id = String(g.id || g.giftId || '');
      const name = (g.name || g.giftName || '').toLowerCase().trim();
      const img = g.image?.url_list?.[0] || g.image_url || g.pictureUrl || '';
      const entry = {
        id,
        name: g.name || g.giftName || '',
        coins: g.diamond_count || g.diamondCount || 0,
        img,
        type: g.type || g.giftType || 0,
      };
      if (id) liveGiftDb.set(id, entry);
      if (name) liveGiftDb.set(name, entry);
    }
    giftDbFetched = true;
    console.log(`[GiftDB] ✅ Loaded ${gifts.length} gifts from TikTok API`);

    // Update the KNOWN_GIFTS set so unknown-gift detection stays accurate
    for (const g of gifts) {
      const n = (g.name || '').toLowerCase().trim();
      if (n) KNOWN_GIFTS.add(n);
    }

    // Send to all connected OBS clients via SSE
    const dbPayload = {};
    for (const g of gifts) {
      const id = String(g.id || g.giftId || '');
      if (id) dbPayload[id] = {
        id,
        name: g.name || g.giftName || '',
        coins: g.diamond_count || g.diamondCount || 0,
        img: g.image?.url_list?.[0] || g.image_url || '',
        type: g.type || g.giftType || 0,
      };
    }
    broadcast('gift_db', { count: gifts.length, db: dbPayload });
  } catch (err) {
    console.warn('[GiftDB] fetch failed:', err.message);
    scheduleGiftDbFetch(60000);
  }
}

function scheduleGiftDbFetch(ms = 15000) {
  if (giftDbFetchTimer) clearTimeout(giftDbFetchTimer);
  giftDbFetchTimer = setTimeout(fetchGiftDb, ms);
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

// ── Helper to render dashboard
function renderDashboard() {
  const color = tiktokStatus === 'connected' ? '#00d26a' : tiktokStatus === 'connecting' ? '#ffd700' : '#ff2d55';
  return `
  <h1>🎁 Gift Alert Control</h1>
  <p>Username: <b>@${TIKTOK_USERNAME}</b></p>
  <p><span class="dot" style="background:${color}"></span>TikTok: <b>${tiktokStatus}</b></p>
  <p>OBS Clients: <b>${clients.size}</b></p>

  <div class="links">
    <p><a href="/overlay?obs=1" target="_blank">🖥 Overlay URL</a></p>
    <p><a href="/gift-log" target="_blank">📣 Gift Log</a></p>
    <p><a href="/gift-db" target="_blank">📦 Gift DB</a></p>
    <p><a href="/unknown-gifts" target="_blank">🆕 New Gifts</a></p>
  </div>

  <button class="test-main-btn" onclick="toggleTest()">🛠️ Diagnostic Test Panel</button>

  <div id="test-section">
    <button class="testbtn" onclick="sendTest('normal')">🎭 Single Gift</button>
    <button class="streakbtn" onclick="sendTest('streak')">🔥 Streak x50</button>
    <button class="centurybtn" onclick="sendTest('century')">💯 Century x100 (Epic)</button>
    <button class="streakbtn" style="background:#ff2d55" onclick="sendTest('streak100')">🔥 Streak x100 (No Epic)</button>
    <button class="whalebtn" onclick="sendTest('whale')">🐳 Whale 500</button>
  </div>

  <div id="result"></div>
  <button class="logout-btn" onclick="logout()">Sign Out</button>
  `;
}

// ── GET / (Minimal Entry)
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Secure Access — TikTok Proxy</title><meta charset="UTF-8"/>
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0f;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;overflow:hidden}
  body::before {
    content:''; position:fixed; inset:0; z-index:-1;
    background: radial-gradient(circle at 20% 30%, rgba(255, 45, 85, 0.1) 0%, transparent 40%),
                radial-gradient(circle at 80% 70%, rgba(105, 201, 208, 0.08) 0%, transparent 40%);
    animation: bgPulse 10s ease-in-out infinite alternate;
  }
  @keyframes bgPulse { from { opacity: 0.5; } to { opacity: 1; } }
  .box{text-align:center;padding:48px 56px;border:1px solid rgba(255,255,255,0.08);border-radius:28px;background:rgba(255,255,255,0.03);width:100%;max-width:480px;backdrop-filter:blur(20px);box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);display:none}
  #login-ui{display:block}
  #pin-ui{display:none}
  #control-ui{display:none}
  .login-header{margin-bottom:32px}
  .login-header h1{font-size:32px;color:#fff;margin-bottom:8px;letter-spacing:1px}
  .google-btn{background:#fff;color:#000;border:none;border-radius:14px;padding:14px;font-size:15px;font-weight:bold;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:12px;width:100%;transition:transform 0.2s}
  .google-btn:hover{transform:translateY(-2px)}
  .google-btn img{width:20px}
  input{width:100%;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);padding:14px;border-radius:14px;color:#fff;font-size:18px;text-align:center;margin:20px 0;outline:none}
  .confirm-btn{background:linear-gradient(135deg,#ff2d55,#ff6b00);border:none;border-radius:14px;padding:14px;width:100%;color:#fff;font-weight:bold;cursor:pointer}
  
  /* Logged In UI items */
  h1{font-size:26px;margin-bottom:12px;color:#ff2d55}
  p{color:rgba(255,255,255,0.5);font-size:14px;margin:8px 0}
  b{color:#fff}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}
  .links{margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);display:grid;grid-template-columns:1fr 1fr;gap:12px;text-align:left}
  a{color:#69c9d0;text-decoration:none}
  button{margin-top:10px;padding:12px 28px;border:none;border-radius:12px;color:#fff;font-size:14px;cursor:pointer;width:100%}
  .test-main-btn{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2)}
  .testbtn{background:linear-gradient(135deg,#ff2d55,#ff6b00)}
  .streakbtn{background:linear-gradient(135deg,#5c35cc,#69c9d0)}
  .centurybtn{background:linear-gradient(135deg,#ffd700,#ff6b00);color:#000;font-weight:bold}
  .whalebtn{background:linear-gradient(135deg,#8b5cf6,#ffd700)}
  .logout-btn{margin-top:20px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.4);font-size:11px;padding:8px}
  #result{margin-top:10px;font-size:12px;color:#00d26a}
  #test-section{display:none;margin-top:15px;padding-top:15px;border-top:1px dashed rgba(255,255,255,0.1)}
</style>
</head><body>
<div id="login-ui" class="box">
  <div class="login-header"><h1>🎁 Secure Access</h1><p>Please sign in with Google</p></div>
  <button class="google-btn" onclick="login()"><img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"/> Continue with Google</button>
</div>
<div id="pin-ui" class="box">
  <h1>🔑 Enter PIN</h1>
  <p id="pin-msg">PIN is required to unlock the dashboard</p>
  <input type="password" id="pin-input" placeholder="••••" maxlength="8" onkeyup="if(event.key==='Enter')verifyPin()"/>
  <button class="confirm-btn" onclick="verifyPin()">Unlock Dashboard</button>
</div>
<div id="control-ui" class="box"></div>

<script>
  const firebaseConfig = {
    apiKey: "AIzaSyC1-XQw6s_MEL0r24qslcSDFWlg2kkWaMc",
    authDomain: "hackytiktok-bcac1.firebaseapp.com",
    projectId: "hackytiktok-bcac1",
    storageBucket: "hackytiktok-bcac1.firebasestorage.app",
    messagingSenderId: "1090815347579",
    appId: "1:1090815347579:web:0bf32634fd5bee206f8bde"
  };
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const ALLOWED_EMAIL = "${ALLOWED_EMAIL}";
  let currentPin = localStorage.getItem('gift_pin') || '';

  auth.onAuthStateChanged(user => {
    if (user) {
      if (user.email === ALLOWED_EMAIL) {
        document.getElementById('login-ui').style.display = 'none';
        if(currentPin) verifyPin(); else document.getElementById('pin-ui').style.display = 'block';
      } else {
        alert("Access Denied: " + user.email);
        auth.signOut();
      }
    } else {
      document.getElementById('login-ui').style.display = 'block';
      document.getElementById('pin-ui').style.display = 'none';
      document.getElementById('control-ui').style.display = 'none';
    }
  });

  async function verifyPin() {
    const pin = document.getElementById('pin-input').value || currentPin;
    if(!pin) return;
    try {
      const res = await fetch('/verify-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      if(res.ok) {
        const html = await res.text();
        localStorage.setItem('gift_pin', pin);
        currentPin = pin;
        document.getElementById('pin-ui').style.display = 'none';
        const ctrl = document.getElementById('control-ui');
        ctrl.style.display = 'block';
        ctrl.innerHTML = html;
      } else {
        localStorage.removeItem('gift_pin');
        document.getElementById('pin-msg').textContent = '❌ Invalid PIN code';
        document.getElementById('pin-input').value = '';
        document.getElementById('pin-ui').style.display = 'block';
      }
    } catch(e) { alert("Verify failed: " + e.message); }
  }

  function login() { auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  function logout() { localStorage.removeItem('gift_pin'); auth.signOut(); }
  function toggleTest(){ const s = document.getElementById('test-section'); s.style.display = (s.style.display==='block'?'none':'block'); }
  async function sendTest(type){
    const r = document.getElementById('result'); r.textContent = 'Triggering...';
    try {
      let url = '/test';
      if(type === 'streak') url = '/test-streak';
      if(type === 'streak100') url = '/test-streak?count=100';
      if(type === 'century') url = '/test-century';
      if(type === 'whale') url = '/test-whale';
      // Append pin for server check
      const separator = url.includes('?') ? '&' : '?';
      const res = await fetch(url + separator + 'pin=' + currentPin);
      if(res.ok) r.textContent = 'Sent successfully!'; else r.textContent = 'Permission Denied!';
    } catch(e){ r.textContent = 'Error: ' + e.message; }
  }
</script>
</body></html>`);
});

// ── Verify session middleware
app.use(express.json());
app.post('/verify-access', (req, res) => {
  const { pin } = req.body;
  if (pin === ADMIN_PIN) {
    res.send(renderDashboard());
  } else {
    res.status(401).send('Invalid PIN');
  }
});

// Middleware for test routes
function checkSecurity(req, res, next) {
  const pin = req.query.pin || req.headers['x-pin'];
  if (pin === ADMIN_PIN) next();
  else res.status(403).send('Unauthorized');
}

// ── SSE stream
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 20000);

  clients.add(res);
  console.log(`[SSE] + client total = ${ clients.size } `);

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[SSE] - client total = ${ clients.size } `);
  });
});

// ── Status JSON
app.get('/status', (req, res) => {
  res.json({ status: tiktokStatus, username: TIKTOK_USERNAME, clients: clients.size });
});

// ── Live Gift DB — HTML gallery or JSON
app.get('/gift-db', (req, res) => {
  const wantsJson = req.query.json !== undefined || (req.headers.accept || '').includes('application/json');

  const entries = [];
  for (const [key, val] of liveGiftDb) {
    if (/^\d+$/.test(key)) entries.push(val);
  }
  entries.sort((a, b) => a.coins - b.coins);

  if (wantsJson) {
    const db = {};
    entries.forEach(e => { db[e.id] = e; });
    return res.json({ fetched: giftDbFetched, count: entries.length, db });
  }

  if (!giftDbFetched) {
    return res.send(`<!DOCTYPE html><html><head><title>Gift DB</title><meta charset="UTF-8" />
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#fff;font-family:monospace;padding:32px}h1{color:#ff9a3c;font-size:22px;margin-bottom:16px}</style></head>
  <body><h1>📦 Live Gift DB</h1>
    <p style="color:rgba(255,255,255,0.4)">Gift DB not loaded yet. The server needs to connect to TikTok LIVE first. Make sure you are streaming and the server has connected.</p>
    <p style="margin-top:12px"><a href="/gift-db" style="color:#69c9d0">↻ Refresh</a></p></body></html>`);
  }

  const html = `<!DOCTYPE html>
  <html><head><title>TikTok Gift DB (${entries.length})</title><meta charset="UTF-8" />
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{background:#0a0a0f;color:#fff;font-family:monospace;padding:32px}
      h1{font-size:22px;margin-bottom:8px;color:#ff9a3c}
      .subtitle{color:rgba(255,255,255,0.4);font-size:12px;margin-bottom:24px}
      .search{width:100%;max-width:500px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:#fff;padding:10px 16px;font-size:14px;outline:none;margin-bottom:20px;font-family:monospace}
      .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
      .gift{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:12px 10px;text-align:center;transition:border-color .2s}
      .gift:hover{border-color:rgba(255,154,60,0.5)}
      .gift img{width:56px;height:56px;object-fit:contain;margin:0 auto 8px;display:block}
      .gift .name{font-size:12px;color:#fff;font-weight:bold;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .gift .coins{font-size:11px;color:#ff9a3c}
      .gift .id{font-size:10px;color:rgba(255,255,255,0.25);margin-top:2px}
      .empty-img{width:56px;height:56px;background:rgba(255,255,255,0.05);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 8px}
      input:focus{border-color:#ff9a3c}
      #count{color:rgba(255,255,255,0.4);font-size:12px;margin-bottom:12px}
    </style></head>
    <body>
      <h1>📦 Live TikTok Gift Database</h1>
      <p class="subtitle">Fetched from TikTok API · ${entries.length} gifts · Updates automatically each stream</p>
      <input class="search" id="q" placeholder="Search by name or ID…" oninput="filter(this.value)" />
      <div id="count">${entries.length} gifts</div>
      <div class="grid" id="grid">
        ${entries.map(g => `<div class="gift" data-name="${(g.name || '').toLowerCase()}" data-id="${g.id}">
  ${g.img ? `<img src="${g.img}" onerror="this.style.display='none'" loading="lazy"/>` : `<div class="empty-img">🎁</div>`}
  <div class="name" title="${g.name}">${g.name || 'Unknown'}</div>
  <div class="coins">🪙 ${g.coins?.toLocaleString() || 0}</div>
  <div class="id">ID: ${g.id}</div>
</div>`).join('')}
      </div>
      <script>
        function filter(q){
          q = q.toLowerCase().trim();
        const gifts=document.querySelectorAll('.gift');
        let shown=0;
  gifts.forEach(el=>{
    const match=!q||el.dataset.name.includes(q)||el.dataset.id.includes(q);
        el.style.display=match?'':'none';
        if(match)shown++;
  });
        document.getElementById('count').textContent=shown+' gifts'+(q?' matching "'+q+'"':'');
}
      </script>
    </body></html>`;
  res.send(html);
});

// ── Unknown gifts log (shows gifts not in GIFT_DATA)
app.get('/unknown-gifts', (req, res) => {
  const list = [];
  for (const [name, info] of unknownGifts) {
    list.push({ name, ...info });
  }
  list.sort((a, b) => b.count - a.count);
  const html = `<!DOCTYPE html>
  <html><head><title>Unknown Gifts</title><meta charset="UTF-8" />
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{background:#0a0a0f;color:#fff;font-family:monospace;padding:32px}
      h1{font-size:22px;margin-bottom:24px;color:#ff9a3c}
      table{width:100%;border-collapse:collapse}
      th{text-align:left;padding:10px 16px;background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.5);font-size:11px;letter-spacing:1px;text-transform:uppercase}
      td{padding:10px 16px;border-top:1px solid rgba(255,255,255,0.06);font-size:13px;vertical-align:top}
      .url{color:#69c9d0;font-size:11px;word-break:break-all}
      .count{color:#ff9a3c;font-weight:bold}
      .new{background:rgba(255,45,85,0.1)}
      .img{width:40px;height:40px;object-fit:contain;border-radius:8px;background:#1a1a2e}
      .empty{color:rgba(255,255,255,0.3);padding:24px 0}
    </style></head>
    <body>
      <h1>🆕 Unknown / New Gifts (${list.length})</h1>
      <p style="color:rgba(255,255,255,0.4);font-size:12px;margin-bottom:20px">Gifts received during this session that are NOT in the gift database. Add them to GIFT_DATA in tiktok-gift-alert.html.</p>
      ${list.length === 0
        ? '<div class="empty">No unknown gifts seen yet this session! All received gifts are in the database. 🎉</div>'
        : `<table>
<thead><tr><th>Gift Name</th><th>Count</th><th>Coins</th><th>Gift ID</th><th>Image</th><th>Picture URL</th></tr></thead>
<tbody>${list.map(g => `<tr class="new">
  <td><b>${g.name}</b></td>
  <td class="count">${g.count}×</td>
  <td>${g.coins}</td>
  <td style="font-size:11px;color:#aaa">${g.giftId || '-'}</td>
  <td>${g.pictureUrl ? `<img class="img" src="${g.pictureUrl}" onerror="this.style.display='none'"/>` : '-'}</td>
  <td class="url">${g.pictureUrl || '-'}</td>
</tr>`).join('')}
</tbody></table>`}
    </body></html>`;
  res.send(html);
});

// ── Single test gift
app.get('/test', checkSecurity, (req, res) => {
  const gifts = [
    { nickname: 'NightOwl_Stream', giftName: 'Rose', coins: 5, pictureUrl: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.png' },
    { nickname: 'xXDragonSlayerXx', giftName: 'Lion', coins: 29999, pictureUrl: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/77f6ab69b0b03bda98a0a3d2bfdeb46f.png~tplv-obj.png' },
    { nickname: 'TikTokQueen99', giftName: 'Diamond', coins: 5000, pictureUrl: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/3f02fa9594bd1495ff4e8aa5ae265eef~tplv-obj.png' },
    { nickname: 'CosmicVibes', giftName: 'Universe', coins: 34999, pictureUrl: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/e9cafce8279220ed26016a71076d6a8a.png~tplv-obj.png' },
  ];
  const g = gifts[Math.floor(Math.random() * gifts.length)];
  broadcast('gift', {
    streakKey: '', uniqueId: g.nickname, nickname: g.nickname,
    giftName: g.giftName, count: 1, coins: g.coins, pictureUrl: g.pictureUrl, isStreak: false,
  });
  console.log(`[Test] Single gift: ${ g.giftName } `);
  res.json({ ok: true, sent: g, obsClients: clients.size });
});

// ── Streak simulation: creates card then streams live updates to it
app.get('/test-streak', checkSecurity, (req, res) => {
  const streakKey = `test_${ Date.now() } `;
  const nickname = 'StreakMaster';
  const giftName = 'Rose';
  const pictureUrl = 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.png';
  const coinsPer = 1;
  const finalCount = parseInt(req.query.count) || 50;

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

// ── Century test (x100 streak)
app.get('/test-century', (req, res) => {
  const streakKey = `test_century_${ Date.now() } `;
  const nickname = 'CenturyKing';
  const giftName = 'Rose';
  const pictureUrl = 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.png';
  const finalCount = 100;

  broadcast('gift', {
    streakKey, uniqueId: nickname, nickname, giftName,
    count: 1, coins: 1, pictureUrl, isStreak: true,
  });

  let step = 2;
  const iv = setInterval(() => {
    if (step > finalCount) {
      clearInterval(iv);
      broadcast('gift_end', { streakKey, count: finalCount, coins: finalCount });
      return;
    }
    broadcast('gift_update', { streakKey, nickname, giftName, count: step, coins: step, pictureUrl });
    step++;
  }, 25); // Faster for century test
  res.json({ ok: true });
});

// ── Whale test (500 coins)
app.get('/test-whale', (req, res) => {
  const nickname = 'WhaleHunter';
  broadcast('gift', {
    streakKey: '', uniqueId: nickname, nickname,
    giftName: 'Lion', giftId: 'single_test',
    count: 1, coins: 500,
    pictureUrl: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/77f6ab69b0b03bda98a0a3d2bfdeb46f.png~tplv-obj.png',
    isStreak: false,
  });
  res.json({ ok: true });
});

// ── Overlay HTML
app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'tiktok-gift-alert.html'));
});

// ── Dashboard HTML
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ── Gift Log (streamer monitor page)
app.get('/gift-log', (req, res) => {
  res.sendFile(path.join(__dirname, 'gift-log.html'));
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

  if (tiktok) { try { tiktok.disconnect(); } catch (_) { } tiktok = null; }

  console.log(`[TikTok] Connecting to @${ TIKTOK_USERNAME }...`);
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
      console.log(`[TikTok] Connected! roomId = ${ state.roomId } `);
      broadcast('connected', { username: TIKTOK_USERNAME, roomId: state.roomId });
      // Fetch gift database shortly after connecting (give the API a moment)
      scheduleGiftDbFetch(3000);
    })
    .catch(err => {
      tiktokStatus = 'offline';
      console.warn(`[TikTok] Not live: ${ err.message } `);
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
    const now = Date.now();
    const isStreakable = data.giftType === 1;   // giftType 1 = streakable (Rose, Heart, etc.)
    const giftId = String(data.giftId || data.gift_id || 'unknown');
    const streakKey = `${ data.uniqueId }:${ giftId } `;
    // Enrich from live DB if available (covers ALL TikTok gifts, all regions)
    const dbEntry = liveGiftDb.get(giftId);
    const pictureUrl = data.giftPictureUrl || data.giftImageUrl || data.pictureUrl || dbEntry?.img || '';
    const giftName = data.giftName || data.gift_name || dbEntry?.name || 'Gift';
    const diamondCount = data.diamondCount || data.diamond_count || dbEntry?.coins || 1;
    const count = data.repeatCount || data.repeat_count || 1;

    // ── Track unknown gifts (not in GIFT_DATA)
    const giftNameLower = giftName.toLowerCase();
    const isKnown = [...KNOWN_GIFTS].some(k => giftNameLower.includes(k));
    if (!isKnown) {
      const existing = unknownGifts.get(giftName);
      if (existing) {
        existing.count++;
      } else {
        unknownGifts.set(giftName, {
          count: 1,
          coins: diamondCount,
          giftId,
          pictureUrl,
          giftType: data.giftType,
          firstSeen: new Date().toISOString(),
        });
        // Log full raw data only on first encounter
        console.log(`[Gift] 🆕 UNKNOWN GIFT: "${giftName}" giftId = ${ giftId } giftType = ${ data.giftType } coins = ${ diamondCount } `);
        console.log(`[Gift]    pictureUrl: ${ pictureUrl } `);
        console.log(`[Gift]    raw keys: ${ Object.keys(data).join(', ') } `);
      }
    }

    if (isStreakable) {
      const existing = activeStreaks.get(streakKey);

      // ── 1. If this is the FIRST event for this streak, ALWAYS send the 'gift' event
      // This ensures the client starts its buffer properly.
      if (!existing) {
        broadcast('gift', {
          streakKey,
          uniqueId: data.uniqueId,
          nickname: data.nickname || data.uniqueId || 'Someone',
          giftName,
          giftId,
          count: count, // Use actual count from TikTok (don't hardcode 1)
          coins: diamondCount * count,
          pictureUrl,
          isStreak: true,
        });
        console.log(`[Gift] 🔴 Streak START  ${ data.nickname } "${giftName}" x${ count } `);
      }

      // ── 2. Handle Mid-streak vs End-streak
      if (!data.repeatEnd) {
        // Mid-streak event
        if (existing) {
          // Only broadcast update if count moved forward
          if (count > existing.count) {
            broadcast('gift_update', {
              streakKey,
              nickname: data.nickname || data.uniqueId || 'Someone',
              giftName,
              count,
              coins: diamondCount * count,
              pictureUrl,
            });
          }
        }

        // Set/reset fallback end timer (increased to 8s - generous for network/user lag)
        if (existing?.timer) clearTimeout(existing.timer);
        const timer = setTimeout(() => {
          const cur = activeStreaks.get(streakKey);
          if (cur) {
            broadcast('gift_end', { streakKey, count: cur.count, coins: diamondCount * cur.count });
            activeStreaks.delete(streakKey);
            console.log(`[Gift] ⌛ Streak TIMEOUT "${giftName}" x${ cur.count } `);
          }
        }, 8000);

        activeStreaks.set(streakKey, { count, timer });

      } else {
        // repeatEnd = true — streak finished
        if (existing?.timer) clearTimeout(existing.timer);
        activeStreaks.delete(streakKey);

        // If it was already existing, send final update
        if (existing && count > existing.count) {
          broadcast('gift_update', {
            streakKey,
            nickname: data.nickname || data.uniqueId || 'Someone',
            giftName,
            count,
            coins: diamondCount * count,
            pictureUrl,
          });
        }

        // Always send gift_end
        broadcast('gift_end', {
          streakKey,
          count,
          coins: diamondCount * count,
        });
        console.log(`[Gift] ✅ Streak END  ${ data.nickname } x${ count } "${giftName}"`);
      }

    } else {
      // Non-streakable: simple dedup
      const dedupKey = `${ data.uniqueId }:${ data.giftId } `;
      const lastSeen = recentSingles.get(dedupKey);
      if (lastSeen && (now - lastSeen) < 4000) {
        console.log(`[Gift] ⛔ Duplicate blocked: ${ dedupKey } `);
        return;
      }
      recentSingles.set(dedupKey, now);
      if (recentSingles.size > 100) {
        for (const [k, t] of recentSingles)
          if (now - t > 10000) recentSingles.delete(k);
      }

      broadcast('gift', {
        streakKey: '',
        uniqueId: data.uniqueId,
        nickname: data.nickname || data.uniqueId || 'Someone',
        giftName,
        giftId,
        count: 1,
        coins: diamondCount,
        pictureUrl,
        isStreak: false,
      });
      console.log(`[Gift] ✅ Single  ${ data.nickname } "${giftName}" — ${ diamondCount } coins`);
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
  console.log(`[TikTok] Retry in ${ ms / 1000 } s`);
  reconnectTimer = setTimeout(connectTikTok, ms);
}

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${ PORT } — @${ TIKTOK_USERNAME } `);
  connectTikTok();
});
