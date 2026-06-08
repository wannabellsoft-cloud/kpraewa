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
      } catch { cfg = { provider: 'socketio' }; }

      const handlers = {};
      const on = (event, fn) => { handlers[event] = fn; };

      if (cfg.provider === 'pusher' && cfg.key) {
        await loadScript('https://js.pusher.com/8.4/pusher.min.js');
        const p = new Pusher(cfg.key, { cluster: cfg.cluster || 'ap1' });
        const ch = p.subscribe(cfg.channel || 'donate');
        const proxy = {
          on(event, fn) {
            handlers[event] = fn;
            ch.bind(event, fn);
          }
        };
        return proxy;
      }

      // Default: Socket.IO
      await loadScript('/socket.io/socket.io.js');
      const socket = io();
      const proxy = {
        on(event, fn) {
          handlers[event] = fn;
          socket.on(event, fn);
        }
      };
      return proxy;
    }
  };
})();
