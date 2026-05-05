import { useEffect, useRef, useState } from 'react';
import type { Action, GameState } from './shared/game';

export interface LobbyView {
  code: string;
  myId: number;            // -1 for spectator
  hostId: number;
  started: boolean;
  players: { id: number; name: string; connected: boolean; isAi: boolean }[];
  emotes: { id: string; playerId: number; emoji: string; ts: number }[];
}

export interface PublicRoom {
  code: string;
  host: string;
  playerCount: number;
  connectedHumans: number;
  maxPlayers: number;
  started: boolean;
}

export type ServerMsg =
  | { t: 'LOBBY'; lobby: LobbyView }
  | { t: 'STATE'; state: GameState; lobby: LobbyView }
  | { t: 'SESSION'; code: string; id: number; token: string; spectator?: boolean }
  | { t: 'ROOMS'; rooms: PublicRoom[] }
  | { t: 'ROOM_CLOSED'; reason: string }
  | { t: 'ERR'; msg: string };

export type ClientMsg =
  | { t: 'CREATE'; name: string }
  | { t: 'JOIN'; code: string; name: string }
  | { t: 'RESUME'; code: string; token: string }
  | { t: 'SPECTATE'; code: string }
  | { t: 'LIST_ROOMS' }
  | { t: 'ADD_AI' }
  | { t: 'REMOVE_AI' }
  | { t: 'START' }
  | { t: 'ACT'; action: Action }
  | { t: 'EMOTE'; emoji: string }
  | { t: 'PLAY_AGAIN' }
  | { t: 'DELETE_ROOM' }
  | { t: 'LEAVE' };

export interface Session {
  code: string;
  id: number;
  token: string;
  spectator: boolean;
}

export interface NetworkConn {
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  lobby: LobbyView | null;
  state: GameState | null;
  session: Session | null;
  rooms: PublicRoom[];
  error: string | null;
  send: (msg: ClientMsg) => void;
  disconnect: () => void;
  clearError: () => void;
}

const SESSION_KEY = 'ph_session';

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch { return null; }
}
function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

function defaultWsUrl(): string {
  const fromEnv = (import.meta as any).env?.VITE_WS_URL as string | undefined;
  if (fromEnv) {
    // PartyKit hosts WebSocket parties at /parties/<name>/<room>. If the env value is just a host,
    // append the canonical path. If it already includes /parties/, use it verbatim.
    if (/\/parties\//.test(fromEnv)) return fromEnv;
    const trimmed = fromEnv.replace(/\/$/, '');
    return `${trimmed}/parties/main/global`;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.hostname}:8787`;
}

export function useNetwork(active: boolean): NetworkConn {
  const [status, setStatus] = useState<NetworkConn['status']>('idle');
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!active) return;
    setStatus('connecting');
    const ws = new WebSocket(defaultWsUrl());
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus('open');
      const stored = loadSession();
      if (stored && !stored.spectator) {
        ws.send(JSON.stringify({ t: 'RESUME', code: stored.code, token: stored.token } as ClientMsg));
      }
    };
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data) as ServerMsg;
        if (msg.t === 'LOBBY') {
          setLobby(msg.lobby);
          if (!msg.lobby.started) setState(null);
        } else if (msg.t === 'STATE') {
          setLobby(msg.lobby);
          setState(msg.state);
        } else if (msg.t === 'SESSION') {
          const s: Session = { code: msg.code, id: msg.id, token: msg.token, spectator: !!msg.spectator };
          setSession(s);
          if (!s.spectator) saveSession(s);
        } else if (msg.t === 'ROOMS') {
          setRooms(msg.rooms);
        } else if (msg.t === 'ROOM_CLOSED') {
          setError(msg.reason);
          setLobby(null); setState(null); setSession(null);
          saveSession(null);
        } else if (msg.t === 'ERR') {
          setError(msg.msg);
          // If we tried to resume into a stale session, clear it.
          if (/not found|invalid session/i.test(msg.msg)) saveSession(null);
        }
      } catch {
        // ignore malformed
      }
    };
    ws.onerror = () => { setStatus('error'); setError('Connection error — is the server running?'); };
    ws.onclose = () => setStatus(s => (s === 'error' ? s : 'closed'));
    return () => { try { ws.close(); } catch { /* ignore */ } };
  }, [active]);

  const send = (msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    // Clear any previous error so a fresh attempt isn't masked by stale text.
    setError(null);
  };
  const disconnect = () => {
    saveSession(null);
    setSession(null);
    try { wsRef.current?.close(); } catch { /* ignore */ }
    setLobby(null); setState(null); setStatus('closed'); setError(null);
  };
  const clearError = () => setError(null);
  return { status, lobby, state, session, rooms, error, send, disconnect, clearError };
}
