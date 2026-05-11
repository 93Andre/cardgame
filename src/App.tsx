import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion, LayoutGroup, useReducedMotion } from 'framer-motion';
import {
  type Action,
  type Card,
  type GameState,
  type PileEntry,
  type AiDifficulty,
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
  nextActiveIndex,
  reducer,
} from './shared/game';
import { useNetwork, type NetworkConn, type ChatMsg, loadSession, clearSession } from './net';
import { useAuth, recordMatch, supabaseEnabled, checkUsernameAvailable, fetchLeaderboard, fetchRecentMatches, updateUsername, updateAvatar, signUpWithPassword, signInWithPassword, resetPassword, setNewPassword, AVATARS, avatarDef, USERNAME_RE, USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN, type SupabaseStats, type AuthState, type LeaderboardRow, type MatchHistoryRow } from './auth';
import { pageview } from './analytics';
import { useHaptics } from './hooks/useHaptics';

/* ============== Sound (Web Audio synth, no assets) ============== */

type SoundName = 'play' | 'pickup' | 'burn' | 'reset' | 'skip' | 'reverse' | 'seven' | 'win' | 'click' | 'emote' | 'yourTurn' | 'chain';

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

  private buildGraph(ctx: AudioContext) {
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

    // Silent keep-alive oscillator. Browsers (especially iOS Safari and Chrome on Android)
    // suspend AudioContexts that are silent for too long — that's why sound was cutting out
    // during long AI-only sequences. A near-DC oscillator at gain 0 keeps the audio engine
    // running with zero audible output and zero CPU impact.
    try {
      const keepAliveOsc = ctx.createOscillator();
      const keepAliveGain = ctx.createGain();
      keepAliveGain.gain.value = 0;
      keepAliveOsc.frequency.value = 1;
      keepAliveOsc.connect(keepAliveGain).connect(ctx.destination);
      keepAliveOsc.start();
    } catch { /* ignore — graph still works */ }

    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => { /* ignore */ });
      } else if (ctx.state === 'closed') {
        if (this.ctx === ctx) {
          this.ctx = null;
          this.master = null;
          this.compressor = null;
        }
      }
    });
  }

  private ensure() {
    // If a previous context got closed by the browser, drop the cached references so we recreate.
    if (this.ctx && (this.ctx.state as string) === 'closed') {
      this.ctx = null; this.master = null; this.compressor = null;
    }
    if (!this.ctx) {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctor) {
        const ctx: AudioContext = new Ctor();
        this.ctx = ctx;
        this.buildGraph(ctx);
      }
    }
    if (this.ctx?.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (!this.installedHandlers && typeof window !== 'undefined') {
      this.installedHandlers = true;
      const resume = () => {
        // If suspended, resume. If closed, the next play() call's ensure() will recreate.
        if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
      };
      document.addEventListener('visibilitychange', resume);
      window.addEventListener('focus', resume);
      window.addEventListener('pointerdown', resume);
      window.addEventListener('keydown', resume);
      window.addEventListener('touchstart', resume, { passive: true });
      // Belt-and-suspenders: poll every 10s so a quietly-suspended context doesn't stay dead
      // through the game just because the user wasn't generating "wakeful" events.
      setInterval(() => {
        if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
      }, 10000);
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
  play(name: SoundName, opts?: { count?: number }) {
    switch (name) {
      case 'play': this.tone(420, 0.08, 'triangle', 0.18); this.tone(640, 0.06, 'triangle', 0.10, 0.02); break;
      // Pickup: scales with the number of cards being picked up so a 2-card
      // pickup feels light and a 25-card pickup feels heavy. Composition:
      //   • Descending sawtooth sweep ("whoof") — duration grows with count
      //   • Staccato "tap" cluster — one square pulse per card up to 8, each
      //     slightly lower-pitched, simulating cards landing in the hand
      //   • Low boom for big pickups (>=10) for satisfying weight
      case 'pickup': {
        const count = Math.max(1, opts?.count ?? 1);
        const taps = Math.min(8, count);
        const sweepDur = 0.18 + Math.min(0.4, count * 0.025);   // 0.18s..~0.45s
        // Whoof — fast descending sawtooth, gain creeps up with count.
        this.tone(420, sweepDur, 'sawtooth', 0.10 + Math.min(0.06, count * 0.005));
        this.tone(140, sweepDur, 'sawtooth', 0.08 + Math.min(0.05, count * 0.004), 0.04);
        // Tap cluster — staggered cards landing.
        for (let i = 0; i < taps; i++) {
          const freq = 280 - i * 14;
          const delay = 0.06 + i * 0.04;
          this.tone(freq, 0.05, 'square', 0.08 + Math.min(0.04, count * 0.002), delay);
        }
        // Low impact for big pickups.
        if (count >= 10) this.tone(80, 0.28, 'sine', 0.18, 0.10);
        break;
      }
      case 'burn': this.noiseBurst(0.35, 0.22); this.tone(120, 0.30, 'sawtooth', 0.18); break;
      case 'reset': this.tone(520, 0.08, 'square', 0.12); this.tone(780, 0.10, 'square', 0.10, 0.06); break;
      case 'skip': this.tone(700, 0.08, 'square', 0.14); this.tone(500, 0.08, 'square', 0.14, 0.08); break;
      case 'reverse': this.tone(900, 0.10, 'triangle', 0.14); this.tone(600, 0.10, 'triangle', 0.14, 0.08); this.tone(400, 0.10, 'triangle', 0.14, 0.16); break;
      case 'seven': this.tone(330, 0.18, 'sine', 0.16); break;
      case 'win': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.18, i * 0.12)); break;
      case 'click': this.tone(880, 0.03, 'square', 0.06); break;
      case 'emote': this.tone(750, 0.06, 'triangle', 0.10); break;
      // Your-turn chime: soft ascending two-note ding (A4 → E5). Quieter
      // and lower-pitched than the previous version — the goal is a polite
      // nudge, not an alert. The 180ms delay before this fires (in the
      // GameScreen effect) still keeps it from being masked by overlapping
      // gameplay sfx, even at this lower gain.
      case 'yourTurn': {
        this.tone(440,    0.13, 'sine', 0.13);          // A4 head
        this.tone(659.25, 0.20, 'sine', 0.11, 0.07);    // E5 ascending
        break;
      }
      // Chain: short, rising "click-ding" — a tap (D5 triangle) into a
      // brighter A5 with a quick E6 sparkle. Distinct from the CUT
      // OBJECTION sample so a chain reads as "+1, you got another"
      // rather than "GOTCHA". Total ~220ms, slightly louder than a play.
      case 'chain': {
        this.tone(587.33,  0.07, 'triangle', 0.20);          // D5 tap
        this.tone(880,     0.10, 'triangle', 0.18, 0.06);    // A5 lift
        this.tone(1318.51, 0.14, 'sine',     0.10, 0.06);    // E6 sparkle
        break;
      }
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

// Persistent player profile — name + lifetime W/L. Keyed by single localStorage entries
// so it works even when a user clears the rest of their site data.
const PROFILE_NAME_KEY = 'ph_player_name';
const PROFILE_STATS_KEY = 'ph_player_stats';
interface ProfileStats { wins: number; losses: number; games: number; }
function loadName(): string {
  try { return localStorage.getItem(PROFILE_NAME_KEY) ?? ''; } catch { return ''; }
}
function saveName(n: string) {
  try { localStorage.setItem(PROFILE_NAME_KEY, n); } catch { /* ignore */ }
}
function loadStats(): ProfileStats {
  try {
    const raw = localStorage.getItem(PROFILE_STATS_KEY);
    if (!raw) return { wins: 0, losses: 0, games: 0 };
    const v = JSON.parse(raw);
    return { wins: +v.wins || 0, losses: +v.losses || 0, games: +v.games || 0 };
  } catch { return { wins: 0, losses: 0, games: 0 }; }
}
function saveStats(s: ProfileStats) {
  try { localStorage.setItem(PROFILE_STATS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
// Record a finished game's outcome for the local player. "win" = finished
// first (finishPos === 1; the reducer assigns 1-indexed places). "loss" =
// was the Poop Head. Other positions count as a "game" only — this keeps
// win-rate honest in 4+ player games.
function recordOutcome(outcome: 'win' | 'loss' | 'middle') {
  const s = loadStats();
  s.games += 1;
  if (outcome === 'win') s.wins += 1;
  else if (outcome === 'loss') s.losses += 1;
  saveStats(s);
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
  size?: 'tiny' | 'small' | 'normal';   // tiny is for cramped compact tiles
  small?: boolean;                       // back-compat: alias for size="small"
  hidden?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;            // double-tap shortcut — used to fast-play a single card
  dim?: boolean;
  jokerEffRank?: Rank | null;
  magnifyOnHover?: boolean;
  cuttable?: boolean;                    // out-of-turn play available — fuchsia glow
  chainable?: boolean;                   // chain (just-played player rank match) — emerald glow
}

// Power cards carry game-changing rules (burn / reset / skip / reverse / lock
// / wild). A subtle bottom accent stripe + corner glyph lets players scan
// their hand and read "this card matters" without having to remember every
// rule. Each rank has its own glyph so the effect is identifiable at a
// glance — e.g. 2 = reset wave, 7 = lock, 8 = skip arrow, 10 = flame, K =
// reverse arrows, JK = prism.
const POWER_CARD_ACCENTS: Partial<Record<Rank, { bar: string; tip: string; glyph: string; tint: string }>> = {
  '10': { bar: 'bg-rose-500',    tip: 'Burns pile',        glyph: '🔥', tint: 'rgba(244,63,94,0.10)' },
  '2':  { bar: 'bg-sky-500',     tip: 'Resets pile',       glyph: '↻',  tint: 'rgba(56,189,248,0.10)' },
  '8':  { bar: 'bg-amber-500',   tip: 'Skips next',        glyph: '⤳',  tint: 'rgba(245,158,11,0.10)' },
  'K':  { bar: 'bg-violet-500',  tip: 'Reverses',          glyph: '↺',  tint: 'rgba(167,139,250,0.10)' },
  '7':  { bar: 'bg-pink-500',    tip: '7-or-lower lock',   glyph: '🔒', tint: 'rgba(244,114,182,0.10)' },
  'JK': { bar: 'bg-fuchsia-500', tip: 'Wild',              glyph: '✦',  tint: 'rgba(232,121,249,0.12)' },
};

function CardFace({ card, size, small, hidden, selected, onClick, onDoubleClick, dim, jokerEffRank, magnifyOnHover, cuttable, chainable }: CardFaceProps) {
  const resolvedSize: 'tiny' | 'small' | 'normal' = size ?? (small ? 'small' : 'normal');
  const w =
    resolvedSize === 'tiny'  ? 'w-6 h-9 text-[7px] sm:w-7 sm:h-10 sm:text-[8px]' :
    resolvedSize === 'small' ? 'w-9 h-12 text-[10px] sm:w-10 sm:h-14 sm:text-xs' :
                               'w-14 h-20 text-sm sm:w-16 sm:h-24 sm:text-base';
  const hoverCls = magnifyOnHover ? 'hover:scale-[2] hover:z-30 hover:shadow-2xl' : '';
  // One-click cut/chain affordance: pulsing ring + glow. Chain (rank-only,
  // previous player) lights up emerald to differentiate from a true Ultimate
  // cut (rank+suit) which stays fuchsia.
  const cutCls = chainable
    ? 'ring-2 ring-emerald-400 shadow-[0_0_16px_rgba(52,211,153,0.85)] animate-pulse'
    : cuttable
      ? 'ring-2 ring-fuchsia-400 shadow-[0_0_16px_rgba(232,121,249,0.85)] animate-pulse'
      : '';
  const base = `relative ${w} rounded-md border shadow-sm flex flex-col items-center justify-center select-none transition-all duration-150 ${hoverCls} ${cutCls}`;
  if (hidden || !card) {
    // Card back: replaces the previous literal "PH" placeholder with a
    // proper card-back pattern. Layered:
    //   (1) deep indigo→violet gradient body
    //   (2) inset bezel ring so the back reads as a card edge, not a chip
    //   (3) chevron lattice via repeating-linear-gradient — the classic
    //       playing-card "fabric" feel without a raster asset
    //   (4) wordmark monogram "L" centered, low-opacity, so each back is
    //       quietly branded without competing with the table.
    // Same semantics as before (clickable, selected lift) but no cryptic
    // letters. Aria-label keeps it identified for screen readers.
    return (
      <div
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        aria-label="Face-down card"
        className={`${base} ${onClick ? 'cursor-pointer' : ''} ${selected ? '-translate-y-2 ring-2 ring-amber-400' : ''} text-white border-indigo-900/60 overflow-hidden`}
        style={{
          backgroundImage: [
            // chevron lattice
            'repeating-linear-gradient(135deg, rgba(255,255,255,0.10) 0 6px, transparent 6px 12px)',
            'repeating-linear-gradient( 45deg, rgba(0,0,0,0.18)    0 6px, transparent 6px 12px)',
            // body gradient
            'linear-gradient(135deg, #4c1d95 0%, #3730a3 60%, #1e1b4b 100%)',
          ].join(', '),
        }}
      >
        {/* Inset bezel — a thin lighter outline 2px in from the edge so the
            back has the depth of a real card. */}
        <div
          className="absolute inset-[3px] rounded-[3px] pointer-events-none"
          style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.18), inset 0 0 0 2px rgba(0,0,0,0.20)' }}
        />
        {/* Monogram — keeps the Latrine identity quietly present. Smaller
            on tiny/small to avoid crowding. */}
        <div
          className={`relative font-black tracking-tighter select-none ${
            resolvedSize === 'tiny' ? 'text-base' : resolvedSize === 'small' ? 'text-xl' : 'text-3xl'
          }`}
          style={{
            color: 'rgba(255,255,255,0.85)',
            textShadow: '0 1px 0 rgba(0,0,0,0.45), 0 0 14px rgba(167,139,250,0.55)',
          }}
        >
          L
        </div>
      </div>
    );
  }
  const isJoker = card.rank === 'JK';
  // Suit-tinted colour: hearts use the warmer red-600 (orange-leaning),
  // diamonds the cooler rose-600 (pink-leaning), so the two reds don't
  // blend at a glance. Spades stay neutral grey-900; clubs slightly
  // cooler slate-900 for the same reason.
  const colorStyle: React.CSSProperties = isJoker
    ? { color: '#7e22ce' }                                // joker purple
    : card.suit === '♥' ? { color: '#dc2626' }            // hearts: red
    : card.suit === '♦' ? { color: '#e11d48' }            // diamonds: rose
    : card.suit === '♠' ? { color: '#0f172a' }            // spades: slate-900
    :                     { color: '#1e293b' };           // clubs: slate-800
  const bg = isJoker ? 'bg-amber-50' : 'bg-white';
  const accent = POWER_CARD_ACCENTS[card.rank];
  // Bar is thinner on tiny/small cards so it doesn't eat the rank glyph.
  const barH = resolvedSize === 'tiny' ? 'h-[2px]' : resolvedSize === 'small' ? 'h-[3px]' : 'h-1';
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`${base} ${bg} border-gray-300 ${onClick ? 'cursor-pointer hover:shadow-md' : ''} ${selected ? '-translate-y-3 ring-2 ring-amber-500' : ''} ${dim ? 'opacity-50' : ''} overflow-hidden`}
      title={accent?.tip}
      style={colorStyle}
    >
      <div className="absolute top-0.5 left-0.5 leading-none font-bold">{isJoker ? 'J' : card.rank}</div>
      <div className={resolvedSize === 'tiny' ? 'text-sm' : resolvedSize === 'small' ? 'text-lg' : 'text-2xl'}>{isJoker ? '★' : card.suit}</div>
      <div className="absolute bottom-0.5 right-0.5 leading-none font-bold rotate-180">{isJoker ? 'J' : card.rank}</div>
      {isJoker && jokerEffRank && jokerEffRank !== 'JK' && (
        <div className="absolute -top-2 -right-2 px-1 py-0.5 bg-purple-700 text-white text-[10px] rounded-full font-bold">={jokerEffRank}</div>
      )}
      {accent && (
        <>
          {/* Bottom accent bar — tinted by power-effect, sits flush with the
              card's bottom edge inside the rounded clip. */}
          <div className={`absolute bottom-0 inset-x-0 ${barH} ${accent.bar}`} aria-hidden />
          {/* Per-rank glyph in the upper-right — distinct identity per power
              card (🔥 burn, ↻ reset, ⤳ skip, ↺ reverse, 🔒 lock, ✦ wild)
              instead of the generic ⚡ pip. Sized down on tiny cards. */}
          {resolvedSize !== 'tiny' && (
            <div className="absolute top-0.5 right-0.5 text-[10px] leading-none opacity-85" aria-hidden>{accent.glyph}</div>
          )}
        </>
      )}
    </div>
  );
}

function AnimatedCard(props: CardFaceProps & { layoutId?: string; fromDeck?: boolean }) {
  const { layoutId, fromDeck, magnifyOnHover, ...rest } = props;
  // Cards from a deck draw fade in AFTER the flying-overlay lands on top of them
  // (so the visual reads as: card-back travels from deck → arrives at hand → reveals face).
  return (
    <motion.div
      layoutId={layoutId}
      initial={{ scale: fromDeck ? 1 : 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.6, opacity: 0 }}
      transition={fromDeck
        ? { duration: 0.25, delay: 0.5 }
        : { type: 'spring', stiffness: 300, damping: 28 }
      }
    >
      <CardFace {...rest} magnifyOnHover={magnifyOnHover} />
    </motion.div>
  );
}

/* ============== Player area ============== */

// Visual rank medal for a player who has finished. 1st = crown, 2nd = silver, 3rd = bronze, then numeric.
function RankMedal({ pos }: { pos: number }) {
  const emoji = pos === 1 ? '👑' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : '🏅';
  const ring = pos === 1 ? 'border-amber-400 bg-amber-50 text-amber-800'
    : pos === 2 ? 'border-slate-300 bg-slate-50 text-slate-700'
    : pos === 3 ? 'border-orange-400 bg-orange-50 text-orange-800'
    : 'border-emerald-400 bg-emerald-50 text-emerald-800';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-bold ${ring}`}>
      <span className="text-sm leading-none">{emoji}</span>
      <span>#{pos}</span>
    </span>
  );
}

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

// CompactCardRow — face-up cards + a face-down `×N` pill on a single row,
// with a 600ms "promotion" animation when face-up just emptied (the player
// ran out of their face-up row and is about to play from face-down). The
// pill scales up + glows + pulses once, then settles in place.
function CompactCardRow({
  player, selectedFaceUpIds, faceUpClickable, onFaceUpClick, faceDownClickable, onFaceDownClick,
}: {
  player: Player;
  selectedFaceUpIds?: Set<string>;
  faceUpClickable?: boolean;
  onFaceUpClick?: (id: string) => void;
  faceDownClickable?: boolean;
  onFaceDownClick?: (id: string) => void;
}) {
  // Track when face-up went from non-empty → empty so we can flag a brief
  // "your face-down is up next" highlight on the pill. Resets after 1.2s.
  const prevFaceUpRef = useRef(player.faceUp.length);
  const [promoteKey, setPromoteKey] = useState(0);
  useEffect(() => {
    const prev = prevFaceUpRef.current;
    const cur = player.faceUp.length;
    if (prev > 0 && cur === 0 && player.faceDown.length > 0) {
      setPromoteKey(k => k + 1);
    }
    prevFaceUpRef.current = cur;
  }, [player.faceUp.length, player.faceDown.length]);

  const noCards = player.faceUp.length === 0 && player.faceDown.length === 0;
  const fdCount = player.faceDown.length;
  const promoting = promoteKey > 0; // becomes true once and stays — the spring uses key for replay

  return (
    // Single horizontal row: face-up cards on the left, face-down ×N pill
    // tight against them on the right. No flex-wrap on the outer row so
    // the pill never drops to its own line — that's the whole point of
    // collapsing 3 card-backs into a pill on mobile.
    <div className="flex items-center gap-1">
      {/* Face-up cards. shrink-0 so the box claims its full content width
          — without it, flex would shrink the box below the cards' visible
          width and the pill would start overlapping the rightmost card. */}
      <div className="flex gap-0.5 shrink-0">
        {player.faceUp.map(c2 => (
          <AnimatedCard
            key={c2.id} layoutId={c2.id} card={c2} size="tiny" magnifyOnHover
            selected={selectedFaceUpIds?.has(c2.id)}
            onClick={faceUpClickable && onFaceUpClick ? () => onFaceUpClick(c2.id) : undefined}
          />
        ))}
        {noCards && <span className="text-[9px] text-gray-500 italic">no cards</span>}
      </div>

      {/* Face-down pill — single mini card-back + ×N badge. When the
          face-down phase becomes interactive (clickable), expand back to
          three real card-backs so the player can tap each one. */}
      {fdCount > 0 && (
        faceDownClickable && onFaceDownClick ? (
          <div className="flex gap-0.5 flex-wrap">
            {player.faceDown.map(c2 => (
              <CardFace key={c2.id} size="tiny" hidden onClick={() => onFaceDownClick(c2.id)} />
            ))}
          </div>
        ) : (
          <motion.div
            key={`fd-pill-${promoteKey}`}
            initial={promoting ? { scale: 0.8, opacity: 0.6 } : false}
            animate={promoting
              ? { scale: [0.8, 1.18, 1], opacity: [0.6, 1, 1] }
              : { scale: 1, opacity: 1 }}
            transition={{ duration: 0.6, times: [0, 0.55, 1], ease: 'easeOut' }}
            className="relative flex items-center shrink-0"
            title={`${fdCount} face-down card${fdCount === 1 ? '' : 's'}`}
            aria-label={`${fdCount} face-down cards`}
          >
            {/* Render N actual card-backs heavily overlapped (each peeks
                by ~6px). Reads as a real stack of face-down cards rather
                than a count badge, but still occupies only ~36px total
                width for 3 cards thanks to the negative margins.
                Slight rotation per card sells the "hand of cards" look. */}
            {Array.from({ length: fdCount }).map((_, i) => (
              <div
                key={`fd-mini-${i}`}
                style={{
                  marginLeft: i === 0 ? 0 : -18,
                  transform: `rotate(${(i - (fdCount - 1) / 2) * 5}deg)`,
                  zIndex: i,
                }}
              >
                <CardFace size="tiny" hidden />
              </div>
            ))}
            {/* Promotion glow — a soft amber ring that fades out shortly
                after face-up cleared. Visually "promotes" the pill. */}
            {promoting && (
              <motion.span
                key={`glow-${promoteKey}`}
                initial={{ opacity: 0.85, scale: 0.9 }}
                animate={{ opacity: 0, scale: 1.5 }}
                transition={{ duration: 0.9, ease: 'easeOut' }}
                className="absolute inset-0 rounded-md ring-2 ring-amber-400 pointer-events-none"
              />
            )}
          </motion.div>
        )
      )}
    </div>
  );
}

function PlayerArea({ player, isCurrent, isViewer, isSpectatorFocus, onSpectatorFocus, compact, faceDownClickable, onFaceDownClick, emotes,
  faceUpClickable, onFaceUpClick, selectedFaceUpIds, turnElapsedMs, recentlyActed, avatar, connected = true }: {
  player: Player; isCurrent: boolean; isViewer: boolean; compact?: boolean;
  isSpectatorFocus?: boolean;                        // spectator has this player camera-focused
  onSpectatorFocus?: () => void;                     // click handler for spectators only
  faceDownClickable?: boolean; onFaceDownClick?: (id: string) => void;
  faceUpClickable?: boolean; onFaceUpClick?: (id: string) => void;
  selectedFaceUpIds?: Set<string>;
  emotes?: { id: string; playerId: number; emoji: string }[];
  turnElapsedMs?: number;
  recentlyActed?: boolean;            // 600ms pulse on whoever just played — table-wide readability.
  avatar?: string | null;             // avatar key for the small pip beside the name
  connected?: boolean;                // network presence; false → render "away" indicator
}) {
  const c = colorFor(player.id);
  // Register this tile's screen-centre so the deck-draw overlay can fly
  // cards directly to it. Re-measured on resize/scroll because the table
  // layout reflows on viewport changes. Cleanup nulls the entry so a
  // departed seat doesn't leave stale coords behind.
  const tileRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const measure = () => registerPlayerPos(player.id, tileRef.current);
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      registerPlayerPos(player.id, null);
    };
  }, [player.id]);
  // Compact mode: tighter padding, smaller text, face-up + face-down rendered side-by-side
  // in a single row so the tile stays short enough to fit around the table on mobile.
  return (
    <div
      ref={tileRef}
      onClick={onSpectatorFocus}
      role={onSpectatorFocus ? 'button' : undefined}
      aria-pressed={onSpectatorFocus ? isSpectatorFocus : undefined}
      className={`table-seat relative ${compact ? 'p-0.5 sm:p-1.5' : 'p-2 sm:p-3'} rounded-lg ${compact ? 'border sm:border-2' : 'border-2'} ${
        isSpectatorFocus
          ? 'border-violet-300 ring-2 ring-violet-400 shadow-[0_0_18px_rgba(167,139,250,0.45)]'
          : isCurrent
            ? `${c.border} ring-2 ${c.ring} active-player-glow`
            : 'border-white/20'
      } ${recentlyActed ? 'player-acted-pulse' : ''} ${onSpectatorFocus ? 'cursor-pointer hover:ring-2 hover:ring-violet-300 transition-shadow' : ''} flex flex-col ${compact ? 'gap-0.5 sm:gap-1' : 'gap-2'} min-w-0 transition-transform duration-300 ${isCurrent && !isSpectatorFocus ? 'scale-[1.04]' : ''} ${!connected && !player.isAi && !isViewer ? 'opacity-70 saturate-50' : ''}`}>
      {/* Active-player spotlight — a soft amber radial gradient pouring
          down from above the tile, like a stage light. Layered behind
          the tile content (pointer-events-none + z-0). Only renders for
          the active player and not when the spectator is camera-focused
          on someone else (the violet spectator treatment owns that). */}
      {isCurrent && !isSpectatorFocus && (
        <div
          className="absolute inset-x-[-12px] -top-8 h-12 pointer-events-none rounded-full"
          style={{
            background: 'radial-gradient(ellipse at 50% 100%, rgba(251,191,36,0.30) 0%, transparent 65%)',
            filter: 'blur(3px)',
          }}
          aria-hidden
        />
      )}
      {/* Turn-speed indicator: appears above the current player's tile after 15s of thinking,
          fills toward the 30s server-side auto-pickup cutoff. */}
      {isCurrent && typeof turnElapsedMs === 'number' && turnElapsedMs > 15000 && (
        <div className="absolute -top-1 left-2 right-2 h-1 bg-white/15 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-1000 ease-linear ${
              turnElapsedMs > 27000 ? 'bg-rose-500'
                : turnElapsedMs > 22000 ? 'bg-amber-500'
                : 'bg-emerald-500'
            }`}
            style={{ width: `${Math.min(100, ((turnElapsedMs - 15000) / 15000) * 100)}%` }}
          />
        </div>
      )}
      <div className={`flex items-center justify-between min-w-0 ${compact ? 'gap-1' : 'gap-2'}`}>
        <span className={`font-semibold flex items-center gap-1 sm:gap-1.5 min-w-0 ${compact ? 'text-[10px] sm:text-[11px]' : ''}`}>
          {/* Active-player avatar gets a small scale-up so their seat reads
              like a spotlit stage rather than a static tile. The compact
              variant uses a smaller wrapper on mobile to recover horizontal
              space — Avatar's `sm` is 28px; this clamps it to 22px. */}
          <span className={`inline-flex shrink-0 transition-transform duration-300 ${isCurrent ? 'scale-110' : ''} ${compact ? '[&>div]:w-[22px] [&>div]:h-[22px] [&>div]:text-sm sm:[&>div]:w-7 sm:[&>div]:h-7 sm:[&>div]:text-base' : ''}`}>
            <Avatar avatar={avatar} name={player.name} size="sm" />
          </span>
          {/* Allow short names ("AI 1", "Player 1") to render in full on
              compact tiles. Only truncate when the rendered name would
              overflow — `truncate` here clamps to one line but the parent
              `min-w-0` lets the name claim available width before the
              hand-count chip wins. */}
          <span className="truncate">{player.name}</span>
          {!compact && player.isAi && <span className="text-[10px] px-1 py-0.5 bg-white/10 text-white/75 rounded shrink-0">AI</span>}
          {!compact && isViewer && <span className="text-[10px] text-emerald-200 shrink-0">(you)</span>}
          {/* Away pip — surfaces "this player's app is suspended" so the
              rest of the table knows why the game isn't progressing.
              Hidden for AIs (always connected) and for the viewer (you
              wouldn't render a tile of yourself as away in a meaningful
              way). The active player gets a stronger amber treatment
              since their disconnection is what's actually blocking play. */}
          {!connected && !player.isAi && !isViewer && (
            <span
              className={`shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold tracking-wide ${
                isCurrent
                  ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-400/60 animate-pulse'
                  : 'bg-slate-100 text-slate-600'
              }`}
              title={`${player.name} is offline (app backgrounded)`}
              aria-label="offline"
            >
              <span aria-hidden>💤</span>
              <span>AWAY</span>
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 whitespace-nowrap shrink-0">
          <HandStack count={player.hand.length} />
          {/* Last-card warning — only fires once a player is genuinely
              about to win (hand + face-up + face-down combined = 1). The
              most dramatic moment in the game; the tile celebrates it.
              Hidden once they've actually gone out (finishPos set). */}
          {!player.out && (player.hand.length + player.faceUp.length + player.faceDown.length === 1) && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-black tracking-wider bg-rose-500 text-white ring-1 ring-rose-300/60 shadow-[0_2px_6px_rgba(244,63,94,0.55)] animate-pulse"
              title={`${player.name} has 1 card left!`}
            >
              <span aria-hidden>🔥</span>
              <span>1 LEFT</span>
            </span>
          )}
          {player.out && player.finishPos !== null && <RankMedal pos={player.finishPos} />}
        </span>
      </div>
      {compact ? (
        // Compact tile: face-up cards + a small face-down `×N` pill on the
        // same row. The pill collapses 3 card-backs into a single mini-card
        // glyph + count, recovering vertical space vs the previous
        // stacked-row layout. When face-up empties out and face-down is
        // about to take over (the player ran out of face-up), we animate
        // the pill *promoting* into the face-up slot for a beat — so the
        // transition feels like the deck is sliding forward, not just
        // disappearing.
        <CompactCardRow
          player={player}
          selectedFaceUpIds={selectedFaceUpIds}
          faceUpClickable={faceUpClickable}
          onFaceUpClick={onFaceUpClick}
          faceDownClickable={faceDownClickable}
          onFaceDownClick={onFaceDownClick}
        />
      ) : (
        <>
          <div className="flex gap-1 flex-wrap">
            {player.faceUp.map(c2 => (
              <AnimatedCard
                key={c2.id} layoutId={c2.id} card={c2} small magnifyOnHover
                selected={selectedFaceUpIds?.has(c2.id)}
                onClick={faceUpClickable && onFaceUpClick ? () => onFaceUpClick(c2.id) : undefined}
              />
            ))}
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
        </>
      )}
      {/* Floating emote bursts — animation variant chosen per-emoji from the
          catalogue so each reaction has its own personality (🔥 spawns four
          flames, 💀 shakes, 🃏 flips, etc.). Falls back to a generic 'rise'
          for any emoji not in the catalogue. */}
      <AnimatePresence>
        {(emotes ?? []).filter(e => e.playerId === player.id).slice(-1).map(e => {
          const def = EMOTE_BY_EMOJI[e.emoji] ?? { emoji: e.emoji, label: '', anim: 'rise' as EmoteAnim };
          // Cheap deterministic seed for jitter so multiple bursts don't all
          // animate identically — derived from the emote's wire id.
          const seed = e.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
          return <EmoteBurst key={e.id} def={def} seed={seed} />;
        })}
      </AnimatePresence>
    </div>
  );
}

/* ============== Circular table layout ============== */

// Arranges player tiles around a central pile area, with the viewer always at the bottom
// and other players spread clockwise (or counter-clockwise) by turn order.
function CircularTable({ players, current, viewer, direction, directionFlashKey, pickupAnim, playAnim, renderPlayer, centerContent }: {
  players: Player[];
  current: number;
  viewer: number;
  direction: 1 | -1;
  directionFlashKey?: number;        // bumps when direction flips → triggers chevron flash
  pickupAnim?: { key: number; pickerId: number; count: number } | null;
  playAnim?: { key: number; actorId: number; cards: Card[] } | null;
  renderPlayer: (p: Player, isNext: boolean, compact: boolean) => React.ReactNode;
  centerContent: React.ReactNode;
}) {
  const n = players.length;
  const nextIdx = nextActiveIndex(players, current, direction);
  const safeViewer = viewer >= 0 ? viewer : current;
  // Detect three orientations: portrait phone, landscape phone, desktop.
  const detectLayout = (): 'portrait' | 'landscape' | 'desktop' => {
    if (typeof window === 'undefined') return 'desktop';
    const w = window.innerWidth, h = window.innerHeight;
    if (w >= 900) return 'desktop';
    if (w > h) return 'landscape';
    return 'portrait';
  };
  const [layout, setLayout] = useState(detectLayout);
  useEffect(() => {
    const onResize = () => setLayout(detectLayout());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  // Layout-specific dimensions. Landscape uses a wider aspect to lay tiles along the
  // long axis instead of stacking them — much better use of horizontal phone space.
  const tileWidth =
    layout === 'desktop'  ? 'clamp(130px, 17vw, 220px)' :
    layout === 'landscape' ? 'clamp(95px, 18vw, 150px)' :
                             'clamp(110px, 30vw, 180px)';
  // Desktop omits an aspect ratio so the table can stretch to fill the
  // available vertical space inside the parent flex column. Cap the height
  // by viewport so the hand below still stays on-screen.
  const aspectRatio =
    layout === 'desktop'  ? undefined :
    layout === 'landscape' ? '5 / 3' :
                             '4 / 5';
  const minHeight =
    layout === 'desktop'  ? 320 :
    layout === 'landscape' ? 280 :
                             540;
  const maxHeight =
    layout === 'desktop' ? 'min(72vh, 720px)' :
                           undefined;
  // Desktop spreads horizontally (rx) generously for 4+ players where space
  // allows; ry is capped at ~0.36 so the slots that land at the top and
  // bottom of the ellipse (north/south) keep their full ~200px tiles inside
  // the table bounds. Going past 0.36 clips the top of the opposite player
  // and the bottom of the viewer's hand area.
  const rx =
    layout === 'desktop'  ? (n <= 3 ? 0.42 : n <= 4 ? 0.46 : 0.48) :
    layout === 'landscape' ? (n <= 3 ? 0.42 : 0.45) :
    n <= 3 ? 0.34 : 0.40;
  // Vertical radius. Restored to 0.36 for 4+ on desktop (the smaller
  // 0.32 stopped the top tile from clipping the StatusBar but pulled the
  // side seats too close together vertically — 6-player layouts had
  // adjacent left/right tiles overlapping each other). The top-tile
  // clearance issue is now solved separately via yOffset below, which
  // shifts the WHOLE ellipse down a few % so the top doesn't crowd the
  // status bar while the sides keep their full vertical spread.
  const ry =
    layout === 'desktop'   ? (n <= 3 ? 0.32 : 0.36) :
    layout === 'landscape' ? (n <= 3 ? 0.34 : 0.38) :
                             (n <= 3 ? 0.40 : 0.42);
  // y-offset applied to every tile's vertical position. Pushes the whole
  // ellipse down a few % so the top tile clears the StatusBar/menu pill.
  // Modest values across the board — too large pushes the viewer's own
  // bottom tile off the container.
  const yOffset = 5;
  // Keep the direction rail inside the player seats. Using the same ellipse
  // as the seats made the line feel pasted across the table; this reads more
  // like a quiet inlay around the pile area.
  const railRx = rx * 0.78;
  const railRy = ry * 0.74;

  return (
    <div
      className={`table-stage relative w-full mx-auto ${layout === 'desktop' ? 'flex-1' : ''}`}
      style={{ aspectRatio, maxWidth: 1160, minHeight, maxHeight }}
    >
      {/* Felt centre monogram — a quiet "LATRINE" wordmark embroidered into
          the felt, visible behind the centre piles. Sits at z-0 with low
          opacity so the pile cards always read on top; just adds a premium
          "this is a real table" touch when the eye lingers on the centre. */}
      <div
        aria-hidden
        className="table-felt-mark absolute left-1/2 -translate-x-1/2 pointer-events-none select-none"
        style={{
          top: `${50 + yOffset}%`,
          transform: 'translate(-50%, -50%)',
          zIndex: 0,
        }}
      >
        LATRINE
      </div>
      {/* Direction-of-play track: a warm inlaid rail. It sits inside the seats
          so it feels carved into the table rather than drawn over the game. */}
      <svg
        key={`flow-comet-${direction}-${directionFlashKey ?? 0}`}
        viewBox="0 0 100 100" preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
      >
        <defs>
          <linearGradient id="direction-inlay" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,224,178,0.32)" />
            <stop offset="48%" stopColor="rgba(180,105,48,0.26)" />
            <stop offset="100%" stopColor="rgba(44,24,12,0.30)" />
          </linearGradient>
          <linearGradient id="direction-marker" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="rgba(251,191,36,0)" />
            <stop offset="48%" stopColor="rgba(253,230,138,0.70)" />
            <stop offset="100%" stopColor="rgba(255,251,235,0.88)" />
          </linearGradient>
        </defs>
        {/* Soft recessed groove. */}
        <ellipse
          cx="50" cy="50" rx={railRx * 100} ry={railRy * 100}
          fill="none" stroke="rgba(30,16,8,0.28)" strokeWidth="4.6"
          vectorEffect="non-scaling-stroke"
        />
        {/* Warm table inlay. */}
        <ellipse
          cx="50" cy="50" rx={railRx * 100} ry={railRy * 100}
          fill="none" stroke="url(#direction-inlay)" strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {/* Inner highlight keeps the rail crisp without adding visual noise. */}
        <ellipse
          cx="50" cy="50" rx={railRx * 100} ry={railRy * 100}
          fill="none" stroke="rgba(255,246,220,0.14)" strokeWidth="0.75"
          vectorEffect="non-scaling-stroke"
        />
        {/* Moving direction marker. */}
        <ellipse
          cx="50" cy="50" rx={railRx * 100} ry={railRy * 100}
          pathLength={100}
          fill="none"
          stroke="url(#direction-marker)" strokeWidth="3.2"
          strokeDasharray="6.5 93.5" strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{
            animation: `flow-comet-${direction === 1 ? 'cw' : 'ccw'} 5.2s linear infinite`,
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.42))',
          }}
        />
      </svg>

      {players.map(p => {
        // Player slots are FIXED relative to the viewer — direction reversal only flips the
        // animated outline below, so players never visually swap places mid-game.
        const slot = (p.id - safeViewer + n) % n;
        const baseAngle = 90 + (slot / n) * 360;
        const angle = baseAngle * Math.PI / 180;
        const xPct = 50 + Math.cos(angle) * rx * 100;
        const yPct = 50 + Math.sin(angle) * ry * 100 + yOffset;
        return (
          <div
            key={p.id}
            className="absolute"
            style={{
              left: `${xPct}%`, top: `${yPct}%`,
              transform: 'translate(-50%, -50%)',
              width: tileWidth,
            }}
          >
            {renderPlayer(p, p.id === nextIdx, layout !== 'desktop')}
          </div>
        );
      })}

      <div
        className="center-pile-well absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ top: `${50 + yOffset}%` }}
      >
        {centerContent}
      </div>

      {/* Opponent / AI play animation — fly the just-played card(s) from
          the actor's tile to the pile centre. The static pile already shows
          them at the destination after the state update; the moving overlay
          gives the eye something to follow so plays don't appear to teleport.
          Reuses the same slot math as player tiles for the source position. */}
      <AnimatePresence>
        {playAnim && (() => {
          const slot = (playAnim.actorId - safeViewer + n) % n;
          const baseAngle = 90 + (slot / n) * 360;
          const angle = baseAngle * Math.PI / 180;
          const sourceX = 50 + Math.cos(angle) * rx * 100;
          const sourceY = 50 + Math.sin(angle) * ry * 100 + yOffset;
          // Multi-card plays: cards arrive sequentially with a clear
          // stagger AND fan out at the destination so two/three same-rank
          // plays don't visually merge into a single card on the pile.
          // Per-card horizontal offset spreads them ~28px apart in the
          // viewport (translated to pixels via x/y in the animate{}).
          const totalCards = playAnim.cards.length;
          const fanStepPx = 28;
          return playAnim.cards.map((c, i) => {
            const fanOffset = (i - (totalCards - 1) / 2) * fanStepPx;
            return (
              <motion.div
                key={`play-${playAnim.key}-${c.id}`}
                initial={{
                  left: `${sourceX}%`, top: `${sourceY}%`,
                  x: '-50%', y: '-50%',
                  scale: 0.6, opacity: 0, rotate: (i - totalCards / 2) * 5,
                }}
                animate={{
                  left: '50%', top: '50%',
                  x: `calc(-50% + ${fanOffset}px)`,
                  y: '-50%',
                  scale: 1, opacity: 1,
                  rotate: (i - (totalCards - 1) / 2) * 6,
                }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.12 } }}
                transition={{ duration: 0.42, delay: i * 0.16, ease: [0.4, 0.0, 0.2, 1] }}
                className="absolute pointer-events-none"
                style={{ zIndex: 35 + i, perspective: '600px' }}
                aria-hidden
              >
                {/* Mid-flight Y-axis flip: a 3D rotate from 180→0 over the
                    flight duration so the card visually flips from back to
                    face as it lands. Inner div carries the flip so the
                    outer motion.div retains its translation animation. */}
                <motion.div
                  initial={{ rotateY: 180 }}
                  animate={{ rotateY: 0 }}
                  transition={{ duration: 0.42, delay: i * 0.16, ease: [0.4, 0.0, 0.2, 1] }}
                  style={{ transformStyle: 'preserve-3d' }}
                >
                  <CardFace card={c} />
                </motion.div>
              </motion.div>
            );
          });
        })()}
      </AnimatePresence>

      {/* Pile-pickup animation: card-backs fly from the centre pile to the
          picker's tile. Reuses the same slot math as the player tiles, so the
          target lands exactly on their position regardless of orientation. */}
      <AnimatePresence>
        {pickupAnim && (() => {
          const slot = (pickupAnim.pickerId - safeViewer + n) % n;
          const baseAngle = 90 + (slot / n) * 360;
          const angle = baseAngle * Math.PI / 180;
          const targetX = 50 + Math.cos(angle) * rx * 100;
          const targetY = 50 + Math.sin(angle) * ry * 100 + yOffset;
          // Big pickups feel heavier: longer flight, slightly larger stagger,
          // and we show more card-backs (capped at 18 — past that they blur).
          const big = pickupAnim.count >= 10;
          const huge = pickupAnim.count >= 20;
          const flightDur = huge ? 0.85 : big ? 0.7 : 0.55;
          const stagger = huge ? 0.04 : big ? 0.032 : 0.025;
          return Array.from({ length: pickupAnim.count }).map((_, i) => {
            // Stagger and slight angular jitter so the cards "fan out" mid-flight
            // instead of stacking like a single sprite.
            const jitter = (i - pickupAnim.count / 2) * 1.2;
            const delay = i * stagger;
            return (
              <motion.div
                key={`pickup-${pickupAnim.key}-${i}`}
                initial={{ left: '50%', top: '50%', x: '-50%', y: '-50%', scale: 1, opacity: 1, rotate: 0 }}
                animate={{
                  left: `${targetX + jitter}%`,
                  top:  `${targetY + jitter * 0.4}%`,
                  x: '-50%', y: '-50%',
                  scale: 0.45,
                  opacity: 0,
                  rotate: jitter * 2,
                }}
                transition={{ duration: flightDur, delay, ease: [0.4, 0.0, 0.2, 1] }}
                className="absolute pointer-events-none w-10 h-14 sm:w-12 sm:h-16 rounded-md border border-indigo-900/60 shadow-lg flex items-center justify-center text-[14px] font-black tracking-tighter text-white/85 overflow-hidden"
                style={{
                  zIndex: 30,
                  backgroundImage: [
                    'repeating-linear-gradient(135deg, rgba(255,255,255,0.10) 0 5px, transparent 5px 10px)',
                    'repeating-linear-gradient( 45deg, rgba(0,0,0,0.18)    0 5px, transparent 5px 10px)',
                    'linear-gradient(135deg, #4c1d95 0%, #3730a3 60%, #1e1b4b 100%)',
                  ].join(', '),
                }}
                aria-hidden
              >
                <span style={{ textShadow: '0 1px 0 rgba(0,0,0,0.45), 0 0 8px rgba(167,139,250,0.55)' }}>L</span>
              </motion.div>
            );
          });
        })()}
        {/* "+N cards" floating burst on the picker's tile — gives the
            pile-pickup moment a clear "you got this many" hit. Rose-
            tinted because pickup is the bad outcome. Animates up + out
            over ~1.1s. Sized to the count so big pickups feel HEAVY. */}
        {pickupAnim && (() => {
          const slot = (pickupAnim.pickerId - safeViewer + n) % n;
          const baseAngle = 90 + (slot / n) * 360;
          const angle = baseAngle * Math.PI / 180;
          const targetX = 50 + Math.cos(angle) * rx * 100;
          const targetY = 50 + Math.sin(angle) * ry * 100 + yOffset;
          const bigBoost = pickupAnim.count >= 10 ? 1.18 : 1;
          return (
            <motion.div
              key={`pickup-burst-${pickupAnim.key}`}
              initial={{ opacity: 0, scale: 0.5, y: 8 }}
              animate={{ opacity: [0, 1, 1, 0], scale: [0.5, bigBoost * 1.15, bigBoost, bigBoost * 0.95], y: [8, -6, -10, -22] }}
              transition={{ duration: 1.1, times: [0, 0.2, 0.7, 1], ease: 'easeOut' }}
              className="absolute pointer-events-none font-black text-rose-200 drop-shadow-[0_3px_8px_rgba(244,63,94,0.55)]"
              style={{
                left: `${targetX}%`,
                top: `${targetY}%`,
                transform: 'translate(-50%, -50%)',
                fontSize: pickupAnim.count >= 10 ? '1.8rem' : '1.4rem',
                letterSpacing: '0.02em',
                zIndex: 40,
              }}
              aria-hidden
            >
              +{pickupAnim.count}
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}

/* ============== Center piles ============== */

function CardStack({ count, top, layerCards, emptyLabel, tone = 'normal' }: {
  count: number;
  top?: React.ReactNode;
  layerCards?: PileEntry[];
  emptyLabel?: string;
  tone?: 'normal' | 'burned';
}) {
  const MAX_LAYERS = 12;
  const visibleLayers = Math.min(count, MAX_LAYERS);
  const baseLayers = Math.max(0, visibleLayers - 1);
  // The PLAY pile (layerCards provided) reads as a messy, growing stack
  // — bigger per-layer offset + jittered rotation make it look like real
  // cards have been thrown on. The DECK / BURN pile (no layerCards, just
  // a count of card-back placeholders) keeps the original tight stacking
  // so it reads as a neat draw deck.
  const isPlayStack = !!layerCards;
  const layerStep = isPlayStack ? 2.4 : 1.6;
  const padPx = baseLayers * layerStep;
  // Deterministic "thrown" rotation per card so the stack doesn't re-jitter
  // on every render. Seeded off the card id when available.
  const rotationFor = (entry: PileEntry | undefined, fallbackKey: number) => {
    if (!isPlayStack) return 0;
    const seed = entry?.card.id ?? `f-${fallbackKey}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    // Map hash to ±5° range
    return ((h % 1001) / 1000 - 0.5) * 10;
  };
  return (
    <div
      className="relative"
      style={{
        width: `calc(4rem + ${padPx + (isPlayStack ? 18 : 0)}px)`,
        height: `calc(6rem + ${padPx + (isPlayStack ? 8 : 0)}px)`,
      }}
    >
      {Array.from({ length: baseLayers }).map((_, i) => {
        const depth = baseLayers - i;
        const offset = depth * layerStep;
        const layerCardEntry = layerCards ? layerCards[layerCards.length - depth] : undefined;
        const fallbackCls = tone === 'burned'
          ? 'border-rose-600/60 bg-rose-500'
          : 'border-indigo-800/60 bg-indigo-700';
        const rotate = rotationFor(layerCardEntry, depth);
        return (
          <div
            key={i}
            aria-hidden
            className="absolute"
            style={{
              top: offset,
              left: offset,
              transform: rotate ? `rotate(${rotate}deg)` : undefined,
              transformOrigin: 'center center',
              filter: `brightness(${1 - depth * 0.04})`,
            }}
          >
            {layerCardEntry
              ? <CardFace card={layerCardEntry.card} jokerEffRank={layerCardEntry.effRank} magnifyOnHover />
              : <div className={`w-12 h-[68px] sm:w-16 sm:h-24 rounded-md border ${fallbackCls}`} />
            }
          </div>
        );
      })}
      <div
        className="absolute top-0 left-0"
        style={isPlayStack && count > 0 ? { transform: `rotate(${rotationFor(undefined, count)}deg)`, transformOrigin: 'center center' } : undefined}
      >
        {count > 0
          ? (top ?? <CardFace hidden />)
          : <div className="w-12 h-[68px] sm:w-16 sm:h-24 rounded-md border-2 border-dashed border-gray-400 flex items-center justify-center text-[10px] text-gray-400">{emptyLabel ?? 'empty'}</div>}
      </div>
    </div>
  );
}

// Refs the deck's on-screen position so AnimatedCard can fly from there into the hand.
const deckPosRef: React.MutableRefObject<{ x: number; y: number } | null> = { current: null };

function CenterPiles({ deckCount, pile, burnedCount, lastBurnSize }: {
  deckCount: number; pile: PileEntry[]; burnedCount: number; lastBurnSize: number;
}) {
  const top = pile[pile.length - 1];
  const deckRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      if (deckRef.current) {
        const r = deckRef.current.getBoundingClientRect();
        deckPosRef.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  });

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

  // Compact pile counter — icon + number on a single line, instead of the
  // verbose "deck: N" / "pile: N" / "burned: N" labels that ate vertical
  // space on small viewports. Tabular-nums keeps the digits aligned as
  // counts change.
  const Counter = ({ icon, label, n, tone }: { icon: string; label: string; n: number; tone?: string }) => (
    <span
      className={`text-[11px] sm:text-xs font-semibold tabular-nums drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)] flex items-center gap-1 ${tone ?? 'text-white/90'}`}
      title={`${label}: ${n}`}
    >
      <span aria-hidden>{icon}</span>
      <span>{n}</span>
    </span>
  );

  return (
    // Counters now render ABOVE each card stack (was below). With the
    // tighter mobile layout the bottom seats sit close to the centre piles
    // and the below-card labels (`📰 51` / `📥 0` / `BURNED 0`) bled into
    // the top of those tiles. items-end on the parent still aligns card
    // bottoms; the column flex order just lifts the counter off the seam.
    <div className="relative flex items-end gap-3 sm:gap-7 justify-center">
      <div className="flex flex-col items-center gap-1" ref={deckRef}>
        <Counter icon="🂠" label="deck" n={deckCount} />
        <CardStack count={deckCount} />
      </div>
      <div className="flex flex-col items-center gap-1 relative">
        <Counter icon="🃟" label="pile" n={pile.length} />
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
        <span
          className="text-[11px] sm:text-xs font-semibold tabular-nums drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)] flex items-center gap-1 text-rose-200"
          title={`burned: ${burnedCount}`}
        >
          <span className="text-rose-200/70 uppercase tracking-wider text-[9px] sm:text-[10px]">burned</span>
          <span>{burnedCount}</span>
        </span>
        <CardStack
          count={burnedCount}
          tone="burned"
          top={
            // Burned-pile glyph: glyph-less rose card-back. The rose tone +
            // stacked card-backs underneath already communicate "burned"
            // — no need for an icon on the face.
            <div
              className="relative w-12 h-[68px] sm:w-16 sm:h-24 rounded-md border border-rose-700/70 shadow-sm overflow-hidden"
              style={{
                backgroundImage: [
                  'repeating-linear-gradient(135deg, rgba(255,255,255,0.10) 0 6px, transparent 6px 12px)',
                  'repeating-linear-gradient( 45deg, rgba(0,0,0,0.18)    0 6px, transparent 6px 12px)',
                  'linear-gradient(135deg, #f43f5e 0%, #be123c 60%, #7f1d1d 100%)',
                ].join(', '),
              }}
            >
              <div
                className="absolute inset-[3px] rounded-[3px] pointer-events-none"
                style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.18), inset 0 0 0 2px rgba(0,0,0,0.20)' }}
              />
            </div>
          }
          emptyLabel="empty"
        />
        {/* A single soft rose ring expands briefly on each burn — replaces the old fire+embers fanfare.
            bottom-0 (was top-0) keeps the flash aligned with the card now that the counter sits above. */}
        <AnimatePresence>
          {lastBurnSize > 0 && (
            <motion.div
              key={`burn-flash-${burnedCount}`}
              initial={{ opacity: 0.7, scale: 0.7 }}
              animate={{ opacity: 0, scale: 1.6 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
              className="absolute bottom-0 w-12 h-[68px] sm:w-16 sm:h-24 rounded-md border-2 border-rose-500 pointer-events-none"
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ============== Game log (with ARIA live) ============== */

const LOG_COLLAPSED_KEY = 'ph_log_collapsed';
function loadLogCollapsed(): boolean {
  try { return localStorage.getItem(LOG_COLLAPSED_KEY) === '1'; } catch { return false; }
}
function saveLogCollapsed(v: boolean) {
  try { localStorage.setItem(LOG_COLLAPSED_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

function GameLog({ log, sidebar = false }: { log: string[]; sidebar?: boolean }) {
  // Sidebar mode: collapsible. Persist user preference so the choice
  // survives reloads and travels between rounds. The collapsed view is
  // a slim vertical rail (just the launcher button) so the game area
  // gets ~272px of horizontal space back. New-log "ping" pip nudges the
  // user when they're missing entries.
  const [collapsed, setCollapsed] = useState<boolean>(() => sidebar ? loadLogCollapsed() : false);
  const [unread, setUnread] = useState(0);
  const seenLenRef = useRef(log.length);
  useEffect(() => {
    if (!sidebar) return;
    if (!collapsed) { seenLenRef.current = log.length; setUnread(0); return; }
    if (log.length > seenLenRef.current) setUnread(log.length - seenLenRef.current);
  }, [log.length, collapsed, sidebar]);

  const toggle = () => {
    setCollapsed(c => {
      const next = !c;
      saveLogCollapsed(next);
      if (!next) { seenLenRef.current = log.length; setUnread(0); }
      return next;
    });
  };

  if (sidebar) {
    return (
      <div className={`hidden lg:flex flex-col shrink-0 ${collapsed ? 'w-9' : 'w-72'} transition-[width] duration-200 ease-out`}>
        {collapsed ? (
          <button
            onClick={toggle}
            aria-label="Open game log"
            className="relative w-9 h-28 self-start mt-2 rounded-r-lg bg-white/80 hover:bg-white border border-l-0 border-gray-300 flex flex-col items-center justify-center gap-1 text-gray-700 shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
          >
            <span aria-hidden className="text-base leading-none">📜</span>
            <span className="text-[9px] tracking-[0.2em] font-bold writing-mode-vertical [writing-mode:vertical-rl] [text-orientation:mixed]">LOG</span>
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
        ) : (
          <div className="w-72 max-h-[80vh] overflow-y-auto border border-gray-300 rounded-lg p-3 bg-white/70 text-sm">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold">Game log</div>
              <button
                onClick={toggle}
                aria-label="Collapse game log"
                title="Collapse"
                className="text-gray-500 hover:text-gray-800 px-1.5 py-0.5 rounded hover:bg-gray-200 leading-none"
              >»</button>
            </div>
            <ul aria-live="polite" className="space-y-1">
              {log.slice().reverse().map((l, i) => (
                <li key={i} className="text-gray-700 leading-snug">• {l}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // Embedded (e.g. mobile overlay) — no collapse affordance.
  return (
    <div className="p-3 text-sm">
      <ul aria-live="polite" className="space-y-1">
        {log.slice().reverse().map((l, i) => (
          <li key={i} className="text-gray-700 leading-snug">• {l}</li>
        ))}
      </ul>
    </div>
  );
}

// Slide-in overlay version of the game log (for mobile / tablet, where the sidebar is hidden).
function GameLogOverlay({ log, open, onClose }: { log: string[]; open: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-30 bg-black/40"
          />
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 280, damping: 30 }}
            className="fixed inset-y-0 right-0 z-40 w-80 max-w-[85vw] bg-stone-50 shadow-2xl overflow-y-auto"
          >
            <div className="px-3 py-2 flex items-center justify-between border-b border-gray-200 sticky top-0 bg-stone-50">
              <span className="font-semibold">📜 Game log</span>
              <button onClick={onClose} className="px-2 py-0.5 rounded hover:bg-gray-200" aria-label="Close log">×</button>
            </div>
            <GameLog log={log} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ============== Toasts ============== */

interface Toast { id: number; text: string; tone: 'reset' | 'burn' | 'skip' | 'reverse' | 'seven' | 'win' | 'info' }

// Tone palette: a small colored dot + a glow that tints the dark glass pill.
// All toasts share the same dark frosted-glass body so they read as a coherent
// system instead of a rainbow of garish solid colors.
const TONE_TOKENS: Record<Toast['tone'], { dot: string; glow: string; ring: string }> = {
  reset:   { dot: 'bg-sky-400',     glow: 'rgba(56,189,248,0.40)',  ring: 'ring-sky-400/30' },
  burn:    { dot: 'bg-rose-500',    glow: 'rgba(244,63,94,0.50)',   ring: 'ring-rose-400/40' },
  skip:    { dot: 'bg-amber-400',   glow: 'rgba(251,191,36,0.45)',  ring: 'ring-amber-400/35' },
  reverse: { dot: 'bg-fuchsia-400', glow: 'rgba(232,121,249,0.45)', ring: 'ring-fuchsia-400/35' },
  seven:   { dot: 'bg-pink-400',    glow: 'rgba(244,114,182,0.40)', ring: 'ring-pink-400/30' },
  win:     { dot: 'bg-emerald-400', glow: 'rgba(52,211,153,0.45)',  ring: 'ring-emerald-400/35' },
  info:    { dot: 'bg-slate-300',   glow: 'rgba(148,163,184,0.30)', ring: 'ring-slate-400/25' },
};

function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed top-14 sm:top-16 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2 pointer-events-none px-4 max-w-full">
      <AnimatePresence>
        {toasts.map(t => {
          const k = TONE_TOKENS[t.tone];
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: -12, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
              className={`flex items-center gap-2.5 pl-3 pr-4 py-1.5 rounded-full bg-slate-900/85 backdrop-blur-md ring-1 ${k.ring} text-white text-sm font-semibold tracking-wide shadow-[0_8px_24px_rgba(0,0,0,0.35)]`}
              style={{
                boxShadow: `0 6px 18px ${k.glow}, 0 0 0 1px rgba(255,255,255,0.04) inset`,
              }}
            >
              <span className={`relative inline-block w-2 h-2 rounded-full ${k.dot}`}>
                <span
                  className={`absolute inset-0 rounded-full ${k.dot} animate-ping opacity-60`}
                  aria-hidden
                />
              </span>
              <span className="whitespace-nowrap">{t.text}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/* ============== Status bar ==============
 *
 * Slim dark-glass pill that lives above the table. Earns its horizontal
 * space by surfacing the four facts a player needs at any glance:
 *   1. Whose turn — coloured dot + name + "(your move)" highlight
 *   2. Turn duration — live "thinking time" counter that resets whenever
 *      the current seat changes. Helps surface stalls (yours or theirs)
 *      without a separate timer ring.
 *   3. Pile context — top-of-pile rank + last actor, so you don't have
 *      to scan the centre piles to remember what you're playing onto.
 *   4. Restriction state — 7-lock / bonus / direction pips when active.
 * Plus the spectator-watching pip on the right when applicable.
 */
function StatusBar({ state, viewerId, isMyTurn, spectatorCount, connectedSeats }: { state: GameState; viewerId: number | null; isMyTurn: boolean; spectatorCount?: number; connectedSeats?: boolean[] }) {
  void viewerId;
  const p = state.players[state.current];
  const c = p ? colorFor(p.id) : null;

  // Live turn timer — wallclock seconds since the current seat became active.
  // Resets on every state.current transition. Updates once per second to
  // avoid re-rendering the whole table on a tick.
  const turnStartRef = useRef<number>(Date.now());
  const lastSeatRef = useRef<number>(state.current);
  if (lastSeatRef.current !== state.current) {
    turnStartRef.current = Date.now();
    lastSeatRef.current = state.current;
  }
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  void tick;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - turnStartRef.current) / 1000));
  const slow = elapsedSec >= 15;

  // Pile + last-actor context (skips when the pile is empty / fresh round).
  const top = state.pile.length > 0 ? state.pile[state.pile.length - 1] : null;
  const lastActor = state.lastPlayerId !== null ? state.players[state.lastPlayerId] : null;
  const lastDot = lastActor ? colorFor(lastActor.id) : null;

  return (
    <div
      className="mx-auto pl-20 sm:pl-24 pr-2 sm:pr-3 py-1.5 rounded-full bg-slate-900/80 backdrop-blur-md ring-1 ring-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.35)] text-white text-xs sm:text-sm flex flex-wrap items-center gap-x-3 gap-y-1.5"
    >
      {/* pl-20/24 leaves room for the fixed top-left menu (and Ultimate pill
          beneath it) so this row never crowds them. */}
      <span className="flex items-center gap-1.5 min-w-0">
        {c && <span className={`inline-block w-2 h-2 rounded-full ${c.dot} shrink-0`} />}
        <strong className="font-semibold truncate max-w-[140px] sm:max-w-[180px]">{p?.name}</strong>
        <span className="text-white/60">·</span>
        {(() => {
          const currentConnected = p?.isAi || (connectedSeats?.[state.current] ?? true);
          if (isMyTurn) return <span className="text-emerald-300 font-semibold tracking-wide">your move</span>;
          if (!currentConnected) {
            return (
              <span className="flex items-center gap-1 text-amber-300 font-semibold tracking-wide">
                <span aria-hidden>💤</span>
                offline
              </span>
            );
          }
          return <span className="text-white/65">thinking</span>;
        })()}
      </span>

      {/* Direction arrow — small, used to require a separate row. */}
      <span aria-label="direction" title={`Play direction: ${state.direction === 1 ? 'clockwise' : 'counter-clockwise'}`} className="text-white/55">
        {state.direction === 1 ? '↻' : '↺'}
      </span>

      {/* Restriction / bonus pips */}
      {state.sevenRestriction && (
        <span className="px-1.5 py-0.5 rounded-full bg-rose-500/25 text-rose-200 ring-1 ring-rose-400/30 text-[10px] font-bold tracking-wide">7-OR-LOWER</span>
      )}
      {state.lastWasMine && (
        <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/25 text-emerald-200 ring-1 ring-emerald-400/30 text-[10px] font-bold tracking-wide">BONUS</span>
      )}

      {/* Pile context — only when there's something to summarise. The "·"
          separator + small rank gives the bar weight without a chunky chip. */}
      {top && (
        <span className="hidden sm:flex items-center gap-1.5 text-white/75">
          <span className="text-white/40">pile</span>
          <span className={`font-bold ${RED_SUITS.includes(top.effSuit) ? 'text-rose-300' : 'text-white'}`}>
            {top.effRank}{top.effSuit}
          </span>
          {lastActor && (
            <span className="flex items-center gap-1 text-white/55">
              <span className="text-white/35">·</span>
              {lastDot && <span className={`inline-block w-1.5 h-1.5 rounded-full ${lastDot.dot}`} />}
              <span className="truncate max-w-[120px]">{lastActor.name}</span>
            </span>
          )}
        </span>
      )}

      {/* Live "thinking" counter on the right. Tints amber once it crosses
          15s so observers can spot stalls without a hard timer. */}
      <span className={`ml-auto tabular-nums font-mono text-[11px] ${slow ? 'text-amber-300' : 'text-white/55'}`}
        title="Time on this turn"
      >
        ⏱ {String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:{String(elapsedSec % 60).padStart(2, '0')}
      </span>

      {/* "👁 N watching" pip — surfaced to active players when spectators
          are connected. Auto-hides when zero. */}
      {spectatorCount !== undefined && spectatorCount > 0 && (
        <span
          className="px-2 py-0.5 rounded-full bg-violet-500/25 text-violet-200 ring-1 ring-violet-400/30 font-semibold flex items-center gap-1 text-[10px]"
          title={`${spectatorCount} spectator${spectatorCount === 1 ? '' : 's'} watching`}
        >
          <span aria-hidden>👁</span>
          {spectatorCount}
        </span>
      )}
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

/* ============== Game-start cinematic ==============
 *
 * IntroSequence orchestrates the opening "round establishing → player reel
 * → deal → settle" sequence as a fullscreen overlay. It mounts when a fresh
 * game's deal-key is detected (handled by useDealAnimationGate) and tears
 * itself down via onComplete.
 *
 * Beats (durations in ms — total ~3500ms):
 *   0      establishing  felt darkens, mode banner + "Latrine" wordmark fade in
 *   500    playerReel    avatar chips pop in around an elliptical layout,
 *                        staggered ~140ms each (or all at once if reduced motion)
 *   500+R  shuffle       small deck shuffles in centre
 *   1500   deal          three rounds: face-down → face-up → hand. Each round
 *                        deals one card to every seat in order, with subtly
 *                        different trajectories so the rows are legible.
 *   ~3000  settle        deck collapses, brief "Ready" caption, fade out
 *   ~3500  done          onComplete fires → swap UI takes over
 *
 * Players can tap/press any key to skip → fast-forward to onComplete.
 * `prefers-reduced-motion`: collapses to a 600ms cross-fade with no flying
 * cards (the player chips and a static "Dealing…" line are all that show).
 */
function IntroSequence({
  players,
  avatars,
  mode,
  aiDifficulty,
  onComplete,
}: {
  players: Player[];
  avatars: (string | null)[];
  mode: 'classic' | 'ultimate';
  aiDifficulty?: AiDifficulty;
  onComplete: () => void;
}) {
  const reduced = useReducedMotion();
  const n = players.length;
  const isHiddenIntroCard = (card: Card | undefined) =>
    !card || /^(hh|fd|dk|pr)-/.test(card.id);
  const introCardFor = (player: Player, row: number, col: number): Card | null => {
    if (row === 1) return player.faceUp[col] ?? null;
    if (row === 2) {
      const card = player.hand[col];
      return isHiddenIntroCard(card) ? null : card;
    }
    return null;
  };

  // Elliptical seating — viewer at the bottom (angle = π/2). Slightly squashed
  // vertically so it reads like a poker table rather than a circle. The
  // dealing destinations and the chip positions share these coordinates so
  // cards visibly "land" on the right player.
  //
  // Radii scale with the viewport so a 375px-wide phone doesn't put the
  // side seats outside the visible area. We measure once on mount and on
  // resize, then derive RX/RY from the smaller dimension. Falls back to
  // the desktop sizing during SSR / first paint.
  const [vw, setVW] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth));
  const [vh, setVH] = useState(() => (typeof window === 'undefined' ? 768 : window.innerHeight));
  useEffect(() => {
    const update = () => { setVW(window.innerWidth); setVH(window.innerHeight); };
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  // Stage targets up to 760×540 on desktop, but shrinks proportionally so
  // 2*RX + chip width fits the viewport with margin to spare.
  const stageW = Math.min(760, vw - 32);
  const stageH = Math.min(540, vh * 0.70);
  const RX = Math.max(110, stageW / 2 - 80);    // 80px margin per side reserves room for chips
  const RY = Math.max(70,  stageH / 2 - 70);
  const positions = useMemo(() => {
    return players.map((p, i) => {
      // Start at bottom, distribute clockwise. Add tiny offsets so 2-player
      // games don't put both seats on the vertical axis.
      const angle = (i / n) * Math.PI * 2 + Math.PI / 2;
      return {
        x: Math.cos(angle) * RX,
        y: Math.sin(angle) * RY,
        angle,
        name: p.name,
        isAi: !!p.isAi,
        avatar: avatars[i] ?? null,
      };
    });
  }, [players, avatars, n, RX, RY]);

  // Tunables.
  const ESTABLISH_MS = reduced ? 0 : 500;
  const REEL_PER_CHIP_MS = reduced ? 0 : 140;
  const REEL_DUR_MS = reduced ? 0 : Math.max(600, n * REEL_PER_CHIP_MS + 200);
  const SHUFFLE_MS = reduced ? 0 : 700;
  // Table-deal timing: 9 visible cards per player: 3 face-down, 3 face-up,
  // 3 to hand. We deal by row and column around the table, so every seat
  // visibly receives the same setup the reducer actually dealt.
  const DEAL_CARD_GAP_MS = reduced ? 0 : 54;
  const DEAL_TRAVEL_MS = reduced ? 0 : 430;
  const dealStart = ESTABLISH_MS + REEL_DUR_MS + SHUFFLE_MS;
  const totalDealCards = n * 9;
  const dealEnd = dealStart + Math.max(0, totalDealCards - 1) * DEAL_CARD_GAP_MS + DEAL_TRAVEL_MS;
  // dealEnd is the moment the last card lands. The +120ms buffer covers
  // the card's settle frame and lets the parent's exit fade overlap with
  // the table appearing — was 500ms, which felt like the overlay was
  // "stuck" after the action had clearly finished.
  const totalMs = reduced ? 800 : dealEnd + 120;

  // Skip-on-interaction. Any tap, click, or key press fast-forwards.
  const [skipped, setSkipped] = useState(false);
  const [skipArmed, setSkipArmed] = useState(false);
  useEffect(() => {
    if (skipped) {
      const t = setTimeout(onComplete, 180); // brief fade so it doesn't snap
      return () => clearTimeout(t);
    }
    const t = setTimeout(onComplete, totalMs);
    return () => clearTimeout(t);
  }, [skipped, onComplete, totalMs]);

  useEffect(() => {
    const handler = () => setSkipped(true);
    // Defer skip binding so the click/tap that started the game does not
    // bubble into the freshly mounted intro and immediately dismiss it.
    const arm = window.setTimeout(() => {
      setSkipArmed(true);
      window.addEventListener('keydown', handler, { once: true });
      window.addEventListener('pointerdown', handler, { once: true });
    }, 700);
    return () => {
      window.clearTimeout(arm);
      window.removeEventListener('keydown', handler);
      window.removeEventListener('pointerdown', handler);
    };
  }, []);

  // Audio choreography. Light click on each dealt card, with a soft shuffle
  // cue before the first card leaves the deck. Wrapped in timers so a skip clears them.
  useEffect(() => {
    if (reduced) return;
    const timers: number[] = [];
    timers.push(window.setTimeout(() => sfx.play('emote'), Math.max(0, dealStart - 80)));
    for (let cardIdx = 0; cardIdx < totalDealCards; cardIdx++) {
      const t = dealStart + cardIdx * DEAL_CARD_GAP_MS + Math.floor(DEAL_TRAVEL_MS * 0.74);
      timers.push(window.setTimeout(() => sfx.play('click'), t));
    }
    return () => timers.forEach(clearTimeout);
  }, [reduced, dealStart, totalDealCards, DEAL_CARD_GAP_MS, DEAL_TRAVEL_MS]);

  // Reduced-motion path: tiny crossfade with chips + caption only.
  if (reduced) {
    return (
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-40 flex items-center justify-center bg-stone-950/55 backdrop-blur-md"
      >
        <div className="text-white/90 text-base font-semibold tracking-wide">Dealing…</div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: skipped ? 0 : 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-40 flex items-center justify-center cursor-pointer"
      style={{
        background: [
          'radial-gradient(ellipse 90% 70% at 50% 48%, rgba(39,91,67,0.58), rgba(8,20,14,0.82) 68%, rgba(0,0,0,0.90))',
          'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.22))',
        ].join(', '),
        backdropFilter: 'blur(5px)',
      }}
      onClick={() => { if (skipArmed) setSkipped(true); }}
    >
      {/* Wordmark + mode chip — establishing shot. Stays visible all the way
          through establish + reel + shuffle, only beginning to fade once the
          first deal round starts. Positioned higher on mobile (vertical
          space is tight) and noticeably more centered on desktop so it
          reads as a proper title card. */}
      {(() => {
        const wordmarkVisibleMs = ESTABLISH_MS + REEL_DUR_MS + SHUFFLE_MS + 400;
        // Hold at full opacity for the bulk of that window — fade in fast,
        // fade out slowly as the deal kicks off.
        const inAt = 200 / wordmarkVisibleMs;
        const outAt = (wordmarkVisibleMs - 350) / wordmarkVisibleMs;
        return (
        // inset-x-0 + flex-center reliably centers the wordmark on the
        // viewport, regardless of letter-spacing widening the box. The
        // older left-1/2 + -translate-x-1/2 pattern combined with
        // `tracking-[0.22em]` could visually drift on wider screens.
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: [0, 1, 1, 0], y: [-12, 0, 0, -6] }}
          transition={{ duration: wordmarkVisibleMs / 1000, times: [0, inAt, outAt, 1] }}
          className="absolute top-5 sm:top-6 inset-x-0 flex flex-col items-center gap-2 z-10 pointer-events-none"
        >
          <div className="text-white/90 text-xl sm:text-3xl font-black tracking-[0.22em] drop-shadow-[0_4px_20px_rgba(0,0,0,0.55)] text-center">
            LATRINE
          </div>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
          <span className={`px-2.5 py-1 rounded-full font-bold ${mode === 'ultimate' ? 'bg-fuchsia-500/90 text-white' : 'bg-emerald-500/90 text-white'}`}>
            {mode === 'ultimate' ? '✦ Ultimate' : 'Classic'}
          </span>
          <span className="px-2.5 py-1 rounded-full bg-white/10 text-white/80 ring-1 ring-white/15">
            {n} player{n === 1 ? '' : 's'}
          </span>
          {aiDifficulty && players.some(p => p.isAi) && (
            <span className="px-2.5 py-1 rounded-full bg-white/10 text-white/80 ring-1 ring-white/15">
              vs AI · {aiDifficulty}
            </span>
          )}
        </div>
        </motion.div>
        );
      })()}

      {/* Stage — all elliptical layout coordinates are relative to the centre of this box.
          Width/height are derived from the viewport so chips/cards never escape it. */}
      <div
        className="table-stage relative"
        style={{
          width: stageW,
          height: stageH,
        }}
      >
        {/* Player chips — pop in around the table in order */}
        {positions.map((pos, i) => {
          const def = avatarDef(pos.avatar);
          return (
            <motion.div
              key={`chip-${i}`}
              initial={{ opacity: 0, scale: 0.6, x: pos.x * 1.25, y: pos.y * 1.25 }}
              animate={{
                opacity: 1, scale: 1,
                x: pos.x, y: pos.y,
              }}
              transition={{
                delay: (ESTABLISH_MS + i * REEL_PER_CHIP_MS) / 1000,
                type: 'spring', stiffness: 260, damping: 22,
              }}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 pointer-events-none"
            >
              <div
                className={`w-12 h-12 rounded-full ring-2 ring-white/30 shadow-[0_8px_24px_rgba(0,0,0,0.45)] flex items-center justify-center text-2xl bg-gradient-to-br ${def?.gradient ?? 'from-slate-500 to-slate-800'}`}
              >
                <span aria-hidden>{def?.emoji ?? (pos.isAi ? '🤖' : '👤')}</span>
              </div>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold text-white bg-slate-950/70 ring-1 ring-white/10 max-w-[110px] truncate shadow-[0_4px_12px_rgba(0,0,0,0.28)]">
                {pos.name}
                {pos.isAi && <span className="ml-1 text-white/55">· AI</span>}
              </span>
            </motion.div>
          );
        })}

        {/* Dealer deck — six stacked card-backs that shuffle in the centre. */}
        <motion.div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: (ESTABLISH_MS + REEL_DUR_MS - 200) / 1000, duration: 0.25 }}
        >
          {[0, 1, 2, 3, 4, 5].map(i => (
            <motion.div
              key={`shuffle-${i}`}
              initial={{ rotate: 0, x: 0, y: 0 }}
              animate={{
                rotate: [0, (i % 2 === 0 ? 18 : -18), 0],
                x: [0, (i % 2 === 0 ? 22 : -22), 0],
                y: [0, -i * 1.4, -i * 1.4],
              }}
              transition={{
                delay: (ESTABLISH_MS + REEL_DUR_MS) / 1000,
                duration: SHUFFLE_MS / 1000,
                ease: 'easeInOut',
              }}
              className="absolute -translate-x-1/2 -translate-y-1/2"
            >
              <CardFace hidden />
            </motion.div>
          ))}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: [0, 1, 1, 0], y: [4, 0, 0, -3] }}
          transition={{
            delay: (dealStart - 120) / 1000,
            duration: (dealEnd - dealStart + 420) / 1000,
            times: [0, 0.12, 0.82, 1],
          }}
          className="absolute left-1/2 top-1/2 mt-16 -translate-x-1/2 px-3 py-1 rounded-full bg-slate-950/70 ring-1 ring-white/10 text-white/80 text-[11px] font-semibold tracking-[0.16em] uppercase shadow-[0_6px_18px_rgba(0,0,0,0.30)]"
        >
          dealing around the table
        </motion.div>

        {/* The deal — 9 cards per player, arranged as 3 rows of 3. */}
        {positions.flatMap((pos, i) => {
          const player = players[i];
          const rot = (pos.angle * 180) / Math.PI + 90;
          const tangentX = -Math.sin(pos.angle);
          const tangentY = Math.cos(pos.angle);
          return Array.from({ length: 9 }).map((_, cardNo) => {
            const row = Math.floor(cardNo / 3);      // 0 face-down, 1 face-up, 2 hand
            const col = cardNo % 3;
            const cardIdx = cardNo * n + i;
            const cardDelay = dealStart + cardIdx * DEAL_CARD_GAP_MS;
            const visibleCard = introCardFor(player, row, col);
            // Tangent spreads each row into three card slots. Radial offset
            // creates the face-down / face-up / hand lanes toward each player.
            const tangent = (col - 1) * 14;
            const radial = (row - 1) * 18;
            const finalX = pos.x + tangentX * tangent + Math.cos(pos.angle) * radial;
            const finalY = pos.y + tangentY * tangent + Math.sin(pos.angle) * radial * 0.72;
            const midX = finalX * 0.46 + tangentX * (col - 1) * 8;
            const midY = finalY * 0.46 - 34 + row * 5;
            return (
              <motion.div
                key={`deal-${i}-${cardNo}`}
                initial={{ x: 0, y: 0, opacity: 0, scale: 0.92, rotate: 0 }}
                animate={{
                  x: [0, midX, finalX],
                  y: [0, midY, finalY],
                  opacity: [0, 1, 1, 0.94],
                  scale: [0.92, 0.70, 0.43],
                  rotate: [0, rot + (col - 1) * 7, rot + (col - 1) * 4],
                }}
                transition={{
                  delay: cardDelay / 1000,
                  duration: DEAL_TRAVEL_MS / 1000,
                  ease: [0.22, 0.82, 0.28, 1.0],
                  opacity: { duration: DEAL_TRAVEL_MS / 1000, times: [0, 0.12, 0.82, 1] },
                }}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              >
                {visibleCard
                  ? <CardFace card={visibleCard} />
                  : <CardFace hidden />}
              </motion.div>
            );
          });
        })}

        {/* Single "Dealing…" caption that holds through the full burst sequence. */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: [0, 1, 1, 0], y: [8, 0, 0, -4] }}
          transition={{
            delay: dealStart / 1000,
            duration: (dealEnd - dealStart) / 1000,
            times: [0, 0.12, 0.85, 1],
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-slate-950/75 ring-1 ring-white/10 text-white/90 text-xs font-semibold tracking-wide"
        >
          Dealing…
        </motion.div>

        {/* Final "Ready" line — appears as the deal finishes. */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: [0, 1, 0], y: [8, 0, -4] }}
          transition={{ delay: (dealEnd) / 1000, duration: 0.5, times: [0, 0.4, 1] }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-emerald-500/90 text-white text-xs font-bold tracking-wide shadow-[0_6px_20px_rgba(16,185,129,0.45)]"
        >
          Ready
        </motion.div>
      </div>

      {/* Skip hint — faint, lower-right. */}
      <div className="absolute bottom-4 right-4 text-[11px] text-white/50 select-none pointer-events-none">
        tap to skip
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
        {/* 3D flip-on-reveal — the card appears face-down then flips to
            its face over 500ms, mimicking the picker turning it over. */}
        <div className="scale-90" style={{ perspective: '600px' }}>
          <motion.div
            initial={{ rotateY: 180 }}
            animate={{ rotateY: 0 }}
            transition={{ duration: 0.55, delay: 0.18, ease: [0.4, 0.0, 0.2, 1] }}
            style={{ transformStyle: 'preserve-3d' }}
          >
            <CardFace card={card} />
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}

// Detect cards newly added to the viewer's hand specifically because the deck shrank.
// Each newly-drawn card gets its own timer so subsequent state changes (other players'
// turns landing while my fly-in is still running) don't cancel the cleanup and leak the
// card-back overlay.
const FLY_DURATION_MS = 700;
function useFromDeckTracker(state: GameState | null, viewerId: number): Set<string> {
  const [active, setActive] = useState<Set<string>>(new Set());
  const prev = useRef<{ hand: Set<string>; deck: number }>({ hand: new Set(), deck: 0 });
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!state) return;
    const player = state.players[viewerId];
    if (!player) {
      prev.current = { hand: new Set(), deck: state.deck.length };
      return;
    }
    const cur = new Set(player.hand.map(c => c.id));
    const newOnes = [...cur].filter(id => !prev.current.hand.has(id));
    const drewFromDeck = state.deck.length < prev.current.deck;
    prev.current = { hand: cur, deck: state.deck.length };
    if (drewFromDeck && newOnes.length > 0) {
      setActive(s => {
        const next = new Set(s);
        for (const id of newOnes) next.add(id);
        return next;
      });
      for (const id of newOnes) {
        const t = setTimeout(() => {
          setActive(s => {
            if (!s.has(id)) return s;
            const next = new Set(s);
            next.delete(id);
            return next;
          });
          timersRef.current.delete(id);
        }, FLY_DURATION_MS + 200);
        timersRef.current.set(id, t);
      }
    }
  }, [state, viewerId]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return active;
}

/* Per-player tile position registry. PlayerArea registers its own tile's
 * screen-centre on mount + on resize so the deck-draw overlay can target
 * each seat individually. The viewer's seat lands at roughly the same
 * spot as the old "bottom-centre" fallback, but other players now get
 * their own targeted flight too. */
const playerPosRefs: { current: Record<number, { x: number; y: number }> } = { current: {} };

function registerPlayerPos(id: number, el: HTMLElement | null) {
  if (!el) {
    delete playerPosRefs.current[id];
    return;
  }
  const r = el.getBoundingClientRect();
  playerPosRefs.current[id] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/* Per-player draw event tracker. The earlier "hand grew" approach missed
 * the common case: a player plays 1 card → reducer auto-refills 1 card in
 * the same transition, so hand size goes 3 → 3 (different cards) and the
 * size-delta is zero. We instead watch the DECK size and attribute any
 * shrink to state.lastPlayerId (the player whose play triggered the
 * refill). This works for human + AI seats uniformly and is robust to
 * redacted card ids in network mode. Auto-pruned after FLY_DURATION_MS. */
interface DrawEvent { key: number; playerId: number; count: number; }
function useAllPlayerDraws(state: GameState | null): DrawEvent[] {
  const [events, setEvents] = useState<DrawEvent[]>([]);
  const prevDeck = useRef<number | null>(null);
  const counterRef = useRef(0);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    if (!state) { prevDeck.current = null; return; }
    const deck = state.deck.length;
    const last = prevDeck.current;
    prevDeck.current = deck;
    if (last === null) return;
    const drew = last - deck;
    if (drew <= 0) return;                // deck grew or unchanged
    const drewBy = state.lastPlayerId;
    if (drewBy === null) return;          // initial deal / no recent actor
    counterRef.current += 1;
    const ev: DrawEvent = { key: counterRef.current, playerId: drewBy, count: Math.min(drew, 6) };
    setEvents(es => [...es, ev]);
    const t = setTimeout(() => {
      setEvents(es => es.filter(e => e.key !== ev.key));
      timersRef.current.delete(t);
    }, FLY_DURATION_MS + 250);
    timersRef.current.add(t);
  }, [state]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => { timers.forEach(clearTimeout); timers.clear(); };
  }, []);

  return events;
}

// Renders fixed-position card-back motion.divs that fly from the deck to
// each drawing player's tile. Uses screen coordinates from deckPosRef
// (registered by CenterPiles' deck DOM element) and the per-player
// playerPosRefs registry. Falls back to viewport center / bottom-centre
// if a position hasn't been measured yet.
function DeckDrawOverlay({ events }: { events: DrawEvent[] }) {
  if (events.length === 0) return null;
  const from = deckPosRef.current ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return (
    <div className="fixed inset-0 pointer-events-none z-30">
      <AnimatePresence>
        {events.flatMap(ev => {
          const target = playerPosRefs.current[ev.playerId]
            ?? { x: window.innerWidth / 2, y: window.innerHeight - 110 };
          return Array.from({ length: ev.count }).map((_, i) => (
            <motion.div
              key={`draw-${ev.key}-${i}`}
              initial={{ x: from.x - 32, y: from.y - 48, scale: 1, opacity: 1, rotate: 0 }}
              animate={{ x: target.x - 32, y: target.y - 48, scale: 0.7, opacity: 1, rotate: -180 }}
              exit={{ opacity: 0 }}
              transition={{ duration: FLY_DURATION_MS / 1000, ease: [0.16, 1, 0.3, 1], delay: i * 0.08 }}
              className="absolute"
            >
              <CardFace hidden />
            </motion.div>
          ));
        })}
      </AnimatePresence>
    </div>
  );
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
                <p>You can play <strong>multiple cards of the same rank</strong> in one turn (e.g. two 7s). <strong>Jokers can only be played with other Jokers</strong> — never combined with any other rank.</p>
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
                  <li>• A <strong>10</strong> burns the pile. Turn passes to the next player.</li>
                  <li>• <strong>4 of a kind in a row</strong> (across one or multiple turns) burns the pile. <strong>Turn passes</strong> — the burn no longer grants another turn.</li>
                  <li>• <strong>Exception:</strong> if a player plays <strong>four 3s in a single move</strong>, they go again.</li>
                  <li>• Burn check uses <em>actual</em> rank — a Joker copying a 7 does <strong>not</strong> count toward four 7s. Four real Jokers do burn.</li>
                  <li>• Burned cards go to the rose burn-stack so you can see how many have been removed from play.</li>
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

/* ============== Leaderboard ============== */

type LbScope = 'all' | 'online' | 'local';

function LeaderboardScreen({ onBack, auth }: { onBack: () => void; auth: AuthState }) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [scope, setScope] = useState<LbScope>('all');
  const [loading, setLoading] = useState(true);

  // Fetch on mount. Re-fetching on scope change isn't necessary — the RPC
  // returns all three columns and we just re-rank locally — saves round-trips.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchLeaderboard(50).then(r => {
      if (cancelled) return;
      setRows(r);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Re-rank by the active scope's wins. Players with zero games in the
  // selected scope are filtered out so the "Online" tab doesn't look padded
  // by guests-against-AI streaks.
  const ranked = useMemo(() => {
    if (!rows) return [];
    const pickWins   = scope === 'online' ? (r: LeaderboardRow) => r.online_wins   : scope === 'local' ? (r: LeaderboardRow) => r.local_wins   : (r: LeaderboardRow) => r.wins;
    const pickGames  = scope === 'online' ? (r: LeaderboardRow) => r.online_games  : scope === 'local' ? (r: LeaderboardRow) => r.local_games  : (r: LeaderboardRow) => r.games;
    const pickLosses = scope === 'online' ? (r: LeaderboardRow) => r.online_losses : scope === 'local' ? (r: LeaderboardRow) => r.local_losses : (r: LeaderboardRow) => r.losses;
    return rows
      .filter(r => pickGames(r) > 0)
      .map(r => ({ row: r, wins: pickWins(r), games: pickGames(r), losses: pickLosses(r) }))
      .sort((a, b) => b.wins - a.wins || b.games - a.games)
      .slice(0, 25);
  }, [rows, scope]);

  // Highlight the signed-in user's row when it appears.
  const myUsername = auth.profile?.username;

  // Top-line metric callouts pulled across the full result set (not just the
  // current scope) so the "best ever" headlines feel global, not slice-y.
  const headline = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const mostWins = [...rows].sort((a, b) => b.wins - a.wins)[0];
    const biggestPile = [...rows].sort((a, b) => b.largest_pile_ever - a.largest_pile_ever)[0];
    const mostOnline = [...rows].filter(r => r.online_games > 0).sort((a, b) => b.online_wins - a.online_wins)[0] ?? null;
    return { mostWins, biggestPile, mostOnline };
  }, [rows]);

  const tabBtn = (s: LbScope, label: string, emoji: string) => (
    <button
      type="button"
      onClick={() => setScope(s)}
      className={`flex-1 px-3 py-2 rounded-md text-sm font-semibold transition-colors flex items-center justify-center gap-1 ${
        scope === s
          ? 'bg-white text-gray-900 shadow-sm'
          : 'text-gray-300 hover:text-white'
      }`}
      aria-pressed={scope === s}
    ><span aria-hidden>{emoji}</span> {label}</button>
  );

  const medal = (pos: number) => pos === 0 ? '🥇' : pos === 1 ? '🥈' : pos === 2 ? '🥉' : `#${pos + 1}`;

  return (
    <div className="min-h-full p-6 sm:p-8 max-w-3xl mx-auto flex flex-col gap-5 text-white">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full">← Menu</button>
        <h1 className="text-2xl sm:text-3xl font-black tracking-tight drop-shadow">🏆 Leaderboard</h1>
      </div>

      {/* Headline cards — global "best in show" callouts independent of the
          active tab so the most impressive numbers always greet the user. */}
      {headline && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <HeadlineCard icon="👑" label="Most wins"     name={headline.mostWins?.username}    avatar={headline.mostWins?.avatar}    value={headline.mostWins ? `${headline.mostWins.wins} W` : '—'} />
          <HeadlineCard icon="🌐" label="Online king"   name={headline.mostOnline?.username}  avatar={headline.mostOnline?.avatar}  value={headline.mostOnline ? `${headline.mostOnline.online_wins} W` : '—'} />
          <HeadlineCard icon="🗑" label="Biggest pickup" name={headline.biggestPile?.username} avatar={headline.biggestPile?.avatar} value={headline.biggestPile ? `${headline.biggestPile.largest_pile_ever} cards` : '—'} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex bg-slate-900/60 ring-1 ring-white/10 rounded-lg p-1">
        {tabBtn('all', 'All', '🌍')}
        {tabBtn('online', 'Online', '🌐')}
        {tabBtn('local', 'Local', '🤖')}
      </div>

      {/* Table */}
      <div className="bg-white/95 text-gray-900 rounded-xl shadow-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : ranked.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            No games yet in this scope. {scope === 'online' && 'Play an online match to start the rankings!'}
            {scope === 'local' && 'Play a local match vs AI to start the rankings!'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-gray-500 uppercase tracking-wide border-b border-gray-200">
                <th className="text-left p-2 pl-4 w-12">#</th>
                <th className="text-left p-2">Player</th>
                <th className="p-2 text-right">Games</th>
                <th className="p-2 text-right">Wins</th>
                <th className="p-2 text-right">Losses</th>
                <th className="p-2 text-right pr-4">Win %</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((r, i) => {
                const winRate = r.games > 0 ? Math.round((r.wins / r.games) * 100) : 0;
                const me = !!myUsername && r.row.username === myUsername;
                return (
                  <tr
                    key={r.row.username}
                    className={`border-b border-gray-100 last:border-b-0 ${me ? 'bg-emerald-50' : ''}`}
                  >
                    <td className="p-2 pl-4 text-base">{medal(i)}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-2 font-semibold">
                        <Avatar avatar={r.row.avatar} name={r.row.username} size="sm" />
                        <span className="truncate">{r.row.username}</span>
                        {me && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-200 text-emerald-900 font-bold">you</span>}
                      </div>
                    </td>
                    <td className="p-2 text-right tabular-nums text-gray-700">{r.games}</td>
                    <td className="p-2 text-right tabular-nums font-bold text-emerald-700">{r.wins}</td>
                    <td className="p-2 text-right tabular-nums text-rose-700">{r.losses}</td>
                    <td className="p-2 pr-4 text-right tabular-nums text-gray-700">{winRate}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-white/60 text-center">
        Top 25 by wins in the selected scope. Sign in to appear on the board.
      </p>
    </div>
  );
}

function HeadlineCard({ icon, label, name, value, avatar }: { icon: string; label: string; name?: string | null; value: string; avatar?: string | null }) {
  return (
    <div className="bg-white/15 backdrop-blur-sm border border-white/20 rounded-xl px-3 py-2.5 text-white flex items-center gap-2.5">
      {name ? <Avatar avatar={avatar} name={name} size="md" /> : <div className="text-2xl" aria-hidden>{icon}</div>}
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-white/70 flex items-center gap-1">
          <span aria-hidden>{icon}</span> {label}
        </div>
        <div className="text-sm font-bold truncate">{name ?? '—'}</div>
        <div className="text-xs text-white/80">{value}</div>
      </div>
    </div>
  );
}

/* ============== Avatar ============== */

// Reusable avatar pill — gradient background + emoji on top when an avatar
// key is set, otherwise a clean letter on emerald gradient as the fallback.
// Used on the profile header, leaderboard rows, anywhere a user's identity
// appears.
function Avatar({ avatar, name, size = 'md' }: { avatar?: string | null; name?: string | null; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const dims =
    size === 'xl' ? 'w-20 h-20 text-4xl' :
    size === 'lg' ? 'w-16 h-16 text-3xl' :
    size === 'md' ? 'w-10 h-10 text-xl' :
                    'w-7 h-7 text-base';
  const def = avatarDef(avatar);
  // Subtle idle "breathe" on the inner emoji/glyph — 0.96 ↔ 1.04 over 3.4s.
  // Adds life to the table during quiet moments without competing with the
  // active-player spotlight. Reduced-motion users get a static avatar.
  if (def) {
    return (
      <div
        className={`${dims} rounded-full bg-gradient-to-br ${def.gradient} flex items-center justify-center shrink-0 shadow-inner ring-1 ring-white/30`}
        aria-label={`avatar: ${def.key}`}
      >
        <motion.span
          aria-hidden
          animate={{ scale: [1, 1.04, 0.97, 1] }}
          transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
          className="leading-none"
        >{def.emoji}</motion.span>
      </div>
    );
  }
  return (
    <div
      className={`${dims} rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white font-black flex items-center justify-center shrink-0 shadow-inner ring-1 ring-white/30`}
      aria-label="avatar"
    >
      <motion.span
        aria-hidden
        animate={{ scale: [1, 1.04, 0.97, 1] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
        className="leading-none"
      >{(name ?? '?').slice(0, 1).toUpperCase()}</motion.span>
    </div>
  );
}

// Picker grid modal — click an avatar to choose. Selected one gets a ring.
function AvatarPicker({ current, onChoose, onClose }: { current: string | null | undefined; onChoose: (key: string | null) => void; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-stone-900/65 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 12, opacity: 0, scale: 0.96 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 12, opacity: 0, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5 sm:p-6 flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Choose your avatar"
      >
        <div>
          <h3 className="text-xl font-bold mb-1">Choose your avatar</h3>
          <p className="text-sm text-gray-600">Pick one — show off your style.</p>
        </div>
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-2.5">
          {/* Default / clear option */}
          <button
            onClick={() => onChoose(null)}
            title="Default (initial)"
            className={`relative w-14 h-14 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white font-black flex items-center justify-center text-2xl ${
              current ? 'opacity-70 hover:opacity-100' : 'ring-4 ring-emerald-300'
            } hover:scale-105 transition-transform`}
            aria-pressed={!current}
          >
            A
          </button>
          {AVATARS.map(a => {
            const sel = a.key === current;
            return (
              <button
                key={a.key}
                onClick={() => onChoose(a.key)}
                title={a.key}
                className={`relative w-14 h-14 rounded-full bg-gradient-to-br ${a.gradient} text-3xl flex items-center justify-center ${
                  sel ? 'ring-4 ring-emerald-400 scale-105' : 'hover:scale-105'
                } transition-transform shadow-inner`}
                aria-pressed={sel}
              >
                <span aria-hidden>{a.emoji}</span>
              </button>
            );
          })}
        </div>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-800 self-center">Close</button>
      </motion.div>
    </motion.div>
  );
}

/* ============== Match replay (log-based) ============== */

// Tag each log line with a tone so we can color-code the replay timeline.
// Cheap regex match — same shape the in-game toast handler uses, just for
// presentation rather than sound/haptic.
type LogTone = 'play' | 'pickup' | 'burn' | 'reset' | 'reverse' | 'skip' | 'seven' | 'cut' | 'chain' | 'win' | 'flip' | 'info';
function classifyLog(line: string): LogTone {
  if (/POOP HEAD|is OUT/i.test(line))                return 'win';
  if (/Pile burned|Four of a kind/i.test(line))      return 'burn';
  if (/picked up|Picks up/i.test(line))              return 'pickup';
  if (/pile reset/i.test(line))                      return 'reset';
  if (/direction reversed/i.test(line))              return 'reverse';
  if (/skipped/i.test(line))                         return 'skip';
  if (/7-or-lower/i.test(line))                      return 'seven';
  if (/CUT with/i.test(line))                        return 'cut';
  if (/chained/i.test(line))                         return 'chain';
  if (/flipped/i.test(line))                         return 'flip';
  if (/played/i.test(line))                          return 'play';
  return 'info';
}

const LOG_TONE_CLASS: Record<LogTone, string> = {
  play:    'bg-white text-gray-900 border-gray-200',
  pickup:  'bg-amber-50 text-amber-900 border-amber-300',
  burn:    'bg-rose-50 text-rose-900 border-rose-300',
  reset:   'bg-sky-50 text-sky-900 border-sky-300',
  reverse: 'bg-violet-50 text-violet-900 border-violet-300',
  skip:    'bg-amber-50 text-amber-900 border-amber-300',
  seven:   'bg-pink-50 text-pink-900 border-pink-300',
  cut:     'bg-fuchsia-50 text-fuchsia-900 border-fuchsia-300',
  chain:   'bg-emerald-50 text-emerald-900 border-emerald-300',
  win:     'bg-emerald-100 text-emerald-900 border-emerald-400 font-bold',
  flip:    'bg-indigo-50 text-indigo-900 border-indigo-300',
  info:    'bg-gray-50 text-gray-700 border-gray-200',
};
const LOG_TONE_ICON: Record<LogTone, string> = {
  play: '🃏', pickup: '📥', burn: '🔥', reset: '🔄', reverse: '↺', skip: '⏭',
  seven: '🔒', cut: '✂', chain: '↪', win: '🏆', flip: '🔍', info: '·',
};

/* ---- Visual replay (parses the log into events, plays them back) ---- */

type ReplayEvent =
  | { kind: 'play';       actor: string; cards: { rank: string; suit: string }[] }
  | { kind: 'cut';        actor: string; cards: { rank: string; suit: string }[] }
  | { kind: 'chain';      actor: string; cards: { rank: string; suit: string }[] }
  | { kind: 'pickup';     actor: string; count: number }
  | { kind: 'revealPickup'; actor: string; count: number }
  | { kind: 'revealShown'; actor: string; rank: string; suit: string }
  | { kind: 'flip';       actor: string; rank: string; suit: string; legal: boolean; pickedUp?: number }
  | { kind: 'burnTen';    count: number }
  | { kind: 'burnFour';   count: number; fourThrees: boolean }
  | { kind: 'reset' }
  | { kind: 'reverse' }
  | { kind: 'reverseCut' }
  | { kind: 'skip' }
  | { kind: 'seven' }
  | { kind: 'out';        actor: string; place: number }
  | { kind: 'end';        loser: string }
  | { kind: 'info';       line: string };

const CARD_RE = /(JK|10|[2-9JQKA])([♠♥♦♣★])/g;
function extractCards(line: string): { rank: string; suit: string }[] {
  const out: { rank: string; suit: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = CARD_RE.exec(line))) out.push({ rank: m[1], suit: m[2] });
  CARD_RE.lastIndex = 0;
  return out;
}

// Order matters — most specific patterns first so e.g. "8 played — next
// player is skipped" routes to 'skip' rather than 'play'.
function parseLine(line: string): ReplayEvent {
  if (/Pile burned by 10/.test(line)) {
    const m = line.match(/\((\d+) cards/);
    return { kind: 'burnTen', count: m ? +m[1] : 0 };
  }
  if (/Four of a kind/.test(line)) {
    const m = line.match(/\((\d+) cards/);
    return { kind: 'burnFour', count: m ? +m[1] : 0, fourThrees: /four 3s/.test(line) };
  }
  if (/pile reset/.test(line))               return { kind: 'reset' };
  if (/direction reversed/.test(line))       return { kind: 'reverse' };
  if (/direction unchanged/.test(line))      return { kind: 'reverseCut' };
  if (/next player is skipped/.test(line))   return { kind: 'skip' };
  if (/7-or-lower/.test(line))               return { kind: 'seven' };
  if (/POOP HEAD/.test(line)) {
    const m = line.match(/^(.+?) is the POOP HEAD/);
    return { kind: 'end', loser: m ? m[1].trim() : '' };
  }
  if (/is OUT/.test(line)) {
    const m = line.match(/^(.+?) is OUT \(place #(\d+)\)/);
    return { kind: 'out', actor: m ? m[1].trim() : '', place: m ? +m[2] : 0 };
  }
  if (/CUT with/.test(line)) {
    const m = line.match(/^(.+?) CUT with /);
    return { kind: 'cut', actor: m ? m[1].trim() : '', cards: extractCards(line) };
  }
  if (/\bchained\b/.test(line)) {
    const m = line.match(/^(.+?) chained /);
    return { kind: 'chain', actor: m ? m[1].trim() : '', cards: extractCards(line) };
  }
  if (/picked up the pile/.test(line)) {
    const m = line.match(/^(.+?) picked up the pile \((\d+)/);
    return { kind: 'pickup', actor: m ? m[1].trim() : '', count: m ? +m[2] : 0 };
  }
  if (/picked up \d+ — must reveal/.test(line)) {
    const m = line.match(/^(.+?) picked up (\d+)/);
    return { kind: 'revealPickup', actor: m ? m[1].trim() : '', count: m ? +m[2] : 0 };
  }
  if (/revealed:/.test(line)) {
    const m = line.match(/^(.+?) revealed:/);
    const cards = extractCards(line);
    return { kind: 'revealShown', actor: m ? m[1].trim() : '', rank: cards[0]?.rank ?? '', suit: cards[0]?.suit ?? '' };
  }
  if (/flipped face-down/.test(line)) {
    const m = line.match(/^(.+?) flipped face-down /);
    const cards = extractCards(line);
    return { kind: 'flip', actor: m ? m[1].trim() : '', rank: cards[0]?.rank ?? '', suit: cards[0]?.suit ?? '', legal: true };
  }
  if (/flipped .+ — illegal/.test(line)) {
    const m = line.match(/^(.+?) flipped /);
    const m2 = line.match(/Picks up (\d+)/);
    const cards = extractCards(line);
    return { kind: 'flip', actor: m ? m[1].trim() : '', rank: cards[0]?.rank ?? '', suit: cards[0]?.suit ?? '', legal: false, pickedUp: m2 ? +m2[1] : 0 };
  }
  if (/ played /.test(line)) {
    const m = line.match(/^(.+?) played /);
    return { kind: 'play', actor: m ? m[1].trim() : '', cards: extractCards(line) };
  }
  return { kind: 'info', line };
}

function eventDurationMs(ev: ReplayEvent): number {
  switch (ev.kind) {
    case 'play': case 'chain': case 'cut':           return 850;
    case 'pickup': case 'revealPickup':              return 1400;
    case 'burnTen': case 'burnFour':                 return 1300;
    case 'reverse': case 'reverseCut':
    case 'skip': case 'seven': case 'reset':         return 950;
    case 'flip':                                     return 1100;
    case 'revealShown':                              return 1100;
    case 'out':                                      return 1600;
    case 'end':                                      return 2500;
    default:                                         return 500;
  }
}

// Synthesise a Card object so we can reuse <CardFace> for the visual.
function synthCard(rank: string, suit: string): Card {
  return { id: `replay-${rank}-${suit}-${Math.random().toString(36).slice(2, 6)}`, rank: rank as Rank, suit: suit as Suit };
}

// Apply an event to a virtual pile so we can show the pile state at each step.
function applyToPile(pile: Card[], ev: ReplayEvent): Card[] {
  switch (ev.kind) {
    case 'play': case 'chain': case 'cut':
      return [...pile, ...ev.cards.map(c => synthCard(c.rank, c.suit))];
    case 'flip':
      return ev.legal ? [...pile, synthCard(ev.rank, ev.suit)] : [];
    case 'pickup': case 'revealPickup':
    case 'burnTen': case 'burnFour':
      return [];
    default:
      return pile;
  }
}

function eventLabel(ev: ReplayEvent): { actor: string; text: string; tone: string; banner?: string } {
  const fmtCards = (cs: { rank: string; suit: string }[]) =>
    cs.map(c => `${c.rank === 'JK' ? 'J' : c.rank}${c.suit}`).join(' + ');
  switch (ev.kind) {
    case 'play':         return { actor: ev.actor, text: `played ${fmtCards(ev.cards)}`, tone: 'text-white' };
    case 'chain':        return { actor: ev.actor, text: `chained ${fmtCards(ev.cards)}`, tone: 'text-emerald-300', banner: '↪ CHAIN' };
    case 'cut':          return { actor: ev.actor, text: `CUT with ${fmtCards(ev.cards)}`, tone: 'text-fuchsia-300', banner: '✂ CUT' };
    case 'pickup':       return { actor: ev.actor, text: `picked up ${ev.count} card${ev.count === 1 ? '' : 's'}`, tone: 'text-amber-300', banner: '📥 PICKUP' };
    case 'revealPickup': return { actor: ev.actor, text: `picked up ${ev.count} — must reveal`, tone: 'text-amber-300', banner: '📥 PICKUP' };
    case 'revealShown':  return { actor: ev.actor, text: `revealed ${ev.rank}${ev.suit}`, tone: 'text-indigo-300' };
    case 'flip':         return ev.legal
      ? { actor: ev.actor, text: `flipped ${ev.rank}${ev.suit} — legal!`, tone: 'text-emerald-300' }
      : { actor: ev.actor, text: `flipped ${ev.rank}${ev.suit} — illegal! Picks up ${ev.pickedUp ?? 0}`, tone: 'text-rose-300', banner: '💢 ILLEGAL' };
    case 'burnTen':      return { actor: '', text: `Pile burned by 10 (${ev.count} cards)`, tone: 'text-rose-300', banner: '🔥 BURN' };
    case 'burnFour':     return { actor: '', text: `Four of a kind! ${ev.count} cards burned${ev.fourThrees ? ' (four 3s — same player)' : ''}`, tone: 'text-rose-300', banner: '🔥 4-OF-A-KIND' };
    case 'reset':        return { actor: '', text: '2 played — pile reset', tone: 'text-sky-300', banner: '🔄 RESET' };
    case 'reverse':      return { actor: '', text: 'King — direction reversed', tone: 'text-violet-300', banner: '↺ REVERSE' };
    case 'reverseCut':   return { actor: '', text: 'King as cut — direction unchanged', tone: 'text-violet-300' };
    case 'skip':         return { actor: '', text: '8 played — next player skipped', tone: 'text-amber-300', banner: '⏭ SKIP' };
    case 'seven':        return { actor: '', text: '7 played — 7-or-lower lock', tone: 'text-pink-300' };
    case 'out':          return { actor: ev.actor, text: `is OUT (place #${ev.place})`, tone: 'text-emerald-300', banner: ev.place === 1 ? '🏆 WINNER' : '🎉 OUT' };
    case 'end':          return { actor: ev.loser, text: 'is the POOP HEAD!', tone: 'text-rose-300', banner: '💩 POOP HEAD' };
    case 'info':         return { actor: '', text: ev.line, tone: 'text-white/70' };
  }
}

function ReplayPlayer({ lines }: { lines: string[] }) {
  const events = useMemo(() => lines.map(parseLine), [lines]);
  const pileStates = useMemo(() => {
    const out: Card[][] = [];
    let pile: Card[] = [];
    for (const ev of events) { pile = applyToPile(pile, ev); out.push(pile); }
    return out;
  }, [events]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);

  // Auto-advance while playing. Stops when reaching the end.
  useEffect(() => {
    if (!playing) return;
    if (index >= events.length - 1) { setPlaying(false); return; }
    const dur = eventDurationMs(events[index]) / speed;
    const t = setTimeout(() => setIndex(i => Math.min(i + 1, events.length - 1)), dur);
    return () => clearTimeout(t);
  }, [index, playing, speed, events]);

  if (events.length === 0) {
    return <div className="p-6 text-center text-sm text-white/60">No replay data.</div>;
  }

  const current = events[index];
  const pile = pileStates[index];
  const top4 = pile.slice(-4);
  const label = eventLabel(current);
  const isAtEnd = index >= events.length - 1;

  return (
    <div className="flex flex-col bg-emerald-900 text-white">
      {/* Stage */}
      <div className="relative h-56 sm:h-64 overflow-hidden bg-gradient-to-br from-emerald-700 to-emerald-900">
        {/* Soft felt vignette */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.08),transparent_70%)]" />
        {/* Header line — actor + action */}
        <div className="absolute top-3 inset-x-3 flex items-center justify-between text-sm">
          <div className={`font-semibold ${label.tone}`}>
            {label.actor && <span className="text-white/95">{label.actor}</span>}{label.actor && ' '}{label.text}
          </div>
          <div className="text-xs text-white/60 tabular-nums">{index + 1} / {events.length}</div>
        </div>
        {/* Pile preview — stacked top 4 cards, last one most prominent */}
        <div className="absolute inset-0 flex items-center justify-center">
          {top4.length === 0 ? (
            <div className="text-white/40 text-sm italic">Pile empty</div>
          ) : (
            <div className="relative" style={{ width: 200, height: 130 }}>
              {top4.map((c, i) => {
                const offset = (i - top4.length + 1) * 14;
                const rot = (i - top4.length + 1) * 4;
                return (
                  <motion.div
                    key={c.id}
                    initial={{ y: -40, opacity: 0, scale: 0.8, rotate: rot - 8 }}
                    animate={{ y: 0, opacity: 1, scale: 1, rotate: rot }}
                    transition={{ type: 'spring', stiffness: 320, damping: 26 }}
                    className="absolute"
                    style={{ left: 50 + offset, top: 10 - offset / 2, zIndex: i }}
                  >
                    <CardFace card={c} />
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
        {/* Big banner overlay for noteworthy events */}
        <AnimatePresence>
          {label.banner && (
            <motion.div
              key={`banner-${index}`}
              initial={{ opacity: 0, scale: 0.6, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 280, damping: 22 }}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-slate-900/80 backdrop-blur-md ring-1 ring-white/15 text-sm font-bold tracking-wide shadow-lg"
            >
              {label.banner}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Controls */}
      <div className="bg-slate-900/95 px-3 py-2.5 flex items-center gap-2">
        <button
          onClick={() => setIndex(i => Math.max(0, i - 1))}
          className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 flex items-center justify-center"
          disabled={index === 0}
          aria-label="Previous"
        >⏮</button>
        <button
          onClick={() => {
            if (isAtEnd) { setIndex(0); setPlaying(true); return; }
            setPlaying(p => !p);
          }}
          className="w-10 h-10 rounded-full bg-emerald-500 hover:bg-emerald-400 flex items-center justify-center text-lg font-bold shadow"
          aria-label={playing ? 'Pause' : 'Play'}
        >{isAtEnd ? '⟲' : playing ? '⏸' : '▶'}</button>
        <button
          onClick={() => setIndex(i => Math.min(events.length - 1, i + 1))}
          className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 flex items-center justify-center"
          disabled={isAtEnd}
          aria-label="Next"
        >⏭</button>
        <input
          type="range"
          min={0}
          max={events.length - 1}
          value={index}
          onChange={e => { setIndex(+e.target.value); setPlaying(false); }}
          className="flex-1 accent-emerald-400"
          aria-label="Scrub"
        />
        <select
          value={speed}
          onChange={e => setSpeed(+e.target.value)}
          className="bg-white/10 hover:bg-white/20 text-xs rounded px-2 py-1 cursor-pointer"
          aria-label="Speed"
        >
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>
      </div>
    </div>
  );
}

function ReplayModal({ match, onClose }: { match: MatchHistoryRow; onClose: () => void }) {
  const lines = match.game_log ?? [];
  const won = match.finish_pos === 1;
  const lost = match.was_poop_head;
  const date = new Date(match.played_at);
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-stone-900/65 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 12, opacity: 0, scale: 0.96 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 12, opacity: 0, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Match replay"
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl" aria-hidden>{won ? '🏆' : lost ? '💩' : '🃏'}</span>
              <h3 className="text-lg font-bold truncate">
                {match.mode === 'ultimate' ? 'Ultimate' : 'Classic'} · {match.online ? 'Online' : 'vs AI'}
              </h3>
            </div>
            <div className="text-xs text-gray-500">
              {date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              {' · '}{match.player_count} players{match.ai_count > 0 ? ` (${match.ai_count} AI)` : ''}
            </div>
            <div className={`mt-1 inline-block text-xs font-bold px-2 py-0.5 rounded-full ${
              won ? 'bg-emerald-100 text-emerald-800'
              : lost ? 'bg-rose-100 text-rose-800'
              : 'bg-gray-100 text-gray-700'
            }`}>
              {won ? 'WON' : lost ? 'POOP HEAD' : `Finished #${match.finish_pos ?? '?'}`}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        {/* Per-match stats row */}
        <div className="px-5 py-3 grid grid-cols-3 sm:grid-cols-5 gap-2 border-b border-gray-100 bg-gray-50">
          <ReplayStat label="Played"   value={match.cards_played} />
          <ReplayStat label="Pickups"  value={match.pickups} />
          <ReplayStat label="Burns"    value={match.burns} />
          <ReplayStat label="Power"    value={match.power_cards} />
          <ReplayStat label="Biggest"  value={match.largest_pile} />
        </div>

        {/* Visual playback — header banner + auto-advancing pile, controls,
            scrubber. Built directly on top of the human-readable log we
            already store, no extra DB schema. */}
        {lines.length > 0 && <ReplayPlayer lines={lines} />}

        {/* Log timeline (detail) */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {lines.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-500">
              No play-by-play recorded for this match.
            </div>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {lines.map((line, i) => {
                const tone = classifyLog(line);
                return (
                  <li
                    key={i}
                    className={`text-xs leading-snug px-2.5 py-1.5 rounded-md border flex items-start gap-2 ${LOG_TONE_CLASS[tone]}`}
                  >
                    <span aria-hidden className="text-base leading-none shrink-0 mt-px">{LOG_TONE_ICON[tone]}</span>
                    <span className="flex-1">{line}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 text-center">
          <button onClick={onClose} className="text-sm text-gray-600 hover:text-gray-900">Close</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ReplayStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">{label}</div>
      <div className="text-base font-bold tabular-nums text-gray-900">{value}</div>
    </div>
  );
}

/* ============== Profile ============== */

function ProfileScreen({ auth, onBack }: { auth: AuthState; onBack: () => void }) {
  const [matches, setMatches] = useState<MatchHistoryRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRecentMatches(20).then(rows => { if (!cancelled) setMatches(rows); });
    auth.refreshStats();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click a recent match row to open the play-by-play replay modal.
  const [replayMatch, setReplayMatch] = useState<MatchHistoryRow | null>(null);

  // Avatar picker — opens a grid modal; choose one (or null for default)
  // and persist via the RPC. Stats refresh re-renders the header.
  const [avatarOpen, setAvatarOpen] = useState(false);
  const onPickAvatar = async (key: string | null) => {
    setAvatarOpen(false);
    await updateAvatar(key);
    auth.refreshStats();
  };

  // Edit username — controlled inline. Server enforces format + uniqueness;
  // a successful save bumps the local profile so the header re-renders.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(auth.profile?.username ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!editing) setDraft(auth.profile?.username ?? ''); }, [auth.profile?.username, editing]);
  const saveUsername = async () => {
    if (saving) return;
    setSaving(true); setErr(null);
    const r = await updateUsername(draft);
    setSaving(false);
    if (!r.ok) { setErr(r.error); return; }
    setEditing(false);
    // The auth hook listens for auth changes, not profile updates, so we
    // optimistically refresh profile via getSession's downstream loader by
    // calling refreshStats (which triggers loadAll). Easiest path.
    auth.refreshStats();
  };

  const stats = auth.stats;
  const sess = auth.session;
  const profile = auth.profile;
  if (!sess?.user) {
    return (
      <div className="min-h-full p-6 flex flex-col items-center justify-center gap-4 text-white">
        <div className="text-lg">Sign in to see your profile.</div>
        <button onClick={onBack} className="text-sm px-3 py-1.5 bg-white/15 hover:bg-white/25 border border-white/25 rounded-full">← Menu</button>
      </div>
    );
  }

  // Streak: count consecutive wins from the most recent match backward.
  const streak = (() => {
    if (!matches) return 0;
    let n = 0;
    for (const m of matches) {
      if (m.finish_pos === 1) n++;
      else break;
    }
    return n;
  })();

  // Per-mode breakdown derived from match history (source of truth: match
  // rows we already pulled). Falls back to zero buckets pre-load.
  const modeBreakdown = (() => {
    const init = { classic: { w: 0, l: 0, g: 0 }, ultimate: { w: 0, l: 0, g: 0 } };
    if (!matches) return init;
    for (const m of matches) {
      const b = init[m.mode];
      b.g += 1;
      if (m.finish_pos === 1) b.w += 1;
      else if (m.was_poop_head) b.l += 1;
    }
    return init;
  })();

  const winRate = stats && stats.games_played > 0
    ? Math.round((stats.wins / stats.games_played) * 100)
    : 0;

  const memberSince = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
    : null;

  return (
    <div className="min-h-full p-6 sm:p-8 max-w-3xl mx-auto flex flex-col gap-5 text-white">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full">← Menu</button>
        <h1 className="text-2xl sm:text-3xl font-black tracking-tight drop-shadow">Your profile</h1>
      </div>

      {/* Header card — username (editable), email, member since, streak */}
      <div className="bg-white/95 text-gray-900 rounded-2xl shadow-xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4">
        <button
          onClick={() => setAvatarOpen(true)}
          aria-label="Change avatar"
          className="relative shrink-0 group"
        >
          <Avatar avatar={profile?.avatar} name={profile?.username} size="lg" />
          <span className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-white text-gray-700 text-xs flex items-center justify-center shadow ring-2 ring-white group-hover:bg-emerald-500 group-hover:text-white transition-colors">✏</span>
        </button>
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  maxLength={USERNAME_MAX}
                  className="px-2.5 py-1 border border-gray-300 rounded text-base font-bold w-44"
                />
                <button
                  onClick={saveUsername}
                  disabled={saving}
                  className={`px-3 py-1 rounded text-xs font-semibold ${saving ? 'bg-gray-200 text-gray-500' : 'bg-emerald-500 hover:bg-emerald-600 text-white'}`}
                >Save</button>
                <button
                  onClick={() => { setEditing(false); setErr(null); }}
                  className="px-3 py-1 rounded text-xs font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200"
                >Cancel</button>
              </div>
              {err && <div className="text-xs text-rose-700">{err}</div>}
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-2xl font-black truncate">{profile?.username ?? 'Unnamed'}</h2>
              <button
                onClick={() => setEditing(true)}
                className="text-xs px-2 py-0.5 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50"
              >Edit</button>
            </div>
          )}
          <div className="text-sm text-gray-500 truncate">{sess.user.email}</div>
          {memberSince && <div className="text-xs text-gray-400 mt-0.5">Member since {memberSince}</div>}
        </div>
        {streak >= 2 && (
          <div className="px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-center shrink-0">
            <div className="text-[10px] uppercase tracking-wider font-bold">🔥 Streak</div>
            <div className="text-xl font-black tabular-nums">{streak}W</div>
          </div>
        )}
      </div>

      {/* Hero metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <HeroStat label="Wins" value={stats?.wins ?? 0} tone="emerald" />
        <HeroStat label="Losses" value={stats?.losses ?? 0} tone="rose" />
        <HeroStat label="Win rate" value={`${winRate}%`} tone="amber" />
        <HeroStat label="Games" value={stats?.games_played ?? 0} tone="slate" />
      </div>

      {/* Online vs local strip + mode breakdown — quick visual segmentation */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <BreakdownCard
          icon="🌐"
          label="Online"
          games={stats?.online_games ?? 0}
          wins={(stats?.online_games ?? 0) === 0 ? 0 : matches?.filter(m => m.online && m.finish_pos === 1).length ?? 0}
        />
        <BreakdownCard
          icon="🤖"
          label="Local (vs AI)"
          games={(stats?.games_played ?? 0) - (stats?.online_games ?? 0)}
          wins={matches?.filter(m => !m.online && m.finish_pos === 1).length ?? 0}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <ModeStrip label="Classic" {...modeBreakdown.classic} />
        <ModeStrip label="Ultimate" {...modeBreakdown.ultimate} />
        <ModeStrip label="Total" w={(stats?.wins ?? 0)} l={(stats?.losses ?? 0)} g={(stats?.games_played ?? 0)} />
      </div>

      {/* Detailed stat grid */}
      <div className="bg-white/95 text-gray-900 rounded-xl shadow-lg p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
        <DetailStat icon="📥" label="Pile pickups"  value={stats?.pickups ?? 0} />
        <DetailStat icon="🗑" label="Biggest pickup" value={stats?.largest_pile_ever ?? 0} suffix=" cards" />
        <DetailStat icon="🃏" label="Cards played"  value={stats?.cards_played ?? 0} />
        <DetailStat icon="⚡" label="Power cards"   value={stats?.power_cards ?? 0} />
        <DetailStat icon="🔥" label="Burns triggered" value={stats?.burns ?? 0} />
        <DetailStat icon="✂"  label="Cuts"           value={stats?.cuts ?? 0} />
      </div>

      {/* Recent matches */}
      <div className="bg-white/95 text-gray-900 rounded-xl shadow-lg overflow-hidden">
        <div className="px-4 py-3 text-sm font-bold border-b border-gray-200">Recent matches</div>
        {matches === null ? (
          <div className="p-6 text-center text-sm text-gray-500">Loading…</div>
        ) : matches.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">No matches yet — go play one!</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {matches.map(m => {
              const won = m.finish_pos === 1;
              const lost = m.was_poop_head;
              const date = new Date(m.played_at);
              const when = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
              const hasReplay = (m.game_log?.length ?? 0) > 0;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setReplayMatch(m)}
                    disabled={!hasReplay}
                    className={`w-full px-4 py-2.5 flex items-center justify-between text-sm text-left transition-colors ${hasReplay ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'}`}
                    aria-label={hasReplay ? 'View replay' : 'No replay available'}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span aria-hidden className="text-base">
                        {won ? '🏆' : lost ? '💩' : '·'}
                      </span>
                      <div className="flex flex-col min-w-0">
                        <div className="font-semibold truncate flex items-center gap-1.5">
                          <span>{m.mode === 'ultimate' ? 'Ultimate' : 'Classic'}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">{m.online ? '🌐 online' : '🤖 vs AI'}</span>
                        </div>
                        <div className="text-xs text-gray-500">
                          {m.player_count} players{m.ai_count > 0 ? ` (${m.ai_count} AI)` : ''} · {when}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <span className={`text-xs font-bold ${won ? 'text-emerald-700' : lost ? 'text-rose-700' : 'text-gray-500'}`}>
                        {won ? 'WON' : lost ? 'POOP HEAD' : `#${m.finish_pos ?? '?'}`}
                      </span>
                      {hasReplay && <span aria-hidden className="text-gray-400">▶</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AnimatePresence>
        {avatarOpen && (
          <AvatarPicker
            current={profile?.avatar}
            onChoose={onPickAvatar}
            onClose={() => setAvatarOpen(false)}
          />
        )}
        {replayMatch && (
          <ReplayModal match={replayMatch} onClose={() => setReplayMatch(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

function HeroStat({ label, value, tone }: { label: string; value: number | string; tone: 'emerald' | 'rose' | 'amber' | 'slate' }) {
  const palette = {
    emerald: 'bg-emerald-50 text-emerald-900 border-emerald-200',
    rose: 'bg-rose-50 text-rose-900 border-rose-200',
    amber: 'bg-amber-50 text-amber-900 border-amber-200',
    slate: 'bg-white/95 text-gray-900 border-gray-200',
  }[tone];
  return (
    <div className={`rounded-xl border ${palette} p-3 text-center shadow-sm`}>
      <div className="text-[10px] uppercase tracking-wider font-bold opacity-80">{label}</div>
      <div className="text-2xl sm:text-3xl font-black tabular-nums">{value}</div>
    </div>
  );
}

function BreakdownCard({ icon, label, games, wins }: { icon: string; label: string; games: number; wins: number }) {
  const losses = Math.max(0, games - wins);
  return (
    <div className="bg-white/95 text-gray-900 rounded-xl shadow-sm p-3 flex items-center gap-3">
      <div className="text-2xl" aria-hidden>{icon}</div>
      <div className="flex-1">
        <div className="text-xs uppercase tracking-wider font-bold text-gray-500">{label}</div>
        <div className="text-sm font-bold tabular-nums">
          {games} games · <span className="text-emerald-700">{wins}W</span> · <span className="text-rose-700">{losses}L</span>
        </div>
      </div>
    </div>
  );
}

function ModeStrip({ label, w, l, g }: { label: string; w?: number; l?: number; g?: number }) {
  return (
    <div className="bg-white/15 backdrop-blur-sm border border-white/20 rounded-xl p-2.5 text-white text-center">
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="font-bold tabular-nums text-sm">
        <span className="text-emerald-300">{w ?? 0}W</span> · <span className="text-rose-300">{l ?? 0}L</span> · <span className="opacity-80">{g ?? 0}G</span>
      </div>
    </div>
  );
}

function DetailStat({ icon, label, value, suffix }: { icon: string; label: string; value: number; suffix?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-xl" aria-hidden>{icon}</div>
      <div>
        <div className="text-[10px] uppercase tracking-wider font-bold text-gray-500">{label}</div>
        <div className="text-base font-bold tabular-nums">{value}{suffix}</div>
      </div>
    </div>
  );
}

// PWA install prompt. Browsers fire `beforeinstallprompt` once when the
// app meets installability criteria (manifest + SW + first interaction).
// We stash the event and surface a small "Install app" pill the user can
// click — calling `prompt()` shows the native install dialog. After the
// user accepts/dismisses, the event is consumed and the pill hides.
//
// On iOS the event isn't fired (Safari uses a manual Share → Add to Home
// Screen flow), so we fall back to a static "Add to Home Screen" hint
// when the app isn't already running standalone and the device looks
// like iOS. Hides itself after the user has installed.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosPromptVisible, setIosPromptVisible] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // Already running as an installed PWA? Nothing to offer.
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      // iOS-specific
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) { setInstalled(true); return; }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => { setInstalled(true); setDeferred(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);

    // iOS Safari fallback — never fires beforeinstallprompt. Show a static
    // hint when the user hasn't dismissed it before.
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !(/CriOS|FxiOS|EdgiOS/.test(ua));
    const dismissed = localStorage.getItem('ph_ios_install_dismissed') === '1';
    if (isIOS && !dismissed) setIosPromptVisible(true);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) return null;

  if (deferred) {
    return (
      <button
        onClick={async () => {
          try {
            await deferred.prompt();
            await deferred.userChoice;
          } catch { /* ignore */ }
          setDeferred(null);
        }}
        className="px-3 h-9 rounded-full text-xs sm:text-sm font-semibold flex items-center gap-1.5 bg-emerald-500/90 hover:bg-emerald-400 text-white shadow-[0_4px_14px_rgba(16,185,129,0.35)] transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
        </svg>
        Install app
      </button>
    );
  }

  if (iosPromptVisible) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/70 ring-1 ring-white/10 text-white/85 text-[11px] sm:text-xs max-w-xs">
        <span aria-hidden className="text-base shrink-0">📲</span>
        <span className="leading-snug">
          Install on iPhone: tap <span className="font-bold">Share</span>, then <span className="font-bold">Add to Home Screen</span>.
        </span>
        <button
          onClick={() => {
            try { localStorage.setItem('ph_ios_install_dismissed', '1'); } catch { /* ignore */ }
            setIosPromptVisible(false);
          }}
          aria-label="Dismiss"
          className="ml-1 text-white/50 hover:text-white/90 leading-none px-1"
        >×</button>
      </div>
    );
  }

  return null;
}

function MenuScreen({ onLocal, onNetwork, onLeaderboard, onProfile, prefilledCode, auth }: { onLocal: () => void; onNetwork: (code?: string) => void; onLeaderboard: () => void; onProfile: () => void; prefilledCode?: string; auth: AuthState }) {
  const localStatsLS = loadStats();
  const localName = loadName();
  const [signInOpen, setSignInOpen] = useState(false);
  // Pre-select which tab the modal opens on — the menu has separate Sign-in
  // and Create-account buttons, each deep-links to the corresponding tab.
  const [signInTab, setSignInTab] = useState<'signin' | 'signup'>('signin');
  // Force-open the modal when the user lands here via a password-reset
  // email — the modal itself swaps into "set new password" mode.
  useEffect(() => {
    if (auth.passwordRecovery) setSignInOpen(true);
  }, [auth.passwordRecovery]);
  // Stored online session — if present, the user was last in a real room.
  // The RESUME flow on the server will reject stale tokens, so we offer a
  // "Resume" CTA but also a way to dismiss it.
  const [resumable, setResumable] = useState(() => loadSession());
  // Prefer cloud stats when signed in (cross-device truth); fall back to
  // localStorage for guests so they see something instead of zeros.
  const signedIn = !!auth.session?.user;
  const cs: SupabaseStats | null = signedIn ? auth.stats : null;
  const wins   = cs ? cs.wins   : localStatsLS.wins;
  const losses = cs ? cs.losses : localStatsLS.losses;
  const games  = cs ? cs.games_played : localStatsLS.games;
  const onlineGames = cs?.online_games ?? null;
  const winRate = games > 0 ? Math.round((wins / games) * 100) : 0;
  const displayName = signedIn ? (auth.profile?.username ?? auth.session?.user?.email ?? 'Signed in') : localName;
  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-5 p-6">
      <h1 className="text-4xl sm:text-5xl font-black tracking-tight text-white drop-shadow-md">💩 Latrine</h1>
      <p className="max-w-xl text-center text-white/85 text-sm sm:text-base">
        A shedding card game. Get rid of all your cards. Last one holding cards is the Poop Head 💩.
      </p>
      {/* PWA install — only renders when the browser fires beforeinstallprompt
          (Chromium/Edge/Android) or when running on iOS Safari with the
          static fallback hint. Self-hides if already installed. */}
      <InstallAppButton />
      {(displayName || games > 0) && (
        <div className="flex items-center gap-3 text-xs sm:text-sm bg-white/15 backdrop-blur-sm border border-white/25 rounded-full px-4 py-1.5 text-white/95">
          {displayName && (
            <span className="flex items-center gap-1.5">
              {signedIn && <Avatar avatar={auth.profile?.avatar} name={auth.profile?.username} size="sm" />}
              <strong>{displayName}</strong>
            </span>
          )}
          {games > 0 && (
            <>
              <span className="text-white/50">•</span>
              <span>🏆 <strong>{wins}</strong>W / <strong>{losses}</strong>L</span>
              <span className="text-white/60">({winRate}%, {games} played{onlineGames ? `, ${onlineGames} online` : ''})</span>
            </>
          )}
        </div>
      )}
      {/* Resume CTA — shown when the local session token points at a real
          room. Clicking enters the network mode, which RESUMEs automatically
          via the same stored token. If the room has actually expired, the
          user lands in the lobby with a "Room not found" error. */}
      {resumable && !resumable.spectator && !prefilledCode && (
        <div className="flex flex-col items-center gap-2 bg-white/15 backdrop-blur-sm border border-emerald-300/40 rounded-2xl px-5 py-3 text-white">
          <span className="text-sm">⏯ You were in room <strong>{resumable.code}</strong>.</span>
          <div className="flex gap-2">
            <button
              onClick={() => onNetwork(resumable.code)}
              className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-white font-semibold rounded-lg shadow text-sm"
            >Resume</button>
            <button
              onClick={() => { clearSession(); setResumable(null); }}
              className="px-4 py-1.5 bg-white/15 hover:bg-white/25 text-white rounded-lg text-sm"
            >Dismiss</button>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <button onClick={onLocal} className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow">
          Local play (with AI option)
        </button>
        <button onClick={() => onNetwork(prefilledCode)} className="px-6 py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-lg shadow">
          {prefilledCode ? `Join room ${prefilledCode}` : 'Online multiplayer'}
        </button>
      </div>

      {/* Secondary nav — leaderboard always available, profile only when
          signed in (it's user-specific). Both sit below the play buttons so
          they don't compete with the primary action. */}
      {supabaseEnabled && (
        <div className="flex flex-wrap gap-2 justify-center">
          <button
            onClick={onLeaderboard}
            className="text-sm px-4 py-2 bg-white/10 hover:bg-white/20 backdrop-blur-sm border border-white/25 rounded-full text-white flex items-center gap-1.5"
          >
            <span aria-hidden>🏆</span> Leaderboard
          </button>
          {signedIn && (
            <button
              onClick={onProfile}
              className="text-sm px-4 py-2 bg-white/10 hover:bg-white/20 backdrop-blur-sm border border-white/25 rounded-full text-white flex items-center gap-1.5"
            >
              <span aria-hidden>👤</span> Your profile
            </button>
          )}
        </div>
      )}

      {/* Auth strip — sign-in CTA for guests, sign-out + email pip when signed in.
          Hidden entirely if Supabase isn't configured (env vars missing). */}
      {supabaseEnabled && auth.ready && (
        signedIn ? (
          <div className="flex items-center gap-2 text-xs text-white/85">
            <span>{auth.session?.user?.email}</span>
            <button onClick={() => auth.signOut()} className="underline hover:text-white">sign out</button>
          </div>
        ) : (
          // Guest auth strip — a single frosted-glass tray containing both
          // CTAs, matching the action-bar vocabulary used elsewhere. Clear
          // hierarchy: ghost "Sign in" for returning users, solid emerald
          // "Create account" for new ones. Each deep-links the modal to the
          // matching tab.
          <div className="mt-2 flex flex-col items-center gap-2">
            <span className="text-[11px] text-white/60 tracking-wide">
              Playing as guest. Sign in to sync stats across devices.
            </span>
            <div className="inline-flex items-center gap-1 p-1 rounded-full bg-slate-900/60 backdrop-blur-md ring-1 ring-white/10 shadow-lg shadow-black/20">
              <button
                onClick={() => { setSignInOpen(true); setSignInTab('signin'); }}
                className="px-4 h-9 rounded-full text-white/80 text-sm font-medium hover:text-white hover:bg-white/5 active:bg-white/10 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
              >Sign in</button>
              <button
                onClick={() => { setSignInOpen(true); setSignInTab('signup'); }}
                className="px-4 h-9 rounded-full bg-emerald-500 text-white text-sm font-semibold tracking-tight hover:bg-emerald-400 active:bg-emerald-600 active:scale-[0.98] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60"
              >Create account</button>
            </div>
          </div>
        )
      )}

      <HowToPlay />

      <AnimatePresence>
        {signInOpen && (
          <SignInModal auth={auth} initialTab={signInTab} onClose={() => setSignInOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}

// Auth modal — email + password is the primary flow (more reliable than
// magic-link delivery), with magic-link as a fallback option below the form.
//   • Sign in — email + password. Has "Forgot password?" + "Send magic link"
//   • Sign up — username (validated + availability-checked) + email + password
// Password-recovery state is detected at the auth-hook level; when active
// we swap the body for a "set new password" prompt regardless of tab.
type AuthMode = 'signin' | 'signup';
function SignInModal({ auth, onClose, initialTab = 'signin' }: { auth: AuthState; onClose: () => void; initialTab?: AuthMode }) {
  const [mode, setMode] = useState<AuthMode>(initialTab);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // 'magic' = magic-link success; 'confirmation' = password signup pending
  // email confirmation; 'reset' = password-reset email sent
  const [sent, setSent] = useState<null | 'magic' | 'confirmation' | 'reset'>(null);
  const [error, setError] = useState<string | null>(null);
  // Show the magic-link fallback row only after the user explicitly opens it
  // — avoids two competing call-to-actions on the primary form.
  const [magicOpen, setMagicOpen] = useState(false);
  // Forgot-password flow: simple email input → reset email sent.
  const [forgotOpen, setForgotOpen] = useState(false);

  // Username availability check (signup only).
  const [available, setAvailable] = useState<null | true | false | 'invalid' | 'checking'>(null);
  useEffect(() => {
    if (mode !== 'signup') return;
    const u = username.trim();
    if (!u) { setAvailable(null); return; }
    if (u.length < USERNAME_MIN || u.length > USERNAME_MAX || !USERNAME_RE.test(u)) {
      setAvailable('invalid');
      return;
    }
    setAvailable('checking');
    const t = setTimeout(async () => {
      const ok = await checkUsernameAvailable(u);
      setAvailable(ok === null ? null : ok ? true : false);
    }, 350);
    return () => clearTimeout(t);
  }, [username, mode]);

  const usernameOk = mode === 'signin' || available === true;
  const passwordOk = password.length >= PASSWORD_MIN;
  const canSubmit = !!email.trim() && passwordOk && !busy && (mode === 'signin' || usernameOk);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError(null);
    let r: { ok: true } | { ok: true; needsConfirmation: boolean } | { ok: false; error: string };
    if (mode === 'signin') {
      r = await signInWithPassword(email.trim(), password);
    } else {
      r = await signUpWithPassword(email.trim(), password, { username: username.trim() });
    }
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    // Signup that requires confirmation → show "check your email" success.
    // Signup that immediately signs in (Supabase project setting allows it),
    // or a successful sign-in → close the modal; the auth hook will pick up
    // the new session.
    if (mode === 'signup' && (r as any).needsConfirmation) {
      setSent('confirmation');
    } else {
      onClose();
    }
  };

  const onMagic = async () => {
    if (!email.trim() || busy) return;
    setBusy(true); setError(null);
    const r = await auth.signInWithEmail(
      email.trim(),
      mode === 'signup' && username.trim() ? { username: username.trim() } : undefined,
    );
    setBusy(false);
    if (r.ok) setSent('magic');
    else setError(r.error);
  };

  const onForgot = async () => {
    if (!email.trim() || busy) return;
    setBusy(true); setError(null);
    const r = await resetPassword(email.trim());
    setBusy(false);
    if (r.ok) { setSent('reset'); setForgotOpen(false); }
    else setError(r.error);
  };

  // Recovery: user landed here from a "reset password" email. Show a tight
  // "set new password" prompt and ignore the rest of the modal.
  if (auth.passwordRecovery) {
    return <SetNewPasswordModal auth={auth} onClose={onClose} />;
  }

  const tabBtn = (m: AuthMode, label: string) => (
    <button
      type="button"
      onClick={() => { setMode(m); setError(null); setSent(null); setMagicOpen(false); setForgotOpen(false); }}
      className={`flex-1 px-3 py-2 rounded-md text-sm font-semibold transition-colors ${
        mode === m
          ? 'bg-white text-gray-900 shadow-sm'
          : 'text-gray-500 hover:text-gray-800'
      }`}
      aria-pressed={mode === m}
    >{label}</button>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-stone-900/65 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 12, opacity: 0, scale: 0.96 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 12, opacity: 0, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label={mode === 'signin' ? 'Sign in' : 'Create account'}
      >
        <div>
          <h3 className="text-xl font-bold mb-1">
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </h3>
          <p className="text-sm text-gray-600">
            {mode === 'signin'
              ? 'Enter your email and password.'
              : 'Pick a username, enter your email and a password.'}
          </p>
        </div>

        <div className="flex bg-gray-100 rounded-lg p-1">
          {tabBtn('signin', 'Sign in')}
          {tabBtn('signup', 'Create account')}
        </div>

        {sent === 'magic' && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-900">
            ✉️ Magic link sent to <strong>{email}</strong>. Click it to finish — you can close this tab.
          </div>
        )}
        {sent === 'confirmation' && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-900">
            ✉️ Confirmation email sent to <strong>{email}</strong>. Click the link to activate, then sign in with your password.
          </div>
        )}
        {sent === 'reset' && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-900">
            ✉️ Reset link sent to <strong>{email}</strong>. Click it and choose a new password.
          </div>
        )}

        {!sent && (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            {mode === 'signup' && (
              <div className="flex flex-col gap-1">
                <input
                  autoFocus
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="Username"
                  required
                  minLength={USERNAME_MIN}
                  maxLength={USERNAME_MAX}
                  className={`px-3 py-2 border rounded text-sm ${
                    available === false || available === 'invalid'
                      ? 'border-rose-400 bg-rose-50'
                      : available === true
                        ? 'border-emerald-400 bg-emerald-50'
                        : 'border-gray-300'
                  }`}
                />
                <div className="text-[11px] h-4">
                  {available === 'checking' && <span className="text-gray-500">Checking…</span>}
                  {available === true && <span className="text-emerald-700">✓ Available</span>}
                  {available === false && <span className="text-rose-700">Already taken</span>}
                  {available === 'invalid' && (
                    <span className="text-rose-700">
                      {USERNAME_MIN}–{USERNAME_MAX} chars, letters / digits / _ / - only
                    </span>
                  )}
                  {available === null && username.length === 0 && (
                    <span className="text-gray-500">{USERNAME_MIN}–{USERNAME_MAX} chars, letters / digits / _ / -</span>
                  )}
                </div>
              </div>
            )}
            <input
              type="email"
              autoFocus={mode === 'signin'}
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete={mode === 'signin' ? 'username' : 'email'}
              className="px-3 py-2 border border-gray-300 rounded text-sm"
            />
            <div className="flex flex-col gap-1">
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Password"
                required
                minLength={PASSWORD_MIN}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                className="px-3 py-2 border border-gray-300 rounded text-sm"
              />
              {mode === 'signup' && (
                <div className={`text-[11px] ${password.length === 0 ? 'text-gray-500' : passwordOk ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {password.length === 0 ? `At least ${PASSWORD_MIN} characters` : passwordOk ? '✓ Looks good' : `At least ${PASSWORD_MIN} characters`}
                </div>
              )}
            </div>
            {error && <div className="text-xs text-rose-700">{error}</div>}
            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-2 h-11 w-full rounded-lg bg-emerald-600 text-white text-[15px] font-semibold tracking-tight shadow-sm shadow-emerald-900/20 hover:bg-emerald-500 active:bg-emerald-700 active:scale-[0.99] transition-colors duration-150 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-2"
            >
              {busy
                ? (mode === 'signin' ? 'Signing in…' : 'Creating account…')
                : (mode === 'signin' ? 'Sign in' : 'Create account')}
            </button>

            {/* Secondary actions row — forgot pw + magic-link fallback */}
            {mode === 'signin' && (
              <div className="flex flex-col gap-1.5 text-xs text-gray-600">
                {forgotOpen ? (
                  <div className="flex items-center justify-between gap-2 bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
                    <span className="truncate">Send reset link to <strong>{email || 'your email'}</strong>?</span>
                    <div className="flex gap-1.5">
                      <button type="button" onClick={onForgot} disabled={!email.trim() || busy} className="text-indigo-700 font-semibold hover:underline disabled:text-gray-400">Send</button>
                      <button type="button" onClick={() => setForgotOpen(false)} className="text-gray-500 hover:underline">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setForgotOpen(true)} className="self-start text-gray-600 hover:text-gray-900 hover:underline">Forgot password?</button>
                )}
              </div>
            )}

            {/* Magic-link fallback — collapsed by default */}
            {magicOpen ? (
              <div className="flex items-center justify-between gap-2 text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
                <span className="truncate">Send a one-tap link to <strong>{email || 'your email'}</strong>?</span>
                <div className="flex gap-1.5">
                  <button type="button" onClick={onMagic} disabled={!email.trim() || busy} className="text-indigo-700 font-semibold hover:underline disabled:text-gray-400">Send</button>
                  <button type="button" onClick={() => setMagicOpen(false)} className="text-gray-500 hover:underline">Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setMagicOpen(true)} className="text-xs text-gray-500 hover:text-gray-800 self-center hover:underline">
                Or send a magic link instead
              </button>
            )}
          </form>
        )}
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-800 self-center">Close</button>
      </motion.div>
    </motion.div>
  );
}

// Tight prompt for the password-recovery flow — shown when the user clicks
// a reset email and lands back here in a recovery session.
function SetNewPasswordModal({ auth, onClose }: { auth: AuthState; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || pw.length < PASSWORD_MIN) return;
    setBusy(true); setError(null);
    const r = await setNewPassword(pw);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setDone(true);
    auth.clearPasswordRecovery();
    setTimeout(onClose, 1200);
  };
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-stone-900/65 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={() => { /* don't close on backdrop — recovery flow needs intent */ }}
    >
      <motion.div
        initial={{ y: 12, opacity: 0, scale: 0.96 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 flex flex-col gap-4"
        role="dialog"
        aria-label="Set a new password"
      >
        <div>
          <h3 className="text-xl font-bold mb-1">Set a new password</h3>
          <p className="text-sm text-gray-600">You're signed in via the reset link. Pick a new password to finish.</p>
        </div>
        {done ? (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-900">
            ✓ Password updated. You're signed in.
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <input
              type="password"
              autoFocus
              value={pw}
              onChange={e => setPw(e.target.value)}
              placeholder="New password"
              required
              minLength={PASSWORD_MIN}
              autoComplete="new-password"
              className="px-3 py-2 border border-gray-300 rounded text-sm"
            />
            <div className="text-[11px] text-gray-500">At least {PASSWORD_MIN} characters</div>
            {error && <div className="text-xs text-rose-700">{error}</div>}
            <button
              type="submit"
              disabled={busy || pw.length < PASSWORD_MIN}
              className={`px-4 py-2 rounded font-semibold ${busy || pw.length < PASSWORD_MIN ? 'bg-gray-200 text-gray-500 cursor-not-allowed' : 'bg-indigo-500 hover:bg-indigo-600 text-white'}`}
            >
              {busy ? 'Saving…' : 'Save & sign in'}
            </button>
          </form>
        )}
      </motion.div>
    </motion.div>
  );
}

// Plus/minus stepper for small integer ranges. Number inputs were a footgun
// here — typing into a pre-filled field gave you "01" / "13" / etc. The
// stepper avoids the keyboard entirely and clamps to [min, max].
function Stepper({ value, setValue, min, max }: { value: number; setValue: (n: number) => void; min: number; max: number }) {
  const dec = () => setValue(Math.max(min, value - 1));
  const inc = () => setValue(Math.min(max, value + 1));
  const atMin = value <= min;
  const atMax = value >= max;
  const btn = (disabled: boolean) =>
    `w-9 h-9 rounded-md border text-lg font-bold leading-none flex items-center justify-center transition-colors ${
      disabled
        ? 'bg-gray-100 text-gray-300 border-gray-200 cursor-not-allowed'
        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 active:scale-95'
    }`;
  return (
    <div className="flex items-center gap-1.5 select-none">
      <button type="button" onClick={dec} disabled={atMin} className={btn(atMin)} aria-label="Decrease">−</button>
      <span className="w-8 text-center font-semibold tabular-nums" aria-live="polite">{value}</span>
      <button type="button" onClick={inc} disabled={atMax} className={btn(atMax)} aria-label="Increase">+</button>
    </div>
  );
}

function LocalSetupScreen({ onStart, onBack }: { onStart: (humans: number, ais: number, aiDifficulty: AiDifficulty) => void; onBack: () => void }) {
  const [humans, setHumans] = useState(1);
  const [ais, setAis] = useState(2);
  const [difficulty, setDifficulty] = useState<AiDifficulty>(() => {
    try { const v = localStorage.getItem('ph_ai_difficulty'); return (v === 'easy' || v === 'normal' || v === 'hard') ? v : 'normal'; } catch { return 'normal'; }
  });
  const total = humans + ais;
  const valid = humans >= 1 && total >= MIN_PLAYERS && total <= MAX_PLAYERS;
  const setAndPersistDifficulty = (d: AiDifficulty) => {
    setDifficulty(d);
    try { localStorage.setItem('ph_ai_difficulty', d); } catch { /* ignore */ }
  };
  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-6 p-6">
      <h2 className="text-3xl font-bold text-white drop-shadow">Local game setup</h2>
      <div className="flex flex-col gap-4 bg-white/70 p-6 rounded-lg border border-gray-300 w-80">
        <div className="flex items-center justify-between">
          <span>Humans (hot-seat)</span>
          <Stepper value={humans} setValue={setHumans} min={1} max={MAX_PLAYERS} />
        </div>
        <div className="flex items-center justify-between">
          <span>AI opponents</span>
          <Stepper value={ais} setValue={setAis} min={0} max={MAX_PLAYERS - 1} />
        </div>
        {ais > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-gray-700">AI difficulty</span>
            <div className="grid grid-cols-3 gap-1">
              {(['easy', 'normal', 'hard'] as AiDifficulty[]).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setAndPersistDifficulty(d)}
                  className={`px-2 py-1.5 rounded text-sm font-semibold capitalize ${
                    difficulty === d
                      ? d === 'easy' ? 'bg-emerald-500 text-white'
                        : d === 'normal' ? 'bg-amber-500 text-white'
                        : 'bg-rose-500 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >{d}</button>
              ))}
            </div>
            <span className="text-[11px] text-gray-500 italic">
              {difficulty === 'easy' && "Plays randomly. Wastes power cards."}
              {difficulty === 'normal' && "Plays the lowest legal card. Saves power cards loosely."}
              {difficulty === 'hard' && "Saves 2/10/Joker for high-value moments. Hunts the four-3s burn."}
            </span>
          </div>
        )}
        <div className={`text-sm ${valid ? 'text-gray-600' : 'text-rose-600'}`}>
          Total: {total} {valid ? '' : `(must be ${MIN_PLAYERS}–${MAX_PLAYERS}, with at least 1 human)`}
        </div>
      </div>
      <div className="flex gap-3">
        <button onClick={onBack} className="px-4 py-2 border border-gray-300 rounded bg-white/80">Back</button>
        <button
          disabled={!valid}
          onClick={() => onStart(humans, ais, difficulty)}
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
  // Local play: pass-the-device. The "active" swapper is the next human
  // player who hasn't readied yet. Network play: it's whoever the viewer is.
  const activeSwapperIdx = isNetwork
    ? viewerId
    : state.players.findIndex(p => !p.isAi && !state.swapReady[p.id]);
  const activeSwapper = activeSwapperIdx >= 0 ? state.players[activeSwapperIdx] : null;
  const sel = activeSwapperIdx >= 0 ? state.swapSelected[activeSwapperIdx] ?? null : null;
  const ready = activeSwapperIdx >= 0 ? state.swapReady[activeSwapperIdx] : false;
  const readyCount = state.swapReady.filter(Boolean).length;
  const total = state.players.length;

  return (
    <div className="min-h-full p-3 sm:p-6 pt-16 sm:pt-20 flex flex-col gap-4 sm:gap-5 max-w-5xl mx-auto w-full">
      {/* Title block — small caps subtitle + bold heading + progress pill,
          all on one row on desktop and stacked on mobile. Replaces the
          plain "Swap phase" text + verbose paragraph. */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-300/80 font-semibold">Pre-game</div>
          <h2 className="text-2xl sm:text-3xl font-black text-white drop-shadow tracking-tight">Swap your cards</h2>
          <p className="text-xs sm:text-sm text-white/65 mt-1 max-w-xl">
            Tap a hand card, then a face-up card (or vice versa) to swap.
            {isNetwork ? ' Each player swaps independently.' : ' Pass the device between players when each is ready.'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] uppercase tracking-widest text-white/55 font-semibold">Ready</span>
          <span className="px-2.5 py-1 rounded-full bg-slate-900/75 ring-1 ring-white/10 text-white text-sm font-bold tabular-nums">
            {readyCount}<span className="text-white/45">/{total}</span>
          </span>
        </div>
      </div>

      {/* HERO swap panel for the active human player. Bigger, brighter, dark
          glass body + amber rail on the side that ties it to the start CTA. */}
      {activeSwapper && !ready && (
        <div className="relative rounded-2xl bg-slate-900/80 backdrop-blur-md ring-1 ring-white/10 shadow-[0_12px_36px_rgba(0,0,0,0.45)] overflow-hidden">
          <div className={`absolute left-0 top-0 bottom-0 w-1 ${colorFor(activeSwapperIdx).dot}`} />
          <div className="p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${colorFor(activeSwapperIdx).dot}`} />
                <span className="text-white font-bold text-base sm:text-lg">{activeSwapper.name}</span>
                {viewerId === activeSwapperIdx && <span className="text-[10px] text-emerald-300 font-bold tracking-wide">(you)</span>}
              </div>
              {sel && (
                <div className="text-[11px] text-amber-300 font-semibold">
                  Selected — pick a card from {sel.source === 'hand' ? 'face-up' : 'hand'} to swap
                </div>
              )}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-white/45 font-semibold mb-1.5">Face-up</div>
              <div className="flex gap-1.5 flex-wrap">
                {activeSwapper.faceUp.map(card => (
                  <CardFace key={card.id} card={card} small
                    selected={sel?.source === 'faceUp' && sel.id === card.id}
                    onClick={() => dispatch({ type: 'SWAP_PICK', player: activeSwapperIdx, source: 'faceUp', id: card.id })}
                  />
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-white/45 font-semibold mb-1.5">Hand</div>
              <div className="flex gap-1.5 flex-wrap">
                {activeSwapper.hand.map(card => (
                  <CardFace key={card.id} card={card} small
                    selected={sel?.source === 'hand' && sel.id === card.id}
                    onClick={() => dispatch({ type: 'SWAP_PICK', player: activeSwapperIdx, source: 'hand', id: card.id })}
                  />
                ))}
              </div>
            </div>
            <button
              onClick={() => dispatch({ type: 'SWAP_READY', player: activeSwapperIdx })}
              className="self-end px-4 h-10 rounded-full bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-white text-sm font-bold shadow-[0_4px_14px_rgba(16,185,129,0.4)] transition-all"
            >
              I'm ready ✓
            </button>
          </div>
        </div>
      )}

      {/* Other seats — every player's face-up + hand visible (hand is
          hidden for non-self in network mode; local mode shows all hands
          since the device is being passed around). The active swapper is
          rendered in the hero panel above and skipped here, so we don't
          show their seat twice. AIs and already-ready players still
          render with cards but at lower opacity so the eye lands on the
          active panel first. */}
      <div className="flex flex-col gap-2">
        <div className="text-[10px] uppercase tracking-widest text-white/40 font-semibold">Other players</div>
        <div className="grid gap-2 sm:gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {state.players.map((p, i) => {
            const isActive = i === activeSwapperIdx && !ready;
            if (isActive) return null; // shown in hero
            const c = colorFor(i);
            const isReady = state.swapReady[i];
            const handHidden = isNetwork && viewerId !== i;
            return (
              <div
                key={p.id}
                className={`relative rounded-xl bg-slate-900/55 backdrop-blur-md ring-1 overflow-hidden ${
                  isReady ? 'ring-emerald-400/25' : 'ring-white/10'
                }`}
              >
                <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${c.dot}`} />
                <div className="p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`inline-block w-2 h-2 rounded-full ${c.dot} shrink-0`} />
                      <span className="text-white text-sm font-bold truncate">{p.name}</span>
                      {p.isAi && <span className="text-[9px] px-1 py-0.5 rounded bg-white/10 text-white/80 font-bold tracking-wide shrink-0">AI</span>}
                      {viewerId === i && <span className="text-[10px] text-emerald-300 font-bold shrink-0">(you)</span>}
                    </div>
                    {isReady
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/25 text-emerald-200 ring-1 ring-emerald-400/30 font-bold tracking-wide shrink-0">READY ✓</span>
                      : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 text-white/55 ring-1 ring-white/10 font-bold tracking-wide shrink-0">WAITING</span>
                    }
                  </div>
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-white/40 font-semibold mb-1">Face-up</div>
                    <div className="flex gap-0.5 flex-wrap">
                      {p.faceUp.map(card => (
                        <CardFace key={card.id} card={card} size="tiny" dim={isReady} />
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-white/40 font-semibold mb-1">Hand</div>
                    <div className="flex gap-0.5 flex-wrap">
                      {p.hand.map(card => (
                        <CardFace key={card.id} card={card} size="tiny" hidden={handHidden} dim={isReady} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Start CTA — emerald to match the hero panel button. Replaces the
          orange orphan. Disabled state is a faded outline rather than a
          chunky grey block. */}
      <div className="mt-1">
        <button
          disabled={!allReady}
          onClick={() => dispatch({ type: 'BEGIN_PLAY' })}
          className={`w-full sm:w-auto px-6 h-11 rounded-full font-bold text-sm sm:text-base transition-all ${
            allReady
              ? 'bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] text-white shadow-[0_8px_24px_rgba(16,185,129,0.45)]'
              : 'bg-white/5 text-white/40 ring-1 ring-white/10 cursor-not-allowed'
          }`}
        >
          {allReady ? '▶ Start game' : `Waiting for ${total - readyCount} more…`}
        </button>
      </div>
    </div>
  );
}

function PassScreen({ state, dispatch }: { state: GameState; dispatch: (a: Action) => void }) {
  const p = state.players[state.current];
  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 p-6">
      <h2 className="text-3xl font-bold text-white drop-shadow">Pass the device to {p.name}</h2>
      <p className="text-white/80">The previous player's hand is hidden.</p>
      <button onClick={() => dispatch({ type: 'ACK_PASS' })} className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg shadow">
        Start {p.name}'s turn
      </button>
    </div>
  );
}

function sortCards(cards: Card[]): Card[] {
  return cards.slice().sort((a, b) => RANK_VALUE[a.rank] - RANK_VALUE[b.rank] || a.suit.localeCompare(b.suit));
}

function PlayScreen({ state, dispatch, viewerId, emotes, onEmote, chats, onChat, fromDeckIds, spectatorCount, avatars, connectedSeats }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
  emotes?: { id: string; playerId: number; emoji: string }[]; onEmote?: (e: string) => void;
  chats?: ChatMsg[]; onChat?: (text: string) => void;
  fromDeckIds?: Set<string>;
  spectatorCount?: number;
  // avatars[i] = avatar key for state.players[i], or null/undefined for default.
  avatars?: (string | null)[];
  // Per-seat connection presence — only meaningful in network mode.
  // `undefined` (local mode) → assume everyone connected; `false` →
  // surface an "away" indicator on that player's tile.
  connectedSeats?: boolean[];
}) {
  const isSpectator = viewerId === -1;
  // Spectators get to pick a "camera angle" — which player's hand they're
  // following. Defaults to whoever's turn it is now (rotates with the game).
  // Click any tile to focus that player. For real players this is just their
  // own seat; the spectator state is decorative.
  const [spectatorFocus, setSpectatorFocus] = useState<number | null>(null);
  const viewer = isSpectator
    ? (spectatorFocus !== null && state.players[spectatorFocus] ? spectatorFocus : state.current)
    : (viewerId ?? state.current);
  const isMyTurn = !isSpectator && viewer === state.current && !state.players[viewer]?.isAi;
  const me = state.players[viewer];
  const src = me ? activeSource(me, state.deck.length === 0) : null;
  const [sortOn, setSortOn] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Turn-speed indicator: track how long the current player has been "thinking".
  // Resets whenever state.current changes. Tick once per second so the bar progresses smoothly.
  const turnStartRef = useRef<number>(Date.now());
  const lastCurrentRef = useRef<number>(state.current);
  if (lastCurrentRef.current !== state.current) {
    lastCurrentRef.current = state.current;
    turnStartRef.current = Date.now();
  }
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const turnElapsedMs = now - turnStartRef.current;

  // Turn-alert chime: dedicated ding when state.current rotates to the viewer
  // during the play phase. We track which `state.current` we last chimed for
  // and clear it whenever it isn't our turn, so a round-trip (me → opp → me)
  // chimes on every return. Crucially this also handles the swap→play edge
  // case: if I was already "current" during swap, the boolean false→true
  // edge wouldn't fire, but a (current === me) we haven't chimed for yet
  // does fire correctly.
  const lastChimedCurrentRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.phase !== 'play') { lastChimedCurrentRef.current = null; return; }
    if (!isMyTurn)              { lastChimedCurrentRef.current = null; return; }
    if (lastChimedCurrentRef.current === state.current) return;
    // Slight delay so the chime starts AFTER the previous player's 'play'
    // sound peaks, instead of getting masked by it on the same React tick.
    const t = setTimeout(() => sfx.play('yourTurn'), 180);
    lastChimedCurrentRef.current = state.current;
    return () => clearTimeout(t);
  }, [isMyTurn, state.phase, state.current]);

  // Last-actor flash: track whose tile to pulse for 600ms. Parsed from the most
  // recent log line that begins with "<name> played/picked/flipped/cut". Cleared on
  // a timer so the pulse only fires once per action.
  const [lastActorId, setLastActorId] = useState<number | null>(null);
  const lastLogLenRef = useRef(state.log.length);
  useEffect(() => {
    if (state.log.length === lastLogLenRef.current) return;
    const fresh = state.log.slice(lastLogLenRef.current);
    lastLogLenRef.current = state.log.length;
    // Walk newest-first; first match wins.
    for (let i = fresh.length - 1; i >= 0; i--) {
      const line = fresh[i];
      const m = line.match(/^([^\n:]+?)\s+(played|picked|flipped|cut|CUT|burned)/i);
      if (!m) continue;
      const name = m[1].trim();
      const idx = state.players.findIndex(p => p.name === name);
      if (idx >= 0) {
        setLastActorId(idx);
        const t = setTimeout(() => setLastActorId(null), 650);
        return () => clearTimeout(t);
      }
    }
  }, [state.log, state.players]);

  // Direction flash: bump a counter whenever state.direction flips so the chevron
  // wrapper re-mounts and replays its flash animation. Sound is already played by
  // the toast/log handler when "direction reversed" appears.
  const [directionFlashKey, setDirectionFlashKey] = useState(0);
  const lastDirRef = useRef(state.direction);
  useEffect(() => {
    if (lastDirRef.current !== state.direction) {
      lastDirRef.current = state.direction;
      setDirectionFlashKey(k => k + 1);
    }
  }, [state.direction]);

  // Pile-pickup animation: a one-shot card-backs-fly-to-tile overlay whenever
  // a player takes the pile. Trigger condition is robust to all three log
  // formats:
  //   "X picked up the pile (N cards). No hand cards to reveal."
  //   "X picked up N — must reveal a hand card…"
  //   "X flipped Y — illegal! Picks up N."
  // …and falls back to "pile went non-empty → empty + a player-named line"
  // for forward compat. We snapshot the *previous* pile length because by the
  // time the log line lands, state.pile is already []. Capped at 12 cards so
  // a 30-card pickup reads as a sweep, not a swarm.
  const [pickupAnim, setPickupAnim] = useState<{ key: number; pickerId: number; count: number } | null>(null);
  const prevPileLenRef = useRef(state.pile.length);
  const pickupKeyRef = useRef(0);
  const pickupLogLenRef = useRef(state.log.length);
  useEffect(() => {
    const newLines = state.log.slice(pickupLogLenRef.current);
    pickupLogLenRef.current = state.log.length;
    const prevPile = prevPileLenRef.current;
    prevPileLenRef.current = state.pile.length;
    // Only consider a pickup if the pile actually emptied (not still filling).
    if (prevPile === 0) return;
    for (const line of newLines) {
      // Match any of the pickup phrasings: "picked up", "Picks up". Names can
      // contain spaces, so we anchor the rest of the phrase, not the name.
      const m = line.match(/^([^\n]+?)\s+(?:picked up|flipped[^\n]*?Picks up)\b/i);
      if (!m) continue;
      const name = m[1].trim();
      const idx = state.players.findIndex(p => p.name === name);
      if (idx < 0) continue;
      pickupKeyRef.current += 1;
      // Cap at 18 visible cards (was 12). Past that they blur into noise but
      // 12 felt too small for the genuinely big pickups that actually happen
      // (e.g. ~20-card pile after a no-burn streak).
      setPickupAnim({ key: pickupKeyRef.current, pickerId: idx, count: Math.min(prevPile || 1, 18) });
      const t = setTimeout(() => setPickupAnim(null), 900);
      return () => clearTimeout(t);
    }
  }, [state.log, state.pile.length, state.players]);

  // AI / opponent play animation — when somebody other than the viewer adds
  // cards to the pile, fly a copy of those cards from their tile to the pile
  // centre so the eye follows the play. The viewer's own plays already
  // animate via framer-motion's layoutId on hand cards, so we skip them.
  const [playAnim, setPlayAnim] = useState<{ key: number; actorId: number; cards: Card[] } | null>(null);
  const playPrevPileRef = useRef(state.pile.length);
  const playLogLenRef = useRef(state.log.length);
  const playKeyRef = useRef(0);

  useEffect(() => {
    const prevPile = playPrevPileRef.current;
    const newPile = state.pile.length;
    const prevLog = playLogLenRef.current;
    playPrevPileRef.current = newPile;
    playLogLenRef.current = state.log.length;
    if (newPile <= prevPile) return;                     // pile shrank or stayed (pickup/burn)
    const fresh = state.log.slice(prevLog);
    let actorId = -1;
    // Walk newest-first so multi-line play chains (rare) attribute correctly.
    for (let i = fresh.length - 1; i >= 0; i--) {
      const m = fresh[i].match(/^([^\n]+?)\s+(played|chained|CUT with)\b/i);
      if (!m) continue;
      const idx = state.players.findIndex(p => p.name === m[1].trim());
      if (idx >= 0) { actorId = idx; break; }
    }
    if (actorId < 0) return;
    if (!isSpectator && actorId === viewer) return;       // viewer's own plays animate via layoutId
    const newCards = state.pile.slice(prevPile).map(e => e.card);
    if (newCards.length === 0) return;
    playKeyRef.current += 1;
    setPlayAnim({ key: playKeyRef.current, actorId, cards: newCards });
    // Hold the animation long enough to cover the per-card stagger (160ms
    // each) + travel (420ms). 4-card plays would otherwise tear off mid-
    // flight. Cap at ~1.4s so a wild 5-card sequence still feels snappy.
    const holdMs = Math.min(1400, 420 + 160 * Math.max(0, newCards.length - 1) + 200);
    const t = setTimeout(() => setPlayAnim(null), holdMs);
    return () => clearTimeout(t);
  }, [state.pile, state.log, state.players, viewer, isSpectator]);

  // Out-of-turn matches: includes both Ultimate cuts (rank+suit by anyone) and
  // chains (rank-only, available to the player who just played, in any mode).
  // cutMatches handles both flavors internally.
  const myCutMatches = !isSpectator && me ? cutMatches(state, viewer) : [];
  const canCut = myCutMatches.length > 0 && !isMyTurn;
  // Chain == we are the most recent player. Used to label/colour the action
  // appropriately (subtle visual difference from a true Ultimate cut).
  const isChainOpportunity = canCut && state.lastPlayerId === viewer;

  // Cut-race feedback: if the viewer had cut matches in the previous state but
  // someone else got their cut in first, show a small "Beat to it!" pip so the
  // race outcome is acknowledged instead of silently failing.
  const [beatToIt, setBeatToIt] = useState(false);
  const prevHadCutRef = useRef(false);
  const prevLogLenRef = useRef(state.log.length);
  useEffect(() => {
    const newLines = state.log.slice(prevLogLenRef.current);
    prevLogLenRef.current = state.log.length;
    let cleanup: (() => void) | undefined;
    if (state.mode === 'ultimate' && prevHadCutRef.current && newLines.length > 0) {
      const myName = !isSpectator && me ? me.name : null;
      const someoneElseCut = newLines.some(l => /\bCUT with\b/i.test(l) && (myName ? !l.startsWith(myName + ' ') : true));
      if (someoneElseCut) {
        setBeatToIt(true);
        const t = setTimeout(() => setBeatToIt(false), 1800);
        cleanup = () => clearTimeout(t);
      }
    }
    prevHadCutRef.current = canCut;
    return cleanup;
  }, [state.log, state.mode, canCut, isSpectator, me]);

  const sourceCards = me && src ? cardsFromSource(me, src) : [];
  const displayCards = sortOn ? sortCards(sourceCards) : sourceCards;
  // Resolve the actual selection across BOTH hand and face-up. Previously we
  // filtered to `sourceCards` (hand-only when src === 'hand'), which meant a
  // hand-4 + face-up-4 selection only validated the hand half, leaving the
  // Play button enabled even though the reducer would reject the play.
  const selectedAll = me
    ? state.selected
        .map(id => me.hand.find(c => c.id === id) ?? me.faceUp.find(c => c.id === id))
        .filter((c): c is Card => !!c)
    : [];
  const selectedHand = me ? selectedAll.filter(c => me.hand.some(h => h.id === c.id)) : [];
  const selectedFaceUp = me ? selectedAll.filter(c => me.faceUp.some(f => f.id === c.id)) : [];
  // Hand → face-up chain rule mirroring playCardsByIds: face-up cards may be
  // included only when the deck is empty AND every hand card is part of the
  // play (no leftovers). canPlayCards already enforces all-same-rank within a
  // multi-card play, so we don't need to re-check that here.
  const chainOk =
    selectedFaceUp.length === 0 ||
    (state.deck.length === 0 && selectedHand.length === (me?.hand.length ?? 0));
  const canPlay = isMyTurn && selectedAll.length > 0 && chainOk && canPlayCards(selectedAll, state.pile, state.sevenRestriction);
  const anyLegal = sourceCards.some(c => canPlayCards([c], state.pile, state.sevenRestriction));
  // Pickup gate: blocked only when EVERY card in the active source is a
  // legal play (i.e. there's no card the player could plausibly reveal as
  // an "I couldn't play this" justification). As long as the player holds
  // at least one card they couldn't have played, pickup is allowed even
  // if they also have some legal options.
  const allCardsLegal = sourceCards.length > 0 && !sourceCards.some(
    c => !canPlayCards([c], state.pile, state.sevenRestriction),
  );
  // Face-up gamble: when the active source is face-up and the player has
  // committed exactly one face-up card that turns out to be illegal, the
  // reducer's house rule forces a pickup of the pile + that card. The
  // button stays clickable so the player can opt in deliberately, but it
  // changes label/colour so the consequence is unmistakable. Multi-card
  // illegal attempts are not allowed (you can't gamble two face-up cards
  // and pick up both with the pile).
  const isFaceUpIllegalCommit =
    isMyTurn && src === 'faceUp' && !canPlay && selectedAll.length === 1 && selectedFaceUp.length === 1;

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
      } else if ((e.key === 'p' || e.key === 'P') && state.pile.length > 0 && src !== 'faceDown' && !allCardsLegal) {
        // Pickup is allowed unless every card in the active source is
        // legal — same gate as the button so the hotkey isn't a bypass.
        dispatch({ type: 'PICKUP_PILE' });
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMyTurn, canPlay, displayCards, src, state.pile.length, allCardsLegal, dispatch]);

  return (
    <LayoutGroup>
      {/* Spectator persistent banner — pinned bottom-left so it doesn't fight
          with toasts (top-centre) or the menu pill (top-left). The user is
          NOT a player; the banner makes that obvious and tells them the
          interaction model (click any tile to focus). Auto-collapses to a
          slim "watching X" line after first interaction. */}
      {isSpectator && (
        <div
          className="fixed bottom-3 left-3 z-30 px-3 py-1.5 rounded-full bg-violet-600/90 backdrop-blur-md ring-1 ring-violet-300/30 text-white text-xs font-semibold shadow-[0_8px_24px_rgba(124,58,237,0.45)] flex items-center gap-2 pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <span aria-hidden>👁</span>
          {spectatorFocus !== null && state.players[spectatorFocus]
            ? <>Spectating — watching <strong className="font-bold">{state.players[spectatorFocus].name}</strong></>
            : <>Spectating — click any player to follow</>}
        </div>
      )}
      <div className="relative min-h-screen overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 85% 68% at 50% 43%, rgba(255,255,255,0.10), transparent 62%), radial-gradient(ellipse 120% 90% at 50% 58%, rgba(5,20,14,0.10), rgba(0,0,0,0.34) 100%)',
          }}
        />
        <AnimatePresence>
          {beatToIt && (
            <motion.div
              key="beat-to-it"
              initial={{ y: -16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -16, opacity: 0 }}
              className="fixed top-16 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 rounded-full text-xs font-semibold shadow-lg bg-fuchsia-600 text-white pointer-events-none"
              role="status"
              aria-live="polite"
            >
              ✂ Beat to it!
            </motion.div>
          )}
        </AnimatePresence>
        <div className="relative z-10 min-h-screen p-3 sm:p-4 pt-14 flex flex-col gap-3 sm:gap-4 lg:gap-5 min-w-0">
          <StatusBar state={state} viewerId={viewerId} isMyTurn={isMyTurn} spectatorCount={spectatorCount} connectedSeats={connectedSeats} />
          {/* Player tiles + center piles. Linear stack on small screens (turn-ordered);
              circular table layout on lg+ so the viewer can see who's next at a glance. */}
          {(() => {
            const renderPlayerTile = (pp: Player, _isNext: boolean, compact: boolean) => {
              const isOwnArea = pp.id === state.current && isMyTurn;
              const chainEligible = isOwnArea && src === 'hand' && state.deck.length === 0;
              const selectedFaceUpIds = isOwnArea ? new Set(state.selected.filter(id => pp.faceUp.some(c => c.id === id))) : undefined;
              return (
                <PlayerArea
                  player={pp}
                  isCurrent={pp.id === state.current}
                  isViewer={pp.id === viewer && !isSpectator}
                  isSpectatorFocus={isSpectator && pp.id === viewer}
                  onSpectatorFocus={isSpectator ? () => setSpectatorFocus(pp.id) : undefined}
                  compact={compact}
                  faceDownClickable={isOwnArea && src === 'faceDown'}
                  onFaceDownClick={(id) => dispatch({ type: 'FLIP_FACEDOWN', id })}
                  faceUpClickable={chainEligible}
                  onFaceUpClick={(id) => dispatch({ type: 'TOGGLE_SELECT', id })}
                  selectedFaceUpIds={selectedFaceUpIds}
                  emotes={emotes}
                  turnElapsedMs={pp.id === state.current ? turnElapsedMs : undefined}
                  recentlyActed={pp.id === lastActorId}
                  avatar={avatars?.[pp.id] ?? null}
                  // Network presence — `undefined` in local mode means
                  // assume connected. AI seats are always considered
                  // connected (they're driven by the server, not a socket).
                  connected={pp.isAi ? true : (connectedSeats?.[pp.id] ?? true)}
                />
              );
            };
            const center = <CenterPiles deckCount={state.deck.length} pile={state.pile} burnedCount={state.burnedCount} lastBurnSize={state.lastBurnSize} />;

            const safeViewer = viewer >= 0 ? viewer : state.current;
            return (
              <CircularTable
                players={state.players}
                current={state.current}
                viewer={safeViewer}
                direction={state.direction}
                directionFlashKey={directionFlashKey}
                pickupAnim={pickupAnim}
                playAnim={playAnim}
                renderPlayer={renderPlayerTile}
                centerContent={center}
              />
            );
          })()}

          <div className="hand-dock pt-3 px-3 sm:px-4 -mx-3 sm:mx-auto w-[calc(100%+1.5rem)] sm:w-full max-w-4xl">
            <div className="flex items-center justify-between mb-2 gap-3">
              {/* Status line — small caps label so it reads as a section
                  heading rather than competing with the buttons on the right. */}
              <div className="text-[11px] sm:text-xs uppercase tracking-[0.14em] text-white/60 font-semibold truncate">
                {isSpectator && me && (
                  <>
                    <span className="text-violet-200">{me.name}'s hand</span>
                    {state.current === viewer && <span className="ml-1 text-white/40">— their turn</span>}
                  </>
                )}
                {!isSpectator && !isMyTurn && <>Waiting for {state.players[state.current].name}…</>}
                {isMyTurn && src === 'hand' && <>Your hand</>}
                {isMyTurn && src === 'faceUp' && <>Playing from face-up</>}
                {isMyTurn && src === 'faceDown' && <>Pick a face-down card</>}
              </div>
              {/* Single dark-glass segmented control. All three actions share
                  the same body, dividers, and typography — replaces the prior
                  mix of beige/grey buttons and a circular outline `?`. */}
              <div className="flex items-stretch shrink-0 rounded-full bg-slate-900/75 backdrop-blur-md ring-1 ring-white/10 shadow-[0_4px_14px_rgba(0,0,0,0.35)] overflow-hidden text-white">
                <button
                  onClick={() => setShortcutsOpen(o => !o)}
                  className={`px-3 h-8 inline-flex items-center justify-center text-[12px] font-semibold border-r border-white/10 transition-colors ${
                    shortcutsOpen ? 'bg-white/10 text-white' : 'text-white/80 hover:bg-white/5'
                  }`}
                  aria-label="Keyboard & input shortcuts"
                  aria-expanded={shortcutsOpen}
                  title="Shortcuts"
                >
                  <span className="text-[13px] leading-none">?</span>
                </button>
                <button
                  onClick={() => setLogOpen(o => !o)}
                  className="px-3 h-8 inline-flex items-center justify-center gap-1.5 text-[12px] font-semibold text-white/85 border-r border-white/10 hover:bg-white/5 transition-colors"
                  aria-label="Open game log"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z" />
                    <path d="M8 8h8M8 12h8M8 16h5" />
                  </svg>
                  <span>Log</span>
                </button>
                <button
                  onClick={() => setSortOn(s => !s)}
                  className="px-3 h-8 inline-flex items-center justify-center gap-1.5 text-[12px] font-semibold text-white/85 hover:bg-white/5 transition-colors"
                  title={sortOn ? 'Switch to deal order' : 'Sort by rank'}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    {sortOn
                      ? <><path d="M3 6h13M3 12h9M3 18h5" /><path d="M17 8l4 4-4 4" /></>
                      : <><path d="M3 6h7M3 12h11M3 18h15" /></>}
                  </svg>
                  <span>{sortOn ? 'Sorted' : 'Sort'}</span>
                </button>
              </div>
            </div>
            <AnimatePresence initial={false}>
              {shortcutsOpen && (
                <motion.div
                  key="shortcut-tray"
                  initial={{ opacity: 0, y: -4, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: 'auto' }}
                  exit={{ opacity: 0, y: -4, height: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="mb-2 text-[11px] text-white/80 bg-slate-900/80 ring-1 ring-white/10 rounded-lg px-3 py-2 flex flex-wrap gap-x-4 gap-y-1.5">
                    <span className="flex items-center gap-1.5"><kbd className="px-1.5 py-0.5 rounded bg-white/15 font-mono text-[10px] text-white">double-tap</kbd> play card</span>
                    <span className="flex items-center gap-1.5"><kbd className="px-1.5 py-0.5 rounded bg-white/15 font-mono text-[10px] text-white">1–9</kbd> select nth</span>
                    <span className="flex items-center gap-1.5"><kbd className="px-1.5 py-0.5 rounded bg-white/15 font-mono text-[10px] text-white">Enter</kbd> play selection</span>
                    <span className="flex items-center gap-1.5"><kbd className="px-1.5 py-0.5 rounded bg-white/15 font-mono text-[10px] text-white">P</kbd> pick up pile</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {/* Face-down phase: render the player's face-down cards here as the primary interaction surface. */}
            {isMyTurn && src === 'faceDown' && me && (
              <div className="flex gap-3 flex-wrap items-center justify-center">
                {me.faceDown.map(c => (
                  <motion.div
                    key={c.id}
                    whileHover={{ scale: 1.08, y: -4 }}
                    whileTap={{ scale: 0.95 }}
                  >
                    <CardFace hidden onClick={() => dispatch({ type: 'FLIP_FACEDOWN', id: c.id })} />
                  </motion.div>
                ))}
                <span className="text-xs text-white/60 italic">Tap one to flip blind.</span>
              </div>
            )}
            {src && src !== 'faceDown' && (() => {
              // Hand layout — adaptive across three regimes so the table area
              // stays put no matter how many cards the viewer is holding:
              //   • ≤9 cards: single row, no overlap (the common case)
              //   • 10–18 cards: single row with progressive overlap (cap 36px)
              //   • 19+ cards: TWO rows, each with its own modest overlap so
              //     each card stays readable. Splitting beats squeezing 22+
              //     cards into one row where they'd be slivers.
              // Horizontal scroll remains a fallback if even two rows would
              // overflow on a very narrow viewport.
              const handLen = displayCards.length;
              const useTwoRows = handLen >= 19;
              const rows: typeof displayCards[] = useTwoRows
                ? [displayCards.slice(0, Math.ceil(handLen / 2)),
                   displayCards.slice(Math.ceil(handLen / 2))]
                : [displayCards];
              // Per-row overlap is computed off that row's length so each row
              // stays balanced even when the split is uneven by one card.
              const overlapForRow = (rowLen: number) =>
                rowLen > 9 ? Math.min(36, (rowLen - 9) * 3.5) : 0;
              const renderCard = (c: typeof displayCards[number], i: number, rowOverlap: number, baseIndex: number, rowLen: number) => {
                const wouldBeOk = isMyTurn ? canPlayCards([c], state.pile, state.sevenRestriction) : true;
                const isCutMatch = canCut && myCutMatches.some(m => m.id === c.id);
                const isChainMatch = isCutMatch && isChainOpportunity;
                // One-click out-of-turn play: clicking a glowing card fires CUT.
                const onClick = isMyTurn
                  ? () => dispatch({ type: 'TOGGLE_SELECT', id: c.id })
                  : isCutMatch
                    ? () => dispatch({ type: 'CUT', player: viewer, ids: myCutMatches.map(m => m.id) })
                    : undefined;
                // Double-tap shortcut — play this card immediately as a
                // single-card play. Only fires when (a) it's your turn,
                // (b) the card alone is a legal play, and (c) we're
                // playing from hand or face-up (face-down has its own
                // flow). Multi-card plays still need select + Play.
                const canFastPlay = isMyTurn && wouldBeOk && (src === 'hand' || src === 'faceUp');
                const onDoubleClick = canFastPlay
                  ? () => dispatch({ type: 'PLAY_CARDS', ids: [c.id] })
                  : undefined;
                // Hand fan: ±1.2° per slot around the row centre. Reads as
                // a real handful instead of a perfectly aligned row. Tiny
                // angle so legibility isn't impacted; the negative-margin
                // overlap still controls horizontal density.
                const fanCentreOffset = i - (rowLen - 1) / 2;
                const fanRot = fanCentreOffset * 1.2;
                return (
                  <div
                    key={c.id}
                    className="shrink-0 relative hover:z-20"
                    style={{
                      marginLeft: i === 0 ? 0 : -rowOverlap,
                      zIndex: baseIndex + i,
                      transform: `rotate(${fanRot}deg)`,
                      transformOrigin: '50% 100%',
                    }}
                  >
                    <AnimatedCard
                      layoutId={c.id} card={c}
                      fromDeck={fromDeckIds?.has(c.id)}
                      selected={state.selected.includes(c.id)}
                      dim={isMyTurn && !wouldBeOk && state.selected.length === 0}
                      cuttable={isCutMatch && !isChainMatch}
                      chainable={isChainMatch}
                      onClick={onClick}
                      onDoubleClick={onDoubleClick}
                    />
                  </div>
                );
              };
              return (
                <div
                  // pt-7 / pb-3 gives the selected-card lift (-translate-y-3,
                  // ~12px) plus its amber ring and any cuttable/chainable glow
                  // a clear top buffer. overflow-x: auto silently promotes
                  // overflow-y to clip per spec, so vertical decorations would
                  // otherwise get chopped at the container edge.
                  // overflow-clip-margin extends the clip box slightly so any
                  // residual shadow doesn't get cut.
                  className="flex flex-col items-stretch gap-1 overflow-x-auto -mx-3 sm:-mx-4 px-4 sm:px-6 pt-7 pb-3"
                  style={{
                    scrollbarWidth: 'thin',
                    scrollPaddingInline: '1rem',
                    overflowClipMargin: '12px',
                  } as React.CSSProperties}
                >
                  <LayoutGroup>
                    {rows.map((row, rIdx) => {
                      const rowOverlap = overlapForRow(row.length);
                      const baseIndex = rIdx === 0 ? 0 : rows[0].length;
                      return (
                        <div
                          key={rIdx}
                          className="flex items-end"
                          // `safe center` keeps the row visually centered when
                          // it FITS, but falls back to flex-start when it
                          // overflows. Without `safe`, plain `center` pushes
                          // the leading edge past scroll-origin so the leftmost
                          // card is unreachable / visually clipped.
                          style={{ justifyContent: 'safe center' }}
                        >
                          {row.map((c, i) => renderCard(c, i, rowOverlap, baseIndex, row.length))}
                        </div>
                      );
                    })}
                  </LayoutGroup>
                </div>
              );
            })()}
          </div>

          {/* Action bar — sticky, always-mounted, always one row. Modern
              segmented control aesthetic: a single dark glass tray holds
              compact Play / Pick-up pills + an optional Cut. Disabled state
              is a faded outline rather than a chunky gray block. The
              "no legal play" hint sits inside the tray as a subtle caption,
              not a layout-breaking sentence on its own line. */}
          {!isSpectator && src !== 'faceDown' && (
            <div className="sticky bottom-0 left-0 right-0 z-20 mt-2 pb-3 pt-2 px-3 -mx-3 sm:-mx-4 flex items-center gap-2 justify-center pointer-events-none">
              <div className="flex items-center gap-1.5 p-1 rounded-full bg-slate-900/80 backdrop-blur-md ring-1 ring-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.45)] pointer-events-auto">
                <button
                  disabled={!canPlay && !isFaceUpIllegalCommit}
                  onClick={() => dispatch({ type: 'PLAY_SELECTED' })}
                  title={isFaceUpIllegalCommit ? 'Illegal face-up card — clicking will pick up the pile + this card' : undefined}
                  className={`px-4 sm:px-5 h-9 sm:h-10 rounded-full text-sm font-semibold flex items-center gap-1.5 transition-all ${
                    canPlay
                      ? 'bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-white shadow-[0_4px_12px_rgba(16,185,129,0.45)]'
                      : isFaceUpIllegalCommit
                        ? 'bg-amber-500 hover:bg-amber-400 active:scale-95 text-white shadow-[0_4px_12px_rgba(245,158,11,0.45)] ring-2 ring-amber-300/60'
                        : 'text-white/35 cursor-not-allowed'
                  }`}
                >
                  {isFaceUpIllegalCommit
                    ? <><span aria-hidden>⚠</span> Try (illegal → pick up)</>
                    : <><span aria-hidden>▶</span> Play</>}
                </button>
                {(() => {
                  // House rule: pickup is blocked only when EVERY card in
                  // the active source is a legal play — at that point the
                  // player must play one, because there's no "I couldn't
                  // play this" reveal candidate. As long as they hold at
                  // least one illegal-on-pile card, pickup remains an
                  // option (even if they also have legal plays).
                  // Pickup also stays open as a strong-affordance "you
                  // have no legal moves" button when !anyLegal.
                  const pickupAllowed =
                    isMyTurn && state.pile.length > 0 && !allCardsLegal;
                  const lockedAllLegal =
                    isMyTurn && state.pile.length > 0 && allCardsLegal;
                  return (
                    <button
                      disabled={!pickupAllowed}
                      onClick={() => pickupAllowed && dispatch({ type: 'PICKUP_PILE' })}
                      title={lockedAllLegal ? 'Every card is a legal play — Pickup is locked.' : undefined}
                      className={`px-4 sm:px-5 h-9 sm:h-10 rounded-full text-sm font-semibold flex items-center gap-1.5 transition-all ${
                        pickupAllowed
                          ? (!anyLegal
                              ? 'bg-rose-500 hover:bg-rose-400 active:scale-95 text-white shadow-[0_4px_12px_rgba(244,63,94,0.45)] ring-2 ring-rose-300/60'
                              : 'bg-white/10 hover:bg-white/20 active:scale-95 text-white')
                          : 'text-white/35 cursor-not-allowed'
                      }`}
                    >
                      <span aria-hidden>⤴</span> Pick up
                    </button>
                  );
                })()}
                {canCut && (
                  <motion.button
                    initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => dispatch({ type: 'CUT', player: viewer, ids: myCutMatches.map(c => c.id) })}
                    className={`px-4 sm:px-5 h-9 sm:h-10 rounded-full text-sm font-semibold flex items-center gap-1.5 active:scale-95 text-white animate-pulse ${
                      isChainOpportunity
                        ? 'bg-emerald-600 hover:bg-emerald-500 shadow-[0_4px_12px_rgba(52,211,153,0.55)]'
                        : 'bg-fuchsia-600 hover:bg-fuchsia-500 shadow-[0_4px_12px_rgba(232,121,249,0.55)]'
                    }`}
                    title={isChainOpportunity ? `Chain ${myCutMatches.map(c => c.rank + c.suit).join(', ')}` : `Cut with ${myCutMatches.map(c => c.rank + c.suit).join(', ')}`}
                  >
                    {isChainOpportunity ? '↪ CHAIN' : '✂ CUT'} <span className="opacity-70 font-normal">{myCutMatches.length}</span>
                  </motion.button>
                )}
              </div>
            </div>
          )}

          {onEmote && !isSpectator && (
            <EmoteBar onEmote={onEmote} />
          )}
          {onChat && chats && (
            <ChatPanel
              chats={chats}
              selfPlayerId={isSpectator ? -1 : viewer}
              players={state.players.map(p => ({ id: p.id, name: p.name }))}
              onSend={onChat}
            />
          )}
        </div>
        <GameLogOverlay log={state.log} open={logOpen} onClose={() => setLogOpen(false)} />
      </div>
    </LayoutGroup>
  );
}

/* ============== Expressive emote pack ============== */

type EmoteAnim = 'bounce' | 'rise' | 'shake' | 'spawn' | 'wiggle' | 'flip';
interface EmoteDef {
  emoji: string;
  label: string;
  anim: EmoteAnim;
  count?: number;        // spawn count for 'spawn' animation
  glow?: string;         // optional ambient color glow
}
// Lookup by emoji char; emojis sent over the wire are still single-char so the
// network protocol doesn't change — animation metadata is purely client-side.
const EMOTES: EmoteDef[] = [
  { emoji: '👍', label: 'nice',     anim: 'bounce', glow: 'rgba(52,211,153,0.45)' },
  { emoji: '🔥', label: 'fire',     anim: 'spawn',  count: 4, glow: 'rgba(244,114,28,0.55)' },
  { emoji: '❤️', label: 'love',     anim: 'spawn',  count: 3, glow: 'rgba(244,63,94,0.45)' },
  { emoji: '🎉', label: 'party',    anim: 'spawn',  count: 5, glow: 'rgba(251,191,36,0.45)' },
  { emoji: '👏', label: 'clap',     anim: 'shake' },
  { emoji: '😂', label: 'lol',      anim: 'wiggle' },
  { emoji: '💩', label: 'poop',     anim: 'rise' },
  { emoji: '🤡', label: 'clown',    anim: 'flip' },
  { emoji: '😱', label: 'shock',    anim: 'shake', glow: 'rgba(244,63,94,0.4)' },
  { emoji: '😎', label: 'cool',     anim: 'rise' },
  { emoji: '🤯', label: 'mind blown', anim: 'spawn', count: 3 },
  { emoji: '💀', label: 'rip',      anim: 'shake' },
  { emoji: '🥱', label: 'bored',    anim: 'rise' },
  { emoji: '🫵', label: 'callout',  anim: 'bounce' },
  { emoji: '✂️', label: 'cut!',     anim: 'wiggle', glow: 'rgba(232,121,249,0.45)' },
  { emoji: '🃏', label: 'wild',     anim: 'flip',   glow: 'rgba(167,139,250,0.45)' },
];
const EMOTE_BY_EMOJI: Record<string, EmoteDef> =
  Object.fromEntries(EMOTES.map(e => [e.emoji, e]));

const EMOTE_FAVS_KEY = 'ph_emote_favs';
const DEFAULT_FAVS = ['👍', '😂', '🔥', '💩', '😱'];
function loadFavs(): string[] {
  try {
    const raw = localStorage.getItem(EMOTE_FAVS_KEY);
    if (!raw) return DEFAULT_FAVS;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.every(x => typeof x === 'string')) {
      // Filter to known emojis so a stale storage entry from an older version
      // doesn't render orphan glyphs.
      const valid = arr.filter(e => EMOTE_BY_EMOJI[e]).slice(0, 5);
      return valid.length > 0 ? valid : DEFAULT_FAVS;
    }
  } catch { /* ignore */ }
  return DEFAULT_FAVS;
}
function saveFavs(favs: string[]) {
  try { localStorage.setItem(EMOTE_FAVS_KEY, JSON.stringify(favs.slice(0, 5))); } catch { /* ignore */ }
}

// Renders a single emote burst on a player tile. Animation variant is chosen
// per emoji from the catalog so each reaction has its own personality —
// "🔥" spawns multiple flames, "💀" shakes, "👏" claps left/right, etc.
function EmoteBurst({ def, seed }: { def: EmoteDef; seed: number }) {
  const count = def.count ?? 1;
  return (
    <>
      {Array.from({ length: count }).map((_, i) => {
        const xJitter = count > 1 ? (i - (count - 1) / 2) * 18 + (((seed * (i + 1)) % 7) - 3) : 0;
        const tilt = count > 1 ? ((seed + i * 31) % 30) - 15 : 0;
        const delay = i * 0.07;
        const animProps = (() => {
          switch (def.anim) {
            case 'bounce': return {
              initial: { opacity: 0, scale: 0.4, y: 0 },
              animate: { opacity: [0, 1, 1, 0], scale: [0.4, 1.4, 1.0, 1.0], y: [0, -22, -16, -42] },
              transition: { duration: 1.4, delay, times: [0, 0.25, 0.5, 1] },
            };
            case 'rise': return {
              initial: { opacity: 0, y: 4, scale: 0.7 },
              animate: { opacity: [0, 1, 1, 0], y: [4, -28, -54, -86], scale: [0.7, 1.1, 1.05, 1.0] },
              transition: { duration: 1.6, delay, times: [0, 0.2, 0.6, 1], ease: 'easeOut' as const },
            };
            case 'shake': return {
              initial: { opacity: 0, scale: 0.6, rotate: 0 },
              animate: { opacity: [0, 1, 1, 0], scale: [0.6, 1.25, 1.1, 1.0], rotate: [0, -18, 18, -10, 0], y: [0, -10, -20, -40] },
              transition: { duration: 1.4, delay, times: [0, 0.15, 0.5, 0.8, 1] },
            };
            case 'spawn': return {
              initial: { opacity: 0, scale: 0.3, x: xJitter, y: 8, rotate: tilt },
              animate: { opacity: [0, 1, 1, 0], scale: [0.3, 1.2, 1.0, 0.9], y: [8, -28, -60, -100], rotate: [tilt, tilt + 8, tilt - 4, tilt] },
              transition: { duration: 1.7, delay, times: [0, 0.18, 0.6, 1], ease: 'easeOut' },
            };
            case 'wiggle': return {
              initial: { opacity: 0, scale: 0.5, rotate: 0 },
              animate: { opacity: [0, 1, 1, 0], scale: [0.5, 1.35, 1.1, 1.0], rotate: [0, 12, -10, 8, -6, 0], y: [0, -16, -28, -48] },
              transition: { duration: 1.5, delay, times: [0, 0.15, 0.4, 0.6, 0.85, 1] },
            };
            case 'flip': return {
              initial: { opacity: 0, scale: 0.4, rotateY: 0 },
              animate: { opacity: [0, 1, 1, 0], scale: [0.4, 1.2, 1.05, 1.0], rotateY: [0, 360, 720, 720], y: [0, -22, -34, -58] },
              transition: { duration: 1.6, delay, times: [0, 0.4, 0.7, 1] },
            };
          }
        })();
        return (
          <motion.div
            key={i}
            // Cast: framer-motion's Easing type is a string-literal union and the
            // IIFE above widens our 'easeOut' to plain string. Runtime is fine.
            {...(animProps as any)}
            className="absolute right-2 top-2 text-3xl pointer-events-none"
            style={{
              filter: def.glow ? `drop-shadow(0 0 6px ${def.glow})` : undefined,
              translateX: count > 1 ? xJitter : undefined,
            }}
          >
            {def.emoji}
          </motion.div>
        );
      })}
    </>
  );
}

/* ============== In-room chat ============== */

// Floating chat panel — collapsed icon at bottom-right, expanded sliding panel
// shows the last messages + input. Lives outside the player tile system so
// spectators can chat too (their messages render with a "Spectator" tag and
// neutral colour). Modern glass styling consistent with the action bar.
function ChatPanel({ chats, selfPlayerId, players, onSend }: {
  chats: ChatMsg[];
  selfPlayerId: number;          // viewer's seat id, or -1 for spectator
  players: { id: number; name: string }[];
  onSend: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [seenIds, setSeenIds] = useState<Set<string>>(() => new Set(chats.map(c => c.id)));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Unread count excludes the user's own messages — you don't get a
  // notification for your own typing.
  const unread = open ? 0 : chats.filter(c => !seenIds.has(c.id) && c.playerId !== selfPlayerId).length;
  // When the panel opens (or new messages while open), mark everything seen
  // and scroll to the bottom.
  useEffect(() => {
    if (open) {
      setSeenIds(new Set(chats.map(c => c.id)));
      // Defer scroll so the layout is settled.
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [open, chats]);

  // Floating preview bubble — shows the most recent unread message above the
  // launcher when the panel is closed. Auto-dismisses after 4s, or when the
  // user opens chat. Self-messages are skipped, and we play a soft ping.
  const [preview, setPreview] = useState<ChatMsg | null>(null);
  const lastSeenChatIdRef = useRef<string | null>(chats[chats.length - 1]?.id ?? null);
  useEffect(() => {
    const newest = chats[chats.length - 1];
    if (!newest) return;
    if (newest.id === lastSeenChatIdRef.current) return;
    lastSeenChatIdRef.current = newest.id;
    if (open) return;
    if (newest.playerId === selfPlayerId) return;
    setPreview(newest);
    // Subtle ping — uses the existing 'click' tone (already a polite blip).
    sfx.play('click');
    const t = setTimeout(() => setPreview(null), 4000);
    return () => clearTimeout(t);
  }, [chats, open, selfPlayerId]);
  // Clear the preview the moment the panel opens so it doesn't linger.
  useEffect(() => { if (open) setPreview(null); }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t.slice(0, 240));
    setText('');
  };

  const colorForChat = (c: ChatMsg) => c.playerId === -1 ? null : colorFor(c.playerId);

  return (
    <div className="fixed bottom-16 right-3 z-30">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
            className="absolute bottom-12 right-0 w-72 sm:w-80 max-h-[70vh] flex flex-col bg-slate-900/92 backdrop-blur-md ring-1 ring-white/15 rounded-2xl shadow-[0_12px_32px_rgba(0,0,0,0.55)] overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <span className="text-xs font-semibold text-white/85 flex items-center gap-1.5">
                <span aria-hidden>💬</span> Chat
              </span>
              <button
                onClick={() => setOpen(false)}
                className="text-white/60 hover:text-white text-sm leading-none"
                aria-label="Close chat"
              >×</button>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1.5 max-h-72">
              {chats.length === 0 && (
                <div className="text-xs text-white/40 italic text-center py-4">
                  No messages yet — say hi 👋
                </div>
              )}
              {chats.map(c => {
                const mine = c.playerId === selfPlayerId;
                const palette = colorForChat(c);
                return (
                  <div key={c.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                    <div className="text-[10px] text-white/55 px-1 flex items-center gap-1">
                      {palette && <span className={`inline-block w-1.5 h-1.5 rounded-full ${palette.dot}`} />}
                      <span>{c.name}{c.playerId === -1 && <span className="ml-1 px-1 py-px rounded bg-white/15 text-white/70 text-[9px]">spectator</span>}</span>
                    </div>
                    <div
                      className={`max-w-[85%] px-2.5 py-1.5 rounded-2xl text-sm leading-snug shadow-sm ${
                        mine
                          ? 'bg-emerald-500 text-white rounded-br-md'
                          : c.playerId === -1
                            ? 'bg-white/10 text-white/85 rounded-bl-md'
                            : 'bg-white/15 text-white rounded-bl-md'
                      }`}
                    >
                      {c.text}
                    </div>
                  </div>
                );
              })}
            </div>
            <form onSubmit={submit} className="flex items-center gap-1.5 px-2 py-2 border-t border-white/10 bg-slate-900/60">
              <input
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="Say something…"
                maxLength={240}
                className="flex-1 px-2.5 py-1.5 rounded-full bg-white/10 text-sm text-white placeholder-white/40 focus:outline-none focus:bg-white/15 ring-1 ring-white/10"
              />
              <button
                type="submit"
                disabled={!text.trim()}
                className={`px-3 py-1.5 rounded-full text-sm font-semibold ${text.trim() ? 'bg-emerald-500 hover:bg-emerald-400 text-white' : 'bg-white/10 text-white/40 cursor-not-allowed'}`}
                aria-label="Send"
              >→</button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating message preview — peeks out from above the launcher with the
          most recent unread message. Auto-dismisses after 4s; clicking opens
          the panel instead. Pointer-events on so it's clickable. */}
      <AnimatePresence>
        {preview && !open && (
          <motion.button
            type="button"
            onClick={() => setOpen(true)}
            initial={{ opacity: 0, x: 24, y: 4, scale: 0.92 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 12, y: 4, scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            className="absolute bottom-12 right-0 max-w-[240px] bg-slate-900/92 backdrop-blur-md ring-1 ring-emerald-400/30 rounded-2xl rounded-br-md shadow-[0_8px_24px_rgba(0,0,0,0.5)] p-2.5 text-left"
            aria-label={`New message from ${preview.name}`}
          >
            <div className="flex items-center gap-1 text-[10px] font-semibold text-emerald-300/90 mb-0.5">
              {preview.playerId !== -1 && (
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${colorFor(preview.playerId).dot}`} />
              )}
              <span className="truncate">{preview.name}</span>
            </div>
            <div className="text-sm text-white leading-snug line-clamp-2 break-words">{preview.text}</div>
          </motion.button>
        )}
      </AnimatePresence>

      <button
        onClick={() => setOpen(o => !o)}
        title="Chat"
        className={`relative w-10 h-10 rounded-full bg-slate-900/85 backdrop-blur-md ring-1 ring-white/15 shadow-lg text-xl hover:bg-slate-800 flex items-center justify-center ${unread > 0 && !open ? 'chat-pulse' : ''}`}
      >
        {open ? '×' : '💬'}
        {unread > 0 && !open && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-slate-900">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    </div>
  );
}

function EmoteBar({ onEmote }: { onEmote: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const [favs, setFavs] = useState<string[]>(loadFavs);
  const send = (emoji: string) => {
    onEmote(emoji);
    // Promote the emoji to the top of favourites — recently-used floats up.
    const next = [emoji, ...favs.filter(e => e !== emoji)].slice(0, 5);
    setFavs(next);
    saveFavs(next);
    setOpen(false);
    setPicker(false);
  };
  return (
    <div className="fixed bottom-3 right-3 z-30">
      <AnimatePresence>
        {open && !picker && (
          <motion.div
            key="favs"
            initial={{ opacity: 0, y: 12, scale: 0.85 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.85 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="absolute bottom-12 right-0 flex gap-1 bg-slate-900/85 backdrop-blur-md ring-1 ring-white/15 rounded-full px-2 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
          >
            {favs.map(emoji => (
              <button
                key={emoji}
                onClick={() => send(emoji)}
                className="text-xl hover:scale-125 transition-transform px-1 leading-none"
                aria-label={`emote ${emoji}`}
              >{emoji}</button>
            ))}
            <button
              onClick={() => setPicker(true)}
              className="ml-1 text-sm text-white/70 hover:text-white px-2 leading-none border-l border-white/15"
              title="More emotes"
            >＋</button>
          </motion.div>
        )}
        {open && picker && (
          <motion.div
            key="picker"
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.95 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="absolute bottom-12 right-0 grid grid-cols-6 gap-1 bg-slate-900/90 backdrop-blur-md ring-1 ring-white/15 rounded-2xl p-2 shadow-[0_10px_30px_rgba(0,0,0,0.5)] w-64"
          >
            {EMOTES.map(e => (
              <button
                key={e.emoji}
                onClick={() => send(e.emoji)}
                title={e.label}
                className="text-xl hover:scale-125 hover:bg-white/10 rounded-md transition-all p-1.5 leading-none"
                aria-label={`emote ${e.label}`}
              >{e.emoji}</button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <button
        onClick={() => { setOpen(o => !o); setPicker(false); }}
        title="Send an emote"
        className="w-10 h-10 rounded-full bg-slate-900/85 backdrop-blur-md ring-1 ring-white/15 shadow-lg text-xl hover:bg-slate-800 flex items-center justify-center"
      >{open ? '×' : '😀'}</button>
    </div>
  );
}

// 30s reveal time-limit, mirrored from the server-side TURN_TIMEOUT_MS.
// Local games run their own copy of this timer (the server isn't involved
// for hot-seat). Network games rely on the server's auto-reveal — we still
// render a visible countdown here so the player knows it's coming.
const REVEAL_TIMEOUT_MS = 30 * 1000;

function RevealChoiceScreen({ state, dispatch, viewerId }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
}) {
  const rawCards = state.pendingReveal?.cards ?? [];
  // legalIds: cards the picker COULD have legally played onto the pile
  // they just picked up. House rule says they must reveal a card they
  // couldn't have played — so these are dimmed + unclickable. If every
  // card was legal (edge case), the constraint is dropped so the user
  // isn't stranded.
  const legalIdSet = useMemo(
    () => new Set(state.pendingReveal?.legalIds ?? []),
    [state.pendingReveal?.legalIds]
  );
  const allWereLegal = rawCards.length > 0 && legalIdSet.size === rawCards.length;
  const isCardEligible = (id: string) => allWereLegal || !legalIdSet.has(id);
  const picker = state.players[state.current];
  const isMyChoice = viewerId === null
    ? !picker?.isAi
    : (viewerId === state.current && !picker?.isAi);

  // Visible countdown for the active picker. Refreshes 10x/sec so the bar
  // glides smoothly. Local games (viewerId === null) also enforce the limit
  // here by dispatching a random REVEAL_CHOICE on expiry — the server
  // already does this for network games, but adding it locally too means
  // the rule is consistent everywhere and the UI is self-honest.
  const startedAtRef = useRef<number>(Date.now());
  // Reset the start whenever this screen mounts for a fresh reveal (the key
  // changes via state.current → React unmounts/mounts cleanly).
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!isMyChoice) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [isMyChoice]);
  const elapsed = now - startedAtRef.current;
  const remaining = Math.max(0, REVEAL_TIMEOUT_MS - elapsed);
  const pct = Math.min(100, (elapsed / REVEAL_TIMEOUT_MS) * 100);
  // Auto-pick a card on expiry — only fires for local games where
  // viewerId === null (no server). Network games are handled server-side.
  // Picks from eligible (illegal-on-prior-pile) cards first; falls back
  // to any card if every hand card was legal.
  useEffect(() => {
    if (!isMyChoice || viewerId !== null) return;
    if (rawCards.length === 0) return;
    const t = setTimeout(() => {
      const eligible = rawCards.filter(c => isCardEligible(c.id));
      const pool = eligible.length > 0 ? eligible : rawCards;
      const choice = pool[Math.floor(Math.random() * pool.length)];
      if (choice) dispatch({ type: 'REVEAL_CHOICE', id: choice.id });
    }, REVEAL_TIMEOUT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMyChoice, viewerId, rawCards.length]);
  // Picker sees real cards sorted for scanning; everyone else just gets a tiny
  // status pip — no full-screen takeover when it's not their decision.
  if (!isMyChoice) {
    return (
      <motion.div
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -16, opacity: 0 }}
        className="fixed top-16 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 rounded-full bg-emerald-950/85 backdrop-blur-sm border border-emerald-400/30 text-emerald-100 text-xs font-semibold shadow-lg flex items-center gap-2 pointer-events-none"
        role="status"
        aria-live="polite"
      >
        <motion.span
          animate={{ opacity: [0.35, 1, 0.35] }}
          transition={{ repeat: Infinity, duration: 1.4 }}
          className="text-base"
        >🃏</motion.span>
        <span>{picker?.name} is revealing…</span>
      </motion.div>
    );
  }
  const cards = sortCards(rawCards);
  return (
    <motion.div
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      className="fixed bottom-0 left-0 right-0 z-30 bg-emerald-950/92 backdrop-blur-md border-t-2 border-emerald-400/40 shadow-[0_-8px_32px_rgba(0,0,0,0.45)] rounded-t-2xl sm:rounded-t-3xl"
      role="dialog"
      aria-label="Reveal a card from your hand"
    >
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-3 pb-4 flex flex-col items-center gap-2.5">
        {/* Slim countdown bar at the very top — fills + warms toward red as the
            30s timeout approaches so the player knows a random card will be
            picked if they stall. Hidden when expired (right before the auto
            REVEAL_CHOICE fires from the local-mode timeout effect). */}
        {remaining > 0 && (
          <div className="w-full max-w-md h-1 rounded-full bg-emerald-900/60 overflow-hidden">
            <div
              className={`h-full transition-all duration-100 ease-linear ${
                pct > 85 ? 'bg-rose-500' : pct > 65 ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        {/* Drag handle — purely decorative cue that this is a sheet. */}
        <div className="w-10 h-1 rounded-full bg-emerald-300/40" aria-hidden />
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm sm:text-base font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
              Reveal a card you couldn't play
            </span>
            <span className={`text-xs font-semibold tabular-nums ${
              remaining < 8000 ? 'text-rose-300' : 'text-white/70'
            }`}>
              {Math.ceil(remaining / 1000)}s
            </span>
          </div>
          <span className="text-[11px] text-white/85 drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
            Playable cards are dimmed — you have to prove you had no legal move.
          </span>
        </div>
        <div className="flex flex-wrap gap-2 justify-center">
          {cards.map((card, idx) => {
            const eligible = isCardEligible(card.id);
            return (
              <motion.button
                key={card.id}
                type="button"
                disabled={!eligible}
                onClick={() => eligible && dispatch({ type: 'REVEAL_CHOICE', id: card.id })}
                whileHover={eligible ? { scale: 1.12, y: -6 } : undefined}
                whileTap={eligible ? { scale: 0.95 } : undefined}
                initial={{ y: 18, opacity: 0 }}
                animate={{ y: 0, opacity: eligible ? 1 : 0.4 }}
                transition={{ type: 'spring', stiffness: 300, damping: 22, delay: idx * 0.03 }}
                className={`bg-transparent border-0 p-0 ${eligible ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                aria-label={eligible ? `Reveal ${card.rank}${card.suit}` : `${card.rank}${card.suit} — would have been a legal play`}
                title={eligible ? undefined : 'Would have been a legal play — pick a different card'}
              >
                <div className={`relative rounded-md transition-shadow ${
                  eligible
                    ? 'ring-1 ring-emerald-300/35 hover:ring-2 hover:ring-emerald-300 hover:shadow-[0_8px_20px_rgba(16,185,129,0.35)]'
                    : 'ring-1 ring-white/10 saturate-50'
                }`}>
                  <CardFace card={card} />
                  {!eligible && (
                    <span
                      aria-hidden
                      className="absolute -top-1.5 -right-1.5 px-1 py-0.5 rounded-full text-[9px] font-bold tracking-wide bg-emerald-500/85 text-white ring-1 ring-white/20"
                    >LEGAL</span>
                  )}
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

function FlipScreen({ state, dispatch, viewerId }: {
  state: GameState; dispatch: (a: Action) => void; viewerId: number | null;
}) {
  const card = state.flippedCard!;
  const legal = canPlayCards([card], state.pile, state.sevenRestriction);
  const myAction = viewerId === null || (viewerId === state.current && !state.players[state.current]?.isAi);
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center p-6 overflow-hidden">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        className="absolute inset-0 bg-stone-900/55 backdrop-blur-sm"
      />
      <motion.div
        initial={{ clipPath: 'inset(50% 0 50% 0)', opacity: 0 }}
        animate={{ clipPath: 'inset(0% 0 0% 0)', opacity: 1 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-md rounded-3xl bg-stone-50 border-2 border-stone-300 shadow-2xl p-8 flex flex-col items-center gap-6"
      >
        <h2 className="text-2xl sm:text-3xl font-black text-center">
          Face-down flip — <span className="text-amber-700">{state.players[state.current].name}</span>
        </h2>
        <motion.div
          initial={{ rotateY: 180, scale: 0.4 }}
          animate={{ rotateY: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 18, delay: 0.3 }}
          className="scale-150 sm:scale-[1.8]"
          style={{ transformOrigin: 'center' }}
        >
          <CardFace card={card} />
        </motion.div>
        <div className="text-base sm:text-lg font-semibold text-center mt-4">
          {legal
            ? <span className="text-emerald-700">✓ Legal — it will be played.</span>
            : <span className="text-rose-700">✗ Not legal — {state.players[state.current].name} picks up the pile + this card.</span>
          }
        </div>
        {myAction && (
          <motion.button
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }}
            onClick={() => dispatch({ type: 'RESOLVE_FLIP' })}
            className="px-8 py-3 bg-amber-500 hover:bg-amber-400 active:scale-95 text-white font-bold rounded-xl shadow-lg text-base"
          >Continue</motion.button>
        )}
      </motion.div>
    </div>
  );
}

function EndScreen({ state, onPlayAgain, canPlayAgain = true, awaitingHost = false, onCloseRoom }: { state: GameState; onPlayAgain: () => void; canPlayAgain?: boolean; awaitingHost?: boolean; onCloseRoom?: () => void }) {
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
    { label: 'Largest pile picked up', emoji: '🗑', key: 'largestPile' },
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

      {/* POOP HEAD rubber-stamp — slams down 600ms after the title with a
          rotated bounce + rose ring, sized so it reads as a "stamp" rather
          than a label. Decorative; aria-hidden. */}
      <motion.div
        initial={{ scale: 4, opacity: 0, rotate: -22 }}
        animate={{ scale: 1, opacity: 1, rotate: -8 }}
        transition={{ delay: 0.55, type: 'spring', stiffness: 280, damping: 14 }}
        className="z-10"
        aria-hidden
      >
        <div className="px-4 py-1.5 rounded-md border-[3px] border-rose-600 text-rose-700 font-black tracking-[0.18em] text-base sm:text-xl bg-white/10 shadow-[0_6px_24px_rgba(244,63,94,0.45)]">
          💩 POOP HEAD
        </div>
      </motion.div>

      <ol className="bg-white/90 p-4 rounded-lg border border-gray-300 z-10 min-w-[260px] space-y-1.5">
        {order.map(p => (
          <li key={p.id} className="flex items-center gap-2">
            <RankMedal pos={p.finishPos!} />
            <span className={`inline-block w-2 h-2 rounded-full ${colorFor(p.id).dot}`} />
            <span className={p.finishPos === 1 ? 'font-bold' : ''}>{p.name}</span>
            {p.finishPos === 1 && (
              <motion.span
                aria-hidden
                animate={{ y: [0, -3, 0] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                className="text-lg leading-none drop-shadow-[0_2px_4px_rgba(251,191,36,0.55)]"
              >👑</motion.span>
            )}
          </li>
        ))}
        <li className="text-rose-700 font-semibold flex items-center gap-2">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-rose-400 bg-rose-50 text-rose-800 text-[10px] font-bold">
            <span className="text-sm leading-none">💩</span>
            <span>#{state.players.length}</span>
          </span>
          <span className={`inline-block w-2 h-2 rounded-full ${colorFor(loser?.id ?? 0).dot}`} />
          <span>{loser?.name} (Poop Head)</span>
        </li>
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
              <th className="p-1">🗑 Biggest</th>
              <th className="p-1">🃏 Played</th>
              <th className="p-1">⚡ Power</th>
              <th className="p-1">🔥 Burns</th>
              {ultimate && <th className="p-1">✂ Cuts</th>}
            </tr>
          </thead>
          <tbody>
            {state.players.map(p => {
              // Default includes largestPile: 0 so older saved/in-flight games
              // (which may not have the field) don't render undefined.
              const s = state.stats[p.id] ?? { pickups: 0, cardsPlayed: 0, powerCards: 0, burns: 0, cuts: 0, largestPile: 0 };
              return (
                <tr key={p.id} className="border-b border-gray-100 last:border-b-0">
                  <td className="p-1 flex items-center gap-1.5">
                    <span className={`inline-block w-2 h-2 rounded-full ${colorFor(p.id).dot}`} />
                    {p.name}{p.isAi && <span className="text-[10px] text-gray-500">AI</span>}
                  </td>
                  <td className="p-1 text-center tabular-nums">{s.pickups}</td>
                  <td className="p-1 text-center tabular-nums">{s.largestPile ?? 0}</td>
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

      {/* Rematch panel — a single one-tap "same seats" CTA replaces the
          old "Play again" button. The seat strip makes it explicit who
          you're queuing up against, so there's no ambiguity about whether
          rematch keeps the same lineup. Loser is tagged with a 💩 chip;
          everyone else is neutral. Online: non-host viewers see the
          identical strip with a "waiting for host" status. */}
      <div className="z-10 w-full max-w-2xl flex flex-col items-center gap-3">
        <div className="w-full rounded-2xl bg-slate-900/80 backdrop-blur-md ring-1 ring-white/10 shadow-[0_12px_36px_rgba(0,0,0,0.45)] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-[0.18em] text-emerald-300/80 font-semibold">Quick rematch</span>
              <span className="text-white text-base font-bold">Same seats, new deal</span>
            </div>
            {canPlayAgain ? (
              <button
                onClick={onPlayAgain}
                className="px-5 h-11 rounded-full bg-emerald-500 hover:bg-emerald-400 active:scale-[0.97] text-white font-bold shadow-[0_8px_24px_rgba(16,185,129,0.45)] transition-all flex items-center gap-2"
              >
                <span aria-hidden>▶</span>
                Play again
              </button>
            ) : (
              <span className="flex items-center gap-2 px-3 h-9 rounded-full bg-white/5 ring-1 ring-white/10 text-white/75 text-xs font-semibold">
                <motion.span
                  animate={{ opacity: [0.4, 1, 0.4] }}
                  transition={{ repeat: Infinity, duration: 1.4 }}
                  aria-hidden
                >⏳</motion.span>
                Waiting for host…
              </span>
            )}
          </div>
          {/* Seat strip — coloured dot + name + status chip per player. */}
          <div className="flex flex-wrap gap-1.5">
            {state.players.map(p => {
              const isLoser = p.id === state.poopHead;
              const isWinner = p.finishPos === 1;
              const c = colorFor(p.id);
              return (
                <div
                  key={p.id}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ring-1 ${
                    isLoser
                      ? 'bg-rose-500/15 ring-rose-400/30 text-rose-100'
                      : isWinner
                        ? 'bg-amber-400/15 ring-amber-400/40 text-amber-100'
                        : 'bg-white/5 ring-white/10 text-white/80'
                  }`}
                >
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.dot}`} />
                  <span className="truncate max-w-[120px]">{p.name}</span>
                  {p.isAi && <span className="text-[9px] px-1 py-0 rounded bg-white/10 text-white/70 font-bold tracking-wide">AI</span>}
                  {isLoser && <span aria-hidden className="text-xs leading-none">💩</span>}
                  {isWinner && <span aria-hidden className="text-xs leading-none">👑</span>}
                </div>
              );
            })}
          </div>
        </div>
        <ShareScorecardButton state={state} />
        {/* Host-only "Close room" — sends everyone back to the menu and
            frees the room code. Renders as a low-emphasis text link so
            it doesn't compete with the rematch CTA above. */}
        {onCloseRoom && (
          <button
            onClick={onCloseRoom}
            className="text-xs text-white/60 hover:text-rose-300 underline underline-offset-2"
          >
            Close room
          </button>
        )}
      </div>
    </div>
  );
}

// Render a 1080×1080 scorecard onto an offscreen canvas, then either pop the
// native share sheet (mobile) or trigger a download. Self-contained — no
// external image libs. Caches the blob so repeat clicks are instant.
function ShareScorecardButton({ state }: { state: GameState }) {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await renderScorecardBlob(state);
      if (!blob) return;
      const file = new File([blob], 'latrine-scorecard.png', { type: 'image/png' });
      const canShareFiles =
        typeof navigator !== 'undefined' &&
        typeof (navigator as Navigator & { canShare?: (d: ShareData) => boolean }).canShare === 'function' &&
        (navigator as Navigator & { canShare?: (d: ShareData) => boolean }).canShare!({ files: [file] });
      if (canShareFiles && typeof navigator.share === 'function') {
        try {
          await navigator.share({ files: [file], title: 'Latrine — game over', text: '💩 Latrine scorecard' });
          return;
        } catch { /* user cancelled — fall through to download */ }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'latrine-scorecard.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`px-5 py-3 rounded-lg font-bold shadow border ${busy ? 'bg-gray-300 text-gray-600 cursor-wait' : 'bg-white/90 hover:bg-white text-gray-800 border-gray-300'}`}
    >
      {busy ? '…' : '📤 Share scorecard'}
    </button>
  );
}

async function renderScorecardBlob(state: GameState): Promise<Blob | null> {
  const SIZE = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Felt background — solid base + soft radial highlight to mimic the live table.
  ctx.fillStyle = '#2c5d44';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const grad = ctx.createRadialGradient(SIZE / 2, SIZE * 0.3, 80, SIZE / 2, SIZE / 2, SIZE * 0.7);
  grad.addColorStop(0, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // Title.
  ctx.fillStyle = 'white';
  ctx.font = 'bold 88px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto';
  ctx.fillText('💩 Latrine', SIZE / 2, 110);
  ctx.font = '500 36px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(state.mode === 'ultimate' ? 'Ultimate · Game over' : 'Game over', SIZE / 2, 175);

  // Loser callout.
  const loser = state.players.find(p => p.id === state.poopHead);
  ctx.fillStyle = '#fde68a';
  ctx.font = 'bold 64px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(`${loser?.name ?? '?'} is the Poop Head 💩`, SIZE / 2, 280);

  // Final order panel.
  const order = state.players
    .filter(p => p.finishPos !== null)
    .sort((a, b) => (a.finishPos! - b.finishPos!));
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  const panelX = 120, panelY = 360, panelW = SIZE - 240;
  const rows = order.length + 1;
  const rowH = 70;
  const panelH = rows * rowH + 60;
  ctx.beginPath();
  ctx.roundRect(panelX, panelY, panelW, panelH, 24);
  ctx.fill();
  ctx.fillStyle = '#1f2937';
  ctx.textAlign = 'left';
  ctx.font = 'bold 44px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('Final standings', panelX + 32, panelY + 50);
  ctx.font = '500 38px ui-sans-serif, system-ui, sans-serif';
  let y = panelY + 110;
  const medal = (pos: number) => pos === 0 ? '🥇' : pos === 1 ? '🥈' : pos === 2 ? '🥉' : `#${pos + 1}`;
  for (const p of order) {
    ctx.fillStyle = '#1f2937';
    ctx.fillText(`${medal(p.finishPos!)}  ${p.name}${p.isAi ? ' (AI)' : ''}`, panelX + 32, y);
    y += rowH;
  }
  if (loser) {
    ctx.fillStyle = '#9f1239';
    ctx.fillText(`💩  ${loser.name}${loser.isAi ? ' (AI)' : ''}`, panelX + 32, y);
  }

  // Footer.
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'center';
  ctx.font = '500 30px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('cardgame-lilac.vercel.app', SIZE / 2, SIZE - 60);

  return await new Promise<Blob | null>(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
}

/* ============== Network lobby ============== */

// Share button: prefers the native Web Share sheet (so iOS users can drop the
// link straight into iMessage), falls back to clipboard copy with a brief
// "Copied!" confirmation. Self-contained — owns its own copied-state.
function ShareRoomButton({ code, url }: { code: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const onClick = async () => {
    const text = `Join my Latrine game — room ${code}`;
    try {
      if (canShare) {
        await navigator.share({ title: 'Latrine', text, url });
        return;
      }
    } catch { /* user cancelled or share failed; fall through to clipboard */ }
    try { await navigator.clipboard?.writeText(url); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={onClick}
      className="text-xs px-3 py-1 bg-white/80 border border-gray-300 rounded hover:bg-white flex items-center gap-1"
      title={url}
    >
      {copied ? '✓ Copied!' : (canShare ? '📤 Share invite' : '🔗 Copy invite link')}
    </button>
  );
}


function NetLobbyScreen({ conn, onLeave, prefilledCode, auth }: { conn: NetworkConn; onLeave: () => void; prefilledCode?: string; auth: AuthState }) {
  // Avatar to bind to this seat — taken from the signed-in profile if any.
  // Guests connect without one and get the default initial-letter fallback
  // on their tile (same as their menu identity pill).
  const myAvatar = auth.profile?.avatar ?? undefined;
  const [name, setName] = useState(() => loadName());
  const [code, setCode] = useState(prefilledCode?.toUpperCase() ?? '');
  // Public rooms appear in LIST_ROOMS and are joinable with a single click.
  // Private rooms are unlisted; only the room code lets you in (host shares
  // it via link / iMessage / etc).
  const [createPrivate, setCreatePrivate] = useState(false);
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() => {
    try {
      const v = localStorage.getItem('ph_ai_difficulty');
      return (v === 'easy' || v === 'normal' || v === 'hard') ? v : 'normal';
    } catch { return 'normal'; }
  });
  const setAndPersistDifficulty = (d: AiDifficulty) => {
    setAiDifficulty(d);
    try { localStorage.setItem('ph_ai_difficulty', d); } catch { /* ignore */ }
  };

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
            {/* Public room list — one-click join. Each row is the join button:
                you don't have to retype the code, the listing knows it. Started
                rooms show "Spectate" instead. Private rooms never appear here
                — they're hidden by the server. */}
            {conn.rooms.length > 0 && (
              <div className="border border-gray-300 rounded bg-white/80">
                <div className="px-3 py-2 text-xs font-semibold text-gray-700 border-b border-gray-200 flex items-center justify-between">
                  <span>🟢 Live games ({conn.rooms.length})</span>
                  <button
                    onClick={() => conn.send({ t: 'LIST_ROOMS' })}
                    className="text-gray-500 hover:text-gray-800" title="Refresh"
                  >↻</button>
                </div>
                <ul className="max-h-56 overflow-y-auto divide-y divide-gray-100">
                  {conn.rooms.map(r => {
                    const isJoinable = !r.started && r.playerCount < r.maxPlayers;
                    const action = r.started ? 'spectate' : (isJoinable ? 'join' : 'full');
                    const onClick = () => {
                      if (action === 'full') return;
                      if (action === 'join' && !nameTrim) return;
                      saveName(nameTrim);
                      if (action === 'spectate') conn.send({ t: 'SPECTATE', code: r.code });
                      else                       conn.send({ t: 'JOIN', code: r.code, name: nameTrim, avatar: myAvatar });
                    };
                    return (
                      <li key={r.code}>
                        <button
                          onClick={onClick}
                          disabled={action === 'full' || (action === 'join' && !nameTrim)}
                          className={`w-full px-3 py-2.5 text-left text-sm flex items-center justify-between transition-colors ${
                            action === 'full'
                              ? 'opacity-60 cursor-not-allowed'
                              : action === 'join' && !nameTrim
                                ? 'opacity-60 cursor-not-allowed'
                                : 'hover:bg-indigo-50 active:bg-indigo-100'
                          }`}
                        >
                          <span className="flex flex-col min-w-0">
                            <span className="font-semibold truncate">{r.host}'s game</span>
                            <span className="text-xs text-gray-500">
                              {r.playerCount}/{r.maxPlayers} players · {r.started ? 'in progress' : 'lobby'}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5 whitespace-nowrap">
                            {r.started && r.connectedHumans === 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">paused</span>
                            )}
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                              action === 'full'   ? 'bg-gray-200 text-gray-600' :
                              action === 'spectate' ? 'bg-gray-700 text-white' :
                                                    'bg-emerald-500 text-white'
                            }`}>
                              {action === 'full' ? 'full' : action === 'spectate' ? 'spectate' : '▶ join'}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <input value={name} onChange={e => { setName(e.target.value); saveName(e.target.value); }} placeholder="Your name"
              className="px-3 py-2 border border-gray-300 rounded" />

            {/* Create-room block. The toggle is a two-pill segmented control:
                Public (listed, one-click joinable from the live games list)
                or Private (hidden — only joinable via the code, which the
                host shares out-of-band). The 4-char code itself is the
                credential — no separate password. */}
            <div className="flex flex-col gap-2 p-3 rounded-lg bg-white/60 border border-gray-300">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-gray-700">New room</span>
                <div className="flex items-center bg-gray-200 rounded-full p-0.5 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => setCreatePrivate(false)}
                    aria-pressed={!createPrivate}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-full transition-colors ${!createPrivate ? 'bg-emerald-500 text-white shadow-sm' : 'text-gray-600'}`}
                    title="Listed in the live games list — anyone can click Join"
                  >🌐 Public</button>
                  <button
                    type="button"
                    onClick={() => setCreatePrivate(true)}
                    aria-pressed={createPrivate}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-full transition-colors ${createPrivate ? 'bg-slate-700 text-white shadow-sm' : 'text-gray-600'}`}
                    title="Hidden — only joinable via the room code"
                  >🔒 Private</button>
                </div>
              </div>
              <p className="text-[11px] text-gray-500 leading-snug">
                {createPrivate
                  ? 'Hidden from the live games list. Share the room code to invite friends.'
                  : 'Anyone can find and join from the live games list above.'}
              </p>
              <button
                disabled={!nameTrim}
                onClick={() => {
                  saveName(nameTrim);
                  conn.send({ t: 'CREATE', name: nameTrim, private: createPrivate, avatar: myAvatar });
                }}
                className={`px-4 py-2 rounded font-semibold ${
                  nameTrim ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'
                }`}
              >{createPrivate ? '🔒 Create private room' : '🌐 Create public room'}</button>
            </div>

            <div className="text-center text-xs text-gray-500">— or join with a code —</div>
            <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Room code"
              className="px-3 py-2 border border-gray-300 rounded uppercase tracking-widest text-center" maxLength={4} />
            <div className="grid grid-cols-2 gap-2">
              <button
                disabled={!nameTrim || codeTrim.length !== 4}
                onClick={() => {
                  saveName(nameTrim);
                  conn.send({ t: 'JOIN', code: codeTrim, name: nameTrim, avatar: myAvatar });
                }}
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
  const hasAi = conn.lobby.players.some(p => p.isAi);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-6">
      <h2 className="text-3xl font-bold flex items-center gap-2">
        Room {conn.lobby.code}
        {conn.lobby.private && (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-white font-semibold flex items-center gap-1 align-middle"
            title="Private — hidden from the live games list"
          >
            <span aria-hidden>🔒</span> Private
          </span>
        )}
      </h2>
      <ShareRoomButton code={conn.lobby.code} url={shareUrl} />
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
      {isHost && hasAi && (
        <div className="flex flex-col items-center gap-1.5 bg-white/80 px-3 py-2 rounded-lg border border-gray-300">
          <span className="text-xs text-gray-600">AI difficulty</span>
          <div className="grid grid-cols-3 gap-1">
            {(['easy', 'normal', 'hard'] as AiDifficulty[]).map(d => (
              <button
                key={d}
                type="button"
                onClick={() => setAndPersistDifficulty(d)}
                className={`px-3 py-1 rounded text-xs font-semibold capitalize ${
                  aiDifficulty === d
                    ? d === 'easy' ? 'bg-emerald-500 text-white'
                      : d === 'normal' ? 'bg-amber-500 text-white'
                      : 'bg-rose-500 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >{d}</button>
            ))}
          </div>
        </div>
      )}
      {isHost ? (
        <button
          disabled={!enough}
          onClick={() => conn.send({ t: 'START', aiDifficulty })}
          className={`px-6 py-3 rounded-lg font-bold shadow ${enough ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
        >Start game ({conn.lobby.players.length})</button>
      ) : (
        <div className="text-white/80">Waiting for host to start…</div>
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

      {/* Chat in the lobby — same component as in-game so the conversation
          carries through. Spectators appear here too if any are watching. */}
      <ChatPanel
        chats={conn.lobby.chats ?? []}
        selfPlayerId={conn.lobby.myId}
        players={conn.lobby.players.map(p => ({ id: p.id, name: p.name }))}
        onSend={(text) => conn.send({ t: 'CHAT', text })}
      />
    </div>
  );
}

/* ============== Sound + toast bindings ============== */

function useEventEffects(log: string[], resetKey: any): { toasts: Toast[] } {
  // Track the last log line we processed by *content*, not by index. The reducer caps
  // the log at 50 entries (oldest entries shift out as new ones append) — so length
  // alone isn't a reliable cursor: once length plateaus at 50, slice(prevLength) is
  // always empty even though new lines are appended every turn. lastIndexOf survives
  // the rotation as long as the most recently seen line still exists in the cap.
  const lastSeenLine = useRef<string | null>(null);
  const initialized = useRef(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idCounter = useRef(0);
  const haptic = useHaptics();

  useEffect(() => {
    initialized.current = false;
    lastSeenLine.current = null;
    setToasts([]);
  }, [resetKey]);

  useEffect(() => {
    if (log.length === 0) return;
    // First effect run for this game: don't replay every existing line — just record where
    // we are and start diffing from here.
    if (!initialized.current) {
      initialized.current = true;
      lastSeenLine.current = log[log.length - 1];
      return;
    }
    let startIdx: number;
    if (lastSeenLine.current === null) {
      startIdx = 0;
    } else {
      const idx = log.lastIndexOf(lastSeenLine.current);
      if (idx < 0) {
        // The line we last saw has aged out of the cap entirely. Snap to the tail and
        // skip this batch rather than replaying the whole log.
        lastSeenLine.current = log[log.length - 1];
        return;
      }
      startIdx = idx + 1;
    }
    const newLines = log.slice(startIdx);
    if (newLines.length === 0) return;
    lastSeenLine.current = newLines[newLines.length - 1];
    const adds: Toast[] = [];
    for (const line of newLines) {
      if (/Pile burned by 10/i.test(line)) { sfx.play('burn'); haptic('burn'); adds.push({ id: ++idCounter.current, text: '🔥 Pile burned!', tone: 'burn' }); }
      else if (/Four of a kind/i.test(line)) { sfx.play('burn'); haptic('burn'); adds.push({ id: ++idCounter.current, text: '🔥 Four of a kind!', tone: 'burn' }); }
      // Illegal face-down pickups: keep the existing fahhhh sample (different
      // emotional read — that's a "you blew it" moment, not a normal pickup).
      else if (/illegal! Picking up|illegal! Picks up/i.test(line)) { sfx.playSample(SFX_FAHHHH); haptic('error'); }
      // All other pickup phrasings go through the count-aware pickup sound +
      // haptics. Catches both "X picked up the pile (N cards)..." and the
      // more common "X picked up N — must reveal..." case which used to be
      // silent. Vibration pattern scales with N so a 25-card pickup feels
      // genuinely heavier in your hand than a 3-card one (Android only —
      // iOS Safari blocks web vibration).
      else if (/picked up\b/i.test(line)) {
        const m = line.match(/picked up (?:the pile \()?(\d+)/i);
        const count = m ? parseInt(m[1], 10) : 1;
        sfx.play('pickup', { count });
        haptic('pickup', { count });
      }
      else if (/pile reset/i.test(line)) { sfx.play('reset'); haptic('play'); adds.push({ id: ++idCounter.current, text: '🔄 Pile reset', tone: 'reset' }); }
      else if (/direction reversed/i.test(line)) { sfx.play('reverse'); haptic('play'); adds.push({ id: ++idCounter.current, text: '↺ Reverse!', tone: 'reverse' }); }
      else if (/skipped/i.test(line)) { sfx.play('skip'); haptic('play'); adds.push({ id: ++idCounter.current, text: '⏭ Skip!', tone: 'skip' }); }
      else if (/7-or-lower/i.test(line)) { sfx.play('seven'); haptic('play'); adds.push({ id: ++idCounter.current, text: '7-or-lower lock', tone: 'seven' }); }
      else if (/POOP HEAD/i.test(line)) { haptic('win'); adds.push({ id: ++idCounter.current, text: '🏆 Game over!', tone: 'win' }); }
      else if (/\bchained\b/i.test(line)) { sfx.play('chain'); haptic('play'); adds.push({ id: ++idCounter.current, text: '↪ Chain!', tone: 'win' }); }
      else if (/CUT with/i.test(line)) { sfx.playSample(SFX_OBJECTION); haptic('cut'); adds.push({ id: ++idCounter.current, text: '✂ CUT!', tone: 'reverse' }); }
      else if (/^.* played /i.test(line) || /flipped face-down/i.test(line)) { sfx.play('play'); haptic('play'); }
    }
    if (adds.length) {
      setToasts(t => [...t, ...adds]);
      const ids = adds.map(a => a.id);
      setTimeout(() => setToasts(t => t.filter(x => !ids.includes(x.id))), 2500);
    }
  }, [log, haptic]);

  return { toasts };
}

/* ============== Local-mode App ============== */

function LocalGame({ humans, ais, aiSpeed, aiDifficulty, onExit, auth }: { humans: number; ais: number; aiSpeed: number; aiDifficulty: AiDifficulty; onExit: () => void; auth: AuthState }) {
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
    return newGame(total, names, aiSeats, undefined, aiDifficulty);
  }, [humans, ais, aiDifficulty]);
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
  const drawEvents = useAllPlayerDraws(state);

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

  // Ultimate-mode cutters: only AI cutters need detection at this layer (so the
  // AI scheduler knows to fire a cut before the current player's normal turn).
  // Human cuts are handled in-place via the in-hand glow + click-to-cut UX.
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
  const humanCutterPending = cuttersInOrder.find(id => !state.players[id].isAi);

  // Hot-seat: if an AI is about to play and a *different* human has a cut match,
  // switch the viewer to that human so the glowing card is visible in their hand.
  useEffect(() => {
    if (humanCutterPending !== undefined && state.players[state.current]?.isAi) {
      setLocalViewerId(humanCutterPending);
    }
  }, [humanCutterPending, state.current, state.players]);

  // Latest-state ref so timers compute their action against current state at
  // fire-time, not against the (possibly stale) state captured when the
  // effect scheduled. Without this, an interleaved cut or rematch can leave
  // the AI dispatching an invalid action that the reducer silently no-ops,
  // freezing the turn.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

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
    // Give a HUMAN cutter ~1.8s to spot the glow + tap their card before the
    // AI plays through. That's the price of removing the modal cut prompt.
    const humanCutDelay = humanCutterPending !== undefined && aiId === state.current ? 1800 : 0;
    const baseDelay = (isCut ? 350 : 700) * aiSpeed;
    aiTimer.current = window.setTimeout(() => {
      // Recompute against the latest state, not the closure-captured one.
      const fresh = stateRef.current;
      const action = aiPickAction(fresh, aiId!);
      if (action) dispatch(action);
    }, Math.max(baseDelay, revealDelay, humanCutDelay));
    return () => { if (aiTimer.current) clearTimeout(aiTimer.current); };
  }, [state, aiCutterPending, humanCutterPending, aiSpeed]);

  // Local human turn watchdog — mirrors the server's TURN_TIMEOUT_MS. If the
  // current player is human and they don't act within 30s, auto-pickup the
  // pile (or auto-resolve a face-down flip). Reveal phase has its own timer
  // baked into RevealChoiceScreen so we skip it here.
  const humanTurnTimer = useRef<number | null>(null);
  useEffect(() => {
    if (humanTurnTimer.current) { clearTimeout(humanTurnTimer.current); humanTurnTimer.current = null; }
    const phase = state.phase;
    if (phase !== 'play' && phase !== 'flipFaceDown') return;
    const cur = state.players[state.current];
    if (!cur || cur.isAi) return;
    humanTurnTimer.current = window.setTimeout(() => {
      const fresh = stateRef.current;
      const p = fresh.phase;
      if (p !== 'play' && p !== 'flipFaceDown') return;
      const id = fresh.current;
      const player = fresh.players[id];
      if (!player || player.isAi) return;
      const action: Action = p === 'play' ? { type: 'PICKUP_PILE' } : { type: 'RESOLVE_FLIP' };
      dispatch(action);
    }, 30_000);
    return () => { if (humanTurnTimer.current) { clearTimeout(humanTurnTimer.current); humanTurnTimer.current = null; } };
  }, [state.phase, state.current, state.players]);

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
      // Local mode: assume viewer is player 0 (the only consistent human seat
      // outside hot-seat). Hot-seat games skip recording.
      const isHotSeat = state.players.filter(p => !p.isAi).length > 1;
      if (!isHotSeat) {
        const me = state.players[0];
        if (me && !me.isAi) {
          if (me.finishPos === 1) recordOutcome('win');
          else if (state.poopHead === 0) recordOutcome('loss');
          else recordOutcome('middle');
          // Persist a full match row to Supabase if signed in. No-op for guests.
          const s = state.stats[0] ?? { pickups: 0, cardsPlayed: 0, powerCards: 0, burns: 0, cuts: 0, largestPile: 0 };
          recordMatch({
            mode: state.mode,
            online: false,
            player_count: state.players.length,
            ai_count: state.players.filter(p => p.isAi).length,
            finish_pos: me.finishPos,
            was_poop_head: state.poopHead === 0,
            pickups: s.pickups,
            cards_played: s.cardsPlayed,
            power_cards: s.powerCards,
            burns: s.burns,
            cuts: s.cuts,
            largest_pile: s.largestPile ?? 0,
            game_log: state.log,
          });
        }
      }
    } else if (state.phase !== 'end') {
      endedRef.current = false;
    }
  }, [state.phase]);

  // Local-mode avatars: human seats use auth's avatar (only player 0 in
  // typical solo-vs-AI; multiplayer hot-seat is rare and we let them all
  // share the user's avatar — pragmatic compromise). AI seats cycle through
  // a themed pool keyed by their AI-index for visual variety.
  const localAvatars = useMemo(() => {
    const aiAvatars = ['wolf', 'fox', 'eagle', 'dragon', 'shark', 'snake'];
    let aiSeen = 0;
    return state.players.map(p => {
      if (!p.isAi) return auth.profile?.avatar ?? null;
      const av = aiAvatars[aiSeen % aiAvatars.length];
      aiSeen++;
      return av;
    });
  }, [state.players, auth.profile?.avatar]);

  const restart = () => dispatch({
    type: 'NEW_GAME',
    playerCount: humans + ais,
    names: state.players.map(p => p.name),
    aiSeats: state.players.map(p => p.isAi ?? false),
    aiDifficulty,
  });

  let body: React.ReactNode;
  {
    switch (state.phase) {
      case 'swap': body = <SwapScreen state={state} dispatch={dispatch} viewerId={null} />; break;
      case 'pass':
        body = shouldSkipPass
          ? <PlayScreen state={state} dispatch={dispatch} viewerId={localViewerId} fromDeckIds={fromDeckIds} avatars={localAvatars} />
          : <PassScreen state={state} dispatch={dispatch} />;
        break;
      case 'play': body = <PlayScreen state={state} dispatch={dispatch} viewerId={localViewerId} fromDeckIds={fromDeckIds} avatars={localAvatars} />; break;
      case 'flipFaceDown': body = <FlipScreen state={state} dispatch={dispatch} viewerId={localViewerId} />; break;
      // Keep the table mounted under the reveal modal so the pile-pickup
      // animation fires the moment the log line lands. The modal sits on top
      // and absorbs all interaction.
      case 'reveal': body = (
        <>
          <PlayScreen state={state} dispatch={dispatch} viewerId={localViewerId} fromDeckIds={fromDeckIds} avatars={localAvatars} />
          <RevealChoiceScreen state={state} dispatch={dispatch} viewerId={localViewerId} />
        </>
      ); break;
      case 'end': body = <EndScreen state={state} onPlayAgain={restart} />; break;
      default: body = null;
    }
  }

  const handleLocalLeave = () => {
    const inGame = state.phase !== 'end' && state.phase !== 'setup';
    if (inGame && !window.confirm('Leave this game? Your progress will be lost.')) return;
    onExit();
  };
  return (
    <>
      <div className="fixed top-3 left-3 z-50 flex flex-col items-start gap-1">
        <button onClick={handleLocalLeave} className="text-xs px-2 py-1 bg-white/80 border rounded">← menu</button>
        {state.mode === 'ultimate' && <div className="text-[10px] px-2 py-0.5 bg-fuchsia-100 text-fuchsia-800 border border-fuchsia-300 rounded">Ultimate</div>}
      </div>
      <ToastStack toasts={toasts} />
      {body}
      <DeckDrawOverlay events={drawEvents} />
      <AnimatePresence>
        {dealing && (
          <IntroSequence
            players={state.players}
            avatars={localAvatars}
            mode={state.mode}
            aiDifficulty={aiDifficulty}
            onComplete={finishDeal}
          />
        )}
        {reveal && <RevealOverlay key={reveal.ts} playerName={reveal.name} card={reveal.card} />}
      </AnimatePresence>
    </>
  );
}

/* ============== Network-mode App ============== */

function NetworkGame({ onExit, prefilledCode, auth }: { onExit: () => void; prefilledCode?: string; auth: AuthState }) {
  const conn = useNetwork(true);
  const { toasts } = useEventEffects(conn.state?.log ?? [], conn.lobby?.code);
  const { dealing, finishDeal } = useDealAnimationGate(conn.state);
  const reveal = useRevealOverlay(conn.state);
  const myId = conn.session?.spectator ? -1 : conn.lobby?.myId ?? 0;
  const fromDeckIds = useFromDeckTracker(conn.state, myId);
  const drawEvents = useAllPlayerDraws(conn.state);

  const dispatch = (action: Action) => conn.send({ t: 'ACT', action });
  // Pull avatars from the lobby per seat (online players supply their own
  // avatar on JOIN/CREATE; AIs get themed defaults assigned by the server).
  const netAvatars = conn.lobby?.players.map(p => p.avatar) ?? [];
  // Per-seat connection state from the lobby — surfaces "away" pip on
  // tiles when another player has backgrounded the app / dropped network.
  const netConnectedSeats = conn.lobby?.players.map(p => p.connected) ?? undefined;

  // End-of-game sound: the loser hears the fahhhh sample; everyone else hears the win arpeggio.
  const endedRef = useRef(false);
  useEffect(() => {
    if (conn.state?.phase === 'end' && !endedRef.current) {
      endedRef.current = true;
      const myId = conn.session?.spectator ? -1 : conn.lobby?.myId ?? -1;
      if (myId === conn.state.poopHead) sfx.playSample(SFX_FAHHHH);
      else sfx.play('win');
      // Persist W/L for this player. Spectators and AI seats are skipped.
      if (myId >= 0) {
        const me = conn.state.players[myId];
        if (me && !me.isAi) {
          if (me.finishPos === 1) recordOutcome('win');
          else if (conn.state.poopHead === myId) recordOutcome('loss');
          else recordOutcome('middle');
          // Persist a full match row to Supabase if signed in.
          const s = conn.state.stats[myId] ?? { pickups: 0, cardsPlayed: 0, powerCards: 0, burns: 0, cuts: 0, largestPile: 0 };
          recordMatch({
            mode: conn.state.mode,
            online: true,
            player_count: conn.state.players.length,
            ai_count: conn.state.players.filter(p => p.isAi).length,
            finish_pos: me.finishPos,
            was_poop_head: conn.state.poopHead === myId,
            pickups: s.pickups,
            cards_played: s.cardsPlayed,
            power_cards: s.powerCards,
            burns: s.burns,
            cuts: s.cuts,
            largest_pile: s.largestPile ?? 0,
            game_log: conn.state.log,
          });
        }
      }
    } else if (conn.state?.phase !== 'end') {
      endedRef.current = false;
    }
  }, [conn.state?.phase, conn.state?.poopHead, conn.lobby?.myId, conn.session?.spectator]);

  let body: React.ReactNode;
  if (!conn.state) {
    body = <NetLobbyScreen conn={conn} onLeave={() => { conn.disconnect(); onExit(); }} prefilledCode={prefilledCode} auth={auth} />;
  } else {
    const viewerId = myId;
    const onEmote = (e: string) => conn.send({ t: 'EMOTE', emoji: e });
    const onChat = (text: string) => conn.send({ t: 'CHAT', text });
    switch (conn.state.phase) {
      case 'swap': body = <SwapScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} />; break;
      case 'pass':
      case 'play': body = <PlayScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} emotes={conn.lobby?.emotes} onEmote={onEmote} chats={conn.lobby?.chats} onChat={onChat} fromDeckIds={fromDeckIds} spectatorCount={conn.lobby?.spectatorCount} avatars={netAvatars} connectedSeats={netConnectedSeats} />; break;
      case 'flipFaceDown': body = <FlipScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} />; break;
      // Same trick as local mode: keep PlayScreen alive under the reveal modal
      // so its log-watch effect fires the pile-pickup animation.
      case 'reveal': body = (
        <>
          <PlayScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} emotes={conn.lobby?.emotes} onEmote={onEmote} chats={conn.lobby?.chats} onChat={onChat} fromDeckIds={fromDeckIds} spectatorCount={conn.lobby?.spectatorCount} avatars={netAvatars} connectedSeats={netConnectedSeats} />
          <RevealChoiceScreen state={conn.state} dispatch={dispatch} viewerId={viewerId} />
        </>
      ); break;
      case 'end': {
        const isHost = conn.lobby?.myId === conn.lobby?.hostId;
        body = (
          <EndScreen
            state={conn.state}
            onPlayAgain={() => conn.send({ t: 'PLAY_AGAIN' })}
            canPlayAgain={isHost}
            awaitingHost={!isHost}
            onCloseRoom={isHost ? () => {
              if (window.confirm('Close this room? Everyone will be kicked back to the menu.')) {
                conn.send({ t: 'DELETE_ROOM' });
              }
            } : undefined}
          />
        );
        break;
      }
      default: body = <div className="p-6">Loading…</div>;
    }
  }
  // Mid-game leave needs confirmation — bailing without intent during a hand
  // is a common frustration. End/lobby phases can leave silently.
  const handleLeave = () => {
    const inGame = conn.state && conn.state.phase !== 'end';
    if (inGame && !window.confirm('Leave this game? An AI will take over your seat for the rest of the match — you can\'t come back to it.')) return;
    // leave() sends an explicit LEAVE message first so the server knows
    // to free the seat / replace with AI. disconnect() (close-only) is
    // reserved for the menu-from-end-screen path where there's nothing
    // to give up.
    if (inGame) conn.leave(); else conn.disconnect();
    onExit();
  };
  // Host-only "close room" — kicks everyone back to the menu and frees the
  // room code. Mid-game uses a stronger two-line confirmation since it's
  // a big, irreversible action everyone's affected by; lobby/end screens
  // get a single-line confirmation. Available throughout the network
  // session so a host can wind things down anytime.
  const isHostNet = !!conn.lobby && conn.lobby.myId === conn.lobby.hostId;
  const handleCloseRoom = () => {
    const inGame = !!(conn.state && conn.state.phase !== 'end');
    const msg = inGame
      ? "Close the room mid-game?\n\nThis will end the match for everyone and they'll be sent back to the menu. This cannot be undone."
      : 'Close this room? Everyone will be sent back to the menu.';
    if (!window.confirm(msg)) return;
    conn.send({ t: 'DELETE_ROOM' });
  };
  return (
    <>
      <div className="fixed top-3 left-3 z-50 flex flex-col items-start gap-1">
        <div className="flex gap-1.5">
          <button onClick={handleLeave} className="text-xs px-2 py-1 bg-white/80 border rounded">← menu</button>
          {isHostNet && (
            <button
              onClick={handleCloseRoom}
              className="text-xs px-2 py-1 bg-rose-500/90 hover:bg-rose-500 text-white border border-rose-700/50 rounded font-semibold"
              title="Close the room for everyone (host only)"
            >
              Close room
            </button>
          )}
        </div>
        {conn.state?.mode === 'ultimate' && <div className="text-[10px] px-2 py-0.5 bg-fuchsia-100 text-fuchsia-800 border border-fuchsia-300 rounded">Ultimate</div>}
      </div>
      <ToastStack toasts={toasts} />
      <ConnectionPill status={conn.status} attempt={conn.reconnectAttempt} />
      {body}
      <DeckDrawOverlay events={drawEvents} />
      <AnimatePresence>
        {dealing && conn.state && (
          <IntroSequence
            players={conn.state.players}
            avatars={netAvatars}
            mode={conn.state.mode}
            aiDifficulty={conn.state.aiDifficulty}
            onComplete={finishDeal}
          />
        )}
        {reveal && <RevealOverlay key={reveal.ts} playerName={reveal.name} card={reveal.card} />}
      </AnimatePresence>
    </>
  );
}

// Floating pill that shows WS connectivity. Stays hidden when status === 'open'
// and we're not mid-retry. Briefly flashes a green "Reconnected" pip when
// transitioning back from a retry. Top-center so it doesn't fight with the menu
// button or settings.
function ConnectionPill({ status, attempt }: { status: NetworkConn['status']; attempt: number }) {
  const [justReconnected, setJustReconnected] = useState(false);
  const wasRetryingRef = useRef(false);
  useEffect(() => {
    if (status !== 'open' && attempt > 0) wasRetryingRef.current = true;
    if (status === 'open' && wasRetryingRef.current) {
      wasRetryingRef.current = false;
      setJustReconnected(true);
      const t = setTimeout(() => setJustReconnected(false), 1800);
      return () => clearTimeout(t);
    }
  }, [status, attempt]);
  if (status === 'open' && !justReconnected) return null;
  const showReconnecting = status === 'connecting' || status === 'closed' || status === 'error';
  return (
    <motion.div
      initial={{ y: -16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -16, opacity: 0 }}
      className="fixed top-3 left-1/2 -translate-x-1/2 z-50 px-3 py-1 rounded-full text-xs font-semibold shadow-lg flex items-center gap-1.5 pointer-events-none"
      style={{
        background: justReconnected ? 'rgba(16,185,129,0.95)' : 'rgba(244,63,94,0.95)',
        color: 'white',
      }}
      role="status"
      aria-live="polite"
    >
      {justReconnected
        ? <>● Reconnected</>
        : showReconnecting
          ? <>
              <span className="inline-block w-2 h-2 rounded-full bg-white animate-pulse" />
              Reconnecting{attempt > 1 ? ` (${attempt})` : ''}…
            </>
          : null}
    </motion.div>
  );
}

/* ============== Main App ============== */

type AppMode = 'menu' | 'localSetup' | 'local' | 'network' | 'leaderboard' | 'profile';

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
  const [localCfg, setLocalCfg] = useState<{ humans: number; ais: number; aiDifficulty: AiDifficulty } | null>(null);
  // Single auth instance scoped to the app root so the magic-link redirect
  // lands here, the session is read once, and stats are shared across modes.
  const auth = useAuth();

  const toggleMute = (m: boolean) => { setMuted(m); sfx.setMuted(m); };
  const changeVolume = (v: number) => { setVolume(v); sfx.setVolume(v); };
  const changeAiSpeed = (v: number) => { setAiSpeed(v); saveAiSpeed(v); };

  // Refresh cloud stats whenever the user comes back to the menu (after a
  // game). Cheap query and the user expects to see the new W/L immediately.
  useEffect(() => {
    if (mode === 'menu') auth.refreshStats();
  }, [mode]);

  // GA4 page_view on every mode change — the SPA never changes URL, so
  // without this GA only sees the initial load and never the menu → game →
  // leaderboard → profile flow. Names are stable so they aggregate cleanly
  // in Reports → Engagement → Pages and screens.
  useEffect(() => {
    pageview(mode);
  }, [mode]);

  let body: React.ReactNode;
  if (mode === 'menu') body = <MenuScreen onLocal={() => setMode('localSetup')} onNetwork={() => setMode('network')} onLeaderboard={() => setMode('leaderboard')} onProfile={() => setMode('profile')} prefilledCode={urlRoom} auth={auth} />;
  else if (mode === 'leaderboard') body = <LeaderboardScreen onBack={() => setMode('menu')} auth={auth} />;
  else if (mode === 'profile') body = <ProfileScreen onBack={() => setMode('menu')} auth={auth} />;
  else if (mode === 'localSetup') body = <LocalSetupScreen onStart={(h, a, d) => { setLocalCfg({ humans: h, ais: a, aiDifficulty: d }); setMode('local'); }} onBack={() => setMode('menu')} />;
  else if (mode === 'local' && localCfg) body = <LocalGame humans={localCfg.humans} ais={localCfg.ais} aiSpeed={aiSpeed} aiDifficulty={localCfg.aiDifficulty} onExit={() => setMode('menu')} auth={auth} />;
  else if (mode === 'network') body = <NetworkGame onExit={() => setMode('menu')} prefilledCode={urlRoom} auth={auth} />;

  return (
    <div className="min-h-full w-full overflow-auto">
      <SoundControls muted={muted} volume={volume} setMuted={toggleMute} setVolume={changeVolume} aiSpeed={aiSpeed} setAiSpeed={changeAiSpeed} />
      {body}
    </div>
  );
}
