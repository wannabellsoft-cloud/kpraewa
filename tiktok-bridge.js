#!/usr/bin/env node
/**
 * tiktok-bridge.js — forwards TikTok Live gift events to the donate-kpraewa
 * API so they show up inside the /jar overlay.
 *
 * Usage:
 *   node tiktok-bridge.js @k.praewa
 *   node tiktok-bridge.js @k.praewa --api https://kpraewa.vercel.app --user Admin --pass MyPass
 *
 * Reads --user / --pass from CLI or BRIDGE_USER / BRIDGE_PASS env vars.
 * On Vercel deployments, --api defaults to https://kpraewa.vercel.app.
 */

const { TikTokLiveConnection } = require('tiktok-live-connector');

// --- args ---
const argv = process.argv.slice(2);
let handle = null;
const opts = { api: process.env.BRIDGE_API || 'https://kpraewa.vercel.app',
               user: process.env.BRIDGE_USER || 'Admin',
               pass: process.env.BRIDGE_PASS || '' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--api'))   opts.api  = a.includes('=') ? a.split('=')[1] : argv[++i];
  else if (a.startsWith('--user')) opts.user = a.includes('=') ? a.split('=')[1] : argv[++i];
  else if (a.startsWith('--pass')) opts.pass = a.includes('=') ? a.split('=')[1] : argv[++i];
  else if (!handle) handle = a;
}

if (!handle) {
  console.error('Usage: node tiktok-bridge.js @username [--api URL] [--user U] [--pass P]');
  process.exit(1);
}
if (!opts.pass) {
  console.error('Missing --pass (or BRIDGE_PASS env var) — needed to log in to the API.');
  process.exit(1);
}
handle = handle.startsWith('@') ? handle : '@' + handle;
opts.api = opts.api.replace(/\/$/, '');

const log = (...m) => console.log(new Date().toLocaleTimeString(), ...m);
const warn = (...m) => console.warn(new Date().toLocaleTimeString(), ...m);

// --- login to API, keep session cookie ---
let SESSION_COOKIE = '';

async function login() {
  const r = await fetch(opts.api + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: opts.user, pass: opts.pass })
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`login HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/wgsess=[^;]+/);
  if (!m) throw new Error('login OK but no session cookie returned');
  SESSION_COOKIE = m[0];
  log(`Logged in to ${opts.api}`);
}

async function postGift(payload) {
  if (!SESSION_COOKIE) { warn('No session — re-login'); await login(); }
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
  if (!r.ok) warn(`gift POST ${r.status}: ${(await r.text().catch(()=>'')).slice(0,120)}`);
}

// --- Connect to TikTok Live ---
let conn;
async function start() {
  await login();

  conn = new TikTokLiveConnection(handle);

  conn.on('connected', state => {
    log(`Connected to TikTok Live ${handle} (room ${state?.roomId || '?'})`);
  });

  conn.on('disconnected', () => warn('Disconnected from TikTok'));
  conn.on('error', err => warn('TikTok error:', err?.message || err));
  conn.on('streamEnd', () => warn('Stream ended'));

  conn.on('gift', data => {
    // TikTok combos: events fire for each unit, but `repeatEnd: false`
    // means the combo isn't finished — wait until repeatEnd=true to
    // avoid double-counting. (Non-combo gifts have repeatEnd: true.)
    if (data.giftType === 1 && !data.repeatEnd) return;
    const payload = {
      giftName: data.giftDetails?.giftName || data.giftName || 'Gift',
      giftType: (data.giftDetails?.giftName || data.giftName || 'gift').toLowerCase(),
      repeatCount: data.repeatCount || 1,
      diamondCount: data.giftDetails?.diamondCount || data.diamondCount || 0,
      uniqueId: data.user?.uniqueId || data.uniqueId || 'anon',
      nickname: data.user?.nickname || data.nickname || data.uniqueId || 'Someone',
      giftPictureUrl: data.giftDetails?.giftImage?.giftPictureUrl
        || data.giftPictureUrl || null,
      profilePictureUrl: data.user?.profilePicture?.urls?.[0]
        || data.profilePictureUrl || null
    };
    log(`${payload.nickname} sent ${payload.giftName} ×${payload.repeatCount}`);
    postGift(payload).catch(e => warn('post failed:', e.message));
  });

  conn.connect().catch(async err => {
    warn(`Connect failed: ${err?.message || err}`);
    warn('Retry in 30s…');
    setTimeout(start, 30000);
  });
}

start();

process.on('SIGINT', () => { log('Shutting down…'); conn?.disconnect(); process.exit(0); });
