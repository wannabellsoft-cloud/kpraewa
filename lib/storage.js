// Storage abstraction:
//   - Local dev: JSON files in data/
//   - Vercel:   JSON blobs in Vercel Blob (detected via BLOB_STORE_ID / BLOB_READ_WRITE_TOKEN)
// This keeps one bucket for everything — no separate KV store needed.
const fs = require('fs');
const path = require('path');

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN || !!process.env.BLOB_STORE_ID;

let blobLib;
if (useBlob) {
  try { blobLib = require('@vercel/blob'); }
  catch (e) { console.warn('@vercel/blob not available:', e.message); }
}

const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DONATIONS_FILE = path.join(DATA_DIR, 'donations.json');

const SETTINGS_BLOB = 'state/settings.json';
const DONATIONS_BLOB = 'state/donations.json';

const DEFAULT_SETTINGS = {
  streamer: {
    name: 'k.praewa',
    displayName: 'k.praewa',
    avatarUrl: '',
    tiktokUrl: '',
    instagramUrl: '',
    bankName: '',
    bankAccount: '',
    accountHolder: '',
    promptpayId: ''
  },
  alert: {
    duration: 8000,
    bgColor: '#1a1a2e',
    accentColor: '#ff4d8d',
    textColor: '#ffffff',
    amountColor: '#ffd166',
    font: 'Prompt',
    animation: 'slide-up',
    titleTemplate: '{name} โดเนท {amount} บาท!',
    showMessage: true,
    borderRadius: 16,
    imageUrl: ''
  },
  tts: {
    enabled: true,
    rate: 1,
    voice: 'th',
    template: 'คุณ {name} โดเนทมา {amount} บาท พูดว่า {message}',
    readMessageOnly: false
  },
  sound: { enabled: true, url: '', volume: 0.7 },
  rules: { minAmount: 1, maxAmount: 100000, maxNameLength: 30, maxMessageLength: 200 }
};

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function readBlobJson(pathname, fallback) {
  if (!blobLib) return fallback;
  try {
    // list to find the actual blob (path may have a random suffix)
    const { blobs } = await blobLib.list({ prefix: pathname });
    const match = blobs.find(b => b.pathname === pathname) || blobs[0];
    if (!match) return fallback;
    const r = await fetch(match.url);
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) {
    console.warn('[storage] read blob failed:', e.message);
    return fallback;
  }
}

async function writeBlobJson(pathname, data) {
  if (!blobLib) throw new Error('Blob not available');
  // Delete old version first (so URL doesn't accumulate suffixed copies)
  try {
    const { blobs } = await blobLib.list({ prefix: pathname });
    for (const b of blobs) {
      if (b.pathname === pathname) { try { await blobLib.del(b.url); } catch {} }
    }
  } catch {}
  await blobLib.put(pathname, JSON.stringify(data, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

async function getSettings() {
  if (useBlob) {
    // First call after deploy: fall back to bundled settings.json so the streamer
    // doesn't have to reconfigure everything from scratch.
    const seeded = readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    return await readBlobJson(SETTINGS_BLOB, seeded);
  }
  return readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
}

async function setSettings(s) {
  if (useBlob) { await writeBlobJson(SETTINGS_BLOB, s); return; }
  writeJsonFile(SETTINGS_FILE, s);
}

async function getDonations() {
  if (useBlob) { return await readBlobJson(DONATIONS_BLOB, []); }
  return readJsonFile(DONATIONS_FILE, []);
}

async function setDonations(list) {
  if (useBlob) { await writeBlobJson(DONATIONS_BLOB, list); return; }
  writeJsonFile(DONATIONS_FILE, list);
}

module.exports = { getSettings, setSettings, getDonations, setDonations, useBlob };
