# Latrine 💩

A web-based shedding card game (variant of Shithead/Palace/Karma). Local hot-seat or networked multiplayer with AI opponents, cutting (Ultimate mode at 4+ players), and reveal-on-pickup. Last player holding cards is crowned the **Poop Head**.

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

### WebSocket server → PartyKit (free, on Cloudflare Workers)

The repo includes `partykit.json` + `party/server.ts` (a port of the Node server to PartyKit's Durable Object model). Free tier covers a card-game's traffic indefinitely.

```bash
# 1. Login (uses GitHub OAuth)
npx partykit login

# 2. Edit `partykit.json` — change `"name": "poophead"` to something unique to you,
#    e.g. "poophead-93andre"

# 3. Deploy
npx partykit deploy
```

Your server is now at `wss://<name>.<username>.partykit.dev`. Set the **host** as `VITE_WS_URL` in Vercel (the client auto-appends `/parties/main/global`):

```
VITE_WS_URL=wss://poophead.93andre.partykit.dev
```

For local development, the same code runs via `npm run dev` (which uses `server/server.ts`, the Node version that's still around for fast local iteration). The PartyKit version is `party/server.ts` and shares the same `src/shared/game.ts` reducer.

## Stack

React 18 · TypeScript · Tailwind · Vite · framer-motion · `ws` (Node WebSocket server) · Web Audio API
