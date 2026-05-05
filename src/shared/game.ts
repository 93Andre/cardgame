/* =============================================================
 * Latrine — shared game module (no DOM/React deps).
 * Imported by both the React client and the Node WebSocket server.
 * ============================================================= */

export const DEFAULT_PLAYER_COUNT = 3;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const HAND_TARGET = 3;
export const FACE_SLOTS = 3;

export type Suit = '♠' | '♥' | '♦' | '♣' | '★';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A' | 'JK';

export interface Card {
  id: string;
  rank: Rank;
  suit: Suit;
}

export interface PileEntry {
  card: Card;
  effRank: Rank;
  effSuit: Suit;  // resolved suit (jokers copy from below) — needed for Ultimate-mode cutting
}

export interface Player {
  id: number;
  name: string;
  hand: Card[];
  faceUp: Card[];
  faceDown: Card[];
  out: boolean;
  finishPos: number | null;
  isAi?: boolean;
}

export type Phase = 'setup' | 'swap' | 'pass' | 'play' | 'flipFaceDown' | 'reveal' | 'end';
export type Source = 'hand' | 'faceUp' | 'faceDown';
export type GameMode = 'classic' | 'ultimate';

export interface GameState {
  phase: Phase;
  players: Player[];
  current: number;
  direction: 1 | -1;
  deck: Card[];
  pile: PileEntry[];
  sevenRestriction: boolean;
  log: string[];
  selected: string[];
  swapReady: boolean[];
  swapSelected: Record<number, { source: Source; id: string } | null>;
  flippedCard: Card | null;
  lastWasMine: boolean;
  poopHead: number | null;
  mode: GameMode;
  burnedCount: number;     // total cards burned across the whole game
  lastBurnSize: number;    // size of the most recent burn (for visual flourish), 0 = no recent burn
  // House rule: when a player picks up the pile, one card from those they picked up is revealed to everyone.
  // pendingReveal: cards the picker can choose from (only set during 'reveal' phase)
  // revealedPickup: the chosen card, broadcast for a few seconds after the choice
  pendingReveal: { cards: Card[] } | null;
  revealedPickup: { playerId: number; card: Card; ts: number } | null;
  stats: Record<number, PlayerStats>;
}

export interface PlayerStats {
  pickups: number;       // pile pickups
  cardsPlayed: number;   // total individual cards placed to pile (own turns + cuts)
  powerCards: number;    // 2/10/8/K/7/Joker count among played cards
  burns: number;         // burn events they triggered (10 or 4-of-a-kind)
  cuts: number;          // out-of-turn cut plays (Ultimate mode)
}

export type Action =
  | { type: 'NEW_GAME'; playerCount?: number; names?: string[]; aiSeats?: boolean[]; mode?: GameMode }
  | { type: 'SWAP_PICK'; player: number; source: Source; id: string }
  | { type: 'SWAP_READY'; player: number }
  | { type: 'BEGIN_PLAY' }
  | { type: 'ACK_PASS' }
  | { type: 'TOGGLE_SELECT'; id: string }
  | { type: 'PLAY_SELECTED' }
  | { type: 'PLAY_CARDS'; ids: string[] }
  | { type: 'PICKUP_PILE' }
  | { type: 'FLIP_FACEDOWN'; id: string }
  | { type: 'RESOLVE_FLIP' }
  | { type: 'CUT'; player: number; ids: string[] }
  | { type: 'REVEAL_CHOICE'; id: string };

export const RANK_ORDER: Rank[] = ['3', '4', '5', '6', '7', '8', '9', 'J', 'Q', 'K', 'A'];
export const RANK_VALUE: Record<Rank, number> = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  J: 11, Q: 12, K: 13, A: 14,
  '2': 2, '10': 10, JK: 3,
};

/* ----- Deck ----- */

export function createDeck(useTwoDecks = false): Card[] {
  const suits: Suit[] = ['♠', '♥', '♦', '♣'];
  const ranks: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const cards: Card[] = [];
  const decks = useTwoDecks ? 2 : 1;
  for (let d = 1; d <= decks; d++) {
    const suffix = d === 1 ? '' : '·d2';
    for (const s of suits) for (const r of ranks) cards.push({ id: `${r}${s}${suffix}`, rank: r, suit: s });
    cards.push({ id: `JK${d * 2 - 1}`, rank: 'JK', suit: '★' });
    cards.push({ id: `JK${d * 2}`, rank: 'JK', suit: '★' });
  }
  return cards;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function deal(deck: Card[], playerCount: number, names?: string[], aiSeats?: boolean[]): { players: Player[]; deck: Card[] } {
  const d = deck.slice();
  const players: Player[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: i,
      name: names?.[i] ?? `Player ${i + 1}`,
      faceDown: d.splice(0, FACE_SLOTS),
      faceUp: d.splice(0, FACE_SLOTS),
      hand: d.splice(0, HAND_TARGET),
      out: false,
      finishPos: null,
      isAi: aiSeats?.[i] ?? false,
    });
  }
  return { players, deck: d };
}

/* ----- Pure logic ----- */

export function resolveEffective(card: Card, pileBefore: PileEntry[]): { effRank: Rank; effSuit: Suit } {
  if (card.rank !== 'JK') return { effRank: card.rank, effSuit: card.suit };
  if (pileBefore.length === 0) return { effRank: '3', effSuit: '★' };
  const below = pileBefore[pileBefore.length - 1];
  return { effRank: below.effRank, effSuit: below.effSuit };
}

export function resolveEffRank(card: Card, pileBefore: PileEntry[]): Rank {
  return resolveEffective(card, pileBefore).effRank;
}

export function topEffRank(pile: PileEntry[]): Rank | null {
  if (pile.length === 0) return null;
  return pile[pile.length - 1].effRank;
}

export function activeSource(p: Player, deckEmpty: boolean): Source | null {
  if (p.hand.length > 0) return 'hand';
  if (!deckEmpty) return 'hand';
  if (p.faceUp.length > 0) return 'faceUp';
  if (p.faceDown.length > 0) return 'faceDown';
  return null;
}

export function cardsFromSource(p: Player, src: Source): Card[] {
  return src === 'hand' ? p.hand : src === 'faceUp' ? p.faceUp : p.faceDown;
}

export function canPlayCards(cards: Card[], pile: PileEntry[], sevenLock: boolean): boolean {
  if (cards.length === 0) return false;
  // House rule: jokers are no longer wild within a multi-card play. All cards in the
  // selection must share the SAME actual rank — so {Joker + 5} is rejected, while
  // {Joker + Joker} or {5 + 5} are fine.
  const ranks = new Set(cards.map(c => c.rank));
  if (ranks.size > 1) return false;
  const baseRank = [...ranks][0] as Rank;
  const top = topEffRank(pile);
  // 2/10/Joker are always playable (exempt from both ≥-top and 7-lock rules).
  if (baseRank === '2' || baseRank === '10' || baseRank === 'JK') return true;
  if (top === null) return true;
  if (sevenLock) return RANK_VALUE[baseRank] <= 7;
  return RANK_VALUE[baseRank] >= RANK_VALUE[top];
}

// Four-of-a-kind burn: uses the ACTUAL rank, not the effective rank. So a Joker
// copying a 7 does NOT contribute to a four-of-a-kind of 7s — only four real jokers
// (rank === 'JK') burn as a joker quad.
export function isFourOfAKind(pile: PileEntry[]): boolean {
  if (pile.length < 4) return false;
  const top = pile[pile.length - 1];
  const r = top.card.rank;
  if (r === '2' || r === '10') return false;
  for (let i = pile.length - 4; i < pile.length - 1; i++) {
    if (pile[i].card.rank !== r) return false;
  }
  return true;
}

export function startingPlayer(players: Player[]): number {
  for (const r of RANK_ORDER) {
    for (let i = 0; i < players.length; i++) {
      if (players[i].hand.some(c => c.rank === r)) return i;
    }
  }
  return 0;
}

export function nextActiveIndex(players: Player[], from: number, dir: 1 | -1, skip = false): number {
  let idx = from;
  let stepsTaken = 0;
  const stepsNeeded = skip ? 2 : 1;
  while (stepsTaken < stepsNeeded) {
    idx = (idx + dir + players.length) % players.length;
    if (!players[idx].out) stepsTaken++;
    if (players.filter(p => !p.out).length <= 1) return from;
  }
  return idx;
}

export function refillHand(player: Player, deck: Card[]): { player: Player; deck: Card[] } {
  const hand = player.hand.slice();
  const d = deck.slice();
  while (hand.length < HAND_TARGET && d.length > 0) {
    hand.push(d.shift()!);
  }
  return { player: { ...player, hand }, deck: d };
}

/* ----- Initial / new game ----- */

export function initialState(): GameState {
  return {
    phase: 'setup',
    players: [],
    current: 0,
    direction: 1,
    deck: [],
    pile: [],
    sevenRestriction: false,
    log: [],
    selected: [],
    swapReady: [],
    swapSelected: {},
    flippedCard: null,
    lastWasMine: false,
    poopHead: null,
    mode: 'classic',
    burnedCount: 0,
    lastBurnSize: 0,
    pendingReveal: null,
    revealedPickup: null,
    stats: {},
  };
}

const POWER_RANKS = new Set<Rank>(['2', '10', '8', 'K', '7', 'JK']);
function emptyStats(): PlayerStats {
  return { pickups: 0, cardsPlayed: 0, powerCards: 0, burns: 0, cuts: 0 };
}
function bumpStats(state: GameState, playerId: number, patch: Partial<PlayerStats>): Record<number, PlayerStats> {
  const cur = state.stats[playerId] ?? emptyStats();
  return { ...state.stats, [playerId]: { ...cur, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, (cur as any)[k] + (v as number)])) as Partial<PlayerStats> } };
}

export function newGame(playerCount: number = DEFAULT_PLAYER_COUNT, names?: string[], aiSeats?: boolean[], mode?: GameMode): GameState {
  // Auto-activate Ultimate at 4+ players unless caller forces classic.
  const resolvedMode: GameMode = mode ?? (playerCount >= 4 ? 'ultimate' : 'classic');
  const useTwoDecks = resolvedMode === 'ultimate';
  const { players, deck } = deal(shuffle(createDeck(useTwoDecks)), playerCount, names, aiSeats);
  const swapSelected: Record<number, null> = {};
  for (let i = 0; i < playerCount; i++) swapSelected[i] = null;
  const intro = resolvedMode === 'ultimate'
    ? 'Ultimate mode: 2 decks, 4 jokers, cutting enabled.'
    : 'Cards dealt. Swap phase: each player may swap cards between hand and face-up.';
  const stats: Record<number, PlayerStats> = {};
  for (let i = 0; i < playerCount; i++) stats[i] = emptyStats();
  return {
    ...initialState(),
    phase: 'swap',
    players,
    deck,
    swapReady: Array(playerCount).fill(false),
    swapSelected,
    mode: resolvedMode,
    stats,
    log: [intro],
  };
}

function logLine(state: GameState, line: string): string[] {
  return [...state.log, line].slice(-50);
}

function playCardsByIds(state: GameState, ids: string[]): GameState {
  const p = state.players[state.current];
  const src = activeSource(p, state.deck.length === 0);
  if (!src || src === 'faceDown') return state;
  if (ids.length === 0) return state;

  // Cards may come from hand and/or face-up. The "hand → face-up chain" rule allows mixing
  // when the deck is empty AND every remaining hand card is being played in the same move.
  const handSelected: Card[] = [];
  const faceUpSelected: Card[] = [];
  for (const id of ids) {
    const inHand = p.hand.find(c => c.id === id);
    if (inHand) { handSelected.push(inHand); continue; }
    const inFace = p.faceUp.find(c => c.id === id);
    if (inFace) { faceUpSelected.push(inFace); continue; }
    return state; // id not found in either source
  }
  const cards = [...handSelected, ...faceUpSelected];

  if (src === 'hand') {
    // Pure hand play is allowed any time. Chaining face-up cards requires:
    //   (a) the deck is empty (so face-up is the genuine next source), and
    //   (b) the play empties the hand (every hand card is included).
    if (faceUpSelected.length > 0) {
      if (state.deck.length > 0) return state;
      if (handSelected.length !== p.hand.length) return state;
    }
  } else {
    // Face-up source: hand must already be empty, so no hand cards expected here.
    if (handSelected.length > 0) return state;
  }

  if (!canPlayCards(cards, state.pile, state.sevenRestriction)) return state;

  let pile = state.pile.slice();
  for (const c of cards) {
    const eff = resolveEffective(c, pile);
    pile = [...pile, { card: c, effRank: eff.effRank, effSuit: eff.effSuit }];
  }

  const players = state.players.slice();
  const idSet = new Set(ids);
  const np: Player = {
    ...p,
    hand: p.hand.filter(c => !idSet.has(c.id)),
    faceUp: p.faceUp.filter(c => !idSet.has(c.id)),
  };
  players[state.current] = np;

  const ranksSummary = cards.map(c => `${c.rank}${c.suit}`).join(' + ');
  const powerCount = cards.filter(c => POWER_RANKS.has(c.rank)).length;
  const next: GameState = {
    ...state,
    players,
    pile,
    selected: [],
    sevenRestriction: false,
    stats: bumpStats(state, state.current, { cardsPlayed: cards.length, powerCards: powerCount }),
    log: logLine(state, `${p.name} played ${ranksSummary}.`),
  };
  // postPlay's source-used parameter only matters for hand-refill behaviour. Pass 'hand' if any
  // hand cards were involved (the chain still counts as a hand-source play for refill purposes,
  // though the deck being empty makes refill a no-op anyway).
  return postPlay(next, state.current, handSelected.length > 0 ? 'hand' : 'faceUp', cards);
}

function postPlay(stateIn: GameState, playerIdx: number, sourceUsed: Source, played: Card[], wasCut = false): GameState {
  let state = stateIn;
  const burnedByTen = played.length > 0 && played.every(c => c.rank === '10');
  const burnedByFour = isFourOfAKind(state.pile);
  let pileCleared = false;
  let goesAgain = false;

  if (burnedByTen) {
    const burnedSize = state.pile.length;
    state = {
      ...state, pile: [],
      burnedCount: state.burnedCount + burnedSize,
      lastBurnSize: burnedSize,
      stats: bumpStats(state, playerIdx, { burns: 1 }),
      log: logLine(state, `Pile burned by 10 (${burnedSize} cards)! Turn passes.`),
    };
    pileCleared = true;
    goesAgain = false;
  } else if (burnedByFour) {
    const burnedSize = state.pile.length;
    // House rule: a 4-of-a-kind burn passes the turn UNLESS the player just played four 3s
    // in a single move — that's the only exception that grants another turn.
    const isFourThreesInOneGo = played.length === 4 && played.every(c => c.rank === '3');
    state = {
      ...state, pile: [],
      burnedCount: state.burnedCount + burnedSize,
      lastBurnSize: burnedSize,
      stats: bumpStats(state, playerIdx, { burns: 1 }),
      log: logLine(state, `Four of a kind (${burnedSize} cards)! Pile burned.${isFourThreesInOneGo ? ' Same player plays again (four 3s).' : ' Turn passes.'}`),
    };
    pileCleared = true;
    goesAgain = isFourThreesInOneGo;
  } else {
    // No burn this play — clear the lastBurnSize flourish so it doesn't linger.
    state = { ...state, lastBurnSize: 0 };
  }

  if (sourceUsed === 'hand' && state.deck.length > 0) {
    const r = refillHand(state.players[playerIdx], state.deck);
    const players = state.players.slice();
    players[playerIdx] = r.player;
    state = { ...state, players, deck: r.deck };
  }

  const p = state.players[playerIdx];
  if (p.hand.length === 0 && p.faceUp.length === 0 && p.faceDown.length === 0) {
    const remainingFinishers = state.players.filter(pp => pp.finishPos !== null).length;
    const players = state.players.slice();
    players[playerIdx] = { ...p, out: true, finishPos: remainingFinishers + 1 };
    state = { ...state, players, log: logLine(state, `${p.name} is OUT (place #${remainingFinishers + 1}) 🎉`) };
    goesAgain = false;
  }

  let skipNext = false;
  let dirChange: 1 | -1 = 1;
  let sevenLock = false;
  if (!pileCleared && played.length > 0) {
    const eff = state.pile[state.pile.length - 1]?.effRank ?? null;
    if (eff === '2') {
      state = { ...state, log: logLine(state, '2 played — pile reset. Next player can play anything.') };
    } else if (eff === '8') {
      skipNext = true;
      state = { ...state, log: logLine(state, '8 played — next player is skipped.') };
    } else if (eff === 'K') {
      if (wasCut) {
        // House rule: a King played as a cut does NOT reverse direction —
        // play continues in the current direction from the cutter.
        state = { ...state, log: logLine(state, 'King played as a cut — direction unchanged.') };
      } else {
        dirChange = -1;
        state = { ...state, log: logLine(state, 'King played — direction reversed.') };
      }
    } else if (eff === '7') {
      sevenLock = true;
      state = { ...state, log: logLine(state, '7 played — next player must play 7-or-lower (or 2/10/Joker).') };
    }
  }

  const stillIn = state.players.filter(pp => !pp.out);
  if (stillIn.length === 1) {
    return { ...state, phase: 'end', poopHead: stillIn[0].id, log: logLine(state, `${stillIn[0].name} is the POOP HEAD!`) };
  }

  let direction: 1 | -1 = (state.direction * dirChange) as 1 | -1;
  let current = state.current;
  let nextPhase: Phase = state.phase;
  let lastWasMine = false;

  if (goesAgain && !state.players[playerIdx].out) {
    current = playerIdx;
    nextPhase = 'play';
    lastWasMine = true;
  } else {
    current = nextActiveIndex(state.players, playerIdx, direction, skipNext);
    nextPhase = 'pass';
  }

  return {
    ...state,
    direction,
    current,
    phase: nextPhase,
    sevenRestriction: sevenLock,
    selected: [],
    lastWasMine,
  };
}

export function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'NEW_GAME':
      return newGame(action.playerCount ?? DEFAULT_PLAYER_COUNT, action.names, action.aiSeats, action.mode);

    case 'SWAP_PICK': {
      const { player, source, id } = action;
      const cur = state.swapSelected[player] ?? null;
      const swapSelected = { ...state.swapSelected };

      if (!cur) {
        swapSelected[player] = { source, id };
        return { ...state, swapSelected };
      }
      if (cur.source === source && cur.id === id) {
        swapSelected[player] = null;
        return { ...state, swapSelected };
      }
      if (cur.source === source) {
        swapSelected[player] = { source, id };
        return { ...state, swapSelected };
      }
      const players = state.players.slice();
      const p = { ...players[player] };
      const handArr = p.hand.slice();
      const faceArr = p.faceUp.slice();
      const aArr = cur.source === 'hand' ? handArr : faceArr;
      const bArr = source === 'hand' ? handArr : faceArr;
      const ai = aArr.findIndex(c => c.id === cur.id);
      const bi = bArr.findIndex(c => c.id === id);
      if (ai >= 0 && bi >= 0) {
        const tmp = aArr[ai];
        aArr[ai] = bArr[bi];
        bArr[bi] = tmp;
      }
      p.hand = handArr;
      p.faceUp = faceArr;
      players[player] = p;
      swapSelected[player] = null;
      return { ...state, players, swapSelected };
    }

    case 'SWAP_READY': {
      const ready = state.swapReady.slice();
      ready[action.player] = !ready[action.player];
      const swapSelected = { ...state.swapSelected, [action.player]: null };
      return { ...state, swapReady: ready, swapSelected };
    }

    case 'BEGIN_PLAY': {
      if (!state.swapReady.every(Boolean)) return state;
      const start = startingPlayer(state.players);
      const startCard = (() => {
        for (const r of RANK_ORDER) {
          if (state.players[start].hand.some(c => c.rank === r)) return r;
        }
        return null;
      })();
      return {
        ...state,
        phase: 'pass',
        current: start,
        log: logLine(state, `${state.players[start].name} starts (lowest ${startCard ?? '?'} in hand).`),
      };
    }

    case 'ACK_PASS':
      return { ...state, phase: 'play', selected: [], flippedCard: null };

    case 'TOGGLE_SELECT': {
      const p = state.players[state.current];
      const src = activeSource(p, state.deck.length === 0);
      if (!src || src === 'faceDown') return state;
      const handCard = p.hand.find(c => c.id === action.id);
      const faceUpCard = p.faceUp.find(c => c.id === action.id);
      const card = handCard ?? faceUpCard;
      if (!card) return state;
      if (src === 'faceUp' && handCard) return state;
      if (src === 'hand' && faceUpCard && state.deck.length > 0) return state;

      const already = state.selected.includes(action.id);
      if (already) {
        return { ...state, selected: state.selected.filter(x => x !== action.id) };
      }
      const sel = state.selected
        .map(id => p.hand.find(c => c.id === id) ?? p.faceUp.find(c => c.id === id))
        .filter(Boolean) as Card[];
      const allCards = [...sel, card];
      // House rule: jokers can only be selected with other jokers, not with any other rank.
      const ranks = new Set(allCards.map(c => c.rank));
      if (ranks.size > 1) return state;
      return { ...state, selected: [...state.selected, action.id] };
    }

    case 'PLAY_SELECTED':
      return playCardsByIds(state, state.selected);

    case 'PLAY_CARDS':
      return playCardsByIds(state, action.ids);

    case 'PICKUP_PILE': {
      if (state.pile.length === 0) return state;
      const players = state.players.slice();
      const p = { ...players[state.current] };
      const pickedCards = state.pile.map(e => e.card);
      const handBeforePickup = [...p.hand];
      p.hand = [...p.hand, ...pickedCards];
      players[state.current] = p;
      const newStats = bumpStats(state, state.current, { pickups: 1 });

      if (handBeforePickup.length === 0) {
        const log = logLine(state, `${p.name} picked up the pile (${pickedCards.length} cards). No hand cards to reveal.`);
        const direction = state.direction;
        const current = nextActiveIndex(players, state.current, direction);
        return {
          ...state, players, pile: [], selected: [], sevenRestriction: false, log, flippedCard: null,
          phase: 'pass', current, pendingReveal: null, revealedPickup: null, lastWasMine: false,
          stats: newStats,
        };
      }

      const log = logLine(state, `${p.name} picked up ${pickedCards.length} — must reveal a hand card…`);
      return {
        ...state, players, pile: [], selected: [], sevenRestriction: false, log, flippedCard: null,
        phase: 'reveal',
        pendingReveal: { cards: handBeforePickup },
        revealedPickup: null,
        lastWasMine: false,
        stats: newStats,
      };
    }

    case 'FLIP_FACEDOWN': {
      const p = state.players[state.current];
      const src = activeSource(p, state.deck.length === 0);
      if (src !== 'faceDown') return state;
      const card = p.faceDown.find(c => c.id === action.id);
      if (!card) return state;
      return { ...state, phase: 'flipFaceDown', flippedCard: card };
    }

    case 'RESOLVE_FLIP': {
      const p = state.players[state.current];
      const card = state.flippedCard;
      if (!card) return state;
      const players = state.players.slice();
      const np: Player = { ...p, faceDown: p.faceDown.filter(c => c.id !== card.id) };
      players[state.current] = np;

      const legal = canPlayCards([card], state.pile, state.sevenRestriction);
      if (legal) {
        let pile = state.pile.slice();
        const eff = resolveEffective(card, pile);
        pile = [...pile, { card, effRank: eff.effRank, effSuit: eff.effSuit }];
        const next: GameState = {
          ...state, players, pile, flippedCard: null, selected: [],
          log: logLine(state, `${p.name} flipped face-down ${card.rank}${card.suit} — legal!`),
        };
        return postPlay(next, state.current, 'faceDown', [card]);
      } else {
        // Face-down phase implies hand and face-up were both empty — nothing private to reveal.
        // Just dump pile + flipped card into the player's hand and pass turn.
        const picked = [...state.pile.map(e => e.card), card];
        const np2: Player = { ...np, hand: [...np.hand, ...picked] };
        players[state.current] = np2;
        const log = logLine(state, `${p.name} flipped ${card.rank}${card.suit} — illegal! Picks up ${picked.length}.`);
        const direction = state.direction;
        const current = nextActiveIndex(players, state.current, direction);
        return {
          ...state, players, pile: [], flippedCard: null, selected: [], sevenRestriction: false,
          phase: 'pass', current, log, lastWasMine: false,
        };
      }
    }

    case 'CUT':
      return applyCut(state, action.player, action.ids);

    case 'REVEAL_CHOICE': {
      if (state.phase !== 'reveal' || !state.pendingReveal) return state;
      const chosen = state.pendingReveal.cards.find(c => c.id === action.id);
      if (!chosen) return state;
      // Picked-up cards are already in the picker's hand (added during PICKUP_PILE).
      // The chosen card is from their pre-pickup hand — just publicly reveal it and pass turn.
      const log = logLine(state, `${state.players[state.current].name} revealed: ${chosen.rank}${chosen.suit}.`);
      const direction = state.direction;
      const current = nextActiveIndex(state.players, state.current, direction);
      return {
        ...state,
        phase: 'pass',
        current,
        pendingReveal: null,
        revealedPickup: { playerId: state.current, card: chosen, ts: Date.now() },
        log,
        lastWasMine: false,
      };
    }

    default:
      return state;
  }
}

/* ----- Ultimate-mode cutting ----- */

// What card+suit must a cutter match? Top of pile (effective rank+suit, jokers resolved).
// Returns null if the pile is empty (no cuts on empty pile).
export function cutTarget(pile: PileEntry[]): { rank: Rank; suit: Suit } | null {
  if (pile.length === 0) return null;
  const top = pile[pile.length - 1];
  return { rank: top.effRank, suit: top.effSuit };
}

// All matching cards in player's HAND that could be used to cut. Hand-only per rules.
export function cutMatches(state: GameState, playerId: number): Card[] {
  if (state.mode !== 'ultimate') return [];
  if (state.phase !== 'play') return [];
  const target = cutTarget(state.pile);
  if (!target) return [];
  const p = state.players[playerId];
  if (!p || p.out) return [];
  return p.hand.filter(c => c.rank === target.rank && c.suit === target.suit);
}

function applyCut(state: GameState, cutterId: number, ids: string[]): GameState {
  if (state.mode !== 'ultimate') return state;
  if (state.phase !== 'play') return state;
  if (ids.length === 0) return state;
  const matches = cutMatches(state, cutterId);
  const matchIds = new Set(matches.map(c => c.id));
  // Every id in the request must be a valid match in the cutter's hand.
  for (const id of ids) if (!matchIds.has(id)) return state;
  const cutter = state.players[cutterId];
  const cards = ids.map(id => cutter.hand.find(c => c.id === id)!).filter(Boolean) as Card[];

  // Remove the cards from cutter's hand.
  const newHand = cutter.hand.filter(c => !ids.includes(c.id));
  const players = state.players.slice();
  players[cutterId] = { ...cutter, hand: newHand };

  // Place cards onto pile (each entry computed against the growing pile).
  let pile = state.pile.slice();
  for (const c of cards) {
    const eff = resolveEffective(c, pile);
    pile = [...pile, { card: c, effRank: eff.effRank, effSuit: eff.effSuit }];
  }

  // Now: the cutter is treated as the current player; postPlay handles burns/skip/etc.
  // The originally-current player effectively gets skipped (postPlay advances from cutter).
  const ranksSummary = cards.map(c => `${c.rank}${c.suit}`).join(' + ');
  const powerCount = cards.filter(c => POWER_RANKS.has(c.rank)).length;
  const next: GameState = {
    ...state,
    players,
    pile,
    selected: [],
    sevenRestriction: false,
    current: cutterId,
    stats: bumpStats(state, cutterId, { cardsPlayed: cards.length, powerCards: powerCount, cuts: 1 }),
    log: logLine(state, `${cutter.name} CUT with ${ranksSummary}!`),
  };
  return postPlay(next, cutterId, 'hand', cards, /* wasCut */ true);
}

/* ----- AI ----- */

const SPECIAL_RANKS = new Set<Rank>(['2', '10', 'JK']);

// Decide the next action for an AI player. Returns null if AI shouldn't act now.
export function aiPickAction(state: GameState, aiId: number): Action | null {
  if (state.phase === 'swap') {
    if (!state.swapReady[aiId]) return { type: 'SWAP_READY', player: aiId };
    return null;
  }
  if (state.phase === 'flipFaceDown' && state.current === aiId) {
    return { type: 'RESOLVE_FLIP' };
  }
  if (state.phase === 'reveal' && state.current === aiId && state.pendingReveal) {
    // AI picks a random card to reveal (no strategic value to optimize).
    const cards = state.pendingReveal.cards;
    const choice = cards[Math.floor(Math.random() * cards.length)];
    return { type: 'REVEAL_CHOICE', id: choice.id };
  }
  // Out-of-turn cuts (Ultimate mode): AI cuts whenever it can — it's a free play.
  if (state.phase === 'play' && state.mode === 'ultimate' && state.current !== aiId) {
    const matches = cutMatches(state, aiId);
    if (matches.length > 0) return { type: 'CUT', player: aiId, ids: matches.map(c => c.id) };
    return null;
  }
  if (state.phase === 'play' && state.current === aiId) {
    // On its own turn, AI may also cut (rare — would only matter if its top-card was just played by someone else).
    if (state.mode === 'ultimate') {
      const matches = cutMatches(state, aiId);
      if (matches.length > 0) return { type: 'CUT', player: aiId, ids: matches.map(c => c.id) };
    }
    const p = state.players[aiId];
    const src = activeSource(p, state.deck.length === 0);
    if (!src) return null;
    if (src === 'faceDown') {
      const card = p.faceDown[Math.floor(Math.random() * p.faceDown.length)];
      return { type: 'FLIP_FACEDOWN', id: card.id };
    }
    const cards = cardsFromSource(p, src);
    const legal = cards.filter(c => canPlayCards([c], state.pile, state.sevenRestriction));
    if (legal.length === 0) return { type: 'PICKUP_PILE' };
    // Group legal cards by rank, prefer non-special, then lowest rank value.
    const byRank = new Map<Rank, Card[]>();
    for (const c of legal) {
      const arr = byRank.get(c.rank) ?? [];
      arr.push(c);
      byRank.set(c.rank, arr);
    }
    const ranks = [...byRank.keys()].sort((a, b) => {
      const sa = SPECIAL_RANKS.has(a), sb = SPECIAL_RANKS.has(b);
      if (sa !== sb) return sa ? 1 : -1;
      return RANK_VALUE[a] - RANK_VALUE[b];
    });
    const chosen = byRank.get(ranks[0])!;
    return { type: 'PLAY_CARDS', ids: chosen.map(c => c.id) };
  }
  return null;
}

/* ----- Redaction (server → per-player view) ----- */

export const HIDDEN_CARD = (id: string): Card => ({ id, rank: '2', suit: '★' });

// Replace cards a viewer must not see with placeholder ids.
// - Other players' hand cards → hidden (count preserved).
// - All players' face-down cards → hidden (already hidden in game; ids replaced for safety).
// - Deck contents → hidden (count preserved).
// - Pile is fully visible.
// - Face-up is fully visible.
export function redactForViewer(state: GameState, viewer: number): GameState {
  // pendingReveal cards now come from the picker's private hand — visible only to them.
  const pendingReveal = !state.pendingReveal
    ? null
    : (state.current === viewer
        ? state.pendingReveal
        : { cards: state.pendingReveal.cards.map((_, i) => HIDDEN_CARD(`pr-${i}`)) });
  return {
    ...state,
    players: state.players.map(p => {
      const isMe = p.id === viewer;
      return {
        ...p,
        hand: isMe ? p.hand : p.hand.map((_, i) => HIDDEN_CARD(`hh-${p.id}-${i}`)),
        faceDown: p.faceDown.map((_, i) => HIDDEN_CARD(`fd-${p.id}-${i}`)),
      };
    }),
    deck: state.deck.map((_, i) => HIDDEN_CARD(`dk-${i}`)),
    pendingReveal,
  };
}
