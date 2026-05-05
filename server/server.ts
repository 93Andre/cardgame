/* Poop Head WebSocket game server (Node).
 * Run via: npm run dev:server */

import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reducer,
  newGame,
  redactForViewer,
  aiPickAction,
  MIN_PLAYERS,
  MAX_PLAYERS,
  type Action,
  type GameState,
} from '../src/shared/game';

interface RoomPlayer {
  id: number;
  name: string;
  ws: WebSocket | null;
  token: string;            // session token for resume
  isAi: boolean;
}

interface Emote {
  id: string;
  playerId: number;
  emoji: string;
  ts: number;
}

interface Room {
  code: string;
  hostId: number;
  players: RoomPlayer[];
  spectators: Set<WebSocket>;
  state: GameState | null;
  emotes: Emote[];
  aiTimer?: NodeJS.Timeout;
  lastActivityAt: number;   // ms timestamp of last meaningful activity
  createdAt: number;
  abandonedAt?: number;     // when the last human disconnected from an in-progress game
}

const ABANDON_GRACE_MS = 60 * 1000;
const hasConnectedHuman = (r: Room) => r.players.some(p => !p.isAi && p.ws !== null);
function sweepAbandoned() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.abandonedAt || !room.state) continue;
    if (hasConnectedHuman(room)) { room.abandonedAt = undefined; continue; }
    if (now - room.abandonedAt >= ABANDON_GRACE_MS) {
      if (room.aiTimer) clearTimeout(room.aiTimer);
      for (const s of room.spectators) { try { s.close(); } catch { /* ignore */ } }
      rooms.delete(code);
    }
  }
}

const rooms = new Map<string, Room>();
const socketToRoom = new WeakMap<WebSocket, { code: string; id: number; spectator: boolean }>();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSIST_FILE = resolve(__dirname, '..', '.poophead-rooms.json');

function makeCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (rooms.has(code)) return makeCode();
  return code;
}

function makeToken(): string {
  return randomBytes(16).toString('hex');
}

function persist() {
  try {
    const dump = [...rooms.values()].map(r => ({
      code: r.code,
      hostId: r.hostId,
      players: r.players.map(p => ({ id: p.id, name: p.name, token: p.token, isAi: p.isAi })),
      state: r.state,
      emotes: r.emotes,
      lastActivityAt: r.lastActivityAt,
      createdAt: r.createdAt,
    }));
    writeFileSync(PERSIST_FILE, JSON.stringify(dump));
  } catch (e) {
    console.error('[poophead] persist failed:', (e as Error).message);
  }
}

function loadPersisted() {
  try {
    const raw = readFileSync(PERSIST_FILE, 'utf8');
    const dump = JSON.parse(raw) as any[];
    const now = Date.now();
    for (const r of dump) {
      // Drop already-stale rooms during load.
      const lastActivityAt = r.lastActivityAt ?? now;
      if (now - lastActivityAt > ROOM_TTL_MS) continue;
      rooms.set(r.code, {
        code: r.code,
        hostId: r.hostId,
        players: r.players.map((p: any) => ({ ...p, ws: null })),
        spectators: new Set(),
        state: r.state ?? null,
        emotes: r.emotes ?? [],
        lastActivityAt,
        createdAt: r.createdAt ?? now,
      });
    }
    console.log(`[poophead] loaded ${rooms.size} persisted room(s)`);
  } catch {
    // no persisted file or parse error — start fresh
  }
}

// Room expires 30 min after last activity (any message, action, broadcast).
// We sweep every 5 min and drop stale rooms.
const ROOM_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function touchRoom(room: Room) {
  room.lastActivityAt = Date.now();
}

function sweepStaleRooms() {
  const now = Date.now();
  let dropped = 0;
  for (const [code, room] of rooms) {
    const idle = now - room.lastActivityAt;
    if (idle <= ROOM_TTL_MS) continue;
    // Force-close any leftover sockets.
    for (const p of room.players) { try { p.ws?.close(); } catch { /* ignore */ } }
    for (const s of room.spectators) { try { s.close(); } catch { /* ignore */ } }
    if (room.aiTimer) clearTimeout(room.aiTimer);
    rooms.delete(code);
    dropped++;
  }
  if (dropped > 0) {
    console.log(`[poophead] swept ${dropped} stale room(s); ${rooms.size} remain`);
    persist();
  }
}

setInterval(sweepStaleRooms, SWEEP_INTERVAL_MS).unref?.();

function lobbyView(room: Room, viewerId: number) {
  return {
    code: room.code,
    myId: viewerId,
    hostId: room.hostId,
    started: room.state !== null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.isAi || p.ws !== null,
      isAi: p.isAi,
    })),
    emotes: room.emotes.slice(-5),
  };
}

function broadcast(room: Room) {
  const payload = (id: number, ws: WebSocket | null, isSpectator: boolean) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (room.state) {
      const viewer = isSpectator ? -1 : id;
      const redacted = redactForViewer(room.state, viewer);
      ws.send(JSON.stringify({ t: 'STATE', state: redacted, lobby: lobbyView(room, isSpectator ? -1 : id) }));
    } else {
      ws.send(JSON.stringify({ t: 'LOBBY', lobby: lobbyView(room, isSpectator ? -1 : id) }));
    }
  };
  for (const p of room.players) payload(p.id, p.ws, false);
  for (const s of room.spectators) payload(-1, s, true);
}

function send(ws: WebSocket, payload: any) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function err(ws: WebSocket, msg: string) {
  send(ws, { t: 'ERR', msg });
}

function actionAllowed(state: GameState, senderId: number, action: Action): boolean {
  switch (action.type) {
    case 'NEW_GAME':
      return false;
    case 'BEGIN_PLAY':
      return true;
    case 'SWAP_PICK':
    case 'SWAP_READY':
      return action.player === senderId;
    case 'ACK_PASS':
      return true;
    case 'TOGGLE_SELECT':
    case 'PLAY_SELECTED':
    case 'PLAY_CARDS':
    case 'PICKUP_PILE':
    case 'FLIP_FACEDOWN':
    case 'RESOLVE_FLIP':
      return state.current === senderId;
    case 'CUT':
      // Cuts are out-of-turn. Sender must equal action.player; ultimate mode + valid match
      // is verified by the reducer itself (applyCut).
      return action.player === senderId;
    case 'REVEAL_CHOICE':
      // Only the player who just picked up (current) can choose what to reveal.
      return state.current === senderId;
    default:
      return false;
  }
}

function applyAction(room: Room, senderId: number, action: Action) {
  if (!room.state) return;
  if (!actionAllowed(room.state, senderId, action)) return;
  let next = reducer(room.state, action);
  while (next.phase === 'pass') {
    next = reducer(next, { type: 'ACK_PASS' });
  }
  room.state = next;
}

// AI auto-step: schedule one AI action (current-turn move, swap-ready, or cut) with delay.
function scheduleAi(room: Room) {
  if (!room.state) return;
  if (room.aiTimer) return;

  // Find an AI that has something to do.
  // 1. swap phase: any AI that hasn't readied
  // 2. play / flipFaceDown: current player if AI
  // 3. play (ultimate mode): any AI with a cut match
  let aiId: number | null = null;
  if (room.state.phase === 'swap') {
    const idx = room.players.findIndex(p => p.isAi && room.state && !room.state.swapReady[p.id]);
    if (idx >= 0) aiId = idx;
  } else if ((room.state.phase === 'play' || room.state.phase === 'flipFaceDown' || room.state.phase === 'reveal') && room.players[room.state.current]?.isAi) {
    aiId = room.state.current;
  } else if (room.state.phase === 'play' && room.state.mode === 'ultimate') {
    for (const p of room.players) {
      if (p.isAi && p.id !== room.state.current && aiPickAction(room.state, p.id)) {
        aiId = p.id;
        break;
      }
    }
  }
  if (aiId === null) return;

  const target = aiId;
  const isCut = room.state.phase === 'play' && room.state.current !== target;
  // If a reveal-on-pickup is on screen, delay AI so the reveal can be seen.
  const REVEAL_MS = 3000;
  const revealRemaining = room.state.revealedPickup
    ? Math.max(0, REVEAL_MS - (Date.now() - room.state.revealedPickup.ts))
    : 0;
  const baseDelay = isCut ? 350 : 700;
  const delay = Math.max(baseDelay, revealRemaining);
  room.aiTimer = setTimeout(() => {
    room.aiTimer = undefined;
    if (!room.state) return;
    const action = aiPickAction(room.state, target);
    if (!action) return;
    applyAction(room, target, action);
    persist();
    broadcast(room);
    scheduleAi(room);
  }, delay);
}

const PORT = Number(process.env.PORT ?? 8787);
loadPersisted();
const wss = new WebSocketServer({ port: PORT });

console.log(`[poophead] WebSocket server listening on :${PORT}`);

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return err(ws, 'Bad JSON'); }

    sweepAbandoned();

    // Touch the room's last-activity timestamp for any incoming message tied to a room.
    const ref = socketToRoom.get(ws);
    if (ref) {
      const r = rooms.get(ref.code);
      if (r) touchRoom(r);
    }

    switch (msg.t) {
      case 'CREATE': {
        const name = String(msg.name ?? '').slice(0, 24).trim() || 'Player 1';
        const code = makeCode();
        const token = makeToken();
        const now = Date.now();
        const room: Room = {
          code,
          hostId: 0,
          players: [{ id: 0, name, ws, token, isAi: false }],
          spectators: new Set(),
          state: null,
          emotes: [],
          lastActivityAt: now,
          createdAt: now,
        };
        rooms.set(code, room);
        socketToRoom.set(ws, { code, id: 0, spectator: false });
        send(ws, { t: 'SESSION', code, id: 0, token });
        broadcast(room);
        persist();
        return;
      }

      case 'JOIN': {
        const code = String(msg.code ?? '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return err(ws, `Room ${code} not found`);
        if (room.state) return err(ws, 'Game already started — try Spectate');
        if (room.players.length >= MAX_PLAYERS) return err(ws, 'Room full');
        const id = room.players.length;
        const name = String(msg.name ?? '').slice(0, 24).trim() || `Player ${id + 1}`;
        const token = makeToken();
        room.players.push({ id, name, ws, token, isAi: false });
        socketToRoom.set(ws, { code, id, spectator: false });
        send(ws, { t: 'SESSION', code, id, token });
        broadcast(room);
        persist();
        return;
      }

      case 'RESUME': {
        const code = String(msg.code ?? '').toUpperCase().trim();
        const token = String(msg.token ?? '');
        const room = rooms.get(code);
        if (!room) return err(ws, `Room ${code} not found`);
        const player = room.players.find(p => p.token === token);
        if (!player) return err(ws, 'Invalid session token');
        // Close any existing socket on this slot.
        if (player.ws && player.ws !== ws) {
          try { player.ws.close(); } catch { /* ignore */ }
        }
        player.ws = ws;
        socketToRoom.set(ws, { code, id: player.id, spectator: false });
        send(ws, { t: 'SESSION', code, id: player.id, token });
        broadcast(room);
        return;
      }

      case 'SPECTATE': {
        const code = String(msg.code ?? '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return err(ws, `Room ${code} not found`);
        room.spectators.add(ws);
        socketToRoom.set(ws, { code, id: -1, spectator: true });
        send(ws, { t: 'SESSION', code, id: -1, token: '', spectator: true });
        broadcast(room);
        return;
      }

      case 'ADD_AI': {
        const ref = socketToRoom.get(ws);
        if (!ref) return err(ws, 'Not in a room');
        const room = rooms.get(ref.code);
        if (!room) return err(ws, 'Room missing');
        if (ref.id !== room.hostId) return err(ws, 'Only host can add AI');
        if (room.state) return err(ws, 'Already started');
        if (room.players.length >= MAX_PLAYERS) return err(ws, 'Room full');
        const id = room.players.length;
        const aiNum = room.players.filter(p => p.isAi).length + 1;
        room.players.push({ id, name: `AI ${aiNum}`, ws: null, token: makeToken(), isAi: true });
        broadcast(room);
        persist();
        return;
      }

      case 'REMOVE_AI': {
        const ref = socketToRoom.get(ws);
        if (!ref) return err(ws, 'Not in a room');
        const room = rooms.get(ref.code);
        if (!room) return;
        if (ref.id !== room.hostId) return err(ws, 'Only host can remove AI');
        if (room.state) return err(ws, 'Already started');
        // Remove last AI seat.
        for (let i = room.players.length - 1; i >= 0; i--) {
          if (room.players[i].isAi) {
            room.players.splice(i, 1);
            // Re-id remaining players (ids must be sequential indices).
            room.players.forEach((p, idx) => { p.id = idx; });
            broadcast(room);
            persist();
            return;
          }
        }
        return err(ws, 'No AI to remove');
      }

      case 'START': {
        const ref = socketToRoom.get(ws);
        if (!ref) return err(ws, 'Not in a room');
        const room = rooms.get(ref.code);
        if (!room) return err(ws, 'Room missing');
        if (ref.id !== room.hostId) return err(ws, 'Only host can start');
        if (room.players.length < MIN_PLAYERS) return err(ws, `Need at least ${MIN_PLAYERS} players`);
        if (room.state) return err(ws, 'Already started');
        const aiDifficulty = msg.aiDifficulty === 'easy' || msg.aiDifficulty === 'hard' ? msg.aiDifficulty : 'normal';
        room.state = newGame(
          room.players.length,
          room.players.map(p => p.name),
          room.players.map(p => p.isAi),
          undefined,
          aiDifficulty,
        );
        broadcast(room);
        persist();
        scheduleAi(room);
        return;
      }

      case 'ACT': {
        const ref = socketToRoom.get(ws);
        if (!ref || ref.spectator) return err(ws, 'Not allowed');
        const room = rooms.get(ref.code);
        if (!room || !room.state) return err(ws, 'No game in progress');
        applyAction(room, ref.id, msg.action as Action);
        broadcast(room);
        persist();
        scheduleAi(room);
        return;
      }

      case 'EMOTE': {
        const ref = socketToRoom.get(ws);
        if (!ref || ref.spectator) return;
        const room = rooms.get(ref.code);
        if (!room) return;
        const emoji = String(msg.emoji ?? '').slice(0, 4);
        if (!emoji) return;
        room.emotes.push({ id: makeToken().slice(0, 8), playerId: ref.id, emoji, ts: Date.now() });
        if (room.emotes.length > 20) room.emotes = room.emotes.slice(-20);
        broadcast(room);
        return;
      }

      case 'PLAY_AGAIN': {
        const ref = socketToRoom.get(ws);
        if (!ref || ref.spectator) return;
        const room = rooms.get(ref.code);
        if (!room) return;
        if (ref.id !== room.hostId) return err(ws, 'Only host can replay');
        if (!room.state || room.state.phase !== 'end') return;
        room.state = newGame(
          room.players.length,
          room.players.map(p => p.name),
          room.players.map(p => p.isAi),
          undefined,
          room.state.aiDifficulty,
        );
        room.emotes = [];
        broadcast(room);
        persist();
        scheduleAi(room);
        return;
      }

      case 'DELETE_ROOM': {
        const ref = socketToRoom.get(ws);
        if (!ref) return err(ws, 'Not in a room');
        const room = rooms.get(ref.code); if (!room) return;
        if (ref.id !== room.hostId) return err(ws, 'Only the host can delete the room');
        const reason = `${room.players[room.hostId]?.name ?? 'Host'} closed the room`;
        for (const p of room.players) {
          if (p.ws) {
            send(p.ws, { t: 'ROOM_CLOSED', reason });
            try { p.ws.close(); } catch { /* ignore */ }
          }
        }
        for (const s of room.spectators) {
          send(s, { t: 'ROOM_CLOSED', reason });
          try { s.close(); } catch { /* ignore */ }
        }
        if (room.aiTimer) clearTimeout(room.aiTimer);
        rooms.delete(ref.code);
        persist();
        return;
      }

      case 'LIST_ROOMS': {
        const list = [...rooms.values()].map(r => ({
          code: r.code,
          host: r.players[r.hostId]?.name ?? '?',
          playerCount: r.players.length,
          connectedHumans: r.players.filter(p => !p.isAi && p.ws !== null).length,
          maxPlayers: MAX_PLAYERS,
          started: r.state !== null,
        }));
        send(ws, { t: 'ROOMS', rooms: list });
        return;
      }

      case 'LEAVE': {
        const ref = socketToRoom.get(ws);
        if (!ref) return;
        const room = rooms.get(ref.code);
        if (!room) return;
        if (ref.spectator) {
          room.spectators.delete(ws);
        } else {
          const player = room.players[ref.id];
          if (player) player.ws = null;
        }
        broadcast(room);
        socketToRoom.delete(ws);
        return;
      }

      default:
        return err(ws, `Unknown message type: ${msg.t}`);
    }
  });

  ws.on('close', () => {
    const ref = socketToRoom.get(ws);
    if (!ref) return;
    const room = rooms.get(ref.code);
    if (!room) return;
    if (ref.spectator) {
      room.spectators.delete(ws);
      return;
    }
    const player = room.players[ref.id];
    if (player) player.ws = null;
    if (room.state && !hasConnectedHuman(room) && !room.abandonedAt) {
      room.abandonedAt = Date.now();
    }
    broadcast(room);
  });
});
