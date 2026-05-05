/* End-to-end test for Ultimate mode + cutting.
 * Drives the reducer directly (no WebSocket needed for the rules portion)
 * because cutting requires deterministic hand contents which a real shuffled
 * room can't provide. Then runs a small WS-flow test to verify the CUT message
 * is wired up server-side. */

import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { reducer, newGame, cutMatches, canPlayCards, isFourOfAKind } from '../src/shared/game.ts';

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n      ${e.message}`); fail++; }
}

console.log('[Ultimate-mode rules — direct reducer]\n');

// 1. Auto-activate at 4+ players, double deck, 4 jokers.
const g4 = newGame(4);
check('4-player game auto-activates ultimate mode', () => assert.equal(g4.mode, 'ultimate'));
check('4-player game uses 2 decks (2×(52+2) = 108 total cards)', () => {
  const total = g4.players.reduce((s, p) => s + p.hand.length + p.faceUp.length + p.faceDown.length, 0) + g4.deck.length;
  assert.equal(total, 108);
});
check('4-player game has 4 jokers total', () => {
  let jk = 0;
  for (const p of g4.players) {
    for (const c of [...p.hand, ...p.faceUp, ...p.faceDown]) if (c.rank === 'JK') jk++;
  }
  jk += g4.deck.filter(c => c.rank === 'JK').length;
  assert.equal(jk, 4);
});

const g3 = newGame(3);
check('3-player game stays classic', () => assert.equal(g3.mode, 'classic'));
check('3-player has 54 cards total (52+2)', () => {
  const total = g3.players.reduce((s, p) => s + p.hand.length + p.faceUp.length + p.faceDown.length, 0) + g3.deck.length;
  assert.equal(total, 54);
});

// 2. Card IDs unique across both decks.
const allIds = new Set();
let dup = false;
for (const p of g4.players) for (const c of [...p.hand, ...p.faceUp, ...p.faceDown]) {
  if (allIds.has(c.id)) dup = true; allIds.add(c.id);
}
for (const c of g4.deck) { if (allIds.has(c.id)) dup = true; allIds.add(c.id); }
check('all 108 card ids are unique across both decks', () => assert.equal(dup, false));

// 3. Construct a controlled scenario: cutting an exact match.
// Build a synthetic state: top of pile is 7♥ from deck 1; player 2 holds 7♥ from deck 2.
function makeUltimateState() {
  const s = newGame(4);
  // Force-arrange: put a 7♥ from deck 1 onto pile, give player 2 a 7♥ from deck 2.
  const sevenH1 = { id: '7♥', rank: '7', suit: '♥' };
  const sevenH2 = { id: '7♥·d2', rank: '7', suit: '♥' };
  // Sweep all hands/faceUp/faceDown to remove these from wherever they were.
  s.players = s.players.map(p => ({
    ...p,
    hand: p.hand.filter(c => c.id !== sevenH1.id && c.id !== sevenH2.id),
    faceUp: p.faceUp.filter(c => c.id !== sevenH1.id && c.id !== sevenH2.id),
    faceDown: p.faceDown.filter(c => c.id !== sevenH1.id && c.id !== sevenH2.id),
  }));
  s.deck = s.deck.filter(c => c.id !== sevenH1.id && c.id !== sevenH2.id);
  // Now place top and give player 2 the match.
  s.pile = [{ card: sevenH1, effRank: '7', effSuit: '♥' }];
  s.players[2] = { ...s.players[2], hand: [...s.players[2].hand, sevenH2] };
  s.phase = 'play';
  s.swapReady = [true, true, true, true];
  s.current = 0; // player 0's turn
  return s;
}

const baseState = makeUltimateState();
check('cutMatches finds player 2 has 7♥ match', () => {
  const m = cutMatches(baseState, 2);
  assert.equal(m.length, 1);
  assert.equal(m[0].id, '7♥·d2');
});
check('cutMatches finds nothing for players without match', () => {
  for (const id of [0, 1, 3]) {
    const m = cutMatches(baseState, id);
    if (m.length > 0) throw new Error(`Player ${id} should have 0 matches, got ${m.length}`);
  }
});

// 4. Apply CUT and verify state transitions correctly.
const cutState = reducer(baseState, { type: 'CUT', player: 2, ids: ['7♥·d2'] });
check('after CUT: pile has both 7♥s on top', () => {
  assert.equal(cutState.pile.length, 2);
  assert.equal(cutState.pile[1].card.id, '7♥·d2');
});
check('after CUT: cutter loses the matching card', () => {
  assert.ok(!cutState.players[2].hand.some(c => c.id === '7♥·d2'));
});
check('after CUT: 7-restriction active for next player', () => {
  assert.equal(cutState.sevenRestriction, true);
});
check('after CUT: turn advances from cutter (player 2) to player 3 (skip player 0 who got cut)', () => {
  // direction is +1 (clockwise). cutter=2, next=(2+1)%4=3.
  assert.equal(cutState.current, 3);
});

// 5. Cutting on a Joker that copied 3♥.
function makeJokerCutScenario() {
  const s = newGame(4);
  const threeH = { id: '3♥', rank: '3', suit: '♥' };
  const threeH2 = { id: '3♥·d2', rank: '3', suit: '♥' };
  const joker = { id: 'JK1', rank: 'JK', suit: '★' };
  s.players = s.players.map(p => ({
    ...p,
    hand: p.hand.filter(c => ![threeH.id, threeH2.id, joker.id].includes(c.id)),
    faceUp: p.faceUp.filter(c => ![threeH.id, threeH2.id, joker.id].includes(c.id)),
    faceDown: p.faceDown.filter(c => ![threeH.id, threeH2.id, joker.id].includes(c.id)),
  }));
  s.deck = s.deck.filter(c => ![threeH.id, threeH2.id, joker.id].includes(c.id));
  // Pile: [3♥, JK] — joker copies 3♥.
  s.pile = [
    { card: threeH, effRank: '3', effSuit: '♥' },
    { card: joker, effRank: '3', effSuit: '♥' },
  ];
  s.players[1] = { ...s.players[1], hand: [...s.players[1].hand, threeH2] };
  s.phase = 'play';
  s.swapReady = [true, true, true, true];
  s.current = 0;
  return s;
}
const jokerScene = makeJokerCutScenario();
check('cut target on joker resolves to underlying card (3♥)', () => {
  const m = cutMatches(jokerScene, 1);
  assert.equal(m.length, 1, `expected 1 match, got ${m.length}`);
  assert.equal(m[0].id, '3♥·d2');
});
const afterJokerCut = reducer(jokerScene, { type: 'CUT', player: 1, ids: ['3♥·d2'] });
check('cutting through joker chain works', () => {
  assert.equal(afterJokerCut.pile.length, 3);
  assert.equal(afterJokerCut.pile[2].card.id, '3♥·d2');
  assert.equal(afterJokerCut.current, 2);
});

// 6. Four-of-a-kind burn via cutting.
function makeBurnByCutScenario() {
  const s = newGame(4);
  // Pile has three 9♣ effective (2 from real plays + 1 set up) — keep simple, build pile of 9♣, 9♣·d2, 9♣ chain via test seed
  // Actually, re-test using same suit *and* rank: only 2 of any (rank,suit) exist per ultimate. So 4-of-a-kind by suit needs jokers or different suits.
  // Burn rule uses effRank only — so 9♣, 9♥, 9♦ + cut 9♥·d2 = four-of-a-kind by rank.
  const c1 = { id: '9♣', rank: '9', suit: '♣' };
  const c2 = { id: '9♥', rank: '9', suit: '♥' };
  const c3 = { id: '9♦', rank: '9', suit: '♦' };
  const c4 = { id: '9♥·d2', rank: '9', suit: '♥' }; // matches c2 exactly
  const all = [c1, c2, c3, c4].map(c => c.id);
  s.players = s.players.map(p => ({
    ...p,
    hand: p.hand.filter(c => !all.includes(c.id)),
    faceUp: p.faceUp.filter(c => !all.includes(c.id)),
    faceDown: p.faceDown.filter(c => !all.includes(c.id)),
  }));
  s.deck = s.deck.filter(c => !all.includes(c.id));
  s.pile = [
    { card: c1, effRank: '9', effSuit: '♣' },
    { card: c3, effRank: '9', effSuit: '♦' },
    { card: c2, effRank: '9', effSuit: '♥' }, // top is 9♥
  ];
  s.players[1] = { ...s.players[1], hand: [...s.players[1].hand, c4] };
  s.phase = 'play';
  s.swapReady = [true, true, true, true];
  s.current = 0;
  return s;
}
const burnScene = makeBurnByCutScenario();
const afterBurn = reducer(burnScene, { type: 'CUT', player: 1, ids: ['9♥·d2'] });
check('cut that completes 4-of-a-kind burns the pile', () => {
  assert.equal(afterBurn.pile.length, 0);
});
check('4-of-a-kind burn (single card from cut) does NOT grant another turn — turn passes', () => {
  assert.notEqual(afterBurn.current, 1);  // cutter does NOT keep playing
  assert.equal(afterBurn.lastWasMine, false);
});

// House rule: only "four 3s in one go" still grants a bonus turn after a 4-of-a-kind burn.
function makeFourThreesScenario() {
  const s = newGame(4);
  const threes = ['3♣', '3♥', '3♦', '3♠'].map(id => ({ id, rank: '3', suit: id.slice(-1) }));
  const ids = new Set(threes.map(t => t.id));
  s.players = s.players.map(p => ({
    ...p,
    hand: p.hand.filter(c => !ids.has(c.id)),
    faceUp: p.faceUp.filter(c => !ids.has(c.id)),
    faceDown: p.faceDown.filter(c => !ids.has(c.id)),
  }));
  s.deck = s.deck.filter(c => !ids.has(c.id));
  s.players[0] = { ...s.players[0], hand: [...s.players[0].hand, ...threes] };
  s.phase = 'play';
  s.swapReady = [true, true, true, true];
  s.current = 0;
  return s;
}
const fourThreesScene = makeFourThreesScenario();
const afterFourThrees = reducer(fourThreesScene, { type: 'PLAY_CARDS', ids: ['3♣', '3♥', '3♦', '3♠'] });
check('four 3s in a single move burns AND grants another turn', () => {
  assert.equal(afterFourThrees.pile.length, 0);
  assert.equal(afterFourThrees.current, 0);
  assert.equal(afterFourThrees.lastWasMine, true);
});

// Joker mixing rule: joker cannot be played with non-jokers.
console.log('\n[Joker mixing rule]\n');
const emptyPile = [];
check('joker alone is playable', () => {
  assert.equal(canPlayCards([{ id: 'JK1', rank: 'JK', suit: '★' }], emptyPile, false), true);
});
check('two jokers together are playable', () => {
  assert.equal(canPlayCards([{ id: 'JK1', rank: 'JK', suit: '★' }, { id: 'JK2', rank: 'JK', suit: '★' }], emptyPile, false), true);
});
check('joker + 5 is REJECTED', () => {
  assert.equal(canPlayCards([{ id: 'JK1', rank: 'JK', suit: '★' }, { id: '5♣', rank: '5', suit: '♣' }], emptyPile, false), false);
});
check('two 5s together still playable', () => {
  assert.equal(canPlayCards([{ id: '5♣', rank: '5', suit: '♣' }, { id: '5♥', rank: '5', suit: '♥' }], emptyPile, false), true);
});

// 7. 7-or-lower lock does not block exact-match cut (but only because cut == same card).
function makeSevenLockScenario() {
  const s = newGame(4);
  const c1 = { id: '7♣', rank: '7', suit: '♣' };
  const c2 = { id: '7♣·d2', rank: '7', suit: '♣' };
  s.players = s.players.map(p => ({
    ...p,
    hand: p.hand.filter(c => ![c1.id, c2.id].includes(c.id)),
    faceUp: p.faceUp.filter(c => ![c1.id, c2.id].includes(c.id)),
    faceDown: p.faceDown.filter(c => ![c1.id, c2.id].includes(c.id)),
  }));
  s.deck = s.deck.filter(c => ![c1.id, c2.id].includes(c.id));
  s.pile = [{ card: c1, effRank: '7', effSuit: '♣' }];
  s.players[2] = { ...s.players[2], hand: [...s.players[2].hand, c2] };
  s.phase = 'play';
  s.swapReady = [true, true, true, true];
  s.sevenRestriction = true; // simulating that the 7 was just played
  s.current = 0;
  return s;
}
const sevenLockScene = makeSevenLockScenario();
const afterSevenCut = reducer(sevenLockScene, { type: 'CUT', player: 2, ids: ['7♣·d2'] });
check('cut works under 7-lock (exact match)', () => {
  assert.equal(afterSevenCut.pile.length, 2);
});

// 7b. 7-or-lower lock: rule is ≤7, NOT ≥top. So a 4 is legal when top is 7♦ and lock is active.
console.log('\n[7-lock semantics]\n');
const pileTop7 = [{ card: { id: '7♦', rank: '7', suit: '♦' }, effRank: '7', effSuit: '♦' }];
check('4 is legal under 7-lock (≤7 rule, NOT ≥top)', () => {
  assert.equal(canPlayCards([{ id: '4♦', rank: '4', suit: '♦' }], pileTop7, true), true);
});
check('3 is legal under 7-lock', () => {
  assert.equal(canPlayCards([{ id: '3♣', rank: '3', suit: '♣' }], pileTop7, true), true);
});
check('7 is legal under 7-lock', () => {
  assert.equal(canPlayCards([{ id: '7♣', rank: '7', suit: '♣' }], pileTop7, true), true);
});
check('8 is illegal under 7-lock', () => {
  assert.equal(canPlayCards([{ id: '8♣', rank: '8', suit: '♣' }], pileTop7, true), false);
});
check('Q is illegal under 7-lock', () => {
  assert.equal(canPlayCards([{ id: 'Q♣', rank: 'Q', suit: '♣' }], pileTop7, true), false);
});
check('2 always legal even under 7-lock', () => {
  assert.equal(canPlayCards([{ id: '2♣', rank: '2', suit: '♣' }], pileTop7, true), true);
});
check('10 always legal even under 7-lock', () => {
  assert.equal(canPlayCards([{ id: '10♣', rank: '10', suit: '♣' }], pileTop7, true), true);
});
check('Joker always legal even under 7-lock', () => {
  assert.equal(canPlayCards([{ id: 'JK1', rank: 'JK', suit: '★' }], pileTop7, true), true);
});

// Sanity: without 7-lock, ≥top still applies.
check('without 7-lock, 4 still illegal on 7 top', () => {
  assert.equal(canPlayCards([{ id: '4♦', rank: '4', suit: '♦' }], pileTop7, false), false);
});
check('without 7-lock, 8 legal on 7 top', () => {
  assert.equal(canPlayCards([{ id: '8♦', rank: '8', suit: '♦' }], pileTop7, false), true);
});

// 7c. Joker 4-of-a-kind rule: jokers don't count toward 4-of-a-kind by effective rank.
console.log('\n[Joker burn rule]\n');
const J = (id) => ({ card: { id, rank: 'JK', suit: '★' }, effRank: '7', effSuit: '♥' });
const c7 = (id) => ({ card: { id, rank: '7', suit: '♥' }, effRank: '7', effSuit: '♥' });
check('three real 7s + 1 joker (eff=7) does NOT burn', () => {
  const pile = [c7('7♥'), c7('7♥·d2'), c7('7♣'), J('JK1')];
  assert.equal(isFourOfAKind(pile), false);
});
check('four real 7s burn', () => {
  const pile = [c7('7♥'), c7('7♥·d2'), c7('7♣'), c7('7♦')];
  assert.equal(isFourOfAKind(pile), true);
});
check('four real jokers burn (rank=JK each)', () => {
  const four = [
    { card: { id: 'JK1', rank: 'JK', suit: '★' }, effRank: '3', effSuit: '★' },
    { card: { id: 'JK2', rank: 'JK', suit: '★' }, effRank: '3', effSuit: '★' },
    { card: { id: 'JK3', rank: 'JK', suit: '★' }, effRank: '3', effSuit: '★' },
    { card: { id: 'JK4', rank: 'JK', suit: '★' }, effRank: '3', effSuit: '★' },
  ];
  assert.equal(isFourOfAKind(four), true);
});

// 8. WebSocket: CUT message validates sender == action.player.
console.log('\n[WebSocket CUT validation]\n');
async function wsTest() {
  const URL = 'ws://127.0.0.1:8787';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function open() {
    const w = new WebSocket(URL);
    w.q = [];
    w.on('message', m => w.q.push(JSON.parse(m.toString())));
    return new Promise(r => w.on('open', () => r(w)));
  }
  const a = await open(), b = await open();
  a.send(JSON.stringify({ t: 'CREATE', name: 'A' }));
  await wait(80);
  const code = [...a.q].reverse().find(m => m.t === 'LOBBY' || m.t === 'STATE')?.lobby?.code;
  b.send(JSON.stringify({ t: 'JOIN', code, name: 'B' }));
  await wait(100);

  // Bob sends CUT claiming to be Alice — server should reject (action.player !== sender id).
  b.send(JSON.stringify({ t: 'ACT', action: { type: 'CUT', player: 0, ids: ['fake'] } }));
  await wait(80);
  // Server doesn't broadcast errors for blocked actions (just ignores). State should be unchanged.
  // Just verify the server didn't crash and connection still alive.
  check('server still responsive after spoofed CUT attempt', () => assert.equal(b.readyState, WebSocket.OPEN));

  a.close(); b.close();
}
await wsTest().catch(e => { console.error('WS test error:', e.message); fail++; });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
