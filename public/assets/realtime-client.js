// Tiny realtime client: connects via Pusher (production/Vercel) or Socket.IO (local dev)
// Usage:
//   const rt = await RealtimeClient.connect();
//   rt.on('donation', d => { ... });
//   rt.on('settings:update', s => { ... });

window.RealtimeClient = (function () {
  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  return {
    async connect() {
      let cfg;
      try {
        cfg = await fetch('/api/realtime-info').then(r => r.json());
        console.log('[Realtime] config:', cfg);
      } catch (e) {
        console.warn('[Realtime] config fetch failed, falling back to socketio:', e);
        cfg = { provider: 'socketio' };
      }

      if (cfg.provider === 'pusher' && cfg.key) {
        console.log('[Realtime] loading Pusher client…');
        await loadScript('https://js.pusher.com/8.4/pusher.min.js');
        // Pusher.logToConsole = true; // uncomment for ultra-verbose
        const p = new Pusher(cfg.key, { cluster: cfg.cluster || 'ap1' });
        p.connection.bind('state_change', s => console.log('[Pusher] state', s.previous, '→', s.current));
        p.connection.bind('error', e => console.error('[Pusher] error', e));
        const chName = cfg.channel || 'donate';
        const ch = p.subscribe(chName);
        ch.bind('pusher:subscription_succeeded', () => console.log('[Pusher] subscribed to', chName));
        ch.bind('pusher:subscription_error', e => console.error('[Pusher] subscription error', e));
        return {
          on(event, fn) {
            ch.bind(event, payload => { console.log('[Pusher recv]', event, payload); fn(payload); });
          }
        };
      }

      // Default: Socket.IO
      console.log('[Realtime] loading Socket.IO client…');
      await loadScript('/socket.io/socket.io.js');
      const socket = io();
      socket.on('connect',    () => console.log('[Socket] connected', socket.id));
      socket.on('disconnect', r  => console.warn('[Socket] disconnected', r));
      socket.on('connect_error', e => console.error('[Socket] connect_error', e?.message || e));
      return {
        on(event, fn) {
          socket.on(event, payload => { console.log('[Socket recv]', event, payload); fn(payload); });
        }
      };
    }
  };
})();
