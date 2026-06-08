#!/usr/bin/env node
/**
 * tiktok-bridge.js — forwards TikTok Live gifts to the donate-kpraewa API.
 *
 *   node tiktok-bridge.js @k.praewa --pass MyPass
 *   node tiktok-bridge.js @k.praewa --api https://kpraewa.vercel.app --user Admin --pass MyPass
 *   node tiktok-bridge.js @k.praewa --pass MyPass --verbose
 *
 * Flags:
 *   --api <url>     API base URL (default https://kpraewa.vercel.app)
 *   --user <name>   Admin username (default 'Admin' or BRIDGE_USER env)
 *   --pass <pass>   Admin password (or BRIDGE_PASS env)
 *   --verbose       Log every event TikTok sends (chats, likes, joins…)
 *   --raw           Log the raw gift JSON when one arrives
 */

const {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
  UserOfflineError,
  AlreadyConnectingError,
  AlreadyConnectedError,
  SignatureRateLimitError,
  SignatureMissingTokensError,
  getPreferredPictureFormat
} = require('tiktok-live-connector');

// ---------- args / env ----------
const argv = process.argv.slice(2);
let handle = process.env.TIKTOK_HANDLE || null;
const opts = {
  api: (process.env.BRIDGE_API || 'https://kpraewa.vercel.app').replace(/\/$/, ''),
  user: process.env.BRIDGE_USER || 'Admin',
  pass: process.env.BRIDGE_PASS || '',
  verbose: process.env.BRIDGE_VERBOSE === '1' || process.env.BRIDGE_VERBOSE === 'true',
  raw: process.env.BRIDGE_RAW === '1' || process.env.BRIDGE_RAW === 'true'
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => (a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]);
  if (a.startsWith('--api'))   opts.api  = val().replace(/\/$/, '');
  else if (a.startsWith('--user'))    opts.user = val();
  else if (a.startsWith('--pass'))    opts.pass = val();
  else if (a === '--verbose' || a === '-v') opts.verbose = true;
  else if (a === '--raw')               opts.raw = true;
  else if (!handle) handle = a;
}
if (!handle) {
  console.error('Missing TikTok handle. Pass as first argument or set TIKTOK_HANDLE env var.');
  console.error('Example: node tiktok-bridge.js @k.praewa --pass YOUR_PASS');
  process.exit(1);
}
if (!opts.pass) {
  console.error('Missing --pass (or BRIDGE_PASS env var) — needed to log in to the donate API.');
  process.exit(1);
}
handle = handle.startsWith('@') ? handle : '@' + handle;

const ts = () => new Date().toLocaleTimeString();
const log  = (...m) => console.log(`[${ts()}]`, ...m);
const warn = (...m) => console.warn(`[${ts()}] !`, ...m);
const ok   = (...m) => console.log(`[${ts()}] OK`, ...m);
const err  = (...m) => console.error(`[${ts()}] X`, ...m);

log(`Bridge starting — target ${handle}, api ${opts.api}`);

// ---------- API session ----------
let SESSION_COOKIE = '';
let consecutivePostFails = 0;

async function login() {
  log(`Logging in as "${opts.user}"…`);
  const r = await fetch(opts.api + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: opts.user, pass: opts.pass })
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/wgsess=[^;]+/);
  if (!m) throw new Error('login OK but no session cookie returned');
  SESSION_COOKIE = m[0];
  ok(`Logged in. Session cookie acquired.`);
}

async function postGift(payload) {
  if (!SESSION_COOKIE) await login();
  const r = await fetch(opts.api + '/api/jar/gift', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: SESSION_COOKIE
    },
    body: JSON.stringify(payload)
  });
  if (r.status === 401) {
    warn('Session expired — re-login');
    SESSION_COOKIE = '';
    await login();
    return postGift(payload);
  }
  if (!r.ok) {
    consecutivePostFails++;
    const txt = (await r.text().catch(() => '')).slice(0, 200);
    warn(`gift POST ${r.status}: ${txt}`);
    return;
  }
  consecutivePostFails = 0;
  ok(`> Forwarded ${payload.giftName} ×${payload.repeatCount} from ${payload.nickname}`);
}

// ---------- TikTok Live ----------
let conn = null;
let reconnectTimer = null;
const dumpedSampleForName = new Set(); // gift names whose raw JSON we've dumped once

// Walk a few likely paths to find a TikTok picture URL.
function pickUrl(imgObj) {
  if (!imgObj) return null;
  if (typeof imgObj === 'string' && /^https?:\/\//i.test(imgObj)) return imgObj;
  try {
    if (typeof getPreferredPictureFormat === 'function') {
      const u = getPreferredPictureFormat(imgObj);
      if (u) return u;
    }
  } catch {}
  return (
    imgObj?.urlList?.[0]
    || imgObj?.url_list?.[0]
    || imgObj?.urls?.[0]
    || imgObj?.giftPictureUrl
    || imgObj?.url
    || imgObj?.uri
    || imgObj?.thumb?.urlList?.[0]
    || null
  );
}

// Deep walk: find the first http(s) URL pointing at a tiktok cdn anywhere in the object.
function deepFindTikTokUrl(obj, depth = 0) {
  if (!obj || depth > 5) return null;
  if (typeof obj === 'string') {
    if (/^https?:\/\/[^"]*(tiktokcdn|tiktok|byteoversea)/i.test(obj)) return obj;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const u = deepFindTikTokUrl(v, depth + 1);
      if (u) return u;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const u = deepFindTikTokUrl(obj[k], depth + 1);
      if (u) return u;
    }
  }
  return null;
}

function extractGift(data) {
  const name = data.giftDetails?.giftName
            || data.gift?.giftName
            || data.gift?.name
            || data.giftName
            || `Gift#${data.giftId || '?'}`;

  // Direct string fields some TikTok versions use
  const directGiftUrl =
       data.giftDetails?.iconUrl
    || data.giftDetails?.pictureUrl
    || data.giftDetails?.giftPictureUrl
    || data.gift?.iconUrl
    || data.gift?.pictureUrl
    || data.gift?.giftPictureUrl
    || data.giftPictureUrl
    || null;

  const giftPictureUrl =
       directGiftUrl
    || pickUrl(data.giftDetails?.image)
    || pickUrl(data.giftDetails?.giftImage)
    || pickUrl(data.giftDetails?.icon)
    || pickUrl(data.gift?.image)
    || pickUrl(data.gift?.giftImage)
    || pickUrl(data.gift?.icon)
    || pickUrl(data.giftImage)
    || deepFindTikTokUrl(data.giftDetails)
    || deepFindTikTokUrl(data.gift)
    || null;

  const profilePictureUrl =
       pickUrl(data.user?.profilePicture)
    || pickUrl(data.user?.avatarThumb)
    || pickUrl(data.profilePicture)
    || data.profilePictureUrl
    || null;

  return {
    giftName: name,
    giftType: String(name).toLowerCase(),
    repeatCount: data.repeatCount || data.combo || 1,
    diamondCount:
      data.giftDetails?.diamondCount
      || data.gift?.diamondCount
      || data.diamondCount
      || 0,
    uniqueId: data.user?.uniqueId || data.uniqueId || 'anon',
    nickname: data.user?.nickname || data.nickname || data.uniqueId || 'Someone',
    giftPictureUrl,
    profilePictureUrl
  };
}

async function start() {
  try {
    await login();
  } catch (e) {
    err(`Cannot reach API — ${e.message}. Retry in 15s`);
    setTimeout(start, 15000);
    return;
  }

  conn = new TikTokLiveConnection(handle);

  conn.on(ControlEvent.CONNECTED, state => {
    ok(`Connected to TikTok Live ${handle}  room=${state?.roomId || '?'}`);
    log('Waiting for gifts…');
  });
  conn.on(ControlEvent.DISCONNECTED, () => warn('Disconnected from TikTok'));
  conn.on(ControlEvent.ERROR, e => warn('TikTok error:', e?.message || e));

  conn.on(WebcastEvent.STREAM_END, () => {
    warn('Stream ended. Will keep listening; reconnect on next live.');
    scheduleReconnect(60_000);
  });

  // Verbose: log every event so user can confirm the socket is alive
  if (opts.verbose) {
    const allEvents = Object.values(WebcastEvent);
    for (const ev of allEvents) {
      conn.on(ev, data => {
        const who = data?.user?.uniqueId || data?.uniqueId || '';
        log(`[event ${ev}]`, who);
      });
    }
  }

  conn.on(WebcastEvent.GIFT, data => {
    if (opts.raw) console.log('RAW GIFT:', JSON.stringify(data, null, 2).slice(0, 800));

    // For combo-able gifts (giftType === 1), TikTok sends one event per tick
    // but only the one with repeatEnd:true represents the final count.
    if (data.giftType === 1 && !data.repeatEnd) return;

    const payload = extractGift(data);
    log(`Gift received: ${payload.nickname} sent ${payload.giftName} ×${payload.repeatCount}` +
        (payload.giftPictureUrl ? `  [image: ${payload.giftPictureUrl.slice(0, 70)}…]` : '  [NO IMAGE URL]'));

    // First-time-no-image: dump raw JSON so we can fix the extraction path.
    if (!payload.giftPictureUrl && !dumpedSampleForName.has(payload.giftName)) {
      dumpedSampleForName.add(payload.giftName);
      console.log(`--- RAW gift JSON for "${payload.giftName}" (no image url found) ---`);
      try { console.log(JSON.stringify(data, null, 2).slice(0, 4000)); }
      catch (e) { console.log('  (could not stringify:', e.message, ')'); }
      console.log('--- end RAW ---');
    }

    postGift(payload).catch(e => warn('post failed:', e.message));
  });

  log(`Connecting to TikTok Live ${handle}…`);
  try {
    const state = await conn.connect();
    // Some versions fire 'connected' here, some via event above. State has roomId.
    if (state?.roomId) log(`Joined room ${state.roomId}`);
  } catch (e) {
    handleConnectError(e);
  }
}

function handleConnectError(e) {
  if (e instanceof UserOfflineError) {
    warn(`@${handle.replace('@','')} is NOT live right now. Will retry every 60s.`);
    scheduleReconnect(60_000);
    return;
  }
  if (e instanceof SignatureRateLimitError) {
    warn('TikTok signing service rate-limited us. Retry in 90s.');
    scheduleReconnect(90_000);
    return;
  }
  if (e instanceof SignatureMissingTokensError) {
    err('TikTok signing service rejected. (The free service may be temporarily down.) Retry in 90s.');
    scheduleReconnect(90_000);
    return;
  }
  if (e instanceof AlreadyConnectingError || e instanceof AlreadyConnectedError) {
    warn('Already connecting/connected — skipping.');
    return;
  }
  err(`Connect failed: ${e?.message || e}`);
  scheduleReconnect(30_000);
}

function scheduleReconnect(ms) {
  clearTimeout(reconnectTimer);
  log(`Reconnect in ${Math.round(ms/1000)}s…`);
  reconnectTimer = setTimeout(() => {
    try { conn?.disconnect?.(); } catch {}
    conn = null;
    start();
  }, ms);
}

start();

// Heartbeat — proves the script is still alive
setInterval(() => log(`(heartbeat) cookie=${SESSION_COOKIE ? 'yes' : 'NO'} postFails=${consecutivePostFails}`), 60_000);

process.on('SIGINT', () => { log('Shutting down…'); conn?.disconnect?.(); process.exit(0); });
process.on('uncaughtException', e => err('Uncaught:', e?.message || e));
process.on('unhandledRejection', e => err('Unhandled rejection:', e?.message || e));
