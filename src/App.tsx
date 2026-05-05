import React, { useEffect, useReducer, useRef, useState } from 'react';
import {
  type Action,
  type Card,
  type GameState,
  type PileEntry,
  type Player,
  type Source,
  type Suit,
  DEFAULT_PLAYER_COUNT,
  MIN_PLAYERS,
  MAX_PLAYERS,
  activeSource,
  canPlayCards,
  cardsFromSource,
  newGame,
  reducer,
} from './shared/game';
import { useNetwork, type NetworkConn } from './net';

/* ============== Sound (Web Audio synth, no assets) ============== */

type SoundName = 'play' | 'pickup' | 'burn' | 'reset' | 'skip' | 'reverse' | 'seven' | 'win' | 'click';

class SoundEngine {
  private ctx: AudioContext | null = null;
  muted: boolean = (() => {
    try { return localStorage.getItem('ph_muted') === '1'; } catch { return false; }
  })();

  private ensure() {
    if (!this.ctx) {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctor) this.ctx = new Ctor();
    }
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem('ph_muted', m ? '1' : '0'); } catch { /* ignore */ }
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.15, delay = 0) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noiseBurst(dur: number, gain = 0.2) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(g).connect(ctx.destination);
    src.start();
  }

  play(name: SoundName) {
    switch (name) {
      case 'play':
        this.tone(420, 0.08, 'triangle', 0.18);
        this.tone(640, 0.06, 'triangle', 0.10, 0.02);
        break;
      case 'pickup':
        this.tone(220, 0.18, 'sawtooth', 0.12);
        this.tone(160, 0.20, 'sawtooth', 0.10, 0.05);
        break;
      case 'burn':
        this.noiseBurst(0.35, 0.22);
        this.tone(120, 0.30, 'sawtooth', 0.18);
        break;
      case 'reset':
        this.tone(520, 0.08, 'square', 0.12);
        this.tone(780, 0.10, 'square', 0.10, 0.06);
        break;
      case 'skip':
        this.tone(700, 0.08, 'square', 0.14);
        this.tone(500, 0.08, 'square', 0.14, 0.08);
        break;
      case 'reverse':
        this.tone(900, 0.10, 'triangle', 0.14);
        this.tone(600, 0.10, 'triangle', 0.14, 0.08);
        this.tone(400, 0.10, 'triangle', 0.14, 0.16);
        break;
      case 'seven':
        this.tone(330, 0.18, 'sine', 0.16);
        break;
      case 'win': {
        const notes = [523, 659, 784, 1046];
        notes.forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.18, i * 0.12));
        break;
      }
      case 'click':
        this.tone(880, 0.03, 'square', 0.06);
        break;
    }
  }
}

const sfx = new SoundEngine();

/* ============== Card components ============== */

const RED_SUITS: Suit[] = ['♥', '♦'];

function CardFace({ card, small = false, hidden = false, selected = false, onClick, dim = false }: {
  card?: Card; small?: boolean; hidden?: boolean; selected?: boolean; onClick?: () => void; dim?: boolean;
}) {
  const w = small ? 'w-10 h-14 text-xs' : 'w-16 h-24 text-base';
  const base = `relative ${w} rounded-md border shadow-sm flex flex-col items-center justify-center select-none transition-all`;
  if (hidden || !card) {
    return (
      <div
        onClick={onClick}
        className={`${base} bg-indigo-600 border-indigo-800 text-white ${onClick ? 'cursor-pointer' : ''} ${selected ? '-translate-y-2 ring-2 ring-amber-400' : ''}`}
      >
        <div className="font-black tracking-widest opacity-80">PH</div>
      </div>
    );
  }
  const isJoker = card.rank === 'JK';
  const red = RED_SUITS.includes(card.suit);
  const colorCls = isJoker ? 'text-purple-700' : red ? 'text-red-600' : 'text-gray-900';
  const bg = isJoker ? 'bg-amber-50' : 'bg-white';
  return (
    <div
      onClick={onClick}
      className={`${base} ${bg} ${colorCls} border-gray-300 ${onClick ? 'cursor-pointer hover:shadow-md' : ''} ${selected ? '-translate-y-3 ring-2 ring-amber-500' : ''} ${dim ? 'opacity-50' : ''}`}
    >
      <div className="absolute top-1 left-1 leading-none font-bold">{isJoker ? 'J' : card.rank}</div>
      <div className="text-2xl">{isJoker ? '★' : card.suit}</div>
      <div className="absolute bottom-1 right-1 leading-none font-bold rotate-180">{isJoker ? 'J' : card.rank}</div>
    </div>
  );
}

function PlayerArea({ player, isCurrent, isViewer, faceDownClickable, onFaceDownClick }: {
  player: Player; isCurrent: boolean; isViewer: boolean;
  faceDownClickable?: boolean; onFaceDownClick?: (id: string) => void;
}) {
  return (
    <div className={`p-3 rounded-lg border ${isCurrent ? 'border-amber-500 bg-amber-50' : 'border-gray-300 bg-white/60'} flex flex-col gap-2 min-w-[220px]`}>
      <div className="flex items-center justify-between">
        <span className="font-semibold">
          {player.name}{isViewer && <span className="ml-1 text-xs text-emerald-700">(you)</span>}
        </span>
        <span className="text-xs text-gray-600">
          hand: {player.hand.length} {player.out && <span className="ml-1 px-2 py-0.5 bg-emerald-200 rounded">out #{player.finishPos}</span>}
        </span>
      </div>
      <div className="flex gap-1">
        {player.faceUp.map(c => <CardFace key={c.id} card={c} small />)}
        {player.faceUp.length === 0 && player.faceDown.length > 0 && (
          <span className="text-xs text-gray-500 italic">face-up empty</span>
        )}
      </div>
      <div className="flex gap-1">
        {player.faceDown.map(c => (
          <CardFace
            key={c.id}
            small
            hidden
            onClick={faceDownClickable && onFaceDownClick ? () => onFaceDownClick(c.id) : undefined}
          />
        ))}
        {player.faceDown.length === 0 && <span className="text-xs text-gray-500 italic">face-down empty</span>}
      </div>
    </div>
  );
}

function CenterPiles({ deckCount, pile }: { deckCount: number; pile: PileEntry[] }) {
  const top = pile[pile.length - 1];
  return (
    <div className="flex items-center gap-6 justify-center">
      <div className="flex flex-col items-center gap-1">
        <div className="relative w-16 h-24">
          {deckCount > 0 ? <CardFace hidden /> : <div className="w-16 h-24 rounded-md border-2 border-dashed border-gray-400" />}
        </div>
        <span className="text-xs text-gray-600">deck: {deckCount}</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className="relative w-16 h-24">
          {top ? <CardFace card={top.card} /> : <div className="w-16 h-24 rounded-md border-2 border-dashed border-gray-400 flex items-center justify-center text-xs text-gray-400">empty</div>}
        </div>
        <span className="text-xs text-gray-600">pile: {pile.length}</span>
      </div>
    </div>
  );
}

function GameLog({ log }: { log: string[] }) {
  return (
    <div className="w-72 max-h-[80vh] overflow-y-auto border border-gray-300 rounded-lg p-3 bg-white/70 text-sm">
      <div className="font-semibold mb-2">Game log</div>
      <ul className="space-y-1">
        {log.slice().reverse().map((l, i) => (
          <li key={i} className="text-gray-700 leading-snug">• {l}</li>
        ))}
      </ul>
    </div>
  );
}

function StatusBar({ state, viewerId, isMyTurn }: { state: GameState; viewerId: number | null; isMyTurn: boolean }) {
  const p = state.players[state.current];
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 bg-white/80 border border-gray-300 rounded-lg text-sm">
      <span><strong>{p?.name}</strong>'s turn{isMyTurn && <span className="ml-1 text-emerald-700 font-semibold">(your move)</span>}</span>
      <span>direction: {state.direction === 1 ? '↻' : '↺'}</span>
      {state.sevenRestriction && <span className="px-2 py-0.5 bg-rose-100 text-rose-700 rounded">7-or-lower</span>}
      {state.lastWasMine && <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded">bonus turn</span>}
      {viewerId !== null && <span className="text-xs text-gray-500">you are {state.players[viewerId]?.name}</span>}
    </div>
  );
}

/* ============== Phase screens (mode-agnostic) ============== */

function SetupScreen({ onLocal, onNetwork }: { onLocal: () => void; onNetwork: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-5xl font-black tracking-tight">💩 Poop Head</h1>
      <p className="max-w-xl text-center text-gray-700">
        A shedding card game. Get rid of all your cards. Last one holding cards is the Poop Head.
      </p>
      <div className="flex gap-3">
        <button onClick={onLocal} className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow">
          Local hot-seat ({DEFAULT_PLAYER_COUNT}p)
        </button>
        <button onClick={onNetwork} className="px-6 py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-lg shadow">
          Online multiplayer
        </button>
      </div>
      <div className="text-xs text-gray-500 max-w-md text-center">
        2 = reset · 10 = burn · 8 = skip · K = reverse · 7 = next plays ≤7 · Joker = copy below · 4-of-a-kind burns
      </div>
    </div>
  );
}

function SwapScreen({ state, dispatch, viewerId }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
}) {
  const allReady = state.swapReady.every(Boolean);
  const isNetwork = viewerId !== null;
  // In network mode, only show swap controls for the viewer's own row.
  return (
    <div className="p-4 flex flex-col gap-4">
      <h2 className="text-2xl font-bold">Swap phase</h2>
      <p className="text-sm text-gray-600">
        Click a hand card, then a face-up card (or vice versa) to swap. Click <em>Ready</em> when done.
        {isNetwork ? ' Each player swaps independently — game starts when all ready.' : ' Pass the device between players.'}
      </p>
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${state.players.length}, minmax(0, 1fr))` }}>
        {state.players.map((p, i) => {
          const editable = isNetwork ? viewerId === i : true;
          const sel = state.swapSelected[i] ?? null;
          const ready = state.swapReady[i];
          return (
            <div key={p.id} className={`border rounded-lg p-3 flex flex-col gap-2 ${editable ? 'bg-white/70' : 'bg-white/40'}`}>
              <div className="font-semibold">
                {p.name} {viewerId === i && <span className="text-xs text-emerald-700">(you)</span>}
              </div>
              <div className="text-xs text-gray-500">Face-up</div>
              <div className="flex gap-1 flex-wrap">
                {p.faceUp.map(c => (
                  <CardFace
                    key={c.id} card={c} small
                    selected={sel?.source === 'faceUp' && sel.id === c.id && !ready}
                    dim={ready || !editable}
                    onClick={editable && !ready ? () => dispatch({ type: 'SWAP_PICK', player: i, source: 'faceUp', id: c.id }) : undefined}
                  />
                ))}
              </div>
              <div className="text-xs text-gray-500">Hand</div>
              <div className="flex gap-1 flex-wrap">
                {p.hand.map(c => (
                  <CardFace
                    key={c.id} card={c} small
                    hidden={isNetwork && viewerId !== i}
                    selected={sel?.source === 'hand' && sel.id === c.id && !ready}
                    dim={ready || !editable}
                    onClick={editable && !ready ? () => dispatch({ type: 'SWAP_PICK', player: i, source: 'hand', id: c.id }) : undefined}
                  />
                ))}
              </div>
              <button
                disabled={!editable}
                onClick={() => dispatch({ type: 'SWAP_READY', player: i })}
                className={`mt-2 px-3 py-1 rounded text-sm font-semibold ${ready ? 'bg-emerald-500 text-white' : 'bg-gray-200'} ${editable ? '' : 'opacity-50 cursor-not-allowed'}`}
              >
                {ready ? 'Ready ✓' : 'Mark ready'}
              </button>
            </div>
          );
        })}
      </div>
      <div>
        <button
          disabled={!allReady}
          onClick={() => dispatch({ type: 'BEGIN_PLAY' })}
          className={`px-5 py-2 rounded-lg font-bold ${allReady ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
        >
          Start game
        </button>
      </div>
    </div>
  );
}

function PassScreen({ state, dispatch }: { state: GameState; dispatch: (a: Action) => void }) {
  const p = state.players[state.current];
  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 p-6">
      <h2 className="text-3xl font-bold">Pass the device to {p.name}</h2>
      <p className="text-gray-700">The previous player's hand is hidden. Tap below when {p.name} is ready.</p>
      <button onClick={() => dispatch({ type: 'ACK_PASS' })} className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow">
        Start {p.name}'s turn
      </button>
    </div>
  );
}

function PlayScreen({ state, dispatch, viewerId }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
}) {
  // viewer is local player in network mode; in local mode, viewer == current player.
  const viewer = viewerId ?? state.current;
  const isMyTurn = viewer === state.current;
  const me = state.players[viewer];
  const src = activeSource(me, state.deck.length === 0);

  // Source cards displayed for the viewer.
  const sourceCards = src ? cardsFromSource(me, src) : [];
  const selectedCards = sourceCards.filter(c => state.selected.includes(c.id));
  const canPlay = isMyTurn && selectedCards.length > 0 && canPlayCards(selectedCards, state.pile, state.sevenRestriction);
  const anyLegal = sourceCards.some(c => canPlayCards([c], state.pile, state.sevenRestriction));

  return (
    <div className="flex h-full">
      <div className="flex-1 p-4 flex flex-col gap-4">
        <StatusBar state={state} viewerId={viewerId} isMyTurn={isMyTurn} />
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${state.players.length}, minmax(0, 1fr))` }}>
          {state.players.map((pp, i) => (
            <PlayerArea
              key={pp.id}
              player={pp}
              isCurrent={i === state.current}
              isViewer={i === viewer}
              faceDownClickable={isMyTurn && i === state.current && src === 'faceDown'}
              onFaceDownClick={(id) => dispatch({ type: 'FLIP_FACEDOWN', id })}
            />
          ))}
        </div>
        <div className="my-2"><CenterPiles deckCount={state.deck.length} pile={state.pile} /></div>

        <div className="border-t pt-3">
          <div className="text-sm text-gray-600 mb-2">
            {!isMyTurn && <>Waiting for {state.players[state.current].name}…</>}
            {isMyTurn && src === 'hand' && <>Your hand:</>}
            {isMyTurn && src === 'faceUp' && <>Hand & deck empty — playing from face-up cards.</>}
            {isMyTurn && src === 'faceDown' && <>Hand & face-up empty — pick a face-down card to flip.</>}
            {isMyTurn && !src && <>No cards left.</>}
          </div>
          {src && src !== 'faceDown' && (
            <div className="flex gap-2 flex-wrap">
              {sourceCards.map(c => {
                const wouldBeOk = canPlayCards([c], state.pile, state.sevenRestriction);
                return (
                  <CardFace
                    key={c.id}
                    card={c}
                    selected={state.selected.includes(c.id)}
                    dim={!wouldBeOk && state.selected.length === 0}
                    onClick={isMyTurn ? () => dispatch({ type: 'TOGGLE_SELECT', id: c.id }) : undefined}
                  />
                );
              })}
            </div>
          )}
          <div className="mt-3 flex gap-2 items-center">
            <button
              disabled={!canPlay}
              onClick={() => dispatch({ type: 'PLAY_SELECTED' })}
              className={`px-4 py-2 rounded font-semibold ${canPlay ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
            >
              Play selected
            </button>
            <button
              disabled={!isMyTurn || state.pile.length === 0 || src === 'faceDown'}
              onClick={() => dispatch({ type: 'PICKUP_PILE' })}
              className={`px-4 py-2 rounded font-semibold ${isMyTurn && state.pile.length > 0 && src !== 'faceDown' ? 'bg-rose-500 hover:bg-rose-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
            >
              Pick up pile
            </button>
            {isMyTurn && !anyLegal && src && src !== 'faceDown' && (
              <span className="text-xs text-rose-700">No legal play in this source — pick up the pile.</span>
            )}
          </div>
        </div>
      </div>
      <GameLog log={state.log} />
    </div>
  );
}

function FlipScreen({ state, dispatch, viewerId }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
}) {
  const card = state.flippedCard!;
  const legal = canPlayCards([card], state.pile, state.sevenRestriction);
  const myAction = viewerId === null || viewerId === state.current;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <h2 className="text-2xl font-bold">Face-down flip — {state.players[state.current].name}</h2>
      <CardFace card={card} />
      <div className="text-sm">
        {legal ? <span className="text-emerald-700">Legal! It will be played.</span> : <span className="text-rose-700">Not legal — pile + this card go to {state.players[state.current].name}'s hand.</span>}
      </div>
      {myAction && (
        <button onClick={() => dispatch({ type: 'RESOLVE_FLIP' })} className="px-6 py-2 bg-amber-500 text-white font-bold rounded">
          Continue
        </button>
      )}
    </div>
  );
}

function EndScreen({ state, onPlayAgain }: { state: GameState; onPlayAgain: () => void }) {
  const loser = state.players.find(p => p.id === state.poopHead);
  const order = state.players
    .filter(p => p.finishPos !== null)
    .sort((a, b) => (a.finishPos! - b.finishPos!));
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <h1 className="text-5xl font-black">💩 {loser?.name} is the Poop Head!</h1>
      <ol className="bg-white/80 p-4 rounded-lg border border-gray-300">
        {order.map(p => <li key={p.id}>#{p.finishPos} — {p.name}</li>)}
        <li className="text-rose-700 font-semibold">#{state.players.length} (Poop Head) — {loser?.name}</li>
      </ol>
      <button onClick={onPlayAgain} className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow">
        Play again
      </button>
    </div>
  );
}

/* ============== Network lobby ============== */

function NetLobbyScreen({ conn, onLeave }: { conn: NetworkConn; onLeave: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  if (!conn.lobby) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-6">
        <h2 className="text-3xl font-bold">Online multiplayer</h2>
        {conn.status === 'connecting' && <div className="text-gray-600">Connecting…</div>}
        {conn.status === 'error' && <div className="text-rose-700 text-sm max-w-md text-center">{conn.error ?? 'Connection failed.'} Make sure the server is running (npm run dev:server).</div>}
        {conn.status === 'open' && (
          <div className="flex flex-col gap-3 w-80">
            <input
              value={name} onChange={e => setName(e.target.value)} placeholder="Your name"
              className="px-3 py-2 border border-gray-300 rounded"
            />
            <button
              disabled={!name.trim()}
              onClick={() => conn.send({ t: 'CREATE', name: name.trim() })}
              className={`px-4 py-2 rounded font-semibold ${name.trim() ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
            >
              Create room
            </button>
            <div className="text-center text-xs text-gray-500">— or —</div>
            <input
              value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Room code"
              className="px-3 py-2 border border-gray-300 rounded uppercase tracking-widest text-center"
              maxLength={4}
            />
            <button
              disabled={!name.trim() || code.length !== 4}
              onClick={() => conn.send({ t: 'JOIN', code, name: name.trim() })}
              className={`px-4 py-2 rounded font-semibold ${name.trim() && code.length === 4 ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
            >
              Join room
            </button>
          </div>
        )}
        <button onClick={onLeave} className="text-sm text-gray-600 underline">Back</button>
      </div>
    );
  }

  const isHost = conn.lobby.myId === conn.lobby.hostId;
  const enough = conn.lobby.players.length >= MIN_PLAYERS;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 p-6">
      <h2 className="text-3xl font-bold">Room {conn.lobby.code}</h2>
      <div className="text-sm text-gray-600">Share this code with other players. {MIN_PLAYERS}–{MAX_PLAYERS} players.</div>
      <ul className="bg-white/80 p-4 rounded-lg border border-gray-300 w-80">
        {conn.lobby.players.map(p => (
          <li key={p.id} className="flex justify-between py-1">
            <span>
              {p.name}
              {p.id === conn.lobby!.hostId && <span className="ml-2 text-xs text-amber-700">host</span>}
              {p.id === conn.lobby!.myId && <span className="ml-2 text-xs text-emerald-700">(you)</span>}
            </span>
            <span className={`text-xs ${p.connected ? 'text-emerald-700' : 'text-rose-700'}`}>
              {p.connected ? 'connected' : 'disconnected'}
            </span>
          </li>
        ))}
      </ul>
      {isHost ? (
        <button
          disabled={!enough}
          onClick={() => conn.send({ t: 'START' })}
          className={`px-6 py-3 rounded-lg font-bold shadow ${enough ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
        >
          Start game ({conn.lobby.players.length})
        </button>
      ) : (
        <div className="text-gray-600">Waiting for host to start…</div>
      )}
      <button onClick={onLeave} className="text-sm text-gray-600 underline">Leave room</button>
      {conn.error && <div className="text-rose-700 text-sm">{conn.error}</div>}
    </div>
  );
}

/* ============== Sound binding ============== */

function useSoundForLog(log: string[], resetKey: any) {
  const lastLen = useRef(0);
  useEffect(() => {
    lastLen.current = 0;
  }, [resetKey]);
  useEffect(() => {
    const newLines = log.slice(lastLen.current);
    lastLen.current = log.length;
    for (const line of newLines) {
      if (/Pile burned by 10/i.test(line)) sfx.play('burn');
      else if (/Four of a kind/i.test(line)) sfx.play('burn');
      else if (/picked up the pile/i.test(line)) sfx.play('pickup');
      else if (/pile reset/i.test(line)) sfx.play('reset');
      else if (/direction reversed/i.test(line)) sfx.play('reverse');
      else if (/skipped/i.test(line)) sfx.play('skip');
      else if (/7-or-lower/i.test(line)) sfx.play('seven');
      else if (/POOP HEAD/i.test(line)) sfx.play('win');
      else if (/^.* played /i.test(line) || /flipped face-down/i.test(line)) sfx.play('play');
      else if (/illegal! Picks up/i.test(line)) sfx.play('pickup');
    }
  }, [log]);
}

/* ============== Local-mode App ============== */

function LocalGame({ onExit }: { onExit: () => void }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => newGame(DEFAULT_PLAYER_COUNT));
  useSoundForLog(state.log, state.players.length === 0);

  let body: React.ReactNode;
  switch (state.phase) {
    case 'setup':
      body = <div className="p-6"><button onClick={() => dispatch({ type: 'NEW_GAME' })} className="px-4 py-2 bg-amber-500 text-white rounded">Deal</button></div>;
      break;
    case 'swap':
      body = <SwapScreen state={state} dispatch={dispatch} viewerId={null} />;
      break;
    case 'pass':
      body = <PassScreen state={state} dispatch={dispatch} />;
      break;
    case 'play':
      body = <PlayScreen state={state} dispatch={dispatch} viewerId={null} />;
      break;
    case 'flipFaceDown':
      body = <FlipScreen state={state} dispatch={dispatch} viewerId={null} />;
      break;
    case 'end':
      body = <EndScreen state={state} onPlayAgain={() => dispatch({ type: 'NEW_GAME' })} />;
      break;
  }
  return (
    <>
      <button onClick={onExit} className="fixed top-3 left-3 z-50 text-xs px-2 py-1 bg-white/80 border rounded">← menu</button>
      {body}
    </>
  );
}

/* ============== Network-mode App ============== */

function NetworkGame({ onExit }: { onExit: () => void }) {
  const conn = useNetwork(true);
  useSoundForLog(conn.state?.log ?? [], conn.lobby?.code);

  // Wrapper dispatcher: send actions over the wire.
  const dispatch = (action: Action) => conn.send({ t: 'ACT', action });

  let body: React.ReactNode;
  if (!conn.state) {
    body = <NetLobbyScreen conn={conn} onLeave={() => { conn.disconnect(); onExit(); }} />;
  } else {
    const viewerId = conn.lobby?.myId ?? 0;
    switch (conn.state.phase) {
      case 'swap':
        body = <SwapScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} />;
        break;
      case 'pass':
      case 'play':
        body = <PlayScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} />;
        break;
      case 'flipFaceDown':
        body = <FlipScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} />;
        break;
      case 'end':
        body = <EndScreen state={conn.state} onPlayAgain={() => { conn.disconnect(); onExit(); }} />;
        break;
      default:
        body = <div className="p-6">Loading…</div>;
    }
  }

  return (
    <>
      <button onClick={() => { conn.disconnect(); onExit(); }} className="fixed top-3 left-3 z-50 text-xs px-2 py-1 bg-white/80 border rounded">← menu</button>
      {body}
    </>
  );
}

/* ============== Main App ============== */

function MuteButton({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={muted ? 'Unmute' : 'Mute'}
      className="fixed top-3 right-3 z-50 w-10 h-10 rounded-full bg-white/80 border border-gray-300 shadow text-lg hover:bg-white"
    >
      {muted ? '🔇' : '🔊'}
    </button>
  );
}

type AppMode = 'menu' | 'local' | 'network';

export default function App() {
  const [mode, setMode] = useState<AppMode>('menu');
  const [muted, setMuted] = useState(sfx.muted);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    sfx.setMuted(next);
  };

  let body: React.ReactNode;
  if (mode === 'menu') body = <SetupScreen onLocal={() => setMode('local')} onNetwork={() => setMode('network')} />;
  else if (mode === 'local') body = <LocalGame onExit={() => setMode('menu')} />;
  else body = <NetworkGame onExit={() => setMode('menu')} />;

  return (
    <div
      className="h-full w-full"
      style={{ background: 'radial-gradient(ellipse at top, #eef6ee 0%, #e8efe6 60%, #dde6dc 100%)' }}
    >
      <MuteButton muted={muted} onToggle={toggleMute} />
      {body}
    </div>
  );
}
