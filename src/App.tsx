import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion, LayoutGroup } from 'framer-motion';
import {
  type Action,
  type Card,
  type GameState,
  type PileEntry,
  type Player,
  type PlayerStats,
  type Rank,
  type Source,
  type Suit,
  DEFAULT_PLAYER_COUNT,
  MIN_PLAYERS,
  MAX_PLAYERS,
  RANK_VALUE,
  activeSource,
  aiPickAction,
  canPlayCards,
  cardsFromSource,
  cutMatches,
  newGame,
  reducer,
} from './shared/game';
import { useNetwork, type NetworkConn } from './net';

/* ============== Sound (Web Audio synth, no assets) ============== */

type SoundName = 'play' | 'pickup' | 'burn' | 'reset' | 'skip' | 'reverse' | 'seven' | 'win' | 'click' | 'emote';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;     // master gain (volume) → compressor → destination
  private compressor: DynamicsCompressorNode | null = null;
  private installedHandlers = false;
  private samples = new Map<string, HTMLAudioElement>();
  muted: boolean = (() => {
    try { return localStorage.getItem('ph_muted') === '1'; } catch { return false; }
  })();
  volume: number = (() => {
    try { const v = parseFloat(localStorage.getItem('ph_vol') ?? '0.7'); return isNaN(v) ? 0.7 : v; } catch { return 0.7; }
  })();

  private ensure() {
    if (!this.ctx) {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctor) {
        const ctx: AudioContext = new Ctor();
        this.ctx = ctx;
        // Build a stable graph: each tone → master gain → compressor → destination.
        // The compressor prevents clipping from overlapping tones (which sounds like sounds
        // "cutting off"); the master gain holds the user's volume preference in one place.
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 6;
        comp.ratio.value = 12;
        comp.attack.value = 0.003;
        comp.release.value = 0.12;
        const master = ctx.createGain();
        master.gain.value = this.volume;
        master.connect(comp);
        comp.connect(ctx.destination);
        this.compressor = comp;
        this.master = master;
      }
    }
    if (this.ctx?.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (!this.installedHandlers && typeof window !== 'undefined') {
      this.installedHandlers = true;
      const resume = () => { if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); };
      document.addEventListener('visibilitychange', resume);
      window.addEventListener('focus', resume);
      window.addEventListener('pointerdown', resume);
      window.addEventListener('keydown', resume);
      window.addEventListener('touchstart', resume, { passive: true });
    }
    return this.ctx;
  }
  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem('ph_muted', m ? '1' : '0'); } catch { /* ignore */ }
  }
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('ph_vol', String(this.volume)); } catch { /* ignore */ }
    if (this.master && this.ctx) {
      // Smoothly retarget the master gain rather than jumping (avoids zipper noise).
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }
  private tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.15, delay = 0) {
    if (this.muted || this.volume < 0.01) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state === 'closed' || !this.master) return;
    try {
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      // Linear envelope only — exponential ramps to near-zero made every tone *sound* cut off
      // because the audible portion ended very early. Linear gives a clean, full fade.
      const peak = gain;
      const attack = 0.005;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + attack);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
      osc.connect(g).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
      // Free graph nodes after they finish so a long session doesn't accumulate them.
      osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* engine occasionally throws under load — drop silently */ }
  }
  private noiseBurst(dur: number, gain = 0.2) {
    if (this.muted || this.volume < 0.01) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state === 'closed' || !this.master) return;
    try {
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      g.gain.value = gain;
      src.buffer = buf;
      src.connect(g).connect(this.master);
      src.start();
      src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  }
  play(name: SoundName) {
    switch (name) {
      case 'play': this.tone(420, 0.08, 'triangle', 0.18); this.tone(640, 0.06, 'triangle', 0.10, 0.02); break;
      case 'pickup': this.tone(220, 0.18, 'sawtooth', 0.12); this.tone(160, 0.20, 'sawtooth', 0.10, 0.05); break;
      case 'burn': this.noiseBurst(0.35, 0.22); this.tone(120, 0.30, 'sawtooth', 0.18); break;
      case 'reset': this.tone(520, 0.08, 'square', 0.12); this.tone(780, 0.10, 'square', 0.10, 0.06); break;
      case 'skip': this.tone(700, 0.08, 'square', 0.14); this.tone(500, 0.08, 'square', 0.14, 0.08); break;
      case 'reverse': this.tone(900, 0.10, 'triangle', 0.14); this.tone(600, 0.10, 'triangle', 0.14, 0.08); this.tone(400, 0.10, 'triangle', 0.14, 0.16); break;
      case 'seven': this.tone(330, 0.18, 'sine', 0.16); break;
      case 'win': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.18, i * 0.12)); break;
      case 'click': this.tone(880, 0.03, 'square', 0.06); break;
      case 'emote': this.tone(750, 0.06, 'triangle', 0.10); break;
    }
  }

  // One-shot mp3 playback. Lazily creates and reuses an HTMLAudioElement per url.
  playSample(url: string, options: { volume?: number } = {}) {
    if (this.muted || this.volume < 0.01) return;
    let el = this.samples.get(url);
    if (!el) {
      el = new Audio(url);
      el.preload = 'auto';
      this.samples.set(url, el);
    }
    try {
      el.volume = Math.min(1, this.volume * (options.volume ?? 1));
      el.currentTime = 0;
      el.play().catch(() => { /* autoplay blocked or interrupted — ignore */ });
    } catch { /* ignore */ }
  }
}

const SFX_FAHHHH = '/sfx/fahhhh.mp3';
const SFX_OBJECTION = '/sfx/objection.mp3';

/* ============== AI speed setting ============== */

// Multiplier on AI move delays. <1 = faster, >1 = slower. Persists in localStorage.
const AI_SPEED_KEY = 'ph_ai_speed';
function loadAiSpeed(): number {
  try { const v = parseFloat(localStorage.getItem(AI_SPEED_KEY) ?? '1'); return Number.isFinite(v) ? v : 1; } catch { return 1; }
}
function saveAiSpeed(v: number) {
  try { localStorage.setItem(AI_SPEED_KEY, String(v)); } catch { /* ignore */ }
}
const sfx = new SoundEngine();

/* ============== Per-player palette ============== */

const PALETTE = [
  { ring: 'ring-amber-400', bg: 'bg-amber-50', border: 'border-amber-400', dot: 'bg-amber-400', text: 'text-amber-700' },
  { ring: 'ring-sky-400', bg: 'bg-sky-50', border: 'border-sky-400', dot: 'bg-sky-400', text: 'text-sky-700' },
  { ring: 'ring-rose-400', bg: 'bg-rose-50', border: 'border-rose-400', dot: 'bg-rose-400', text: 'text-rose-700' },
  { ring: 'ring-emerald-400', bg: 'bg-emerald-50', border: 'border-emerald-400', dot: 'bg-emerald-400', text: 'text-emerald-700' },
  { ring: 'ring-violet-400', bg: 'bg-violet-50', border: 'border-violet-400', dot: 'bg-violet-400', text: 'text-violet-700' },
  { ring: 'ring-orange-400', bg: 'bg-orange-50', border: 'border-orange-400', dot: 'bg-orange-400', text: 'text-orange-700' },
];
const colorFor = (id: number) => PALETTE[id % PALETTE.length];

/* ============== Card components ============== */

const RED_SUITS: Suit[] = ['♥', '♦'];

interface CardFaceProps {
  card?: Card;
  small?: boolean;
  hidden?: boolean;
  selected?: boolean;
  onClick?: () => void;
  dim?: boolean;
  jokerEffRank?: Rank | null;  // shown as small badge when joker copies a rank
}

function CardFace({ card, small, hidden, selected, onClick, dim, jokerEffRank }: CardFaceProps) {
  const w = small ? 'w-9 h-12 text-[10px] sm:w-10 sm:h-14 sm:text-xs' : 'w-14 h-20 text-sm sm:w-16 sm:h-24 sm:text-base';
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
      <div className="absolute top-0.5 left-1 leading-none font-bold">{isJoker ? 'J' : card.rank}</div>
      <div className={small ? 'text-lg' : 'text-2xl'}>{isJoker ? '★' : card.suit}</div>
      <div className="absolute bottom-0.5 right-1 leading-none font-bold rotate-180">{isJoker ? 'J' : card.rank}</div>
      {isJoker && jokerEffRank && jokerEffRank !== 'JK' && (
        <div className="absolute -top-2 -right-2 px-1 py-0.5 bg-purple-700 text-white text-[10px] rounded-full font-bold">={jokerEffRank}</div>
      )}
    </div>
  );
}

function AnimatedCard(props: CardFaceProps & { layoutId?: string; fromDeck?: boolean }) {
  const { layoutId, fromDeck, ...rest } = props;
  // When a card was just drawn from the deck, fly in from the upper-center (deck zone)
  // with a slight rotation to suggest a deal motion.
  const initial = fromDeck
    ? { y: -260, x: 80, scale: 0.65, opacity: 0, rotate: 25 }
    : { scale: 0.6, opacity: 0 };
  return (
    <motion.div
      layoutId={layoutId}
      initial={initial}
      animate={{ y: 0, x: 0, scale: 1, opacity: 1, rotate: 0 }}
      exit={{ scale: 0.6, opacity: 0 }}
      transition={fromDeck
        ? { type: 'spring', stiffness: 200, damping: 22, delay: 0.05 }
        : { type: 'spring', stiffness: 300, damping: 28 }
      }
    >
      <CardFace {...rest} />
    </motion.div>
  );
}

/* ============== Player area ============== */

// Compact hand-depth visual: a horizontal fan of card backs whose count tracks the actual hand size.
function HandStack({ count }: { count: number }) {
  const MAX = 7;
  const visible = Math.min(count, MAX);
  if (count === 0) {
    return <span className="text-[10px] text-gray-500 italic">no cards</span>;
  }
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-7 flex" style={{ width: `${14 + (visible - 1) * 5}px` }}>
        {Array.from({ length: visible }).map((_, i) => (
          <div
            key={i}
            className="absolute w-4 h-6 rounded-sm bg-indigo-600 border border-indigo-800"
            style={{ left: i * 5, top: 0, zIndex: i, boxShadow: '0 1px 1px rgba(0,0,0,0.15)' }}
          />
        ))}
      </div>
      <span className="text-xs font-bold text-gray-700 tabular-nums">{count}</span>
    </div>
  );
}

function PlayerArea({ player, isCurrent, isViewer, faceDownClickable, onFaceDownClick, emotes }: {
  player: Player; isCurrent: boolean; isViewer: boolean;
  faceDownClickable?: boolean; onFaceDownClick?: (id: string) => void;
  emotes?: { id: string; playerId: number; emoji: string }[];
}) {
  const c = colorFor(player.id);
  return (
    <div className={`relative p-2 sm:p-3 rounded-lg border-2 ${isCurrent ? `${c.border} ${c.bg} ring-2 ${c.ring}` : 'border-gray-300 bg-white/60'} flex flex-col gap-2 min-w-0`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold flex items-center gap-1.5 truncate">
          <span className={`inline-block w-2 h-2 rounded-full ${c.dot}`} />
          <span className="truncate">{player.name}</span>
          {player.isAi && <span className="text-[10px] px-1 py-0.5 bg-gray-200 rounded">AI</span>}
          {isViewer && <span className="text-[10px] text-emerald-700">(you)</span>}
        </span>
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <HandStack count={player.hand.length} />
          {player.out && <span className="ml-1 px-1 py-0.5 bg-emerald-200 rounded text-[10px]">#{player.finishPos}</span>}
        </span>
      </div>
      <div className="flex gap-1 flex-wrap">
        {player.faceUp.map(c2 => <AnimatedCard key={c2.id} layoutId={c2.id} card={c2} small />)}
        {player.faceUp.length === 0 && player.faceDown.length > 0 && (
          <span className="text-[10px] text-gray-500 italic">face-up empty</span>
        )}
      </div>
      <div className="flex gap-1">
        {player.faceDown.map(c2 => (
          <CardFace
            key={c2.id} small hidden
            onClick={faceDownClickable && onFaceDownClick ? () => onFaceDownClick(c2.id) : undefined}
          />
        ))}
        {player.faceDown.length === 0 && <span className="text-[10px] text-gray-500 italic">face-down empty</span>}
      </div>
      {/* floating emotes */}
      <AnimatePresence>
        {(emotes ?? []).filter(e => e.playerId === player.id).slice(-1).map(e => (
          <motion.div
            key={e.id}
            initial={{ opacity: 0, y: 0, scale: 0.5 }}
            animate={{ opacity: 1, y: -40, scale: 1.2 }}
            exit={{ opacity: 0, y: -80 }}
            transition={{ duration: 1.4 }}
            className="absolute right-2 top-2 text-3xl pointer-events-none"
          >
            {e.emoji}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ============== Center piles ============== */

// Stacked card layers visualizing depth. Top card is rendered DOMINANTLY at the front;
// depth layers peek out behind it (down-right). For the pile, layerCards renders the
// real previously-played cards face-up underneath. For the deck, no layerCards is given
// so card-back rectangles show (because the deck IS face-down).
function CardStack({ count, top, layerCards, emptyLabel, tone = 'normal' }: {
  count: number;
  top?: React.ReactNode;
  layerCards?: PileEntry[];     // when provided, each layer renders the actual face-up card from this list
  emptyLabel?: string;
  tone?: 'normal' | 'burned';
}) {
  const MAX_LAYERS = 12;
  const visibleLayers = Math.min(count, MAX_LAYERS);
  const baseLayers = Math.max(0, visibleLayers - 1);
  const layerStep = 1.6;
  const padPx = baseLayers * layerStep;
  return (
    <div
      className="relative"
      style={{
        width: `calc(4rem + ${padPx}px)`,
        height: `calc(6rem + ${padPx}px)`,
      }}
    >
      {Array.from({ length: baseLayers }).map((_, i) => {
        const depth = baseLayers - i;       // 1 = just under top, baseLayers = deepest visible
        const offset = depth * layerStep;
        const layerCardEntry = layerCards ? layerCards[layerCards.length - depth] : undefined;
        const fallbackCls = tone === 'burned'
          ? 'border-rose-400/60 bg-gradient-to-b from-amber-100 to-rose-300'
          : 'border-indigo-800/60 bg-indigo-700';
        return (
          <div
            key={i}
            aria-hidden
            className="absolute"
            style={{ top: offset, left: offset, filter: `brightness(${1 - depth * 0.05})` }}
          >
            {layerCardEntry
              ? <CardFace card={layerCardEntry.card} jokerEffRank={layerCardEntry.effRank} />
              : <div className={`w-14 h-20 sm:w-16 sm:h-24 rounded-md border ${fallbackCls}`} />
            }
          </div>
        );
      })}
      <div className="absolute top-0 left-0">
        {count > 0
          ? (top ?? <CardFace hidden />)
          : <div className="w-14 h-20 sm:w-16 sm:h-24 rounded-md border-2 border-dashed border-gray-400 flex items-center justify-center text-[10px] text-gray-400">{emptyLabel ?? 'empty'}</div>}
      </div>
    </div>
  );
}

function CenterPiles({ deckCount, pile, burnedCount, lastBurnSize }: {
  deckCount: number; pile: PileEntry[]; burnedCount: number; lastBurnSize: number;
}) {
  const top = pile[pile.length - 1];

  // Trigger pile-to-burn animation each time burnedCount jumps.
  const [burnFlight, setBurnFlight] = useState<{ id: number; count: number } | null>(null);
  const prevBurned = useRef(burnedCount);
  useEffect(() => {
    if (burnedCount > prevBurned.current) {
      const id = Date.now();
      const count = Math.min(burnedCount - prevBurned.current, 8);
      setBurnFlight({ id, count });
      const t = setTimeout(() => setBurnFlight(f => (f?.id === id ? null : f)), 1400);
      prevBurned.current = burnedCount;
      return () => clearTimeout(t);
    }
    prevBurned.current = burnedCount;
  }, [burnedCount]);

  return (
    <div className="relative flex items-end gap-5 sm:gap-7 justify-center">
      <div className="flex flex-col items-center gap-1">
        <CardStack count={deckCount} />
        <span className="text-xs text-gray-600">deck: {deckCount}</span>
      </div>
      <div className="flex flex-col items-center gap-1 relative">
        <CardStack
          count={pile.length}
          layerCards={pile.slice(0, -1)}
          top={
            <AnimatePresence mode="popLayout">
              {top
                ? <AnimatedCard key={top.card.id} layoutId={top.card.id} card={top.card} jokerEffRank={top.effRank} />
                : null}
            </AnimatePresence>
          }
          emptyLabel="empty"
        />
        <span className="text-xs text-gray-600">pile: {pile.length}</span>

        {/* Cards flying from pile → burn pile (one per burn event) */}
        {burnFlight && Array.from({ length: burnFlight.count }).map((_, i) => (
          <motion.div
            key={`burnfly-${burnFlight.id}-${i}`}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
            animate={{
              x: 90,         // approx distance from pile to burn-pile center (gap-7 + card width)
              y: -10 + Math.random() * 20,
              opacity: 0,
              rotate: 360 + (Math.random() - 0.5) * 60,
              scale: 0.7,
            }}
            transition={{ duration: 0.7, delay: i * 0.05, ease: 'easeIn' }}
            className="absolute left-0 top-0 pointer-events-none"
          >
            <CardFace hidden />
          </motion.div>
        ))}
      </div>
      <div className="flex flex-col items-center gap-1 relative">
        <CardStack
          count={burnedCount}
          tone="burned"
          top={
            <div className="relative w-full h-full rounded-md border-2 border-dashed border-rose-400 bg-gradient-to-b from-amber-100 to-rose-200 flex flex-col items-center justify-center overflow-hidden">
              <div className="text-2xl">🔥</div>
              <div className="text-xs font-bold text-rose-800">{burnedCount}</div>
            </div>
          }
          emptyLabel="🔥 0"
        />
        {/* Burst + embers anchored to the stack region */}
        <div className="absolute inset-0 pointer-events-none flex items-start justify-center">
          <AnimatePresence>
            {lastBurnSize > 0 && (
              <motion.div
                key={`burst-${burnedCount}`}
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: [0, 1, 0], scale: [0.5, 1.6, 1.8] }}
                exit={{ opacity: 0 }}
                transition={{ duration: 1.2 }}
                className="text-3xl mt-4"
              >🔥</motion.div>
            )}
          </AnimatePresence>
          {lastBurnSize > 0 && Array.from({ length: Math.min(lastBurnSize, 8) }).map((_, i) => (
            <motion.div
              key={`ember-${burnedCount}-${i}`}
              initial={{ y: 30, x: (Math.random() - 0.5) * 30, opacity: 1, scale: 0.6 }}
              animate={{ y: -60, opacity: 0, scale: 1.2 }}
              transition={{ duration: 1.4 + Math.random() * 0.6, delay: i * 0.05 }}
              className="absolute left-1/2 bottom-2 -translate-x-1/2 text-base pointer-events-none"
            >✨</motion.div>
          ))}
        </div>
        <span className="text-xs text-rose-700 font-semibold">burned: {burnedCount}</span>
      </div>
    </div>
  );
}

/* ============== Game log (with ARIA live) ============== */

function GameLog({ log }: { log: string[] }) {
  return (
    <div className="hidden lg:block w-72 max-h-[80vh] overflow-y-auto border border-gray-300 rounded-lg p-3 bg-white/70 text-sm">
      <div className="font-semibold mb-2">Game log</div>
      <ul aria-live="polite" className="space-y-1">
        {log.slice().reverse().map((l, i) => (
          <li key={i} className="text-gray-700 leading-snug">• {l}</li>
        ))}
      </ul>
    </div>
  );
}

/* ============== Toasts ============== */

interface Toast { id: number; text: string; tone: 'reset' | 'burn' | 'skip' | 'reverse' | 'seven' | 'win' | 'info' }
const TONE_CLASSES: Record<Toast['tone'], string> = {
  reset: 'bg-sky-500',
  burn: 'bg-rose-600',
  skip: 'bg-amber-500',
  reverse: 'bg-violet-500',
  seven: 'bg-pink-500',
  win: 'bg-emerald-600',
  info: 'bg-gray-700',
};

function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: -20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className={`px-4 py-2 rounded-full text-white font-semibold shadow-lg ${TONE_CLASSES[t.tone]}`}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ============== Status bar ============== */

function StatusBar({ state, viewerId, isMyTurn }: { state: GameState; viewerId: number | null; isMyTurn: boolean }) {
  const p = state.players[state.current];
  const c = p ? colorFor(p.id) : null;
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3 px-3 py-2 bg-white/80 border border-gray-300 rounded-lg text-xs sm:text-sm">
      <span className="flex items-center gap-1.5">
        {c && <span className={`inline-block w-2 h-2 rounded-full ${c.dot}`} />}
        <strong>{p?.name}</strong>'s turn{isMyTurn && <span className="ml-1 text-emerald-700 font-semibold">(your move)</span>}
      </span>
      <span>{state.direction === 1 ? '↻' : '↺'}</span>
      {state.sevenRestriction && <span className="px-2 py-0.5 bg-rose-100 text-rose-700 rounded">7-or-lower</span>}
      {state.lastWasMine && <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded">bonus</span>}
    </div>
  );
}

/* ============== Volume / mute ============== */

function SoundControls({ muted, volume, setMuted, setVolume, aiSpeed, setAiSpeed }: {
  muted: boolean; volume: number; setMuted: (m: boolean) => void; setVolume: (v: number) => void;
  aiSpeed: number; setAiSpeed: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fixed top-3 right-3 z-50 flex items-end gap-2">
      {open && (
        <div className="bg-white/90 border border-gray-300 rounded-lg shadow p-3 flex flex-col gap-2 text-xs">
          <label className="flex items-center gap-2">
            <span className="w-16">Volume</span>
            <input
              type="range" min={0} max={1} step={0.05} value={volume}
              onChange={e => setVolume(parseFloat(e.target.value))}
              className="w-32"
              aria-label="Volume"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-16">AI speed</span>
            <input
              type="range" min={0.25} max={2} step={0.05} value={aiSpeed}
              onChange={e => setAiSpeed(parseFloat(e.target.value))}
              className="w-32"
              aria-label="AI speed"
            />
            <span className="tabular-nums w-10 text-right">{aiSpeed < 1 ? `${(1/aiSpeed).toFixed(1)}× fast` : aiSpeed > 1 ? `${aiSpeed.toFixed(1)}× slow` : '1×'}</span>
          </label>
        </div>
      )}
      <button
        onClick={() => setOpen(o => !o)}
        title="Settings"
        className="w-9 h-9 rounded-full bg-white/80 border border-gray-300 shadow text-base hover:bg-white"
      >⚙</button>
      <button
        onClick={() => setMuted(!muted)}
        title={muted ? 'Unmute' : 'Mute'}
        className="w-9 h-9 rounded-full bg-white/80 border border-gray-300 shadow text-base hover:bg-white"
      >{muted ? '🔇' : '🔊'}</button>
    </div>
  );
}

/* ============== Deal animation ============== */

function DealAnimation({ playerNames, onComplete }: { playerNames: string[]; onComplete: () => void }) {
  const n = playerNames.length;
  // Place players evenly around a "table" — start at the bottom (viewer-friendly).
  const radius = 220;
  const positions = useMemo(() => {
    const arr: { x: number; y: number; name: string; angle: number }[] = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + Math.PI / 2; // start at bottom
      arr.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, name: playerNames[i], angle });
    }
    return arr;
  }, [n, playerNames]);

  const SHUFFLE_MS = 1100;
  const PER_CARD_MS = 35;
  const CARDS_PER_PLAYER = 9;
  const dealStart = SHUFFLE_MS / 1000;
  const dealEnd = dealStart + (n * CARDS_PER_PLAYER * PER_CARD_MS) / 1000 + 0.5;

  useEffect(() => {
    const total = (dealEnd + 0.4) * 1000;
    const t = setTimeout(onComplete, total);
    return () => clearTimeout(t);
  }, [onComplete, dealEnd]);

  // Sound: a soft tick on each card landing.
  useEffect(() => {
    const timers: number[] = [];
    for (let p = 0; p < n; p++) {
      for (let c = 0; c < CARDS_PER_PLAYER; c++) {
        const delay = (dealStart + (p * CARDS_PER_PLAYER + c) * PER_CARD_MS / 1000) * 1000;
        timers.push(window.setTimeout(() => sfx.play('click'), delay));
      }
    }
    return () => timers.forEach(t => clearTimeout(t));
  }, [n]);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-40 flex items-center justify-center bg-stone-900/30 backdrop-blur-sm"
    >
      <div className="relative w-[600px] h-[520px] max-w-[95vw] max-h-[80vh]">
        {/* Player labels */}
        {positions.map((pos, i) => (
          <motion.div
            key={`label-${i}`}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
            className="absolute text-sm font-semibold text-white drop-shadow"
            style={{
              left: `calc(50% + ${pos.x}px)`,
              top: `calc(50% + ${pos.y * 1.15}px)`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <span className="px-2 py-0.5 bg-stone-800/80 rounded-full">{pos.name}</span>
          </motion.div>
        ))}

        {/* Shuffling deck (center) */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <motion.div
              key={`shuffle-${i}`}
              initial={{ rotate: 0, x: 0, y: 0 }}
              animate={{
                rotate: [0, (i % 2 === 0 ? 25 : -25), 0, (i % 2 === 0 ? -15 : 15), 0],
                x: [0, (i % 2 === 0 ? 30 : -30), 0, 0, 0],
                y: [0, -i * 1.5, -i * 1.5, -i * 1.5, -i * 1.5],
              }}
              transition={{ duration: SHUFFLE_MS / 1000, ease: 'easeInOut' }}
              className="absolute -translate-x-1/2 -translate-y-1/2"
            >
              <CardFace hidden />
            </motion.div>
          ))}
        </div>

        {/* Dealt cards flying from center to each player's stack */}
        {positions.flatMap((pos, p) =>
          Array.from({ length: CARDS_PER_PLAYER }).map((_, c) => {
            const row = Math.floor(c / 3); // 0 face-down, 1 face-up, 2 hand
            const col = c % 3;
            const slotX = pos.x + (col - 1) * 24;
            const slotY = pos.y + (row - 1) * 18;
            return (
              <motion.div
                key={`deal-${p}-${c}`}
                initial={{ x: 0, y: 0, scale: 1, opacity: 0, rotate: 0 }}
                animate={{ x: slotX, y: slotY, scale: 0.55, opacity: 1, rotate: pos.angle * (180 / Math.PI) + 90 }}
                transition={{
                  delay: dealStart + (p * CARDS_PER_PLAYER + c) * PER_CARD_MS / 1000,
                  duration: 0.45,
                  type: 'spring', stiffness: 220, damping: 22,
                }}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              >
                <CardFace hidden />
              </motion.div>
            );
          })
        )}

        {/* "Dealing…" caption */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: [0, 1, 1, 0], y: 0 }}
          transition={{ duration: dealEnd, times: [0, 0.05, 0.9, 1] }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white font-semibold text-lg drop-shadow"
        >
          Shuffling & dealing…
        </motion.div>
      </div>
    </motion.div>
  );
}

function useDealAnimationGate(state: GameState | null): { dealing: boolean; finishDeal: () => void } {
  const [dealing, setDealing] = useState(false);
  const prevPhase = useRef<string | null>(null);
  // Stable fingerprint per "fresh deal": face-down cards never change between deal and end-of-game,
  // so their first id distinguishes one game from the next without churning during swap.
  const dealtKey = useRef<string | null>(null);
  useEffect(() => {
    if (!state) {
      prevPhase.current = null;
      dealtKey.current = null;
      return;
    }
    const key = `${state.players.length}|${state.players[0]?.faceDown[0]?.id ?? ''}`;
    const enteringSwap = state.phase === 'swap' && prevPhase.current !== 'swap';
    const newGameKey = key !== dealtKey.current;
    if (state.phase === 'swap' && (enteringSwap || newGameKey)) {
      dealtKey.current = key;
      setDealing(true);
    }
    prevPhase.current = state.phase;
  }, [state]);
  return { dealing, finishDeal: () => setDealing(false) };
}

/* ============== Reveal-on-pickup overlay ============== */

const REVEAL_DURATION_MS = 3000;

function RevealOverlay({ playerName, card }: { playerName: string; card: Card }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.7, y: 30 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.7, y: 30 }}
      transition={{ type: 'spring', stiffness: 240, damping: 22 }}
      className="fixed inset-x-0 top-20 z-30 flex items-center justify-center pointer-events-none"
    >
      <div className="bg-stone-900/85 text-white rounded-xl px-5 py-3 shadow-xl flex items-center gap-3">
        <div className="text-sm">
          <div className="font-semibold">{playerName} picked up the pile</div>
          <div className="text-xs text-stone-300">Revealed card:</div>
        </div>
        <div className="scale-90"><CardFace card={card} /></div>
      </div>
    </motion.div>
  );
}

// Detect cards newly added to the viewer's hand specifically because the deck shrank
// (a refill draw). Computed during render so framer-motion's initial prop is correct on
// the very first mount of those new cards.
function useFromDeckTracker(state: GameState | null, viewerId: number): Set<string> {
  const prev = useRef<{ hand: Set<string>; deck: number }>({ hand: new Set(), deck: 0 });

  const fromDeck = useMemo<Set<string>>(() => {
    if (!state) return new Set();
    const player = state.players[viewerId];
    if (!player) return new Set();
    const curHand = new Set(player.hand.map(c => c.id));
    const newOnes = [...curHand].filter(id => !prev.current.hand.has(id));
    const drewFromDeck = state.deck.length < prev.current.deck;
    return drewFromDeck ? new Set(newOnes) : new Set();
  }, [state, viewerId]);

  useEffect(() => {
    if (!state) return;
    const player = state.players[viewerId];
    if (!player) {
      prev.current = { hand: new Set(), deck: state.deck.length };
      return;
    }
    prev.current = { hand: new Set(player.hand.map(c => c.id)), deck: state.deck.length };
  }, [state, viewerId]);

  return fromDeck;
}

function useRevealOverlay(state: GameState | null) {
  const [shown, setShown] = useState<{ name: string; card: Card; ts: number } | null>(null);
  useEffect(() => {
    if (!state?.revealedPickup) return;
    const r = state.revealedPickup;
    // Skip if we already displayed this exact reveal.
    if (shown?.ts === r.ts) return;
    setShown({ name: state.players[r.playerId]?.name ?? 'Player', card: r.card, ts: r.ts });
    const t = setTimeout(() => setShown(s => (s?.ts === r.ts ? null : s)), REVEAL_DURATION_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.revealedPickup?.ts]);
  return shown;
}

/* ============== Phase screens ============== */

function HowToPlay() {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full max-w-2xl">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-4 py-2 bg-white/80 border border-gray-300 rounded-lg font-semibold flex items-center justify-between hover:bg-white"
      >
        <span>📖 How to play</span>
        <span className="text-gray-500">{open ? '▲' : '▼'}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="p-4 mt-2 bg-white/90 border border-gray-300 rounded-lg text-sm text-gray-800 space-y-3">
              <div>
                <div className="font-bold text-base">🎯 Goal</div>
                <p>Be the first to get rid of all your cards. Last player still holding cards is the <strong>Poop Head 💩</strong>.</p>
              </div>

              <div>
                <div className="font-bold text-base">🃏 Setup</div>
                <p>Each player gets <strong>3 face-down</strong> cards (hidden, even from you), <strong>3 face-up</strong> cards on top of those, and <strong>3 cards in hand</strong>. The remaining cards form the draw deck.</p>
                <p>Before play, each player can swap any cards between their hand and face-up. Click one then the other to swap. Click <em>Mark ready</em> when done.</p>
                <p>The player with the lowest <strong>3</strong> in hand starts. If no 3, lowest 4, etc. Default direction is clockwise.</p>
              </div>

              <div>
                <div className="font-bold text-base">▶ Playing a turn</div>
                <p>Play a card <strong>equal to or higher</strong> than the top of the pile.</p>
                <p>Card order: <span className="font-mono text-xs">3 · 4 · 5 · 6 · 7 · 8 · 9 · J · Q · K · A</span></p>
                <p>You can play <strong>multiple cards of the same rank</strong> in one turn (e.g. two 7s).</p>
                <p>After your play, you refill your hand to 3 from the deck while the deck still has cards.</p>
              </div>

              <div>
                <div className="font-bold text-base">📥 Card source order</div>
                <p>You always play from your <strong>hand</strong> first. Once your hand <em>and</em> the deck are both empty, you start playing from your <strong>face-up</strong> cards. When face-up is empty, you play <strong>blind from face-down</strong> — you don't see the card before it lands. If it's illegal, you pick up the pile + that card.</p>
              </div>

              <div>
                <div className="font-bold text-base">📤 Picking up the pile</div>
                <p>If you can't (or don't want to) play, click <strong>Pick up pile</strong>. The pile cards join your hand, then you must <strong>reveal one card from your hand</strong> to the table. (The chosen card stays in your hand — only its identity becomes public.)</p>
                <p className="text-xs text-gray-600">If your hand was empty before the pickup (e.g. playing from face-up), there's nothing private to reveal and the turn just passes.</p>
              </div>

              <div>
                <div className="font-bold text-base">✨ Special cards</div>
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <li><strong className="text-sky-700">2</strong> — reset; next player can play anything</li>
                  <li><strong className="text-rose-700">10</strong> — burns the pile; turn passes to next player</li>
                  <li><strong className="text-amber-700">8</strong> — skip next player</li>
                  <li><strong className="text-violet-700">K</strong> — reverse direction</li>
                  <li><strong className="text-pink-700">7</strong> — next player must play <strong>≤ 7</strong> (2/10/Joker still allowed)</li>
                  <li><strong className="text-purple-700">Joker ★</strong> — copies the card directly below it (a 3 if the pile is empty)</li>
                </ul>
              </div>

              <div>
                <div className="font-bold text-base">🔥 Burns</div>
                <ul className="space-y-0.5 text-sm">
                  <li>• A <strong>10</strong> burns the pile. Turn passes to next player.</li>
                  <li>• <strong>4 of a kind in a row</strong> (across one or multiple turns) burns the pile. Player who placed the 4th card goes again.</li>
                  <li>• Burn check uses <em>actual</em> rank — a Joker copying a 7 does <strong>not</strong> count toward four 7s. Four real Jokers do burn.</li>
                  <li>• When a pile burns it goes to the burn pile (the 🔥 stack — you can see how many cards have been removed from play).</li>
                </ul>
              </div>

              <div>
                <div className="font-bold text-base">🏁 Winning</div>
                <p>Clear all your cards (hand → face-up → face-down). Each player who finishes is "out". Last player still holding cards is the <strong>Poop Head</strong>.</p>
              </div>

              <div>
                <div className="font-bold text-base">⌨ Keyboard</div>
                <p><span className="font-mono text-xs">1–9</span> select cards · <span className="font-mono text-xs">Enter</span> play selected · <span className="font-mono text-xs">P</span> pick up pile</p>
              </div>

              <div className="border-t pt-3">
                <div className="font-bold text-base text-fuchsia-700">⚡ Ultimate mode (auto at 4+ players)</div>
                <p>Two decks shuffled together — <strong>108 cards, 4 jokers</strong>. New rule: <strong>Cutting</strong>.</p>
                <p>If you hold the <strong>exact same card</strong> (rank <em>and</em> suit) as the top of the pile, you can play it <em>out of turn</em>. A flashing pink <strong>✂ CUT!</strong> button appears whenever you have a match. Cuts are from <strong>hand only</strong>.</p>
                <ul className="space-y-0.5 text-sm">
                  <li>• A Joker on top resolves to the underlying card — so a Joker copying 3♥ can be cut by a 3♥.</li>
                  <li>• The player who was about to play gets <strong>skipped</strong>; play continues from the cutter.</li>
                  <li>• <strong>First message to the server wins</strong> if multiple players race to cut.</li>
                  <li>• Cuts count toward <strong>4-of-a-kind</strong> burns (by actual rank).</li>
                  <li>• A <strong>King played as a cut does NOT reverse direction</strong> — direction is preserved.</li>
                  <li>• Other special-card effects (8 skip, 7 lock, 2 reset) still apply normally on a cut.</li>
                  <li>• You can cut your own play if you somehow have a duplicate, though playing both at once is usually better.</li>
                </ul>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuScreen({ onLocal, onNetwork, prefilledCode }: { onLocal: () => void; onNetwork: (code?: string) => void; prefilledCode?: string }) {
  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-5 p-6">
      <h1 className="text-4xl sm:text-5xl font-black tracking-tight">💩 Poop Head</h1>
      <p className="max-w-xl text-center text-gray-700 text-sm sm:text-base">
        A shedding card game. Get rid of all your cards. Last one holding cards is the Poop Head.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <button onClick={onLocal} className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow">
          Local play (with AI option)
        </button>
        <button onClick={() => onNetwork(prefilledCode)} className="px-6 py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-lg shadow">
          {prefilledCode ? `Join room ${prefilledCode}` : 'Online multiplayer'}
        </button>
      </div>
      <HowToPlay />
    </div>
  );
}

function LocalSetupScreen({ onStart, onBack }: { onStart: (humans: number, ais: number) => void; onBack: () => void }) {
  const [humans, setHumans] = useState(1);
  const [ais, setAis] = useState(2);
  const total = humans + ais;
  const valid = humans >= 1 && total >= MIN_PLAYERS && total <= MAX_PLAYERS;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 p-6">
      <h2 className="text-3xl font-bold">Local game setup</h2>
      <div className="flex flex-col gap-4 bg-white/70 p-6 rounded-lg border border-gray-300 w-80">
        <label className="flex items-center justify-between">
          <span>Humans (hot-seat)</span>
          <input type="number" min={1} max={MAX_PLAYERS} value={humans}
            onChange={e => setHumans(Math.max(1, Math.min(MAX_PLAYERS, +e.target.value || 1)))}
            className="w-16 px-2 py-1 border rounded text-center" />
        </label>
        <label className="flex items-center justify-between">
          <span>AI opponents</span>
          <input type="number" min={0} max={MAX_PLAYERS - 1} value={ais}
            onChange={e => setAis(Math.max(0, Math.min(MAX_PLAYERS - 1, +e.target.value || 0)))}
            className="w-16 px-2 py-1 border rounded text-center" />
        </label>
        <div className={`text-sm ${valid ? 'text-gray-600' : 'text-rose-600'}`}>
          Total: {total} {valid ? '' : `(must be ${MIN_PLAYERS}–${MAX_PLAYERS}, with at least 1 human)`}
        </div>
      </div>
      <div className="flex gap-3">
        <button onClick={onBack} className="px-4 py-2 border border-gray-300 rounded">Back</button>
        <button
          disabled={!valid}
          onClick={() => onStart(humans, ais)}
          className={`px-6 py-2 rounded font-bold ${valid ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
        >Start</button>
      </div>
    </div>
  );
}

function SwapScreen({ state, dispatch, viewerId }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
}) {
  const allReady = state.swapReady.every(Boolean);
  const isNetwork = viewerId !== null && viewerId !== -1;
  return (
    <div className="p-3 sm:p-4 flex flex-col gap-4">
      <h2 className="text-xl sm:text-2xl font-bold">Swap phase</h2>
      <p className="text-xs sm:text-sm text-gray-600">
        Click a hand card, then a face-up card (or vice versa) to swap. Click <em>Ready</em> when done.
        {isNetwork ? ' Each player swaps independently.' : ' Pass the device between players.'}
      </p>
      <div className="grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {state.players.map((p, i) => {
          const editable = isNetwork ? viewerId === i : !p.isAi;
          const sel = state.swapSelected[i] ?? null;
          const ready = state.swapReady[i];
          const c = colorFor(i);
          return (
            <div key={p.id} className={`border-2 rounded-lg p-3 flex flex-col gap-2 ${editable ? `bg-white/70 ${c.border}` : 'bg-white/40 border-gray-300'}`}>
              <div className="font-semibold flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-full ${c.dot}`} />
                {p.name}
                {p.isAi && <span className="text-[10px] px-1 py-0.5 bg-gray-200 rounded">AI</span>}
                {viewerId === i && <span className="text-xs text-emerald-700">(you)</span>}
              </div>
              <div className="text-xs text-gray-500">Face-up</div>
              <div className="flex gap-1 flex-wrap">
                {p.faceUp.map(card => (
                  <CardFace key={card.id} card={card} small
                    selected={sel?.source === 'faceUp' && sel.id === card.id && !ready}
                    dim={ready || !editable}
                    onClick={editable && !ready ? () => dispatch({ type: 'SWAP_PICK', player: i, source: 'faceUp', id: card.id }) : undefined}
                  />
                ))}
              </div>
              <div className="text-xs text-gray-500">Hand</div>
              <div className="flex gap-1 flex-wrap">
                {p.hand.map(card => (
                  <CardFace key={card.id} card={card} small
                    hidden={isNetwork && viewerId !== i}
                    selected={sel?.source === 'hand' && sel.id === card.id && !ready}
                    dim={ready || !editable}
                    onClick={editable && !ready ? () => dispatch({ type: 'SWAP_PICK', player: i, source: 'hand', id: card.id }) : undefined}
                  />
                ))}
              </div>
              <button
                disabled={!editable}
                onClick={() => dispatch({ type: 'SWAP_READY', player: i })}
                className={`mt-1 px-3 py-1 rounded text-sm font-semibold ${ready ? 'bg-emerald-500 text-white' : 'bg-gray-200'} ${editable ? '' : 'opacity-50 cursor-not-allowed'}`}
              >{ready ? 'Ready ✓' : 'Mark ready'}</button>
            </div>
          );
        })}
      </div>
      <div>
        <button
          disabled={!allReady}
          onClick={() => dispatch({ type: 'BEGIN_PLAY' })}
          className={`px-5 py-2 rounded-lg font-bold ${allReady ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
        >Start game</button>
      </div>
    </div>
  );
}

function PassScreen({ state, dispatch }: { state: GameState; dispatch: (a: Action) => void }) {
  const p = state.players[state.current];
  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 p-6">
      <h2 className="text-3xl font-bold">Pass the device to {p.name}</h2>
      <p className="text-gray-700">The previous player's hand is hidden.</p>
      <button onClick={() => dispatch({ type: 'ACK_PASS' })} className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow">
        Start {p.name}'s turn
      </button>
    </div>
  );
}

function sortCards(cards: Card[]): Card[] {
  return cards.slice().sort((a, b) => RANK_VALUE[a.rank] - RANK_VALUE[b.rank] || a.suit.localeCompare(b.suit));
}

function PlayScreen({ state, dispatch, viewerId, emotes, onEmote, fromDeckIds }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
  emotes?: { id: string; playerId: number; emoji: string }[]; onEmote?: (e: string) => void;
  fromDeckIds?: Set<string>;
}) {
  const isSpectator = viewerId === -1;
  const viewer = isSpectator ? state.current : (viewerId ?? state.current);
  const isMyTurn = !isSpectator && viewer === state.current && !state.players[viewer]?.isAi;
  const me = state.players[viewer];
  const src = me ? activeSource(me, state.deck.length === 0) : null;
  const [sortOn, setSortOn] = useState(true);

  // Ultimate mode: viewer can cut if they have cards matching the top of the pile.
  const myCutMatches = !isSpectator && state.mode === 'ultimate' && me ? cutMatches(state, viewer) : [];
  const canCut = myCutMatches.length > 0 && !isMyTurn; // cutting your own play is allowed but redundant — only show on others' turns

  const sourceCards = me && src ? cardsFromSource(me, src) : [];
  const displayCards = sortOn ? sortCards(sourceCards) : sourceCards;
  const selectedCards = sourceCards.filter(c => state.selected.includes(c.id));
  const canPlay = isMyTurn && selectedCards.length > 0 && canPlayCards(selectedCards, state.pile, state.sevenRestriction);
  const anyLegal = sourceCards.some(c => canPlayCards([c], state.pile, state.sevenRestriction));

  // Keyboard shortcuts: 1-9 to toggle nth card, Enter to play, P to pickup.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!isMyTurn) return;
      if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        const card = displayCards[idx];
        if (card && src !== 'faceDown') {
          dispatch({ type: 'TOGGLE_SELECT', id: card.id });
          e.preventDefault();
        }
      } else if (e.key === 'Enter' && canPlay) {
        dispatch({ type: 'PLAY_SELECTED' });
        e.preventDefault();
      } else if ((e.key === 'p' || e.key === 'P') && state.pile.length > 0 && src !== 'faceDown') {
        dispatch({ type: 'PICKUP_PILE' });
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMyTurn, canPlay, displayCards, src, state.pile.length, dispatch]);

  return (
    <LayoutGroup>
      <div className="flex flex-col lg:flex-row h-full">
        <div className="flex-1 p-3 sm:p-4 pt-14 sm:pt-14 flex flex-col gap-3 sm:gap-4 min-w-0">
          <StatusBar state={state} viewerId={viewerId} isMyTurn={isMyTurn} />
          <div className="grid gap-2 sm:gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {state.players.map((pp, i) => (
              <PlayerArea
                key={pp.id} player={pp}
                isCurrent={i === state.current}
                isViewer={i === viewer && !isSpectator}
                faceDownClickable={isMyTurn && i === state.current && src === 'faceDown'}
                onFaceDownClick={(id) => dispatch({ type: 'FLIP_FACEDOWN', id })}
                emotes={emotes}
              />
            ))}
          </div>
          <div className="my-2"><CenterPiles deckCount={state.deck.length} pile={state.pile} burnedCount={state.burnedCount} lastBurnSize={state.lastBurnSize} /></div>

          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs sm:text-sm text-gray-600">
                {isSpectator && <>Spectating — {state.players[state.current]?.name}'s turn</>}
                {!isSpectator && !isMyTurn && <>Waiting for {state.players[state.current].name}…</>}
                {isMyTurn && src === 'hand' && <>Your hand: <span className="text-gray-400">(1-9 to select, Enter play, P pickup)</span></>}
                {isMyTurn && src === 'faceUp' && <>Hand & deck empty — playing from face-up.</>}
                {isMyTurn && src === 'faceDown' && <>Pick a face-down card to flip.</>}
              </div>
              <button
                onClick={() => setSortOn(s => !s)}
                className="text-xs px-2 py-1 border border-gray-300 rounded bg-white/70"
              >{sortOn ? 'Unsorted' : 'Sort'}</button>
            </div>
            {/* Face-down phase: render the player's face-down cards here as the primary interaction surface. */}
            {isMyTurn && src === 'faceDown' && me && (
              <div className="flex gap-3 flex-wrap items-center">
                {me.faceDown.map(c => (
                  <motion.div
                    key={c.id}
                    whileHover={{ scale: 1.08, y: -4 }}
                    whileTap={{ scale: 0.95 }}
                  >
                    <CardFace hidden onClick={() => dispatch({ type: 'FLIP_FACEDOWN', id: c.id })} />
                  </motion.div>
                ))}
                <span className="text-xs text-gray-600 italic">Tap one to flip blind.</span>
              </div>
            )}
            {src && src !== 'faceDown' && (
              <div className="flex gap-2 flex-wrap">
                <LayoutGroup>
                  {displayCards.map(c => {
                    const wouldBeOk = isMyTurn ? canPlayCards([c], state.pile, state.sevenRestriction) : true;
                    return (
                      <AnimatedCard
                        key={c.id} layoutId={c.id} card={c}
                        fromDeck={fromDeckIds?.has(c.id)}
                        selected={state.selected.includes(c.id)}
                        dim={isMyTurn && !wouldBeOk && state.selected.length === 0}
                        onClick={isMyTurn ? () => dispatch({ type: 'TOGGLE_SELECT', id: c.id }) : undefined}
                      />
                    );
                  })}
                </LayoutGroup>
              </div>
            )}
            <div className="mt-3 flex gap-2 items-center flex-wrap">
              <button
                disabled={!canPlay}
                onClick={() => dispatch({ type: 'PLAY_SELECTED' })}
                className={`px-4 py-2 rounded font-semibold ${canPlay ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
              >Play selected</button>
              <button
                disabled={!isMyTurn || state.pile.length === 0 || src === 'faceDown'}
                onClick={() => dispatch({ type: 'PICKUP_PILE' })}
                className={`px-4 py-2 rounded font-semibold ${isMyTurn && state.pile.length > 0 && src !== 'faceDown' ? 'bg-rose-500 hover:bg-rose-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
              >Pick up pile</button>
              {isMyTurn && !anyLegal && src && src !== 'faceDown' && (
                <span className="text-xs text-rose-700">No legal play — pick up.</span>
              )}
              {canCut && (
                <motion.button
                  initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                  whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                  onClick={() => dispatch({ type: 'CUT', player: viewer, ids: myCutMatches.map(c => c.id) })}
                  className="px-4 py-2 rounded font-bold bg-fuchsia-600 hover:bg-fuchsia-700 text-white shadow-lg animate-pulse"
                  title={`Cut with ${myCutMatches.map(c => c.rank + c.suit).join(', ')}`}
                >✂ CUT! ({myCutMatches.length})</motion.button>
              )}
            </div>
          </div>

          {onEmote && !isSpectator && (
            <EmoteBar onEmote={onEmote} />
          )}
        </div>
        <GameLog log={state.log} />
      </div>
    </LayoutGroup>
  );
}

function EmoteBar({ onEmote }: { onEmote: (e: string) => void }) {
  const emotes = ['👍', '😂', '💩', '🔥', '😱'];
  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 flex gap-1 bg-white/80 border border-gray-300 rounded-full px-2 py-1 shadow z-30">
      {emotes.map(e => (
        <button key={e} onClick={() => onEmote(e)} className="text-xl hover:scale-125 transition-transform px-1" aria-label={`emote ${e}`}>{e}</button>
      ))}
    </div>
  );
}

function RevealChoiceScreen({ state, dispatch, viewerId }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
}) {
  const rawCards = state.pendingReveal?.cards ?? [];
  const picker = state.players[state.current];
  const isMyChoice = viewerId === null
    ? !picker?.isAi
    : (viewerId === state.current && !picker?.isAi);
  // Picker sees real cards (sorted for scanning); everyone else sees card backs only —
  // these are private hand cards.
  const cards = isMyChoice ? sortCards(rawCards) : rawCards;
  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-5 p-6 bg-gradient-to-b from-amber-100/60 to-rose-100/60">
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 240 }}
        className="flex flex-col items-center gap-2"
      >
        <div className="text-4xl">🃏</div>
        <h2 className="text-2xl sm:text-4xl font-black text-center">
          {picker?.name} picked up the pile
        </h2>
        {isMyChoice ? (
          <p className="text-base sm:text-lg text-amber-900 font-semibold text-center max-w-xl">
            👇 Reveal one card from <span className="underline">your hand</span> to the table. The picked-up cards have already joined your hand.
          </p>
        ) : (
          <p className="text-base text-gray-700 text-center">Waiting for {picker?.name} to reveal a hand card…</p>
        )}
      </motion.div>

      <div className="flex flex-wrap gap-3 justify-center max-w-5xl px-4 py-6 bg-white/60 rounded-2xl border border-amber-300 shadow-inner">
        {cards.map(card => (
          <motion.button
            key={card.id}
            type="button"
            onClick={isMyChoice ? () => dispatch({ type: 'REVEAL_CHOICE', id: card.id }) : undefined}
            disabled={!isMyChoice}
            whileHover={isMyChoice ? { scale: 1.15, y: -10 } : undefined}
            whileTap={isMyChoice ? { scale: 0.95 } : undefined}
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 22 }}
            className={`bg-transparent border-0 p-0 ${isMyChoice ? 'cursor-pointer' : 'cursor-default'}`}
            aria-label={isMyChoice ? `Reveal ${card.rank}${card.suit}` : 'hidden hand card'}
          >
            <div className={isMyChoice ? 'ring-2 ring-amber-400 rounded-md transition-shadow hover:shadow-2xl hover:ring-4 hover:ring-amber-500' : 'opacity-80'}>
              <CardFace card={isMyChoice ? card : undefined} hidden={!isMyChoice} />
            </div>
          </motion.button>
        ))}
      </div>

      {isMyChoice && (
        <div className="text-xs text-gray-600 italic">Tap a card from your hand to reveal it.</div>
      )}
      {!isMyChoice && picker?.isAi && (
        <div className="text-sm text-gray-600 italic flex items-center gap-2">
          <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.4 }}>•••</motion.span>
          AI is choosing…
        </div>
      )}
    </div>
  );
}

function FlipScreen({ state, dispatch, viewerId }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
}) {
  const card = state.flippedCard!;
  const legal = canPlayCards([card], state.pile, state.sevenRestriction);
  const myAction = viewerId === null || (viewerId === state.current && !state.players[state.current]?.isAi);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <h2 className="text-2xl font-bold">Face-down flip — {state.players[state.current].name}</h2>
      <motion.div initial={{ rotateY: 180, scale: 0.7 }} animate={{ rotateY: 0, scale: 1 }} transition={{ duration: 0.5 }}>
        <CardFace card={card} />
      </motion.div>
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

  // "Awards": who topped each metric (only awarded if positive).
  const winnerOf = (key: keyof PlayerStats): number | null => {
    let best: number | null = null;
    let bestVal = 0;
    for (const p of state.players) {
      const v = state.stats[p.id]?.[key] ?? 0;
      if (v > bestVal) { bestVal = v; best = p.id; }
    }
    return bestVal > 0 ? best : null;
  };
  const ultimate = state.mode === 'ultimate';
  const awards: { label: string; emoji: string; key: keyof PlayerStats }[] = [
    { label: 'Most pickups', emoji: '📥', key: 'pickups' },
    { label: 'Most cards played', emoji: '🃏', key: 'cardsPlayed' },
    { label: 'Most power cards', emoji: '⚡', key: 'powerCards' },
    { label: 'Most burns triggered', emoji: '🔥', key: 'burns' },
    ...(ultimate ? [{ label: 'Most cuts', emoji: '✂', key: 'cuts' as keyof PlayerStats }] : []),
  ];

  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-5 p-6 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        {Array.from({ length: 24 }).map((_, i) => (
          <motion.div
            key={i}
            initial={{ y: -50, x: Math.random() * window.innerWidth, opacity: 0, rotate: 0 }}
            animate={{ y: window.innerHeight + 50, opacity: [0, 1, 1, 0], rotate: 360 }}
            transition={{ duration: 3 + Math.random() * 2, delay: Math.random() * 1.5, repeat: Infinity, repeatDelay: 1 }}
            className="absolute text-3xl"
          >💩</motion.div>
        ))}
      </div>

      <motion.h1
        initial={{ scale: 0, rotate: -10 }} animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 200 }}
        className="text-3xl sm:text-5xl font-black text-center px-4 z-10"
      >💩 {loser?.name} is the Poop Head!</motion.h1>

      <ol className="bg-white/90 p-4 rounded-lg border border-gray-300 z-10 min-w-[260px]">
        {order.map(p => <li key={p.id} className="flex items-center gap-2"><span className={`inline-block w-2 h-2 rounded-full ${colorFor(p.id).dot}`} />#{p.finishPos} — {p.name}</li>)}
        <li className="text-rose-700 font-semibold flex items-center gap-2"><span className={`inline-block w-2 h-2 rounded-full ${colorFor(loser?.id ?? 0).dot}`} />#{state.players.length} (Poop Head) — {loser?.name}</li>
      </ol>

      {/* Awards row */}
      <div className="bg-white/90 p-4 rounded-lg border border-gray-300 z-10 max-w-2xl w-full">
        <div className="font-bold text-base mb-2">🏆 Awards</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {awards.map(a => {
            const winner = winnerOf(a.key);
            const val = winner !== null ? state.stats[winner]?.[a.key] ?? 0 : 0;
            return (
              <div key={a.key} className="flex items-center justify-between text-sm border border-gray-200 rounded px-2 py-1.5">
                <span className="flex items-center gap-1.5">
                  <span className="text-base">{a.emoji}</span>
                  <span>{a.label}</span>
                </span>
                <span className="font-semibold text-gray-700">
                  {winner !== null
                    ? <>{state.players[winner].name} <span className="text-gray-500">({val})</span></>
                    : <span className="text-gray-400">—</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-player breakdown */}
      <div className="bg-white/90 p-3 rounded-lg border border-gray-300 z-10 max-w-2xl w-full overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 uppercase border-b border-gray-200">
              <th className="text-left p-1">Player</th>
              <th className="p-1">📥 Pick</th>
              <th className="p-1">🃏 Played</th>
              <th className="p-1">⚡ Power</th>
              <th className="p-1">🔥 Burns</th>
              {ultimate && <th className="p-1">✂ Cuts</th>}
            </tr>
          </thead>
          <tbody>
            {state.players.map(p => {
              const s = state.stats[p.id] ?? { pickups: 0, cardsPlayed: 0, powerCards: 0, burns: 0, cuts: 0 };
              return (
                <tr key={p.id} className="border-b border-gray-100 last:border-b-0">
                  <td className="p-1 flex items-center gap-1.5">
                    <span className={`inline-block w-2 h-2 rounded-full ${colorFor(p.id).dot}`} />
                    {p.name}{p.isAi && <span className="text-[10px] text-gray-500">AI</span>}
                  </td>
                  <td className="p-1 text-center tabular-nums">{s.pickups}</td>
                  <td className="p-1 text-center tabular-nums">{s.cardsPlayed}</td>
                  <td className="p-1 text-center tabular-nums">{s.powerCards}</td>
                  <td className="p-1 text-center tabular-nums">{s.burns}</td>
                  {ultimate && <td className="p-1 text-center tabular-nums">{s.cuts}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <button onClick={onPlayAgain} className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow z-10">
        Play again
      </button>
    </div>
  );
}

/* ============== Network lobby ============== */

function NetLobbyScreen({ conn, onLeave, prefilledCode }: { conn: NetworkConn; onLeave: () => void; prefilledCode?: string }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState(prefilledCode?.toUpperCase() ?? '');
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  // Poll the public room list every 5s while we're still in the lobby form.
  useEffect(() => {
    if (conn.status !== 'open' || conn.lobby) return;
    conn.send({ t: 'LIST_ROOMS' });
    const t = setInterval(() => conn.send({ t: 'LIST_ROOMS' }), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.status, conn.lobby]);

  if (!conn.lobby) {
    const nameTrim = name.trim();
    const codeTrim = code.trim();
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-6">
        <h2 className="text-3xl font-bold">Online multiplayer</h2>
        {conn.status === 'connecting' && <div className="text-gray-600">Connecting…</div>}
        {conn.status === 'error' && <div className="text-rose-700 text-sm max-w-md text-center">{conn.error ?? 'Connection failed.'} Make sure the server is running.</div>}
        {conn.status === 'open' && (
          <div className="flex flex-col gap-3 w-80">
            {/* Public room list */}
            {conn.rooms.length > 0 && (
              <div className="border border-gray-300 rounded bg-white/80">
                <div className="px-3 py-2 text-xs font-semibold text-gray-700 border-b border-gray-200 flex items-center justify-between">
                  <span>🟢 Live games ({conn.rooms.length})</span>
                  <button
                    onClick={() => conn.send({ t: 'LIST_ROOMS' })}
                    className="text-gray-500 hover:text-gray-800" title="Refresh"
                  >↻</button>
                </div>
                <ul className="max-h-48 overflow-y-auto divide-y divide-gray-100">
                  {conn.rooms.map(r => {
                    const selected = pendingCode === r.code;
                    return (
                      <li key={r.code}>
                        <button
                          onClick={() => setPendingCode(selected ? null : r.code)}
                          className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between ${selected ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}
                        >
                          <span className="flex flex-col">
                            <span className="font-semibold">{r.host}'s game</span>
                            <span className="text-xs text-gray-500">
                              {r.playerCount}/{r.maxPlayers} players · {r.started ? 'in progress' : 'lobby'}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5">
                            {r.started && r.connectedHumans === 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">paused</span>
                            )}
                            <span className={`text-xs ${r.started ? 'text-rose-600' : 'text-emerald-600'}`}>
                              {r.started ? 'spectate' : 'join'}
                            </span>
                          </span>
                        </button>
                        {selected && (
                          <div className="px-3 pb-3 pt-1 bg-indigo-50/60 flex flex-col gap-2">
                            <div className="text-xs text-gray-700">Enter the room code to {r.started ? 'spectate' : 'join'} {r.host}'s game:</div>
                            <input
                              autoFocus
                              value={code}
                              onChange={e => setCode(e.target.value.toUpperCase())}
                              placeholder="Room code"
                              maxLength={4}
                              className="px-2 py-1 border border-gray-300 rounded uppercase tracking-widest text-center text-sm"
                            />
                            {!r.started && (
                              <button
                                disabled={!nameTrim || codeTrim !== r.code}
                                onClick={() => conn.send({ t: 'JOIN', code: codeTrim, name: nameTrim })}
                                className={`px-3 py-1.5 rounded text-sm font-semibold ${nameTrim && codeTrim === r.code ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
                              >Join {r.host}'s game</button>
                            )}
                            {r.started && (
                              <button
                                disabled={codeTrim !== r.code}
                                onClick={() => conn.send({ t: 'SPECTATE', code: codeTrim })}
                                className={`px-3 py-1.5 rounded text-sm font-semibold ${codeTrim === r.code ? 'bg-gray-700 hover:bg-gray-800 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
                              >Spectate</button>
                            )}
                            {codeTrim.length > 0 && codeTrim !== r.code && (
                              <div className="text-xs text-rose-700">Code doesn't match.</div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name"
              className="px-3 py-2 border border-gray-300 rounded" />
            <button
              disabled={!nameTrim}
              onClick={() => conn.send({ t: 'CREATE', name: nameTrim })}
              className={`px-4 py-2 rounded font-semibold ${nameTrim ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
            >Create room</button>
            <div className="text-center text-xs text-gray-500">— or —</div>
            <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Room code"
              className="px-3 py-2 border border-gray-300 rounded uppercase tracking-widest text-center" maxLength={4} />
            <div className="grid grid-cols-2 gap-2">
              <button
                disabled={!nameTrim || codeTrim.length !== 4}
                onClick={() => conn.send({ t: 'JOIN', code: codeTrim, name: nameTrim })}
                className={`px-4 py-2 rounded font-semibold ${nameTrim && codeTrim.length === 4 ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
              >Join</button>
              <button
                disabled={codeTrim.length !== 4}
                onClick={() => conn.send({ t: 'SPECTATE', code: codeTrim })}
                className={`px-4 py-2 rounded font-semibold ${codeTrim.length === 4 ? 'bg-gray-700 hover:bg-gray-800 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
              >Spectate</button>
            </div>
            {!nameTrim && <div className="text-xs text-gray-500 text-center">Enter your name first.</div>}
            {nameTrim && codeTrim.length > 0 && codeTrim.length !== 4 && <div className="text-xs text-gray-500 text-center">Room code must be 4 characters.</div>}
            {conn.error && (
              <div className="text-sm text-rose-700 text-center bg-rose-50 border border-rose-200 rounded px-3 py-2">{conn.error}</div>
            )}
          </div>
        )}
        <button onClick={onLeave} className="text-sm text-gray-600 underline">Back</button>
      </div>
    );
  }

  const isHost = conn.lobby.myId === conn.lobby.hostId;
  const enough = conn.lobby.players.length >= MIN_PLAYERS;
  const shareUrl = `${location.origin}${location.pathname}?room=${conn.lobby.code}`;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-6">
      <h2 className="text-3xl font-bold">Room {conn.lobby.code}</h2>
      <button
        onClick={() => navigator.clipboard?.writeText(shareUrl)}
        className="text-xs px-3 py-1 bg-white/80 border border-gray-300 rounded hover:bg-white"
        title={shareUrl}
      >Copy invite link</button>
      <div className="text-sm text-gray-600">{MIN_PLAYERS}–{MAX_PLAYERS} players</div>
      <ul className="bg-white/80 p-4 rounded-lg border border-gray-300 w-80">
        {conn.lobby.players.map(p => {
          const c = colorFor(p.id);
          return (
            <li key={p.id} className="flex justify-between py-1 items-center">
              <span className="flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-full ${c.dot}`} />
                {p.name}
                {p.isAi && <span className="ml-1 text-[10px] px-1 py-0.5 bg-gray-200 rounded">AI</span>}
                {p.id === conn.lobby!.hostId && <span className="ml-1 text-xs text-amber-700">host</span>}
                {p.id === conn.lobby!.myId && <span className="ml-1 text-xs text-emerald-700">(you)</span>}
              </span>
              <span className={`text-xs ${p.connected ? 'text-emerald-700' : 'text-rose-700'}`}>
                {p.connected ? '●' : '○'}
              </span>
            </li>
          );
        })}
      </ul>
      {isHost && (
        <div className="flex gap-2">
          <button onClick={() => conn.send({ t: 'ADD_AI' })} disabled={conn.lobby.players.length >= MAX_PLAYERS}
            className="px-3 py-1 text-sm bg-white/80 border border-gray-300 rounded disabled:opacity-50">+ AI</button>
          <button onClick={() => conn.send({ t: 'REMOVE_AI' })} disabled={!conn.lobby.players.some(p => p.isAi)}
            className="px-3 py-1 text-sm bg-white/80 border border-gray-300 rounded disabled:opacity-50">– AI</button>
        </div>
      )}
      {isHost ? (
        <button
          disabled={!enough}
          onClick={() => conn.send({ t: 'START' })}
          className={`px-6 py-3 rounded-lg font-bold shadow ${enough ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
        >Start game ({conn.lobby.players.length})</button>
      ) : (
        <div className="text-gray-600">Waiting for host to start…</div>
      )}
      <div className="flex gap-4 items-center">
        <button onClick={onLeave} className="text-sm text-gray-600 underline">Leave room</button>
        {isHost && (
          <button
            onClick={() => {
              if (window.confirm('Delete this room? Everyone connected will be disconnected.')) {
                conn.send({ t: 'DELETE_ROOM' });
              }
            }}
            className="text-sm text-rose-700 underline"
          >Delete room</button>
        )}
      </div>
      {conn.error && <div className="text-rose-700 text-sm">{conn.error}</div>}
    </div>
  );
}

/* ============== Sound + toast bindings ============== */

function useEventEffects(log: string[], resetKey: any): { toasts: Toast[] } {
  const lastLen = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idCounter = useRef(0);

  useEffect(() => { lastLen.current = 0; setToasts([]); }, [resetKey]);

  useEffect(() => {
    const newLines = log.slice(lastLen.current);
    lastLen.current = log.length;
    const adds: Toast[] = [];
    for (const line of newLines) {
      if (/Pile burned by 10/i.test(line)) { sfx.play('burn'); adds.push({ id: ++idCounter.current, text: '🔥 Pile burned!', tone: 'burn' }); }
      else if (/Four of a kind/i.test(line)) { sfx.play('burn'); adds.push({ id: ++idCounter.current, text: '🔥 Four of a kind!', tone: 'burn' }); }
      else if (/picked up the pile/i.test(line)) sfx.play('pickup');
      else if (/pile reset/i.test(line)) { sfx.play('reset'); adds.push({ id: ++idCounter.current, text: '🔄 Pile reset', tone: 'reset' }); }
      else if (/direction reversed/i.test(line)) { sfx.play('reverse'); adds.push({ id: ++idCounter.current, text: '↺ Reverse!', tone: 'reverse' }); }
      else if (/skipped/i.test(line)) { sfx.play('skip'); adds.push({ id: ++idCounter.current, text: '⏭ Skip!', tone: 'skip' }); }
      else if (/7-or-lower/i.test(line)) { sfx.play('seven'); adds.push({ id: ++idCounter.current, text: '7-or-lower lock', tone: 'seven' }); }
      else if (/POOP HEAD/i.test(line)) { adds.push({ id: ++idCounter.current, text: '🏆 Game over!', tone: 'win' }); /* end-game sound is dispatched by Local/NetworkGame so the loser specifically hears the loss sample */ }
      else if (/CUT with/i.test(line)) { sfx.playSample(SFX_OBJECTION); adds.push({ id: ++idCounter.current, text: '✂ CUT!', tone: 'reverse' }); }
      // Failed face-down flip — sad fahhhh sound for the bust.
      else if (/illegal! Picking up|illegal! Picks up/i.test(line)) sfx.playSample(SFX_FAHHHH);
      else if (/^.* played /i.test(line) || /flipped face-down/i.test(line)) sfx.play('play');
    }
    if (adds.length) {
      setToasts(t => [...t, ...adds]);
      const ids = adds.map(a => a.id);
      setTimeout(() => setToasts(t => t.filter(x => !ids.includes(x.id))), 2500);
    }
  }, [log]);

  return { toasts };
}

/* ============== Local-mode App ============== */

function LocalCutPromptScreen({ state, playerId, matches, onCut, onSkip }: {
  state: GameState; playerId: number; matches: Card[];
  onCut: () => void; onSkip: () => void;
}) {
  const p = state.players[playerId];
  const c = colorFor(p.id);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-5 p-6">
      <h2 className="text-2xl sm:text-3xl font-bold text-center">
        ✂ {p.name} can <span className={c.text}>CUT</span>!
      </h2>
      <p className="text-gray-700 text-sm text-center max-w-md">
        Pass the device to {p.name}. They have an exact match for the top card.
      </p>
      <div className="flex gap-2">
        {matches.map(card => <CardFace key={card.id} card={card} />)}
      </div>
      <div className="flex gap-3">
        <button onClick={onCut} className="px-6 py-3 bg-fuchsia-600 hover:bg-fuchsia-700 text-white font-bold rounded-lg shadow">
          Cut!
        </button>
        <button onClick={onSkip} className="px-6 py-3 bg-gray-300 hover:bg-gray-400 text-gray-800 rounded-lg">
          Skip
        </button>
      </div>
    </div>
  );
}

function LocalGame({ humans, ais, aiSpeed, onExit }: { humans: number; ais: number; aiSpeed: number; onExit: () => void }) {
  const init = useMemo(() => {
    const total = humans + ais;
    const names = [
      ...Array.from({ length: humans }, (_, i) => `Player ${i + 1}`),
      ...Array.from({ length: ais }, (_, i) => `AI ${i + 1}`),
    ];
    const aiSeats = [
      ...Array.from({ length: humans }, () => false),
      ...Array.from({ length: ais }, () => true),
    ];
    return newGame(total, names, aiSeats);
  }, [humans, ais]);
  const [state, dispatch] = useReducer(reducer, init);
  const { toasts } = useEventEffects(state.log, state.players.length === 0);
  const aiTimer = useRef<number | null>(null);
  const { dealing, finishDeal } = useDealAnimationGate(state);
  const reveal = useRevealOverlay(state);

  // Cards just drawn from the deck — used for the deck→hand fly-in animation.
  // Computed up here (not inside PlayScreen) so it survives phase transitions.
  const _localViewerForDraw = useMemo(() => {
    const idx = state.players.findIndex(p => !p.isAi);
    return Math.max(0, idx);
  }, [state.players]);
  const fromDeckIds = useFromDeckTracker(state, _localViewerForDraw);

  // Local-mode viewer: the most recent HUMAN player. AI turns don't shift this — so
  // when an AI plays, the device keeps showing the human's hand (or hides nothing of theirs).
  const [localViewerId, setLocalViewerId] = useState<number>(() =>
    Math.max(0, init.players.findIndex(p => !p.isAi)),
  );
  useEffect(() => {
    const followPhases = state.phase === 'play' || state.phase === 'flipFaceDown' || state.phase === 'reveal';
    if (followPhases && !state.players[state.current]?.isAi) {
      setLocalViewerId(state.current);
    }
  }, [state.phase, state.current, state.players]);

  // Per-pass skipped-by-human set (cleared on every state.pile change so each new pile event re-prompts).
  const [skippedHumans, setSkippedHumans] = useState<Set<number>>(new Set());
  const lastPileTopId = useRef<string | null>(null);
  useEffect(() => {
    const top = state.pile[state.pile.length - 1]?.card.id ?? null;
    if (top !== lastPileTopId.current) {
      lastPileTopId.current = top;
      setSkippedHumans(new Set());
    }
  }, [state.pile]);

  // Ultimate-mode cutters (in turn order from the player whose turn it is now).
  const cuttersInOrder = useMemo<number[]>(() => {
    if (state.mode !== 'ultimate' || state.phase !== 'play') return [];
    const out: number[] = [];
    const n = state.players.length;
    for (let i = 0; i < n; i++) {
      const idx = ((state.current + state.direction * i) % n + n) % n;
      if (state.players[idx].out) continue;
      if (idx === state.current) continue; // we only consider out-of-turn cuts here
      if (cutMatches(state, idx).length > 0) out.push(idx);
    }
    return out;
  }, [state]);

  const aiCutterPending = cuttersInOrder.find(id => state.players[id].isAi);
  const humanCutter = cuttersInOrder.find(id => !state.players[id].isAi && !skippedHumans.has(id));
  const showHumanCutPrompt = aiCutterPending === undefined && humanCutter !== undefined;

  // AI auto-step.
  useEffect(() => {
    if (aiTimer.current) { clearTimeout(aiTimer.current); aiTimer.current = null; }
    let aiId: number | null = null;
    if (state.phase === 'swap') {
      const idx = state.players.findIndex(p => p.isAi && !state.swapReady[p.id]);
      if (idx >= 0) aiId = idx;
    } else if ((state.phase === 'play' || state.phase === 'flipFaceDown' || state.phase === 'reveal') && state.players[state.current]?.isAi) {
      aiId = state.current;
    } else if (state.phase === 'play' && state.mode === 'ultimate' && aiCutterPending !== undefined) {
      aiId = aiCutterPending;
    }
    if (aiId === null) return;
    const isCut = state.phase === 'play' && state.current !== aiId;
    const revealDelay = state.revealedPickup
      ? Math.max(0, REVEAL_DURATION_MS - (Date.now() - state.revealedPickup.ts))
      : 0;
    const baseDelay = (isCut ? 350 : 700) * aiSpeed;
    aiTimer.current = window.setTimeout(() => {
      const action = aiPickAction(state, aiId!);
      if (action) dispatch(action);
    }, Math.max(baseDelay, revealDelay));
    return () => { if (aiTimer.current) clearTimeout(aiTimer.current); };
  }, [state, aiCutterPending, aiSpeed]);

  // Skip the pass screen whenever the device doesn't actually need to change hands:
  //  - next player is AI, OR
  //  - there's only one human total (solo vs AI).
  const humanCount = useMemo(() => state.players.filter(p => !p.isAi).length, [state.players]);
  const shouldSkipPass = state.phase === 'pass' && (!!state.players[state.current]?.isAi || humanCount <= 1);
  useEffect(() => {
    if (!shouldSkipPass) return;
    const t = window.setTimeout(() => dispatch({ type: 'ACK_PASS' }), 0);
    return () => clearTimeout(t);
  }, [shouldSkipPass]);

  // End-of-game loser sound. Local mode: device is shared so we always play it (the loser is at this device).
  const endedRef = useRef(false);
  useEffect(() => {
    if (state.phase === 'end' && !endedRef.current) {
      endedRef.current = true;
      sfx.playSample(SFX_FAHHHH);
    } else if (state.phase !== 'end') {
      endedRef.current = false;
    }
  }, [state.phase]);

  const restart = () => dispatch({
    type: 'NEW_GAME',
    playerCount: humans + ais,
    names: state.players.map(p => p.name),
    aiSeats: state.players.map(p => p.isAi ?? false),
  });

  let body: React.ReactNode;
  if (showHumanCutPrompt && humanCutter !== undefined) {
    body = (
      <LocalCutPromptScreen
        state={state}
        playerId={humanCutter}
        matches={cutMatches(state, humanCutter)}
        onCut={() => {
          const ids = cutMatches(state, humanCutter).map(c => c.id);
          dispatch({ type: 'CUT', player: humanCutter, ids });
        }}
        onSkip={() => setSkippedHumans(s => new Set(s).add(humanCutter))}
      />
    );
  } else {
    switch (state.phase) {
      case 'swap': body = <SwapScreen state={state} dispatch={dispatch} viewerId={null} />; break;
      case 'pass':
        body = shouldSkipPass
          ? <PlayScreen state={state} dispatch={dispatch} viewerId={localViewerId} fromDeckIds={fromDeckIds} />
          : <PassScreen state={state} dispatch={dispatch} />;
        break;
      case 'play': body = <PlayScreen state={state} dispatch={dispatch} viewerId={localViewerId} fromDeckIds={fromDeckIds} />; break;
      case 'flipFaceDown': body = <FlipScreen state={state} dispatch={dispatch} viewerId={localViewerId} />; break;
      case 'reveal': body = <RevealChoiceScreen state={state} dispatch={dispatch} viewerId={localViewerId} />; break;
      case 'end': body = <EndScreen state={state} onPlayAgain={restart} />; break;
      default: body = null;
    }
  }

  return (
    <>
      <div className="fixed top-3 left-3 z-50 flex flex-col items-start gap-1">
        <button onClick={onExit} className="text-xs px-2 py-1 bg-white/80 border rounded">← menu</button>
        {state.mode === 'ultimate' && <div className="text-[10px] px-2 py-0.5 bg-fuchsia-100 text-fuchsia-800 border border-fuchsia-300 rounded">Ultimate</div>}
      </div>
      <ToastStack toasts={toasts} />
      {body}
      <AnimatePresence>
        {dealing && <DealAnimation playerNames={state.players.map(p => p.name)} onComplete={finishDeal} />}
        {reveal && <RevealOverlay key={reveal.ts} playerName={reveal.name} card={reveal.card} />}
      </AnimatePresence>
    </>
  );
}

/* ============== Network-mode App ============== */

function NetworkGame({ onExit, prefilledCode }: { onExit: () => void; prefilledCode?: string }) {
  const conn = useNetwork(true);
  const { toasts } = useEventEffects(conn.state?.log ?? [], conn.lobby?.code);
  const { dealing, finishDeal } = useDealAnimationGate(conn.state);
  const reveal = useRevealOverlay(conn.state);
  const myId = conn.session?.spectator ? -1 : conn.lobby?.myId ?? 0;
  const fromDeckIds = useFromDeckTracker(conn.state, myId);

  const dispatch = (action: Action) => conn.send({ t: 'ACT', action });

  // End-of-game sound: the loser hears the fahhhh sample; everyone else hears the win arpeggio.
  const endedRef = useRef(false);
  useEffect(() => {
    if (conn.state?.phase === 'end' && !endedRef.current) {
      endedRef.current = true;
      const myId = conn.session?.spectator ? -1 : conn.lobby?.myId ?? -1;
      if (myId === conn.state.poopHead) sfx.playSample(SFX_FAHHHH);
      else sfx.play('win');
    } else if (conn.state?.phase !== 'end') {
      endedRef.current = false;
    }
  }, [conn.state?.phase, conn.state?.poopHead, conn.lobby?.myId, conn.session?.spectator]);

  let body: React.ReactNode;
  if (!conn.state) {
    body = <NetLobbyScreen conn={conn} onLeave={() => { conn.disconnect(); onExit(); }} prefilledCode={prefilledCode} />;
  } else {
    const viewerId = myId;
    const onEmote = (e: string) => conn.send({ t: 'EMOTE', emoji: e });
    switch (conn.state.phase) {
      case 'swap': body = <SwapScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} />; break;
      case 'pass':
      case 'play': body = <PlayScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} emotes={conn.lobby?.emotes} onEmote={onEmote} fromDeckIds={fromDeckIds} />; break;
      case 'flipFaceDown': body = <FlipScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} />; break;
      case 'reveal': body = <RevealChoiceScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} />; break;
      case 'end': {
        const isHost = conn.lobby?.myId === conn.lobby?.hostId;
        body = (
          <>
            <EndScreen state={conn.state} onPlayAgain={() => isHost ? conn.send({ t: 'PLAY_AGAIN' }) : null} />
            {!isHost && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 text-sm text-gray-700">Waiting for host to restart…</div>}
          </>
        );
        break;
      }
      default: body = <div className="p-6">Loading…</div>;
    }
  }
  return (
    <>
      <div className="fixed top-3 left-3 z-50 flex flex-col items-start gap-1">
        <button onClick={() => { conn.disconnect(); onExit(); }} className="text-xs px-2 py-1 bg-white/80 border rounded">← menu</button>
        {conn.state?.mode === 'ultimate' && <div className="text-[10px] px-2 py-0.5 bg-fuchsia-100 text-fuchsia-800 border border-fuchsia-300 rounded">Ultimate</div>}
      </div>
      <ToastStack toasts={toasts} />
      {body}
      <AnimatePresence>
        {dealing && conn.state && <DealAnimation playerNames={conn.state.players.map(p => p.name)} onComplete={finishDeal} />}
        {reveal && <RevealOverlay key={reveal.ts} playerName={reveal.name} card={reveal.card} />}
      </AnimatePresence>
    </>
  );
}

/* ============== Main App ============== */

type AppMode = 'menu' | 'localSetup' | 'local' | 'network';

function readRoomCodeFromUrl(): string | undefined {
  try {
    const params = new URLSearchParams(location.search);
    const r = params.get('room');
    return r ? r.toUpperCase() : undefined;
  } catch { return undefined; }
}

export default function App() {
  const urlRoom = useMemo(readRoomCodeFromUrl, []);
  const [mode, setMode] = useState<AppMode>(urlRoom ? 'network' : 'menu');
  const [muted, setMuted] = useState(sfx.muted);
  const [volume, setVolume] = useState(sfx.volume);
  const [aiSpeed, setAiSpeed] = useState(loadAiSpeed());
  const [localCfg, setLocalCfg] = useState<{ humans: number; ais: number } | null>(null);

  const toggleMute = (m: boolean) => { setMuted(m); sfx.setMuted(m); };
  const changeVolume = (v: number) => { setVolume(v); sfx.setVolume(v); };
  const changeAiSpeed = (v: number) => { setAiSpeed(v); saveAiSpeed(v); };

  let body: React.ReactNode;
  if (mode === 'menu') body = <MenuScreen onLocal={() => setMode('localSetup')} onNetwork={() => setMode('network')} prefilledCode={urlRoom} />;
  else if (mode === 'localSetup') body = <LocalSetupScreen onStart={(h, a) => { setLocalCfg({ humans: h, ais: a }); setMode('local'); }} onBack={() => setMode('menu')} />;
  else if (mode === 'local' && localCfg) body = <LocalGame humans={localCfg.humans} ais={localCfg.ais} aiSpeed={aiSpeed} onExit={() => setMode('menu')} />;
  else if (mode === 'network') body = <NetworkGame onExit={() => setMode('menu')} prefilledCode={urlRoom} />;

  return (
    <div className="min-h-full w-full overflow-auto" style={{ background: 'radial-gradient(ellipse at top, #eef6ee 0%, #e8efe6 60%, #dde6dc 100%)' }}>
      <SoundControls muted={muted} volume={volume} setMuted={toggleMute} setVolume={changeVolume} aiSpeed={aiSpeed} setAiSpeed={changeAiSpeed} />
      {body}
    </div>
  );
}
