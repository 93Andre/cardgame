import { useEffect, useRef, useState } from 'react';
import type { Action, AiDifficulty, GameState } from './shared/game';

export interface LobbyView {
  code: string;
  myId: number;            // -1 for spectator
  hostId: number;
  started: boolean;
  players: { id: number; name: string; connected: boolean; isAi: boolean; avatar: string | null }[];
  emotes: { id: string; playerId: number; emoji: string; ts: number }[];
  chats: ChatMsg[];        // last ~30 messages
  private: boolean;        // unlisted; only joinable via the room code
  spectatorCount: number;  // currently-connected spectators — drives the "👁 N watching" pip
}

export interface ChatMsg {
  id: string;
  // playerId is the seat id (0..n-1) for active players, or -1 for a
  // spectator. Name comes along for spectators since they have no seat row.
  playerId: number;
  name: string;
  text: string;
  ts: number;
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
  | { t: 'CREATE'; name: string; private?: boolean; avatar?: string }
  | { t: 'JOIN'; code: string; name: string; avatar?: string }
  | { t: 'RESUME'; code: string; token: string }
  | { t: 'SPECTATE'; code: string }
  | { t: 'LIST_ROOMS' }
  | { t: 'ADD_AI' }
  | { t: 'REMOVE_AI' }
  | { t: 'START'; aiDifficulty?: AiDifficulty }
  | { t: 'ACT'; action: Action }
  | { t: 'EMOTE'; emoji: string }
  | { t: 'CHAT'; text: string }
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
  reconnectAttempt: number;     // increments while we're retrying after a drop
  send: (msg: ClientMsg) => void;
  disconnect: () => void;
  clearError: () => void;
}

const SESSION_KEY = 'ph_session';

/** Read the persisted session, if any. Exported so the menu can surface a
 *  "Resume your game" CTA without opening a websocket. */
export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch { return null; }
}
export function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

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
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    intentionalCloseRef.current = false;

    // Auto-reconnect with capped exponential backoff so a brief network blip
    // (sleep/wake, wifi handoff) doesn't kick the player out of their seat.
    // Capped at ~4s so we converge quickly once the network returns.
    const connect = () => {
      setStatus('connecting');
      const ws = new WebSocket(defaultWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        setStatus('open');
        attemptRef.current = 0;
        setReconnectAttempt(0);
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
            if (/not found|invalid session/i.test(msg.msg)) saveSession(null);
          }
        } catch { /* ignore malformed */ }
      };
      ws.onerror = () => { /* deferred to onclose for retry decision */ };
      ws.onclose = () => {
        if (intentionalCloseRef.current) {
          setStatus('closed');
          return;
        }
        // Keep retrying. UI overlays a "Reconnecting…" pill while attemptRef > 0.
        attemptRef.current += 1;
        setReconnectAttempt(attemptRef.current);
        const delay = Math.min(4000, 400 * Math.pow(1.6, attemptRef.current - 1));
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };
    connect();

    // When the user returns to a backgrounded tab/PWA the OS may have
    // suspended JS for long enough that the websocket is hung-but-not-
    // closed (no `onclose` ever fires). Without this handler the UI
    // looks "frozen" because we never trigger the reconnect path.
    // On visibilitychange → visible, force-close the socket if it's
    // not in OPEN state. The existing onclose retry handles the rest.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws) return;
      if (ws.readyState !== WebSocket.OPEN) {
        try { ws.close(); } catch { /* ignore */ }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Browser-native online/offline events are a faster signal than the
    // WS heartbeat. When the device flips from offline → online, trigger
    // the same forced reconnect.
    window.addEventListener('online', onVisibility);

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onVisibility);
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, [active]);

  const send = (msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    setError(null);
  };
  const disconnect = () => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    saveSession(null);
    setSession(null);
    try { wsRef.current?.close(); } catch { /* ignore */ }
    setLobby(null); setState(null); setStatus('closed'); setError(null);
    attemptRef.current = 0; setReconnectAttempt(0);
  };
  const clearError = () => setError(null);
  return { status, lobby, state, session, rooms, error, reconnectAttempt, send, disconnect, clearError };
}
