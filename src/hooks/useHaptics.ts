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

let instance: WebHaptics | null = null;
let initFailed = false;
function getHaptics(): WebHaptics | null {
  if (initFailed) return null;
  if (instance) return instance;
  if (typeof window === 'undefined') return null;
  try { instance = new WebHaptics({}); return instance; }
  catch { initFailed = true; return null; }
}

export function useHaptics() {
  return useCallback((event: HapticEvent) => {
    // Primary path: web-haptics (works cross-platform via vibrate or audio synthesis fallback).
    try {
      const wh = getHaptics();
      if (wh) wh.trigger(presetMap[event] as any).catch(() => { /* ignore */ });
    } catch { /* swallow */ }
    // Secondary fallback: navigator.vibrate. Only Android Chrome implements this; iOS Safari
    // and desktop browsers ignore it. Wrapped in try because some browsers throw on unsupported.
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(vibrateMap[event]);
      }
    } catch { /* swallow */ }
  }, []);
}
