/* PartyKit (Cloudflare Workers + Durable Objects) port of the Node WebSocket server.
 *
 * Single-party architecture: one Durable Object instance ("main") holds the rooms Map.
 * Same protocol as the Node server (CREATE / JOIN / RESUME / SPECTATE / ACT / etc.)
 * so the client doesn't need any logic changes — only the WebSocket URL changes.
 */

import type * as Party from 'partykit/server';
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
  conn: Party.Connection | null;
  token: string;
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
  spectators: Set<Party.Connection>;
  state: GameState | null;
  emotes: Emote[];
  aiTimer?: ReturnType<typeof setTimeout>;
  lastActivityAt: number;
  createdAt: number;
  abandonedAt?: number;  // timestamp when an in-progress game lost its last connected human
}

interface ConnState {
  code: string;
  id: number;            // -1 for spectator
  spectator: boolean;
}

const ROOM_TTL_MS = 30 * 60 * 1000;
const ABANDON_GRACE_MS = 60 * 1000;  // an in-progress game with no connected humans is ended after this

function makeToken(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export default class GameServer implements Party.Server {
  rooms = new Map<string, Room>();

  constructor(readonly party: Party.Party) {}

  // Restore persisted rooms on cold start.
  async onStart() {
    const saved = await this.party.storage.get<any[]>('rooms');
    if (!Array.isArray(saved)) return;
    const now = Date.now();
    for (const r of saved) {
      if (now - (r.lastActivityAt ?? 0) > ROOM_TTL_MS) continue;
      this.rooms.set(r.code, {
        code: r.code,
        hostId: r.hostId,
        players: r.players.map((p: any) => ({ ...p, conn: null })),
        spectators: new Set(),
        state: r.state ?? null,
        emotes: r.emotes ?? [],
        lastActivityAt: r.lastActivityAt ?? now,
        createdAt: r.createdAt ?? now,
      });
    }
  }

  // Fire-and-forget snapshot to Durable Object storage.
  persist() {
    const dump = [...this.rooms.values()].map(r => ({
      code: r.code,
      hostId: r.hostId,
      players: r.players.map(p => ({ id: p.id, name: p.name, token: p.token, isAi: p.isAi })),
      state: r.state,
      emotes: r.emotes,
      lastActivityAt: r.lastActivityAt,
      createdAt: r.createdAt,
    }));
    this.party.storage.put('rooms', dump).catch(e => console.error('persist failed:', e));
  }

  // True if any human player currently has an open connection.
  hasConnectedHuman(room: Room): boolean {
    return room.players.some(p => !p.isAi && p.conn !== null);
  }

  // Lazy cleanup — runs at the top of every message handler.
  // PartyKit DOs hibernate when no connections are open, which kills setTimeout.
  // Instead we stamp abandonedAt on disconnect and check elapsed time at next activity.
  sweepAbandoned() {
    const now = Date.now();
    let dirty = false;
    for (const [code, room] of this.rooms) {
      if (!room.abandonedAt || !room.state) continue;
      if (this.hasConnectedHuman(room)) {
        room.abandonedAt = undefined;
        continue;
      }
      if (now - room.abandonedAt >= ABANDON_GRACE_MS) {
        if (room.aiTimer) clearTimeout(room.aiTimer);
        for (const s of room.spectators) { try { s.close(); } catch { /* ignore */ } }
        this.rooms.delete(code);
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  makeCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    while (true) {
      let code = '';
      for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  send(conn: Party.Connection, payload: any) {
    try { conn.send(JSON.stringify(payload)); } catch { /* connection closed */ }
  }
  err(conn: Party.Connection, msg: string) {
    this.send(conn, { t: 'ERR', msg });
  }

  lobbyView(room: Room, viewerId: number) {
    return {
      code: room.code,
      myId: viewerId,
      hostId: room.hostId,
      started: room.state !== null,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        connected: p.isAi || p.conn !== null,
        isAi: p.isAi,
      })),
      emotes: room.emotes.slice(-5),
    };
  }

  broadcast(room: Room) {
    for (const p of room.players) {
      if (!p.conn) continue;
      if (room.state) {
        const redacted = redactForViewer(room.state, p.id);
        this.send(p.conn, { t: 'STATE', state: redacted, lobby: this.lobbyView(room, p.id) });
      } else {
        this.send(p.conn, { t: 'LOBBY', lobby: this.lobbyView(room, p.id) });
      }
    }
    for (const s of room.spectators) {
      if (room.state) {
        const redacted = redactForViewer(room.state, -1);
        this.send(s, { t: 'STATE', state: redacted, lobby: this.lobbyView(room, -1) });
      } else {
        this.send(s, { t: 'LOBBY', lobby: this.lobbyView(room, -1) });
      }
    }
  }

  actionAllowed(state: GameState, senderId: number, action: Action): boolean {
    switch (action.type) {
      case 'NEW_GAME': return false;
      case 'BEGIN_PLAY': return true;
      case 'SWAP_PICK':
      case 'SWAP_READY': return action.player === senderId;
      case 'ACK_PASS': return true;
      case 'TOGGLE_SELECT':
      case 'PLAY_SELECTED':
      case 'PLAY_CARDS':
      case 'PICKUP_PILE':
      case 'FLIP_FACEDOWN':
      case 'RESOLVE_FLIP':
      case 'REVEAL_CHOICE':
        return state.current === senderId;
      case 'CUT': return action.player === senderId;
      default: return false;
    }
  }

  applyAction(room: Room, senderId: number, action: Action) {
    if (!room.state) return;
    if (!this.actionAllowed(room.state, senderId, action)) return;
    let next = reducer(room.state, action);
    while (next.phase === 'pass') {
      next = reducer(next, { type: 'ACK_PASS' });
    }
    room.state = next;
  }

  scheduleAi(room: Room) {
    if (!room.state || room.aiTimer) return;
    let aiId: number | null = null;
    if (room.state.phase === 'swap') {
      const idx = room.players.findIndex(p => p.isAi && room.state && !room.state.swapReady[p.id]);
      if (idx >= 0) aiId = idx;
    } else if (
      (room.state.phase === 'play' || room.state.phase === 'flipFaceDown' || room.state.phase === 'reveal')
      && room.players[room.state.current]?.isAi
    ) {
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
      this.applyAction(room, target, action);
      this.persist();
      this.broadcast(room);
      this.scheduleAi(room);
    }, delay);
  }

  onConnect(_conn: Party.Connection) {
    // Init happens on first message.
  }

  onMessage(message: string, sender: Party.Connection) {
    let msg: any;
    try { msg = JSON.parse(message); } catch { return this.err(sender, 'Bad JSON'); }

    // Lazy cleanup: end abandoned in-progress games whose grace period has elapsed.
    this.sweepAbandoned();

    // Touch activity timestamp on the connection's room.
    const senderState = sender.state as ConnState | null;
    if (senderState) {
      const r = this.rooms.get(senderState.code);
      if (r) r.lastActivityAt = Date.now();
    }

    switch (msg.t) {
      case 'CREATE': {
        const name = String(msg.name ?? '').slice(0, 24).trim() || 'Player 1';
        const code = this.makeCode();
        const token = makeToken();
        const now = Date.now();
        const room: Room = {
          code, hostId: 0,
          players: [{ id: 0, name, conn: sender, token, isAi: false }],
          spectators: new Set(),
          state: null,
          emotes: [],
          lastActivityAt: now,
          createdAt: now,
        };
        this.rooms.set(code, room);
        sender.setState({ code, id: 0, spectator: false } satisfies ConnState);
        this.send(sender, { t: 'SESSION', code, id: 0, token });
        this.broadcast(room);
        this.persist();
        return;
      }

      case 'JOIN': {
        const code = String(msg.code ?? '').toUpperCase().trim();
        const room = this.rooms.get(code);
        if (!room) return this.err(sender, `Room ${code} not found`);
        if (room.state) return this.err(sender, 'Game already started — try Spectate');
        if (room.players.length >= MAX_PLAYERS) return this.err(sender, 'Room full');
        const id = room.players.length;
        const name = String(msg.name ?? '').slice(0, 24).trim() || `Player ${id + 1}`;
        const token = makeToken();
        room.players.push({ id, name, conn: sender, token, isAi: false });
        room.abandonedAt = undefined;
        sender.setState({ code, id, spectator: false } satisfies ConnState);
        this.send(sender, { t: 'SESSION', code, id, token });
        this.broadcast(room);
        this.persist();
        return;
      }

      case 'RESUME': {
        const code = String(msg.code ?? '').toUpperCase().trim();
        const token = String(msg.token ?? '');
        const room = this.rooms.get(code);
        if (!room) return this.err(sender, `Room ${code} not found`);
        const player = room.players.find(p => p.token === token);
        if (!player) return this.err(sender, 'Invalid session token');
        if (player.conn && player.conn !== sender) {
          try { player.conn.close(); } catch { /* ignore */ }
        }
        player.conn = sender;
        room.abandonedAt = undefined;
        sender.setState({ code, id: player.id, spectator: false } satisfies ConnState);
        this.send(sender, { t: 'SESSION', code, id: player.id, token });
        this.broadcast(room);
        return;
      }

      case 'SPECTATE': {
        const code = String(msg.code ?? '').toUpperCase().trim();
        const room = this.rooms.get(code);
        if (!room) return this.err(sender, `Room ${code} not found`);
        room.spectators.add(sender);
        sender.setState({ code, id: -1, spectator: true } satisfies ConnState);
        this.send(sender, { t: 'SESSION', code, id: -1, token: '', spectator: true });
        this.broadcast(room);
        return;
      }

      case 'ADD_AI': {
        const ref = senderState; if (!ref) return this.err(sender, 'Not in a room');
        const room = this.rooms.get(ref.code); if (!room) return;
        if (ref.id !== room.hostId) return this.err(sender, 'Only host can add AI');
        if (room.state) return this.err(sender, 'Already started');
        if (room.players.length >= MAX_PLAYERS) return this.err(sender, 'Room full');
        const id = room.players.length;
        const aiNum = room.players.filter(p => p.isAi).length + 1;
        room.players.push({ id, name: `AI ${aiNum}`, conn: null, token: makeToken(), isAi: true });
        this.broadcast(room);
        this.persist();
        return;
      }

      case 'REMOVE_AI': {
        const ref = senderState; if (!ref) return;
        const room = this.rooms.get(ref.code); if (!room) return;
        if (ref.id !== room.hostId) return this.err(sender, 'Only host can remove AI');
        if (room.state) return this.err(sender, 'Already started');
        for (let i = room.players.length - 1; i >= 0; i--) {
          if (room.players[i].isAi) {
            room.players.splice(i, 1);
            room.players.forEach((p, idx) => { p.id = idx; });
            this.broadcast(room);
            this.persist();
            return;
          }
        }
        return this.err(sender, 'No AI to remove');
      }

      case 'START': {
        const ref = senderState; if (!ref) return this.err(sender, 'Not in a room');
        const room = this.rooms.get(ref.code); if (!room) return;
        if (ref.id !== room.hostId) return this.err(sender, 'Only host can start');
        if (room.players.length < MIN_PLAYERS) return this.err(sender, `Need at least ${MIN_PLAYERS} players`);
        if (room.state) return this.err(sender, 'Already started');
        const aiDifficulty = msg.aiDifficulty === 'easy' || msg.aiDifficulty === 'hard' ? msg.aiDifficulty : 'normal';
        room.state = newGame(
          room.players.length,
          room.players.map(p => p.name),
          room.players.map(p => p.isAi),
          undefined,
          aiDifficulty,
        );
        this.broadcast(room);
        this.persist();
        this.scheduleAi(room);
        return;
      }

      case 'ACT': {
        const ref = senderState; if (!ref || ref.spectator) return this.err(sender, 'Not allowed');
        const room = this.rooms.get(ref.code); if (!room || !room.state) return this.err(sender, 'No game in progress');
        this.applyAction(room, ref.id, msg.action as Action);
        this.broadcast(room);
        this.persist();
        this.scheduleAi(room);
        return;
      }

      case 'EMOTE': {
        const ref = senderState; if (!ref || ref.spectator) return;
        const room = this.rooms.get(ref.code); if (!room) return;
        const emoji = String(msg.emoji ?? '').slice(0, 4);
        if (!emoji) return;
        room.emotes.push({ id: makeToken().slice(0, 8), playerId: ref.id, emoji, ts: Date.now() });
        if (room.emotes.length > 20) room.emotes = room.emotes.slice(-20);
        this.broadcast(room);
        return;
      }

      case 'PLAY_AGAIN': {
        const ref = senderState; if (!ref || ref.spectator) return;
        const room = this.rooms.get(ref.code); if (!room) return;
        if (ref.id !== room.hostId) return this.err(sender, 'Only host can replay');
        if (!room.state || room.state.phase !== 'end') return;
        room.state = newGame(
          room.players.length,
          room.players.map(p => p.name),
          room.players.map(p => p.isAi),
          undefined,
          room.state.aiDifficulty,
        );
        room.emotes = [];
        this.broadcast(room);
        this.persist();
        this.scheduleAi(room);
        return;
      }

      case 'DELETE_ROOM': {
        const ref = senderState; if (!ref) return this.err(sender, 'Not in a room');
        const room = this.rooms.get(ref.code); if (!room) return;
        if (ref.id !== room.hostId) return this.err(sender, 'Only the host can delete the room');
        const reason = `${room.players[room.hostId]?.name ?? 'Host'} closed the room`;
        for (const p of room.players) {
          if (p.conn) {
            this.send(p.conn, { t: 'ROOM_CLOSED', reason });
            try { p.conn.close(); } catch { /* ignore */ }
          }
        }
        for (const s of room.spectators) {
          this.send(s, { t: 'ROOM_CLOSED', reason });
          try { s.close(); } catch { /* ignore */ }
        }
        if (room.aiTimer) clearTimeout(room.aiTimer);
        this.rooms.delete(ref.code);
        this.persist();
        return;
      }

      case 'LIST_ROOMS': {
        const list = [...this.rooms.values()].map(r => ({
          code: r.code,
          host: r.players[r.hostId]?.name ?? '?',
          playerCount: r.players.length,
          connectedHumans: r.players.filter(p => !p.isAi && p.conn !== null).length,
          maxPlayers: MAX_PLAYERS,
          started: r.state !== null,
        }));
        this.send(sender, { t: 'ROOMS', rooms: list });
        return;
      }

      case 'LEAVE': {
        const ref = senderState; if (!ref) return;
        const room = this.rooms.get(ref.code); if (!room) return;
        if (ref.spectator) {
          room.spectators.delete(sender);
        } else {
          const player = room.players[ref.id];
          if (player) player.conn = null;
        }
        this.broadcast(room);
        return;
      }

      default:
        return this.err(sender, `Unknown message type: ${msg.t}`);
    }
  }

  onClose(conn: Party.Connection) {
    const ref = conn.state as ConnState | null;
    if (!ref) return;
    const room = this.rooms.get(ref.code);
    if (!room) return;
    if (ref.spectator) {
      room.spectators.delete(conn);
      return;
    }
    const player = room.players[ref.id];
    if (player) player.conn = null;
    // If the game is in progress and no humans are connected anymore, start the abandon clock.
    // The lazy sweep will end the room ~60s later if nobody returns.
    if (room.state && !this.hasConnectedHuman(room) && !room.abandonedAt) {
      room.abandonedAt = Date.now();
    }
    this.broadcast(room);
    this.persist();
  }
}
