import { useCallback } from 'react';
import { WebHaptics } from 'web-haptics';

/* High-level haptic events used throughout the game.
 * The hook layers web-haptics on top of navigator.vibrate as a fallback —
 * navigator.vibrate works only on Android Chrome (iOS Safari and desktop
 * fail silently), and web-haptics provides a richer pattern API plus
 * audio-based emulation on platforms without a vibration motor.
 */
export type HapticEvent =
  | 'tap'      // card selected / button pressed
  | 'play'     // card played
  | 'pickup'   // pile picked up
  | 'burn'     // 10 / four-of-a-kind burn
  | 'cut'      // out-of-turn cut
  | 'win'      // game finished
  | 'error';   // illegal action / room not found

const presetMap: Record<HapticEvent, string> = {
  tap: 'selection',
  play: 'medium',
  pickup: 'heavy',
  burn: 'error',     // a 3-pulse pattern feels emphatic
  cut: 'warning',
  win: 'success',
  error: 'rigid',
};

const vibrateMap: Record<HapticEvent, number | number[]> = {
  tap: 10,
  play: 22,
  pickup: [20, 30, 40],
  burn: [40, 30, 80],
  cut: [30, 20, 30],
  win: [40, 60, 40, 60, 120],
  error: 50,
};

// Build a vibrate pattern that scales with the number of cards picked up. The
// shape mirrors the audio: an initial "thump" (heavier for bigger pickups), N
// staccato taps representing each card landing, and a final low boom for the
// truly large ones. Pattern format is [vibrate, pause, vibrate, pause, ...].
function pickupPattern(count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  const taps = Math.min(8, n);
  const out: number[] = [];
  // Initial thump — 40ms baseline + 2ms per card (capped).
  out.push(40 + Math.min(40, n * 2));
  for (let i = 0; i < taps; i++) {
    out.push(40);                                  // pause between taps
    out.push(20 + Math.min(20, i * 3));            // tap, slightly longer each
  }
  // Big-pickup low boom.
  if (n >= 15) {
    out.push(60);   // pause
    out.push(120);  // boom
  }
  return out;
}

let instance: WebHaptics | null = null;
let initFailed = false;
let listenersInstalled = false;

function resetInstance() {
  try { (instance as any)?.destroy?.(); } catch { /* ignore */ }
  instance = null;
  initFailed = false;
}

function installLifecycleListeners() {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  // web-haptics uses its own AudioContext under the hood. When the tab is backgrounded or
  // the system suspends audio, that context can stop responding. Drop the singleton on
  // visibility change / focus so the next trigger() recreates it cleanly.
  const onVisible = () => { if (!document.hidden) resetInstance(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', resetInstance);
  // Polling backup — if no focus/visibility events fired but the context died silently,
  // recreate every 30s. trigger() is cheap so the next event still feels fresh.
  setInterval(() => { if (!document.hidden && instance) resetInstance(); }, 30000);
}

function getHaptics(): WebHaptics | null {
  installLifecycleListeners();
  if (initFailed) return null;
  if (instance) return instance;
  if (typeof window === 'undefined') return null;
  try { instance = new WebHaptics({}); return instance; }
  catch { initFailed = true; return null; }
}

export function useHaptics() {
  // Optional second arg `opts` lets the caller scale a haptic to context — at
  // the moment only `pickup` consumes `count` (one buzz per card-ish, capped),
  // but the API is open for similar treatment of other events later.
  return useCallback((event: HapticEvent, opts?: { count?: number }) => {
    // Primary path: web-haptics (works cross-platform via vibrate or audio synthesis fallback).
    try {
      const wh = getHaptics();
      if (wh) wh.trigger(presetMap[event] as any).catch(() => {
        // If a trigger fails, the underlying context may be dead — drop and recreate next time.
        resetInstance();
      });
    } catch { resetInstance(); }
    // Secondary fallback: navigator.vibrate. Only Android Chrome implements this; iOS Safari
    // and desktop browsers ignore it. Wrapped in try because some browsers throw on unsupported.
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        const pattern = event === 'pickup' && opts?.count
          ? pickupPattern(opts.count)
          : vibrateMap[event];
        navigator.vibrate(pattern);
      }
    } catch { /* swallow */ }
  }, []);
}
