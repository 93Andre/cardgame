/* Minimal typed wrapper around the GA4 gtag.js snippet wired in index.html.
 *
 * Why these helpers exist:
 *   • The SPA never changes URL (everything is on "/"), so GA4's default
 *     auto page_view only fires once on load. We call `pageview()` on every
 *     mode change so menu / lobby / leaderboard / profile / game show up as
 *     distinct virtual pages in GA.
 *   • `event()` is a thin wrapper for one-off custom events ("game_end",
 *     "sign_in", etc.) that we may add later — the API is stable.
 *
 * Both helpers no-op gracefully if gtag isn't on the page (e.g. local dev
 * with an ad blocker, or future builds without GA wired).
 */

declare global {
  interface Window {
    gtag?: (...args: any[]) => void;
    dataLayer?: any[];
  }
}

function safeGtag(...args: any[]) {
  if (typeof window === 'undefined') return;
  if (typeof window.gtag !== 'function') return;
  try { window.gtag(...args); } catch { /* swallow — analytics must never break the app */ }
}

/** Fire a virtual page_view. Pass a stable, human-readable name —
 *  e.g. "menu", "leaderboard", "game/local". GA will show it under
 *  Reports → Engagement → Pages and screens. */
export function pageview(name: string) {
  safeGtag('event', 'page_view', {
    page_title:    name,
    page_location: typeof location !== 'undefined' ? `${location.origin}${location.pathname}#${name}` : name,
    page_path:     `/${name}`,
  });
}

/** Fire a custom event. Use sparingly for things you actually want to
 *  funnel-analyse (e.g. signup_completed, game_won). */
export function event(name: string, params: Record<string, any> = {}) {
  safeGtag('event', name, params);
}
