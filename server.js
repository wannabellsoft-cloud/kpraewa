const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Readable } = require('stream');
const crypto = require('crypto');

// --- minimal .env loader (no dependency) ---
try {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
} catch {}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const EASYSLIP_KEY = process.env.EASYSLIP_API_KEY || '';
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DONATIONS_FILE = path.join(DATA_DIR, 'donations.json');

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/widget', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'widget.html')));
app.get('/overlay', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- PromptPay payload (EMVCo) ----
function tlv(id, value) {
  const v = String(value);
  return id + v.length.toString().padStart(2, '0') + v;
}
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function promptpayPayload(rawId, amount) {
  const id = String(rawId || '').replace(/\D/g, '');
  if (!id) return null;
  let proxyValue, proxyType;
  if (id.length === 13) {
    proxyType = '02';
    proxyValue = id;
  } else if (id.length === 10) {
    proxyType = '01';
    proxyValue = '0066' + id.substring(1);
  } else if (id.length === 15) {
    proxyType = '03';
    proxyValue = id;
  } else {
    proxyType = '01';
    proxyValue = id;
  }
  const merchant = tlv('00', 'A000000677010111') + tlv(proxyType, proxyValue);
  let payload =
    tlv('00', '01') +
    tlv('01', amount ? '12' : '11') +
    tlv('29', merchant) +
    tlv('53', '764');
  if (amount && Number(amount) > 0) {
    payload += tlv('54', Number(amount).toFixed(2));
  }
  payload += tlv('58', 'TH');
  payload += '6304';
  return payload + crc16(payload);
}

// ---- API ----
app.get('/api/settings', (_req, res) => {
  res.json(readJson(SETTINGS_FILE, {}));
});

app.post('/api/settings', (req, res) => {
  const current = readJson(SETTINGS_FILE, {});
  const merged = deepMerge(current, req.body || {});
  writeJson(SETTINGS_FILE, merged);
  io.emit('settings:update', merged);
  res.json({ ok: true, settings: merged });
});

function deepMerge(a, b) {
  if (typeof a !== 'object' || a === null) return b;
  if (typeof b !== 'object' || b === null) return b;
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const k of Object.keys(b)) {
    out[k] = (typeof b[k] === 'object' && b[k] !== null && !Array.isArray(b[k]))
      ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}

app.get('/api/qr', async (req, res) => {
  const settings = readJson(SETTINGS_FILE, {});
  const id = settings?.streamer?.promptpayId;
  const amount = req.query.amount ? Number(req.query.amount) : null;
  const payload = promptpayPayload(id, amount);
  if (!payload) return res.status(400).json({ error: 'No PromptPay ID set' });
  try {
    const dataUrl = await QRCode.toDataURL(payload, {
      width: 480, margin: 1,
      color: { dark: '#000000', light: '#ffffff' }
    });
    res.json({ payload, dataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/donate', (req, res) => {
  const settings = readJson(SETTINGS_FILE, {});
  const rules = settings.rules || {};
  let { name, amount, message } = req.body || {};
  name = String(name || 'Anonymous').slice(0, rules.maxNameLength || 30).trim() || 'Anonymous';
  message = String(message || '').slice(0, rules.maxMessageLength || 200).trim();
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount < (rules.minAmount || 1) || amount > (rules.maxAmount || 100000)) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  const donation = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name, amount, message,
    createdAt: new Date().toISOString(),
    test: !!req.body.test
  };
  const list = readJson(DONATIONS_FILE, []);
  if (!donation.test) {
    list.unshift(donation);
    writeJson(DONATIONS_FILE, list.slice(0, 500));
  }
  io.emit('donation', donation);
  res.json({ ok: true, donation });
});

app.get('/api/donations', (_req, res) => {
  res.json(readJson(DONATIONS_FILE, []));
});

// ---- Shared upload helper ----
function handleAssetUpload({ buf, ext, prefix, sizeLimit, sizeLabel }, mutateSettings) {
  if (buf.length > sizeLimit) {
    return { status: 400, body: { ok: false, error: `ไฟล์ใหญ่เกิน ${sizeLabel}` } };
  }
  const filename = `${prefix}-${Date.now()}.${ext}`;
  const assetsDir = path.join(__dirname, 'public', 'assets');
  const target = path.join(assetsDir, filename);
  try {
    // remove old files of same prefix
    const re = new RegExp(`^${prefix}-\\d+\\.`, 'i');
    for (const f of fs.readdirSync(assetsDir)) {
      if (re.test(f)) try { fs.unlinkSync(path.join(assetsDir, f)); } catch {}
    }
    fs.writeFileSync(target, buf);
    const settings = readJson(SETTINGS_FILE, {});
    const url = '/assets/' + filename;
    mutateSettings(settings, url);
    writeJson(SETTINGS_FILE, settings);
    io.emit('settings:update', settings);
    return { status: 200, body: { ok: true, url } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'บันทึกไม่สำเร็จ: ' + e.message } };
  }
}

// ---- Notification sound upload ----
// body: { audio: "data:audio/...;base64,..." }
app.post('/api/upload-sound', (req, res) => {
  const { audio } = req.body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ ok: false, error: 'ไม่พบไฟล์เสียง' });
  }
  const m = audio.match(/^data:audio\/([a-z0-9+\-]+);base64,(.+)$/i);
  if (!m) return res.status(400).json({ ok: false, error: 'รองรับเฉพาะไฟล์เสียง (mp3 / wav / ogg / m4a)' });

  let ext = m[1].toLowerCase();
  if (ext === 'mpeg' || ext === 'mp3') ext = 'mp3';
  else if (ext === 'wav' || ext === 'x-wav' || ext === 'wave') ext = 'wav';
  else if (ext === 'ogg') ext = 'ogg';
  else if (ext === 'mp4' || ext === 'x-m4a' || ext === 'm4a') ext = 'm4a';
  else if (ext === 'webm') ext = 'webm';
  else return res.status(400).json({ ok: false, error: 'นามสกุลไฟล์เสียงไม่รองรับ' });

  const buf = Buffer.from(m[2], 'base64');
  const result = handleAssetUpload(
    { buf, ext, prefix: 'sound', sizeLimit: 4 * 1024 * 1024, sizeLabel: '4MB' },
    (settings, url) => {
      settings.sound = settings.sound || {};
      settings.sound.url = url;
      settings.sound.enabled = true;
    }
  );
  res.status(result.status).json(result.body);
});

// ---- Alert image / GIF upload ----
// body: { image: "data:image/...;base64,..." }
app.post('/api/upload-alert-image', (req, res) => {
  const { image } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ ok: false, error: 'ไม่พบรูปภาพ' });
  }
  const m = image.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,(.+)$/i);
  if (!m) return res.status(400).json({ ok: false, error: 'รองรับเฉพาะ JPG / PNG / GIF / WEBP' });

  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  const result = handleAssetUpload(
    { buf, ext, prefix: 'alert', sizeLimit: 8 * 1024 * 1024, sizeLabel: '8MB' },
    (settings, url) => {
      settings.alert = settings.alert || {};
      settings.alert.imageUrl = url;
    }
  );
  res.status(result.status).json(result.body);
});

// ---- Profile image upload ----
// body: { image: "data:image/...;base64,..." }
app.post('/api/upload-profile', (req, res) => {
  const { image } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ ok: false, error: 'ไม่พบรูปภาพ' });
  }
  const m = image.match(/^data:(image\/(jpeg|jpg|png|webp));base64,(.+)$/);
  if (!m) return res.status(400).json({ ok: false, error: 'รองรับเฉพาะ JPG/PNG/WEBP' });

  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 6 * 1024 * 1024) {
    return res.status(400).json({ ok: false, error: 'รูปใหญ่เกิน 6MB' });
  }

  const filename = `profile-${Date.now()}.${ext}`;
  const targetPath = path.join(__dirname, 'public', 'assets', filename);
  try {
    // Clean up old profile files
    const assetsDir = path.join(__dirname, 'public', 'assets');
    for (const f of fs.readdirSync(assetsDir)) {
      if (/^profile-\d+\.(jpg|png|webp)$/i.test(f)) {
        try { fs.unlinkSync(path.join(assetsDir, f)); } catch {}
      }
    }
    fs.writeFileSync(targetPath, buf);
    // Update settings
    const settings = readJson(SETTINGS_FILE, {});
    settings.streamer = settings.streamer || {};
    settings.streamer.avatarUrl = '/assets/' + filename;
    writeJson(SETTINGS_FILE, settings);
    io.emit('settings:update', settings);
    res.json({ ok: true, avatarUrl: settings.streamer.avatarUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'บันทึกไฟล์ไม่สำเร็จ: ' + e.message });
  }
});

// ---- QR Decoder (PromptPay / TrueMoney) ----
function parseTLV(payload) {
  const out = {};
  let i = 0;
  while (i < payload.length) {
    if (i + 4 > payload.length) break;
    const tag = payload.substring(i, i + 2);
    const len = parseInt(payload.substring(i + 2, i + 4), 10);
    if (Number.isNaN(len) || i + 4 + len > payload.length) break;
    const value = payload.substring(i + 4, i + 4 + len);
    out[tag] = value;
    i += 4 + len;
  }
  return out;
}

function parsePromptPayQR(payload) {
  const root = parseTLV(payload);
  const merchant = root['29'] ? parseTLV(root['29']) : {};
  const aid = merchant['00'] || '';
  let proxyType = null, proxyValue = null, proxyLabel = null;
  if (merchant['01']) { proxyType = '01'; proxyValue = merchant['01']; proxyLabel = 'Mobile'; }
  else if (merchant['02']) { proxyType = '02'; proxyValue = merchant['02']; proxyLabel = 'National ID'; }
  else if (merchant['03']) { proxyType = '03'; proxyValue = merchant['03']; proxyLabel = 'e-Wallet ID'; }
  else if (merchant['04']) { proxyType = '04'; proxyValue = merchant['04']; proxyLabel = 'Bank Account'; }

  // Normalize mobile: 0066xxxxxxxxx → 0xxxxxxxxx
  let inputForm = proxyValue;
  if (proxyType === '01' && proxyValue && proxyValue.startsWith('0066')) {
    inputForm = '0' + proxyValue.substring(4);
  }
  return {
    aid,
    proxyType,
    proxyValue,
    proxyLabel,
    inputForm,
    amount: root['54'] ? Number(root['54']) : null,
    countryCode: root['58'] || null,
    currencyCode: root['53'] || null,
    merchantName: root['59'] || null,
    isPromptPay: aid === 'A000000677010111',
    isTrueMoney: proxyType === '03' && proxyValue && proxyValue.startsWith('0040')
  };
}

// body: { image: "data:image/...;base64,..." } OR { payload: "00020101..." }
app.post('/api/decode-qr', async (req, res) => {
  let payload = req.body?.payload;
  try {
    if (!payload && req.body?.image) {
      const m = String(req.body.image).match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (!m) return res.status(400).json({ ok: false, error: 'รูปแบบรูปไม่ถูกต้อง' });
      const buf = Buffer.from(m[2], 'base64');
      const { Jimp } = require('jimp');
      const jsQR = require('jsqr');
      const img = await Jimp.read(buf);
      const { data, width, height } = img.bitmap;
      const code = jsQR(new Uint8ClampedArray(data), width, height);
      if (!code) return res.status(400).json({ ok: false, error: 'หา QR code ในรูปไม่เจอ (ลองรูปที่ชัดกว่าหรือเฉพาะ QR)' });
      payload = code.data;
    }
    if (!payload) return res.status(400).json({ ok: false, error: 'ต้องส่ง image หรือ payload' });

    const parsed = parsePromptPayQR(payload);
    res.json({ ok: true, payload, parsed });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'decode ไม่สำเร็จ: ' + e.message });
  }
});

// ---- EasySlip verification ----
// body: { image: "data:image/jpeg;base64,...", name, amount, message }
app.post('/api/verify-slip', async (req, res) => {
  if (!EASYSLIP_KEY) {
    return res.status(500).json({ ok: false, error: 'EASYSLIP_API_KEY ไม่ได้ตั้งค่า (เพิ่มใน .env)' });
  }
  const { image, name, amount, message } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ ok: false, error: 'ไม่พบรูปสลิป' });
  }

  const m = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ ok: false, error: 'รูปแบบรูปไม่ถูกต้อง' });
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) {
    return res.status(400).json({ ok: false, error: 'รูปใหญ่เกิน 8MB' });
  }

  let easy;
  try {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), 'slip.' + (mime.split('/')[1] || 'jpg'));
    const r = await fetch('https://developer.easyslip.com/api/v1/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${EASYSLIP_KEY}` },
      body: fd
    });
    easy = await r.json();
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'ติดต่อ EasySlip ไม่ได้: ' + e.message });
  }

  if (!easy || easy.status !== 200 || !easy.data) {
    const code = easy?.message || 'unknown';
    const friendly = {
      'invalid_image': 'รูปสลิปไม่ชัด หรืออ่านไม่ออก',
      'image_size_too_large': 'รูปใหญ่เกินไป',
      'invalid_payload': 'สลิปไม่ถูกต้อง',
      'qrcode_not_found': 'หา QR ในสลิปไม่เจอ — อัปโหลดรูปเต็มสลิปอีกครั้ง',
      'application_not_found': 'API key ไม่ถูกต้อง',
      'application_expired': 'แพ็คเกจ EasySlip หมดอายุ',
      'application_deactivated': 'API key ถูกระงับ',
      'application_out_of_quota': 'เกินโควต้า EasySlip วันนี้แล้ว',
      'access_denied': 'ไม่มีสิทธิ์เข้าถึง',
      'unauthorized': 'API key ไม่ถูกต้อง'
    }[code] || ('ตรวจสลิปไม่สำเร็จ: ' + code);
    return res.status(400).json({ ok: false, error: friendly, raw: easy });
  }

  const slip = easy.data;
  const slipAmount = Number(slip.amount?.amount ?? slip.amount?.local?.amount ?? slip.amount);
  const transRef = slip.transRef || slip.payload || null;
  const imageHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);

  // Anti-replay: same slip can't be reused (check both transRef AND image hash)
  const list = readJson(DONATIONS_FILE, []);
  const dup = list.find(d =>
    (transRef && d.transRef === transRef) ||
    (imageHash && d.imageHash === imageHash)
  );
  if (dup) {
    const when = dup.createdAt ? new Date(dup.createdAt).toLocaleString('th-TH') : '';
    return res.status(400).json({
      ok: false,
      error: `สลิปนี้ถูกใช้ไปแล้ว (โดเนทเข้าระบบเมื่อ ${when})`,
      duplicate: true
    });
  }

  // Validate amount
  const expectedAmount = Number(amount);
  if (Number.isFinite(expectedAmount) && Math.abs(slipAmount - expectedAmount) > 0.01) {
    return res.status(400).json({
      ok: false,
      error: `ยอดในสลิป ${slipAmount.toLocaleString()} บาท ไม่ตรงกับที่กรอก ${expectedAmount.toLocaleString()} บาท`
    });
  }

  // Validate receiver (PromptPay last 4 digits match)
  const settings = readJson(SETTINGS_FILE, {});
  const expectProxy = String(settings.streamer?.promptpayId || '').replace(/\D/g, '');
  const recvProxyRaw = String(
    slip.receiver?.account?.proxy?.account ||
    slip.receiver?.account?.bank?.account ||
    slip.receiver?.proxy?.account ||
    ''
  ).replace(/\D/g, '');
  if (expectProxy && recvProxyRaw) {
    const last4 = expectProxy.slice(-4);
    if (!recvProxyRaw.endsWith(last4)) {
      const recvName = slip.receiver?.account?.name?.th || slip.receiver?.account?.name?.en || '';
      return res.status(400).json({
        ok: false,
        error: `ปลายทางไม่ใช่บัญชีนี้ (สลิปโอนเข้า: ${recvName || '...'+recvProxyRaw.slice(-4)})`
      });
    }
  }

  // All checks passed → create donation
  const rules = settings.rules || {};
  const donation = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: String(name || 'Anonymous').slice(0, rules.maxNameLength || 30).trim() || 'Anonymous',
    amount: slipAmount,
    message: String(message || '').slice(0, rules.maxMessageLength || 200).trim(),
    transRef,
    imageHash,
    verified: true,
    senderBank: slip.sender?.bank?.short || slip.sender?.bank?.name || null,
    senderName: slip.sender?.account?.name?.th || slip.sender?.account?.name?.en || null,
    createdAt: new Date().toISOString(),
    slipTime: slip.date || null
  };
  list.unshift(donation);
  writeJson(DONATIONS_FILE, list.slice(0, 500));
  io.emit('donation', donation);
  res.json({ ok: true, donation });
});

app.delete('/api/donations', (_req, res) => {
  writeJson(DONATIONS_FILE, []);
  res.json({ ok: true });
});

// TTS proxy — Google Translate TTS (no API key, ~200 char limit per request)
app.get('/api/tts', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 200);
  const lang = String(req.query.lang || 'th');
  if (!text) return res.status(400).end();
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(lang)}&client=tw-ob`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://translate.google.com/'
      }
    });
    if (!r.ok) return res.status(502).json({ error: 'TTS upstream ' + r.status });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

io.on('connection', (socket) => {
  socket.emit('settings:update', readJson(SETTINGS_FILE, {}));
});

server.listen(PORT, () => {
  console.log(`\n  ★ Donate system for k.praewa\n`);
  console.log(`  Donor page : http://localhost:${PORT}/`);
  console.log(`  Widget     : http://localhost:${PORT}/widget`);
  console.log(`  Overlay    : http://localhost:${PORT}/overlay   (← ใส่ใน OBS Browser Source)\n`);
});
