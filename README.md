# cardgame

Poop Head — a web-based shedding card game (variant of Shithead/Palace/Karma). Local hot-seat or networked multiplayer.

## Quick start

```bash
npm install
npm run dev          # runs client (5173) and WebSocket server (8787) together
```

Open http://localhost:5173 and pick **Local hot-seat** or **Online multiplayer**.

## Online play

- One player clicks **Create room** to get a 4-letter code.
- Others click **Join room** and enter the code.
- Host clicks **Start game** when 2–6 players are in.

For LAN play across devices, expose Vite on your network IP:

```bash
npx vite --host 0.0.0.0
```

Then point each device at `http://<your-lan-ip>:5173`. Override the WebSocket URL with `VITE_WS_URL` if the server runs elsewhere.

## Tests

```bash
node server/e2e-test.mjs   # multiplayer end-to-end test (requires dev server running)
```

## Stack

React 18 · TypeScript · Tailwind · Vite · `ws` (Node WebSocket server)
