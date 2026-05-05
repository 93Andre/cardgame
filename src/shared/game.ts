/* =============================================================
 * Poop Head — shared game module (no DOM/React deps).
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
}

export interface Player {
  id: number;
  name: string;
  hand: Card[];
  faceUp: Card[];
  faceDown: Card[];
  out: boolean;
  finishPos: number | null;
}

export type Phase = 'setup' | 'swap' | 'pass' | 'play' | 'flipFaceDown' | 'end';
export type Source = 'hand' | 'faceUp' | 'faceDown';

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
}

export type Action =
  | { type: 'NEW_GAME'; playerCount?: number; names?: string[] }
  | { type: 'SWAP_PICK'; player: number; source: Source; id: string }
  | { type: 'SWAP_READY'; player: number }
  | { type: 'BEGIN_PLAY' }
  | { type: 'ACK_PASS' }
  | { type: 'TOGGLE_SELECT'; id: string }
  | { type: 'PLAY_SELECTED' }
  | { type: 'PICKUP_PILE' }
  | { type: 'FLIP_FACEDOWN'; id: string }
  | { type: 'RESOLVE_FLIP' };

export const RANK_ORDER: Rank[] = ['3', '4', '5', '6', '7', '8', '9', 'J', 'Q', 'K', 'A'];
export const RANK_VALUE: Record<Rank, number> = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  J: 11, Q: 12, K: 13, A: 14,
  '2': 2, '10': 10, JK: 3,
};

/* ----- Deck ----- */

export function createDeck(): Card[] {
  const suits: Suit[] = ['♠', '♥', '♦', '♣'];
  const ranks: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const cards: Card[] = [];
  for (const s of suits) for (const r of ranks) cards.push({ id: `${r}${s}`, rank: r, suit: s });
  cards.push({ id: 'JK1', rank: 'JK', suit: '★' });
  cards.push({ id: 'JK2', rank: 'JK', suit: '★' });
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

export function deal(deck: Card[], playerCount: number, names?: string[]): { players: Player[]; deck: Card[] } {
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
    });
  }
  return { players, deck: d };
}

/* ----- Pure logic ----- */

export function resolveEffRank(card: Card, pileBefore: PileEntry[]): Rank {
  if (card.rank !== 'JK') return card.rank;
  if (pileBefore.length === 0) return '3';
  return pileBefore[pileBefore.length - 1].effRank;
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
  const nonJokerRanks = new Set(cards.filter(c => c.rank !== 'JK').map(c => c.rank));
  if (nonJokerRanks.size > 1) return false;
  const baseRank: Rank = nonJokerRanks.size === 0 ? 'JK' : ([...nonJokerRanks][0] as Rank);
  const top = topEffRank(pile);
  if (baseRank === '2' || baseRank === '10' || baseRank === 'JK') return true;
  if (top === null) return true;
  if (sevenLock && RANK_VALUE[baseRank] > 7) return false;
  return RANK_VALUE[baseRank] >= RANK_VALUE[top];
}

export function isFourOfAKind(pile: PileEntry[]): boolean {
  if (pile.length < 4) return false;
  const r = pile[pile.length - 1].effRank;
  if (r === '2' || r === '10') return false;
  for (let i = pile.length - 4; i < pile.length - 1; i++) {
    if (pile[i].effRank !== r) return false;
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
  };
}

export function newGame(playerCount: number = DEFAULT_PLAYER_COUNT, names?: string[]): GameState {
  const { players, deck } = deal(shuffle(createDeck()), playerCount, names);
  const swapSelected: Record<number, null> = {};
  for (let i = 0; i < playerCount; i++) swapSelected[i] = null;
  return {
    ...initialState(),
    phase: 'swap',
    players,
    deck,
    swapReady: Array(playerCount).fill(false),
    swapSelected,
    log: ['Cards dealt. Swap phase: each player may swap cards between hand and face-up.'],
  };
}

function logLine(state: GameState, line: string): string[] {
  return [...state.log, line].slice(-50);
}

function postPlay(stateIn: GameState, playerIdx: number, sourceUsed: Source, played: Card[]): GameState {
  let state = stateIn;
  const burnedByTen = played.length > 0 && played.every(c => c.rank === '10');
  const burnedByFour = isFourOfAKind(state.pile);
  let pileCleared = false;
  let goesAgain = false;

  if (burnedByTen) {
    state = { ...state, pile: [], log: logLine(state, 'Pile burned by 10! Same player plays again.') };
    pileCleared = true;
    goesAgain = true;
  } else if (burnedByFour) {
    state = { ...state, pile: [], log: logLine(state, 'Four of a kind! Pile burned. Same player plays again.') };
    pileCleared = true;
    goesAgain = true;
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
      dirChange = -1;
      state = { ...state, log: logLine(state, 'King played — direction reversed.') };
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
      return newGame(action.playerCount ?? DEFAULT_PLAYER_COUNT, action.names);

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
      const list = cardsFromSource(p, src);
      const card = list.find(c => c.id === action.id);
      if (!card) return state;
      const already = state.selected.includes(action.id);
      if (already) {
        return { ...state, selected: state.selected.filter(x => x !== action.id) };
      }
      const sel = state.selected.map(id => list.find(c => c.id === id)!).filter(Boolean);
      const allCards = [...sel, card];
      const nonJk = new Set(allCards.filter(c => c.rank !== 'JK').map(c => c.rank));
      if (nonJk.size > 1) return state;
      return { ...state, selected: [...state.selected, action.id] };
    }

    case 'PLAY_SELECTED': {
      const p = state.players[state.current];
      const src = activeSource(p, state.deck.length === 0);
      if (!src || src === 'faceDown') return state;
      if (state.selected.length === 0) return state;
      const list = cardsFromSource(p, src);
      const cards = state.selected.map(id => list.find(c => c.id === id)!).filter(Boolean) as Card[];
      if (!canPlayCards(cards, state.pile, state.sevenRestriction)) return state;

      let pile = state.pile.slice();
      for (const c of cards) {
        pile = [...pile, { card: c, effRank: resolveEffRank(c, pile) }];
      }

      const players = state.players.slice();
      const updatedSrc = list.filter(c => !state.selected.includes(c.id));
      const np: Player = { ...p };
      if (src === 'hand') np.hand = updatedSrc;
      else np.faceUp = updatedSrc;
      players[state.current] = np;

      const ranksSummary = cards.map(c => `${c.rank}${c.suit}`).join(' + ');
      const next: GameState = {
        ...state,
        players,
        pile,
        selected: [],
        sevenRestriction: false,
        log: logLine(state, `${p.name} played ${ranksSummary}.`),
      };
      return postPlay(next, state.current, src, cards);
    }

    case 'PICKUP_PILE': {
      if (state.pile.length === 0) return state;
      const players = state.players.slice();
      const p = { ...players[state.current] };
      p.hand = [...p.hand, ...state.pile.map(e => e.card)];
      players[state.current] = p;
      const log = logLine(state, `${p.name} picked up the pile (${state.pile.length} cards).`);
      const next: GameState = {
        ...state, players, pile: [], selected: [], sevenRestriction: false, log, flippedCard: null,
      };
      const direction = state.direction;
      const current = nextActiveIndex(players, state.current, direction);
      return { ...next, current, phase: 'pass', lastWasMine: false };
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
        pile = [...pile, { card, effRank: resolveEffRank(card, pile) }];
        const next: GameState = {
          ...state, players, pile, flippedCard: null, selected: [],
          log: logLine(state, `${p.name} flipped face-down ${card.rank}${card.suit} — legal!`),
        };
        return postPlay(next, state.current, 'faceDown', [card]);
      } else {
        const picked = [...state.pile.map(e => e.card), card];
        const np2: Player = { ...np, hand: [...np.hand, ...picked] };
        players[state.current] = np2;
        const log = logLine(state, `${p.name} flipped ${card.rank}${card.suit} — illegal! Picks up pile (${picked.length}).`);
        const direction = state.direction;
        const current = nextActiveIndex(players, state.current, direction);
        return {
          ...state, players, pile: [], flippedCard: null, selected: [], sevenRestriction: false,
          phase: 'pass', current, log, lastWasMine: false,
        };
      }
    }

    default:
      return state;
  }
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
  };
}
