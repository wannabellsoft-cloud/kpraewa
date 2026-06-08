// Storage abstraction: Vercel KV (Redis) when KV_REST_API_URL is set,
// otherwise local JSON files. All methods return Promises.
const fs = require('fs');
const path = require('path');

const useKV = !!process.env.KV_REST_API_URL;
const SETTINGS_KEY = 'donate:settings';
const DONATIONS_KEY = 'donate:donations';

let kv;
if (useKV) {
  try { kv = require('@vercel/kv').kv; }
  catch (e) { console.warn('@vercel/kv not available:', e.message); }
}

const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DONATIONS_FILE = path.join(DATA_DIR, 'donations.json');

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

async function getSettings() {
  if (useKV && kv) {
    const stored = await kv.get(SETTINGS_KEY);
    return stored || DEFAULT_SETTINGS;
  }
  return readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
}

async function setSettings(s) {
  if (useKV && kv) {
    await kv.set(SETTINGS_KEY, s);
    return;
  }
  writeJsonFile(SETTINGS_FILE, s);
}

async function getDonations() {
  if (useKV && kv) {
    return (await kv.get(DONATIONS_KEY)) || [];
  }
  return readJsonFile(DONATIONS_FILE, []);
}

async function setDonations(list) {
  if (useKV && kv) {
    await kv.set(DONATIONS_KEY, list);
    return;
  }
  writeJsonFile(DONATIONS_FILE, list);
}

module.exports = { getSettings, setSettings, getDonations, setDonations, useKV };
