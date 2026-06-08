// Express app factory. Used by:
//   - local-server.js (wraps with http + socket.io for dev)
//   - api/[...all].js (Vercel serverless wrapper)
const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Readable } = require('stream');
const crypto = require('crypto');

const storage = require('./lib/storage');
const blob = require('./lib/blob');
const realtime = require('./lib/realtime');
const auth = require('./lib/auth');
const { promptpayPayload, parsePromptPayQR } = require('./lib/promptpay');

// ---- minimal .env loader for local dev ----
try {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
} catch {}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '12mb' }));

  // ---- Auth: login routes (must come before static so paths don't collide) ----
  app.get('/widget/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'widget-login.html')));

  app.post('/api/login', (req, res) => {
    const { user, pass } = req.body || {};
    if (!auth.checkCredentials(user, pass)) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password' });
    }
    auth.setSessionCookie(res, user);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth-status', (req, res) => {
    res.json({ authed: !!auth.getSession(req), user: auth.getSession(req)?.u || null });
  });

  // ---- Static + public pages ----
  // /widget is served statically too; the widget.html does a client-side auth-status
  // check and redirects to /widget/login if no session. All admin-only APIs are
  // protected server-side, so even if the markup is visible nothing writes without auth.
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
  app.get('/widget', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'widget.html')));
  app.get('/overlay', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
  app.get('/jar', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'jar.html')));

  // ---- Settings ----
  app.get('/api/settings', async (_req, res) => {
    try { res.json(await storage.getSettings()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/settings', auth.requireAuth, async (req, res) => {
    try {
      const current = await storage.getSettings();
      const merged = deepMerge(current, req.body || {});
      await storage.setSettings(merged);
      await realtime.emit('settings:update', merged);
      res.json({ ok: true, settings: merged });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Realtime info (for client to know which transport to use) ----
  app.get('/api/realtime-info', (_req, res) => {
    res.json(realtime.clientConfig());
  });

  // ---- Realtime health check (no auth — handy for debugging) ----
  app.get('/api/health/realtime', async (_req, res) => {
    const result = await realtime.emit('debug:ping', { at: Date.now() });
    res.json({
      env: {
        PUSHER_APP_ID: process.env.PUSHER_APP_ID ? 'set' : 'MISSING',
        PUSHER_KEY: process.env.PUSHER_KEY ? 'set' : 'MISSING',
        PUSHER_SECRET: process.env.PUSHER_SECRET ? 'set (hidden)' : 'MISSING',
        PUSHER_CLUSTER: process.env.PUSHER_CLUSTER || '(default ap1)'
      },
      triggerResult: result
    });
  });

  // ---- PromptPay QR ----
  app.get('/api/qr', async (req, res) => {
    try {
      const settings = await storage.getSettings();
      const id = settings?.streamer?.promptpayId;
      const amount = req.query.amount ? Number(req.query.amount) : null;
      const payload = promptpayPayload(id, amount);
      if (!payload) return res.status(400).json({ error: 'No PromptPay ID set' });
      const dataUrl = await QRCode.toDataURL(payload, {
        width: 480, margin: 1,
        color: { dark: '#000000', light: '#ffffff' }
      });
      res.json({ payload, dataUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Donate (manual / test) ----
  app.post('/api/donate', auth.requireAuth, async (req, res) => {
    try {
      const settings = await storage.getSettings();
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
      if (!donation.test) {
        const list = await storage.getDonations();
        list.unshift(donation);
        await storage.setDonations(list.slice(0, 500));
      }
      await realtime.emit('donation', donation);
      res.json({ ok: true, donation });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/donations', auth.requireAuth, async (_req, res) => {
    try { res.json(await storage.getDonations()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/donations', auth.requireAuth, async (_req, res) => {
    try { await storage.setDonations([]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- QR decode (PromptPay / TrueMoney) ----
  app.post('/api/decode-qr', auth.requireAuth, async (req, res) => {
    try {
      let payload = req.body?.payload;
      if (!payload && req.body?.image) {
        const m = String(req.body.image).match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (!m) return res.status(400).json({ ok: false, error: 'รูปแบบรูปไม่ถูกต้อง' });
        const buf = Buffer.from(m[2], 'base64');
        const { Jimp } = require('jimp');
        const jsQR = require('jsqr');
        const img = await Jimp.read(buf);
        const { data, width, height } = img.bitmap;
        const code = jsQR(new Uint8ClampedArray(data), width, height);
        if (!code) return res.status(400).json({ ok: false, error: 'หา QR code ในรูปไม่เจอ' });
        payload = code.data;
      }
      if (!payload) return res.status(400).json({ ok: false, error: 'ต้องส่ง image หรือ payload' });
      const parsed = parsePromptPayQR(payload);
      res.json({ ok: true, payload, parsed });
    } catch (e) { res.status(500).json({ ok: false, error: 'decode ไม่สำเร็จ: ' + e.message }); }
  });

  // ---- EasySlip verification ----
  app.post('/api/verify-slip', async (req, res) => {
    const EASYSLIP_KEY = process.env.EASYSLIP_API_KEY || '';
    if (!EASYSLIP_KEY) {
      return res.status(500).json({ ok: false, error: 'EASYSLIP_API_KEY ไม่ได้ตั้งค่า' });
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
        'qrcode_not_found': 'หา QR ในสลิปไม่เจอ',
        'application_not_found': 'API key ไม่ถูกต้อง',
        'application_expired': 'แพ็คเกจ EasySlip หมดอายุ',
        'application_deactivated': 'API key ถูกระงับ',
        'application_out_of_quota': 'เกินโควต้า EasySlip วันนี้แล้ว',
        'unauthorized': 'API key ไม่ถูกต้อง'
      }[code] || ('ตรวจสลิปไม่สำเร็จ: ' + code);
      return res.status(400).json({ ok: false, error: friendly, raw: easy });
    }

    const slip = easy.data;
    const slipAmount = Number(slip.amount?.amount ?? slip.amount?.local?.amount ?? slip.amount);
    const transRef = slip.transRef || slip.payload || null;
    const imageHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);

    const list = await storage.getDonations();
    const dup = list.find(d =>
      (transRef && d.transRef === transRef) ||
      (imageHash && d.imageHash === imageHash)
    );
    if (dup) {
      const when = dup.createdAt ? new Date(dup.createdAt).toLocaleString('th-TH') : '';
      return res.status(400).json({
        ok: false,
        error: `สลิปนี้ถูกใช้ไปแล้ว (เคยใช้เมื่อ ${when})`,
        duplicate: true
      });
    }

    const expectedAmount = Number(amount);
    if (Number.isFinite(expectedAmount) && Math.abs(slipAmount - expectedAmount) > 0.01) {
      return res.status(400).json({
        ok: false,
        error: `ยอดในสลิป ${slipAmount.toLocaleString()} บาท ไม่ตรงกับที่กรอก ${expectedAmount.toLocaleString()} บาท`
      });
    }

    const settings = await storage.getSettings();
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
          error: `ปลายทางไม่ใช่บัญชีนี้ (สลิปโอนเข้า: ${recvName || '...' + recvProxyRaw.slice(-4)})`
        });
      }
    }

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
    await storage.setDonations(list.slice(0, 500));
    await realtime.emit('donation', donation);
    res.json({ ok: true, donation });
  });

  // ---- TTS proxy (Google Translate) ----
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
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Jar: receive TikTok Live gift events ----
  // Posted from tiktok-bridge.js running on the streamer's PC.
  // Auth required so randoms can't spam the jar.
  app.post('/api/jar/gift', auth.requireAuth, async (req, res) => {
    const b = req.body || {};
    const gift = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      giftName: String(b.giftName || 'Gift').slice(0, 40),
      giftType: String(b.giftType || b.giftName || 'gift').toLowerCase().slice(0, 20),
      repeatCount: Math.max(1, Math.min(999, Number(b.repeatCount) || 1)),
      diamondCount: Math.max(0, Math.min(99999, Number(b.diamondCount) || 0)),
      uniqueId: String(b.uniqueId || 'anon').slice(0, 40),
      nickname: String(b.nickname || b.uniqueId || 'Someone').slice(0, 40),
      giftPictureUrl: typeof b.giftPictureUrl === 'string' ? b.giftPictureUrl.slice(0, 500) : null,
      profilePictureUrl: typeof b.profilePictureUrl === 'string' ? b.profilePictureUrl.slice(0, 500) : null,
      receivedAt: new Date().toISOString(),
      test: !!b.test
    };
    const rt = await realtime.emit('jar:gift', gift);
    res.json({ ok: true, gift, realtime: rt });
  });

  // ---- Jar: clear (reset all gifts on overlay) ----
  app.post('/api/jar/clear', auth.requireAuth, async (_req, res) => {
    await realtime.emit('jar:clear', { at: Date.now() });
    res.json({ ok: true });
  });

  // ---- Jar: live TikTok handle (bridge polls this every ~15s) ----
  app.get('/api/jar/handle', async (_req, res) => {
    const s = await storage.getSettings();
    res.json({ handle: s.jarHandle || '' });
  });

  app.post('/api/jar/handle', auth.requireAuth, async (req, res) => {
    let h = String(req.body?.handle || '').trim();
    if (!h) return res.status(400).json({ ok: false, error: 'Missing handle' });
    h = h.startsWith('@') ? h : '@' + h;
    if (!/^@[\w._-]{2,40}$/i.test(h)) return res.status(400).json({ ok: false, error: 'Bad handle format' });
    const s = await storage.getSettings();
    s.jarHandle = h;
    await storage.setSettings(s);
    await realtime.emit('jar:handle-changed', { handle: h });
    res.json({ ok: true, handle: h });
  });

  // ---- File uploads ----
  app.post('/api/upload-sound', auth.requireAuth, async (req, res) => {
    const { audio } = req.body || {};
    if (!audio || typeof audio !== 'string') return res.status(400).json({ ok: false, error: 'ไม่พบไฟล์เสียง' });
    const m = audio.match(/^data:audio\/([a-z0-9+\-]+);base64,(.+)$/i);
    if (!m) return res.status(400).json({ ok: false, error: 'รองรับเฉพาะไฟล์เสียง' });
    let ext = m[1].toLowerCase();
    if (ext === 'mpeg' || ext === 'mp3') ext = 'mp3';
    else if (ext === 'wav' || ext === 'x-wav' || ext === 'wave') ext = 'wav';
    else if (ext === 'ogg') ext = 'ogg';
    else if (ext === 'mp4' || ext === 'x-m4a' || ext === 'm4a') ext = 'm4a';
    else if (ext === 'webm') ext = 'webm';
    else return res.status(400).json({ ok: false, error: 'นามสกุลไฟล์เสียงไม่รองรับ' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 4 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'ไฟล์ใหญ่เกิน 4MB' });
    try {
      const url = await blob.uploadAsset({ buf, ext, prefix: 'sound', mime: 'audio/' + (ext === 'mp3' ? 'mpeg' : ext) });
      const settings = await storage.getSettings();
      settings.sound = settings.sound || {};
      settings.sound.url = url;
      settings.sound.enabled = true;
      await storage.setSettings(settings);
      await realtime.emit('settings:update', settings);
      res.json({ ok: true, url });
    } catch (e) { res.status(500).json({ ok: false, error: 'บันทึกไม่สำเร็จ: ' + e.message }); }
  });

  app.post('/api/upload-alert-image', auth.requireAuth, async (req, res) => {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') return res.status(400).json({ ok: false, error: 'ไม่พบรูปภาพ' });
    const m = image.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,(.+)$/i);
    if (!m) return res.status(400).json({ ok: false, error: 'รองรับเฉพาะ JPG / PNG / GIF / WEBP' });
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'รูปใหญ่เกิน 8MB' });
    try {
      const url = await blob.uploadAsset({ buf, ext, prefix: 'alert', mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) });
      const settings = await storage.getSettings();
      settings.alert = settings.alert || {};
      settings.alert.imageUrl = url;
      await storage.setSettings(settings);
      await realtime.emit('settings:update', settings);
      res.json({ ok: true, url });
    } catch (e) { res.status(500).json({ ok: false, error: 'บันทึกไม่สำเร็จ: ' + e.message }); }
  });

  app.post('/api/upload-profile', auth.requireAuth, async (req, res) => {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') return res.status(400).json({ ok: false, error: 'ไม่พบรูปภาพ' });
    const m = image.match(/^data:(image\/(jpeg|jpg|png|webp));base64,(.+)$/);
    if (!m) return res.status(400).json({ ok: false, error: 'รองรับเฉพาะ JPG / PNG / WEBP' });
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 6 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'รูปใหญ่เกิน 6MB' });
    try {
      const url = await blob.uploadAsset({ buf, ext, prefix: 'profile', mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) });
      const settings = await storage.getSettings();
      settings.streamer = settings.streamer || {};
      settings.streamer.avatarUrl = url;
      await storage.setSettings(settings);
      await realtime.emit('settings:update', settings);
      res.json({ ok: true, avatarUrl: url });
    } catch (e) { res.status(500).json({ ok: false, error: 'บันทึกไม่สำเร็จ: ' + e.message }); }
  });

  return app;
}

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

module.exports = { createApp };
