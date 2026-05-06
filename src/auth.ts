import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';

/* ============== Supabase client ============== */

// Read at build time (Vite). When unset (e.g. local dev without .env.local),
// we degrade gracefully: the auth UI hides and everyone is treated as a guest.
const URL = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
const KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null =
  URL && KEY
    ? createClient(URL, KEY, {
        auth: {
          // Survive page reloads / tab restores. Magic-link returns to the
          // same page; we want the session lifted from the URL hash on load.
          persistSession: true,
          detectSessionInUrl: true,
          autoRefreshToken: true,
        },
      })
    : null;

export const supabaseEnabled = !!supabase;

/* ============== Profile shape ============== */

export interface Profile {
  id: string;
  username: string | null;
  avatar: string | null;
  created_at: string;
}

/** Avatar catalogue. The key is the persisted token; emoji + gradient are
 *  rendered client-side so adding/changing visuals doesn't need a DB change.
 *  Add to the bottom — never re-key existing entries (existing users have
 *  the keys stored). Gradients use Tailwind class strings. */
export const AVATARS: { key: string; emoji: string; gradient: string }[] = [
  { key: 'crown',    emoji: '👑', gradient: 'from-amber-300 to-amber-600' },
  { key: 'lion',     emoji: '🦁', gradient: 'from-amber-400 to-orange-600' },
  { key: 'fox',      emoji: '🦊', gradient: 'from-orange-400 to-rose-600' },
  { key: 'wolf',     emoji: '🐺', gradient: 'from-slate-400 to-slate-700' },
  { key: 'eagle',    emoji: '🦅', gradient: 'from-sky-400 to-indigo-700' },
  { key: 'dragon',   emoji: '🐉', gradient: 'from-emerald-400 to-emerald-700' },
  { key: 'shark',    emoji: '🦈', gradient: 'from-blue-400 to-blue-800' },
  { key: 'snake',    emoji: '🐍', gradient: 'from-lime-400 to-green-700' },
  { key: 'scorpion', emoji: '🦂', gradient: 'from-rose-400 to-rose-800' },
  { key: 'poop',     emoji: '💩', gradient: 'from-yellow-700 to-amber-900' },
  { key: 'joker',    emoji: '🃏', gradient: 'from-violet-400 to-purple-700' },
  { key: 'bolt',     emoji: '⚡', gradient: 'from-yellow-300 to-amber-500' },
  { key: 'fire',     emoji: '🔥', gradient: 'from-orange-400 to-red-600' },
  { key: 'gem',      emoji: '💎', gradient: 'from-cyan-300 to-blue-600' },
  { key: 'skull',    emoji: '💀', gradient: 'from-gray-500 to-gray-900' },
  { key: 'ghost',    emoji: '👻', gradient: 'from-slate-200 to-slate-500' },
  { key: 'rocket',   emoji: '🚀', gradient: 'from-sky-300 to-violet-600' },
  { key: 'star',     emoji: '⭐', gradient: 'from-yellow-300 to-amber-600' },
];

export function avatarDef(key: string | null | undefined) {
  if (!key) return null;
  return AVATARS.find(a => a.key === key) ?? null;
}

/** Lifetime-stats view exposed via the `user_stats` SQL view. */
export interface SupabaseStats {
  games_played: number;
  online_games: number;
  wins: number;
  losses: number;
  pickups: number;
  cards_played: number;
  power_cards: number;
  burns: number;
  cuts: number;
  largest_pile_ever: number;
}

/** Single match row to insert. Mirrors the `match_history` table columns. */
export interface MatchRow {
  mode: 'classic' | 'ultimate';
  online: boolean;
  player_count: number;
  ai_count: number;
  finish_pos: number | null;     // 0 = won; null = poop head or didn't finish
  was_poop_head: boolean;
  pickups: number;
  cards_played: number;
  power_cards: number;
  burns: number;
  cuts: number;
  largest_pile: number;
  duration_ms?: number;
  game_log?: string[];           // human-readable play-by-play, capped at 50 entries by the reducer
}

/* ============== useAuth — session + profile + stats ============== */

export interface AuthState {
  ready: boolean;                  // false during the initial getSession() fetch
  session: Session | null;
  profile: Profile | null;
  stats: SupabaseStats | null;     // null while loading or for guests
  signInWithEmail: (email: string, opts?: { username?: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  signOut: () => Promise<void>;
  refreshStats: () => Promise<void>;
}

/** Username-format rules mirrored from the server-side check constraint. */
export const USERNAME_RE = /^[A-Za-z0-9_-]+$/;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

/** Calls the public RPC to check if a username is free. Returns null on
 *  network/auth errors so the caller can decide how to handle (we treat
 *  null as "skip the check, let the trigger handle collisions"). */
export async function checkUsernameAvailable(name: string): Promise<boolean | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('is_username_available', { name });
  if (error) return null;
  return !!data;
}

export function useAuth(): AuthState {
  const [ready, setReady] = useState(!supabaseEnabled);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<SupabaseStats | null>(null);
  const mountedRef = useRef(true);

  // Fetch the user's profile + stats in one go. Profile is auto-created on
  // signup via the on_auth_user_created trigger, so it should always exist
  // for an authenticated session — but we tolerate a brief race.
  const loadAll = async (uid: string) => {
    if (!supabase) return;
    const [{ data: p }, { data: s }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
      supabase.from('user_stats').select('*').eq('user_id', uid).maybeSingle(),
    ]);
    if (!mountedRef.current) return;
    setProfile((p as Profile) ?? null);
    setStats((s as SupabaseStats) ?? null);
  };

  useEffect(() => {
    mountedRef.current = true;
    if (!supabase) { setReady(true); return; }
    supabase.auth.getSession().then(({ data }) => {
      if (!mountedRef.current) return;
      setSession(data.session ?? null);
      setReady(true);
      if (data.session?.user) loadAll(data.session.user.id);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      if (!mountedRef.current) return;
      setSession(sess);
      if (sess?.user) loadAll(sess.user.id);
      else { setProfile(null); setStats(null); }
    });
    return () => {
      mountedRef.current = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signInWithEmail = async (email: string, opts?: { username?: string }) => {
    if (!supabase) return { ok: false as const, error: 'Auth not configured' };
    // Pass `username` through user_metadata. The signup trigger reads
    // `raw_user_meta_data->>'username'` and uses it verbatim if provided
    // (with collision-suffix fallback). For returning users this metadata
    // is ignored — Postgres only fires the trigger on initial INSERT.
    const data: Record<string, string> | undefined = opts?.username
      ? { username: opts.username }
      : undefined;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin + window.location.pathname,
        data,
      },
    });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  };

  const refreshStats = async () => {
    if (!session?.user || !supabase) return;
    const { data } = await supabase
      .from('user_stats').select('*').eq('user_id', session.user.id).maybeSingle();
    if (mountedRef.current) setStats((data as SupabaseStats) ?? null);
  };

  return { ready, session, profile, stats, signInWithEmail, signOut, refreshStats };
}

/* ============== Match write ============== */

/** Insert a finished match. Silent no-op if guest or auth is disabled. */
export async function recordMatch(row: MatchRow): Promise<void> {
  if (!supabase) return;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return;
  await supabase.from('match_history').insert({ ...row, user_id: session.user.id });
}

/* ============== Leaderboard ============== */

export interface LeaderboardRow {
  username: string;
  avatar: string | null;
  games: number;
  wins: number;
  losses: number;
  online_games: number;
  online_wins: number;
  online_losses: number;
  local_games: number;
  local_wins: number;
  local_losses: number;
  largest_pile_ever: number;
}

/** Fetch the top-N leaderboard rows (default 50). Returns [] on error or
 *  when auth isn't configured — the screen renders a clean empty state. */
export async function fetchLeaderboard(limit = 50): Promise<LeaderboardRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('get_leaderboard', { limit_n: limit });
  if (error || !Array.isArray(data)) return [];
  return data as LeaderboardRow[];
}

/* ============== Profile + match history ============== */

export interface MatchHistoryRow {
  id: string;
  played_at: string;
  mode: 'classic' | 'ultimate';
  online: boolean;
  player_count: number;
  ai_count: number;
  finish_pos: number | null;
  was_poop_head: boolean;
  pickups: number;
  cards_played: number;
  power_cards: number;
  burns: number;
  cuts: number;
  largest_pile: number;
  duration_ms: number | null;
  game_log: string[];
}

/** Fetch the signed-in user's last N matches. Honours RLS so a guest or
 *  another user can never receive someone else's history. */
export async function fetchRecentMatches(limit = 20): Promise<MatchHistoryRow[]> {
  if (!supabase) return [];
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return [];
  const { data, error } = await supabase
    .from('match_history')
    .select('id, played_at, mode, online, player_count, ai_count, finish_pos, was_poop_head, pickups, cards_played, power_cards, burns, cuts, largest_pile, duration_ms, game_log')
    .eq('user_id', session.user.id)
    .order('played_at', { ascending: false })
    .limit(limit);
  if (error || !Array.isArray(data)) return [];
  return data as MatchHistoryRow[];
}

/** Update the signed-in user's avatar. `null` clears it. The key must
 *  match a catalogue entry — server-side check constraint also enforces
 *  format so a malformed token can't slip in via SQL injection in a
 *  third-party client. */
export async function updateAvatar(key: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Auth not configured' };
  if (key !== null && !AVATARS.some(a => a.key === key)) {
    return { ok: false, error: 'Unknown avatar' };
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return { ok: false, error: 'Not signed in' };
  const { error } = await supabase
    .from('profiles')
    .update({ avatar: key })
    .eq('id', session.user.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Update the signed-in user's username. Returns ok+the new value, or an
 *  error message suitable for inline display. The DB enforces format and
 *  uniqueness so we can rely on the server's error rather than mirroring
 *  every check on the client. */
export async function updateUsername(name: string): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Auth not configured' };
  const trimmed = name.trim();
  if (!USERNAME_RE.test(trimmed) || trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) {
    return { ok: false, error: `${USERNAME_MIN}-${USERNAME_MAX} chars, letters/digits/_/- only` };
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return { ok: false, error: 'Not signed in' };
  const { error } = await supabase
    .from('profiles')
    .update({ username: trimmed })
    .eq('id', session.user.id);
  if (error) {
    if (/duplicate|unique/i.test(error.message)) return { ok: false, error: 'Already taken' };
    return { ok: false, error: error.message };
  }
  return { ok: true, username: trimmed };
}
