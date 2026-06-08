// Realtime abstraction: Pusher when PUSHER_APP_ID is set,
// otherwise relies on a global Socket.IO instance set by local-server.js.
const usePusher = !!process.env.PUSHER_APP_ID;
const CHANNEL = 'donate';

let pusherServer = null;
if (usePusher) {
  try {
    const Pusher = require('pusher');
    pusherServer = new Pusher({
      appId: process.env.PUSHER_APP_ID,
      key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER || 'ap1',
      useTLS: true
    });
  } catch (e) {
    console.warn('pusher not available:', e.message);
  }
}

// Returns { ok, transport, status?, error? } so callers can surface diagnostics.
async function emit(event, data) {
  if (usePusher && pusherServer) {
    try {
      const r = await pusherServer.trigger(CHANNEL, event, data);
      const status = r?.status ?? 'unknown';
      console.log(`[realtime] pusher trigger ${event} → ${status}`);
      return { ok: status === 200 || status === 'unknown', transport: 'pusher', status };
    } catch (e) {
      // Pusher errors often have .body with the actual reason
      const detail = e?.body ? `${e.message}: ${typeof e.body === 'string' ? e.body : JSON.stringify(e.body)}` : (e?.message || String(e));
      console.error(`[realtime] PUSHER TRIGGER FAILED for "${event}":`, detail);
      return { ok: false, transport: 'pusher', error: detail };
    }
  }
  if (global.__io) {
    try { global.__io.emit(event, data); return { ok: true, transport: 'socketio' }; }
    catch (e) { console.warn('[realtime] socket emit failed:', e.message); return { ok: false, transport: 'socketio', error: e.message }; }
  }
  return { ok: false, transport: 'none', error: 'no transport configured' };
}

function clientConfig() {
  if (usePusher) {
    return {
      provider: 'pusher',
      key: process.env.PUSHER_KEY || '',
      cluster: process.env.PUSHER_CLUSTER || 'ap1',
      channel: CHANNEL
    };
  }
  return { provider: 'socketio' };
}

module.exports = { emit, clientConfig, usePusher };
