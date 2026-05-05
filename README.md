# cardgame

Poop Head — a web-based shedding card game (variant of Shithead/Palace/Karma). Local hot-seat or networked multiplayer with AI opponents, cutting (Ultimate mode at 4+ players), and reveal-on-pickup.

## Quick start (local dev)

```bash
npm install
npm run dev          # client (5173) + WebSocket server (8787)
```

Open http://localhost:5173 and pick **Local play** or **Online multiplayer**.

## Tests

```bash
node server/e2e-test.mjs        # 21 classic e2e tests
npx tsx server/e2e-ultimate.mjs # 31 Ultimate-mode + cutting tests
```

## Deployment

The frontend and WebSocket server need separate hosting because Vercel-style serverless platforms can't run a persistent WebSocket process.

### Frontend → Vercel

Vercel auto-detects Vite. Push to GitHub, import the repo, deploy. The included `vercel.json` pins the build command and output directory.

After your WS server is up (next section), set this env var in Vercel project settings:

```
VITE_WS_URL=wss://<your-ws-server-host>
```

…then redeploy. The client reads it via `defaultWsUrl()` in `src/net.ts`.

### WebSocket server → Fly.io

The repo includes `Dockerfile` + `fly.toml` for a one-command deploy.

```bash
# 1. Install flyctl
brew install flyctl

# 2. Sign in
fly auth login

# 3. First-time setup — pick a unique app name when prompted
fly launch --copy-config --no-deploy
# (or edit `app = "poophead-server"` in fly.toml to your unique name)

# 4. Deploy
fly deploy
```

Your server is now at `wss://<your-app>.fly.dev`. Use that URL for `VITE_WS_URL` in Vercel.

Cost: Fly bills per-second for a tiny machine — typically ~$2–5 / month for low traffic. The `min_machines_running = 1` keeps the WS connection persistent (not auto-sleeping).

### Alternative WS hosts

The `Dockerfile` works on any container host — Render, Railway, DigitalOcean App Platform, Hetzner, Fly. For Render, set the start command to `npx tsx server/server.ts` and disable auto-sleep on the service. The server reads `process.env.PORT` for the listen port.

## Stack

React 18 · TypeScript · Tailwind · Vite · framer-motion · `ws` (Node WebSocket server) · Web Audio API
