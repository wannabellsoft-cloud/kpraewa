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

async function emit(event, data) {
  if (usePusher && pusherServer) {
    try { await pusherServer.trigger(CHANNEL, event, data); }
    catch (e) { console.warn('[realtime] pusher trigger failed:', e.message); }
    return;
  }
  // Local dev: emit through Socket.IO (set by local-server.js)
  if (global.__io) {
    try { global.__io.emit(event, data); }
    catch (e) { console.warn('[realtime] socket emit failed:', e.message); }
  }
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
