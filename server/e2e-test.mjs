/* End-to-end multiplayer test.
 * Spins up 3 WebSocket clients, runs through lobby → swap → play turns,
 * and asserts redaction + action authorization. */

import WebSocket from 'ws';
import assert from 'node:assert/strict';

const URL = 'ws://127.0.0.1:8787';
const wait = ms => new Promise(r => setTimeout(r, ms));

function open() {
  const w = new WebSocket(URL);
  w.q = [];
  w.on('message', m => w.q.push(JSON.parse(m.toString())));
  return new Promise(r => w.on('open', () => r(w)));
}

const send = (w, msg) => w.send(JSON.stringify(msg));
const lastState = w => [...w.q].reverse().find(m => m.t === 'STATE');
const lastLobby = w => [...w.q].reverse().find(m => m.t === 'LOBBY' || m.t === 'STATE');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass++; }
  catch (e) { console.log(`  ✗ ${label}\n      ${e.message}`); fail++; }
}

async function main() {
  console.log('Connecting 3 clients…');
  const a = await open(), b = await open(), c = await open();

  console.log('\n[Lobby]');
  send(a, { t: 'CREATE', name: 'Alice' });
  await wait(100);
  const code = lastLobby(a).lobby.code;
  check('host gets 4-letter room code', () => assert.match(code, /^[A-Z2-9]{4}$/));
  check('host is myId=0 hostId=0', () => {
    const l = lastLobby(a).lobby;
    assert.equal(l.myId, 0); assert.equal(l.hostId, 0);
  });

  send(b, { t: 'JOIN', code, name: 'Bob' });
  send(c, { t: 'JOIN', code, name: 'Carol' });
  await wait(150);
  check('all 3 players in lobby', () => {
    const l = lastLobby(a).lobby;
    assert.equal(l.players.length, 3);
    assert.deepEqual(l.players.map(p => p.name), ['Alice', 'Bob', 'Carol']);
  });
  check('Bob sees myId=1', () => assert.equal(lastLobby(b).lobby.myId, 1));
  check('Carol sees myId=2', () => assert.equal(lastLobby(c).lobby.myId, 2));

  console.log('\n[Authorization]');
  send(b, { t: 'START' });
  await wait(100);
  check('non-host START rejected', () => {
    const errs = b.q.filter(m => m.t === 'ERR');
    assert.ok(errs.some(e => /host/i.test(e.msg)), 'expected host-only error');
  });

  console.log('\n[Game start]');
  send(a, { t: 'START' });
  await wait(200);
  const sA = lastState(a), sB = lastState(b), sC = lastState(c);
  check('all clients receive STATE', () => {
    assert.ok(sA && sB && sC, 'all three should have STATE');
  });
  check('phase is swap', () => assert.equal(sA.state.phase, 'swap'));

  console.log('\n[Redaction]');
  check('Alice sees own hand with real ranks', () => {
    const aHand = sA.state.players[0].hand;
    assert.equal(aHand.length, 3);
    const real = aHand.filter(c => !(c.rank === '2' && c.suit === '★')).length;
    assert.ok(real >= 1, 'at least some non-placeholder cards');
  });
  check('Alice sees Bob hand as hidden placeholders', () => {
    const bHand = sA.state.players[1].hand;
    assert.equal(bHand.length, 3);
    bHand.forEach(c => {
      assert.equal(c.rank, '2'); assert.equal(c.suit, '★');
      assert.match(c.id, /^hh-1-/);
    });
  });
  check('Bob sees own hand real, Alice & Carol hidden', () => {
    const own = sB.state.players[1].hand.every(c => !c.id.startsWith('hh-'));
    const aliceHidden = sB.state.players[0].hand.every(c => c.id.startsWith('hh-0-'));
    const carolHidden = sB.state.players[2].hand.every(c => c.id.startsWith('hh-2-'));
    assert.ok(own, 'Bob own hand should not be hidden placeholders');
    assert.ok(aliceHidden, 'Alice hand should be hidden to Bob');
    assert.ok(carolHidden, 'Carol hand should be hidden to Bob');
  });
  check('deck contents hidden from all', () => {
    [sA, sB, sC].forEach(s => {
      assert.ok(s.state.deck.every(c => c.id.startsWith('dk-')));
    });
  });
  check('face-up cards visible to all (real ids)', () => {
    [sA, sB, sC].forEach(s => {
      s.state.players.forEach(p => {
        p.faceUp.forEach(c => assert.ok(!c.id.startsWith('hh-') && !c.id.startsWith('dk-')));
      });
    });
  });
  check('face-down cards hidden for everyone', () => {
    [sA, sB, sC].forEach(s => {
      s.state.players.forEach(p => {
        p.faceDown.forEach(c => assert.ok(c.id.startsWith('fd-')));
      });
    });
  });

  console.log('\n[Swap phase ready toggles]');
  send(a, { t: 'ACT', action: { type: 'SWAP_READY', player: 0 } });
  send(b, { t: 'ACT', action: { type: 'SWAP_READY', player: 1 } });
  send(c, { t: 'ACT', action: { type: 'SWAP_READY', player: 2 } });
  await wait(150);
  check('all 3 swapReady = true', () => {
    const s = lastState(a).state;
    assert.deepEqual(s.swapReady, [true, true, true]);
  });

  console.log('\n[Cross-player action rejection]');
  // Bob tries to mark Alice ready — should be rejected by server (action.player !== sender id).
  send(b, { t: 'ACT', action: { type: 'SWAP_READY', player: 0 } });
  await wait(80);
  check('Bob cannot toggle Alice ready', () => {
    const s = lastState(a).state;
    assert.equal(s.swapReady[0], true, 'Alice still ready (no toggle by Bob)');
  });

  console.log('\n[BEGIN_PLAY]');
  send(a, { t: 'ACT', action: { type: 'BEGIN_PLAY' } });
  await wait(150);
  const sPlay = lastState(a).state;
  check('phase advanced past pass to play (auto)', () => {
    assert.equal(sPlay.phase, 'play', `expected play, got ${sPlay.phase}`);
  });
  check('current player chosen', () => {
    assert.ok(sPlay.current >= 0 && sPlay.current < 3);
  });

  console.log('\n[Play turns]');
  // Drive several turns: current player picks the lowest legal card and plays it,
  // or picks up the pile if no legal play.
  const RANK_VALUE = { '3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'J':11,'Q':12,'K':13,'A':14,'2':2,'10':10,'JK':3 };
  const clients = [a, b, c];

  for (let turn = 0; turn < 8; turn++) {
    await wait(80);
    const s = lastState(a).state;
    if (s.phase === 'end') { console.log(`  game ended at turn ${turn}`); break; }
    if (s.phase === 'flipFaceDown') {
      send(clients[s.current], { t: 'ACT', action: { type: 'RESOLVE_FLIP' } });
      continue;
    }
    const cur = s.current;
    const meSocket = clients[cur];
    const myView = lastState(meSocket).state;
    const meP = myView.players[cur];
    // pick from the visible-to-self source (hand if has real cards, else faceUp)
    const source = meP.hand.length > 0 ? meP.hand : meP.faceUp;
    if (source.length === 0) {
      send(meSocket, { t: 'ACT', action: { type: 'PICKUP_PILE' } });
      continue;
    }
    // find any legal single card; else pick up
    const top = s.pile[s.pile.length - 1]?.effRank ?? null;
    const sevenLock = s.sevenRestriction;
    const legal = source.find(c => {
      if (c.rank === '2' || c.rank === '10' || c.rank === 'JK') return true;
      if (top === null) return true;
      if (sevenLock && RANK_VALUE[c.rank] > 7) return false;
      return RANK_VALUE[c.rank] >= RANK_VALUE[top];
    });
    if (!legal) {
      send(meSocket, { t: 'ACT', action: { type: 'PICKUP_PILE' } });
      continue;
    }
    send(meSocket, { t: 'ACT', action: { type: 'TOGGLE_SELECT', id: legal.id } });
    await wait(40);
    send(meSocket, { t: 'ACT', action: { type: 'PLAY_SELECTED' } });
  }
  await wait(150);

  const sFinal = lastState(a).state;
  check('pile or play state advanced', () => {
    assert.ok(sFinal.pile.length > 0 || sFinal.log.some(l => /played|burned|picked up/i.test(l)));
  });
  check('redaction holds throughout play', () => {
    const sNow = lastState(a).state;
    sNow.players.forEach((p, i) => {
      if (i === 0) return; // Alice's own hand
      p.hand.forEach(c => assert.ok(c.id.startsWith('hh-'), 'opponent cards still hidden'));
    });
  });

  console.log('\n[Disconnect]');
  c.close();
  await wait(150);
  check('Carol shown as disconnected in lobby', () => {
    const l = lastLobby(a).lobby;
    const carol = l.players.find(p => p.id === 2);
    assert.equal(carol.connected, false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  a.close(); b.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
