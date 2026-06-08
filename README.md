# Donate System · k.praewa

Donation alert system with EasySlip auto-verification, real-time OBS overlay, TTS readouts, and PromptPay/TrueMoney QR.

Designed to run **both locally (Node.js + Socket.IO)** and **on Vercel (serverless + Pusher + Vercel KV + Vercel Blob)**.

---

## Local development

```bash
npm install
cp .env.example .env       # add your EASYSLIP_API_KEY
npm start
```

- Donor page: http://localhost:3000/
- Widget console: http://localhost:3000/widget
- OBS overlay: http://localhost:3000/overlay

State is stored in `data/settings.json` and `data/donations.json`.
Uploaded assets land in `public/assets/`.

---

## Deploying to Vercel

This project is structured to run on Vercel by swapping three backends via env vars.

### Required services (all have free tiers)

| Service        | What it replaces            | Free tier             |
|---              |---                          |---                    |
| Vercel KV (Redis) | `data/*.json` files        | 30K req/mo · 256 MB   |
| Vercel Blob    | `public/assets/` uploads     | 1 GB · 1M reads       |
| Pusher Channels | Socket.IO realtime          | 100 conn · 200K msg/day |
| EasySlip       | slip verification (existing) | 50 verify/day        |

### Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**:

```
EASYSLIP_API_KEY=...

# Vercel KV (auto-populated when you connect a KV store)
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
KV_REST_API_READ_ONLY_TOKEN=...
KV_URL=...

# Vercel Blob (auto-populated when you connect a Blob store)
BLOB_READ_WRITE_TOKEN=...

# Pusher (from pusher.com → App Keys)
PUSHER_APP_ID=...
PUSHER_KEY=...
PUSHER_SECRET=...
PUSHER_CLUSTER=ap1
```

### One-time setup

1. **Push to GitHub** (already done).
2. **Create the Vercel project** → import the GitHub repo. Framework preset = *Other*.
3. **Connect a KV store**: Vercel Dashboard → Storage → Create → KV. Connect to project — env vars are added automatically.
4. **Connect a Blob store**: Storage → Create → Blob. Same flow.
5. **Sign up Pusher** at pusher.com → create a Channels app → copy the four credentials into Vercel env.
6. **Add `EASYSLIP_API_KEY`** to Vercel env.
7. Redeploy. Done.

### How the code chooses a backend

- `lib/storage.js` → uses Vercel KV when `KV_REST_API_URL` is present, otherwise local JSON files.
- `lib/blob.js` → uses Vercel Blob when `BLOB_READ_WRITE_TOKEN` is present, otherwise writes to `public/assets/`.
- `lib/realtime.js` → uses Pusher when `PUSHER_APP_ID` is present, otherwise Socket.IO (via local-server.js).
- `public/assets/realtime-client.js` → fetches `/api/realtime-info` and loads either Pusher or Socket.IO client.

This means **the same code runs locally and on Vercel** — no separate codebases.

---

## File structure

```
api/[...all].js          Vercel serverless wrapper
local-server.js          Local dev entry (HTTP + Socket.IO)
server.js                Express app factory (routes)
lib/
  storage.js             KV / JSON file abstraction
  blob.js                Vercel Blob / local file abstraction
  realtime.js            Pusher / Socket.IO abstraction
  promptpay.js           PromptPay EMVCo payload + QR decoding
public/
  index.html             Donor wizard (4-step flow)
  widget.html            Streamer console
  overlay.html           OBS browser source
  assets/
    donor.css            Pink rose theme
    admin.css            Dark charcoal theme
    realtime-client.js   Loads Pusher or Socket.IO
data/
  settings.json          Default settings (seeded into KV on first run)
vercel.json              Vercel routes
.env / .env.example      Local env
```

---

## OBS setup

1. OBS → Sources → **+** → Browser
2. URL: `http://localhost:3000/overlay` (or your Vercel URL)
3. Size: 1920 × 1080
4. **Control audio via OBS** ✅ — required for TTS to enter the stream
5. **Refresh browser when scene becomes active** ❌ — keep audio context unlocked
