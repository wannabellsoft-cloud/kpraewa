// Local development server — adds Socket.IO + HTTP listener to the Express app.
// On Vercel, api/[...all].js wraps the same Express app (no Socket.IO; uses Pusher instead).
const http = require('http');
const { Server } = require('socket.io');
const { createApp } = require('./server');

const PORT = process.env.PORT || 3000;
const app = createApp();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// Expose Socket.IO globally so lib/realtime.js can emit through it
global.__io = io;

io.on('connection', async (socket) => {
  try {
    const { getSettings } = require('./lib/storage');
    socket.emit('settings:update', await getSettings());
  } catch {}
});

httpServer.listen(PORT, () => {
  console.log(`\n  ★ Donate system for k.praewa  (local dev)\n`);
  console.log(`  Donor page : http://localhost:${PORT}/`);
  console.log(`  Widget     : http://localhost:${PORT}/widget`);
  console.log(`  Overlay    : http://localhost:${PORT}/overlay   (← OBS Browser Source)\n`);
});
