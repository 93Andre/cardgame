import { useEffect, useRef, useState } from 'react';
import type { Action, GameState } from './shared/game';

export interface LobbyView {
  code: string;
  myId: number;
  hostId: number;
  started: boolean;
  players: { id: number; name: string; connected: boolean }[];
}

export type ServerMsg =
  | { t: 'LOBBY'; lobby: LobbyView }
  | { t: 'STATE'; state: GameState; lobby: LobbyView }
  | { t: 'ERR'; msg: string };

export type ClientMsg =
  | { t: 'CREATE'; name: string }
  | { t: 'JOIN'; code: string; name: string }
  | { t: 'START' }
  | { t: 'ACT'; action: Action }
  | { t: 'LEAVE' };

export interface NetworkConn {
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  lobby: LobbyView | null;
  state: GameState | null;
  error: string | null;
  send: (msg: ClientMsg) => void;
  disconnect: () => void;
}

function defaultWsUrl(): string {
  const fromEnv = (import.meta as any).env?.VITE_WS_URL;
  if (fromEnv) return fromEnv as string;
  // Try same-host on port 8787 (dev convention).
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.hostname}:8787`;
}

export function useNetwork(active: boolean): NetworkConn {
  const [status, setStatus] = useState<NetworkConn['status']>('idle');
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!active) return;
    setStatus('connecting');
    const ws = new WebSocket(defaultWsUrl());
    wsRef.current = ws;
    ws.onopen = () => setStatus('open');
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data) as ServerMsg;
        if (msg.t === 'LOBBY') {
          setLobby(msg.lobby);
          if (!msg.lobby.started) setState(null);
        } else if (msg.t === 'STATE') {
          setLobby(msg.lobby);
          setState(msg.state);
        } else if (msg.t === 'ERR') {
          setError(msg.msg);
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
  };
  const disconnect = () => {
    try { wsRef.current?.close(); } catch { /* ignore */ }
    setLobby(null); setState(null); setStatus('closed'); setError(null);
  };
  return { status, lobby, state, error, send, disconnect };
}
