/* Poop Head WebSocket game server (Node).
 * Run via: npm run dev:server
 * Same authoritative reducer the client uses, with per-player redaction. */

import { WebSocketServer, WebSocket } from 'ws';
import {
  reducer,
  newGame,
  redactForViewer,
  MIN_PLAYERS,
  MAX_PLAYERS,
  type Action,
  type GameState,
} from '../src/shared/game';

interface RoomPlayer {
  id: number;
  name: string;
  ws: WebSocket | null;  // null when disconnected
}

interface Room {
  code: string;
  hostId: number;
  players: RoomPlayer[];   // index === id
  state: GameState | null;
}

const rooms = new Map<string, Room>();
const socketToRoom = new WeakMap<WebSocket, { code: string; id: number }>();

function makeCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit ambiguous chars
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (rooms.has(code)) return makeCode();
  return code;
}

function roomLobbyView(room: Room, viewerId: number) {
  return {
    code: room.code,
    myId: viewerId,
    hostId: room.hostId,
    started: room.state !== null,
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.ws !== null })),
  };
}

function broadcast(room: Room) {
  for (const p of room.players) {
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
    if (room.state) {
      const redacted = redactForViewer(room.state, p.id);
      p.ws.send(JSON.stringify({ t: 'STATE', state: redacted, lobby: roomLobbyView(room, p.id) }));
    } else {
      p.ws.send(JSON.stringify({ t: 'LOBBY', lobby: roomLobbyView(room, p.id) }));
    }
  }
}

function send(ws: WebSocket, payload: any) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function err(ws: WebSocket, msg: string) {
  send(ws, { t: 'ERR', msg });
}

// Most actions must come from a specific player. Validate sender vs action.
function actionAllowed(state: GameState, senderId: number, action: Action): boolean {
  switch (action.type) {
    case 'NEW_GAME':
      return false; // server controls game lifecycle via START
    case 'BEGIN_PLAY':
      return true; // any player can confirm; safer to gate to host but harmless
    case 'SWAP_PICK':
    case 'SWAP_READY':
      return action.player === senderId;
    case 'ACK_PASS':
      return true; // auto-applied server-side; harmless if a client sends it
    case 'TOGGLE_SELECT':
    case 'PLAY_SELECTED':
    case 'PICKUP_PILE':
    case 'FLIP_FACEDOWN':
    case 'RESOLVE_FLIP':
      return state.current === senderId;
    default:
      return false;
  }
}

function applyAction(room: Room, senderId: number, action: Action) {
  if (!room.state) return;
  if (!actionAllowed(room.state, senderId, action)) return;
  let next = reducer(room.state, action);
  // In network mode there is no per-device pass screen — auto-advance.
  while (next.phase === 'pass') {
    next = reducer(next, { type: 'ACK_PASS' });
  }
  room.state = next;
}

const PORT = Number(process.env.PORT ?? 8787);
const wss = new WebSocketServer({ port: PORT });

console.log(`[poophead] WebSocket server listening on :${PORT}`);

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return err(ws, 'Bad JSON'); }

    switch (msg.t) {
      case 'CREATE': {
        const name = String(msg.name ?? '').slice(0, 24).trim() || 'Player 1';
        const code = makeCode();
        const room: Room = {
          code,
          hostId: 0,
          players: [{ id: 0, name, ws }],
          state: null,
        };
        rooms.set(code, room);
        socketToRoom.set(ws, { code, id: 0 });
        broadcast(room);
        return;
      }
      case 'JOIN': {
        const code = String(msg.code ?? '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return err(ws, `Room ${code} not found`);
        if (room.state) return err(ws, 'Game already started');
        if (room.players.length >= MAX_PLAYERS) return err(ws, 'Room full');
        const id = room.players.length;
        const name = String(msg.name ?? '').slice(0, 24).trim() || `Player ${id + 1}`;
        room.players.push({ id, name, ws });
        socketToRoom.set(ws, { code, id });
        broadcast(room);
        return;
      }
      case 'START': {
        const ref = socketToRoom.get(ws);
        if (!ref) return err(ws, 'Not in a room');
        const room = rooms.get(ref.code);
        if (!room) return err(ws, 'Room missing');
        if (ref.id !== room.hostId) return err(ws, 'Only host can start');
        if (room.players.length < MIN_PLAYERS) return err(ws, `Need at least ${MIN_PLAYERS} players`);
        if (room.state) return err(ws, 'Already started');
        room.state = newGame(room.players.length, room.players.map(p => p.name));
        broadcast(room);
        return;
      }
      case 'ACT': {
        const ref = socketToRoom.get(ws);
        if (!ref) return err(ws, 'Not in a room');
        const room = rooms.get(ref.code);
        if (!room || !room.state) return err(ws, 'No game in progress');
        applyAction(room, ref.id, msg.action as Action);
        broadcast(room);
        return;
      }
      case 'LEAVE': {
        const ref = socketToRoom.get(ws);
        if (!ref) return;
        const room = rooms.get(ref.code);
        if (!room) return;
        const player = room.players[ref.id];
        if (player) player.ws = null;
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
    const player = room.players[ref.id];
    if (player) player.ws = null;
    // If everyone disconnected and game hasn't started, drop the room.
    if (!room.state && room.players.every(p => p.ws === null)) {
      rooms.delete(ref.code);
      return;
    }
    broadcast(room);
  });
});
