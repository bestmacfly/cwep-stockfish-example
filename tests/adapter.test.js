import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { Chess } from '../public/vendor/chess.js';
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace("import { Chess } from './vendor/chess.js';", '');
const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
function harness() {
  const events = [], dispatched = [], workers = [], timers = new Map(), delays = new Map(), listeners = new Map();
  let timer = 0;
  class Worker {
    constructor(url) { this.url = url; this.commands = []; workers.push(this); }
    postMessage(command) { this.commands.push(command); }
    terminate() { this.terminated = true; }
    line(data) { this.onmessage({ data }); }
  }
  const elements = new Map();
  const window = { location: { href: 'https://engine.example/index.html', origin: 'https://engine.example' }, crossOriginIsolated: true, addEventListener(type, fn) { listeners.set(type, fn); }, dispatchEvent(event) { dispatched.push(event.type); if (event.type === 'cwep-message') events.push(event.detail); } };
  vm.runInNewContext(source, { Chess, window, document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { textContent: '' }); return elements.get(id); } }, Worker, URL, SharedArrayBuffer, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, setTimeout(fn, ms) { timers.set(++timer, fn); delays.set(timer, ms); return timer; }, clearTimeout(id) { timers.delete(id); delays.delete(id); } });
  const send = (type, payload = {}, requestId = type, protocol = 'cwep', version = '1.0') => window.cwepReceiveMessage({ protocol, version, type, requestId, payload });
  const position = () => send('setPosition', { fen });
  const start = id => send('startAnalysis', { limits: { depth: 8, movetimeMs: 200 } }, id);
  const ready = worker => { worker.line('uciok'); worker.line('readyok'); worker.line('readyok'); };
  const fire = ms => {
    const id = [...timers.keys()].find(id => delays.get(id) === ms);
    assert.notEqual(id, undefined, `Expected a ${ms}ms timer`);
    const fn = timers.get(id); timers.delete(id); delays.delete(id); fn();
  };
  return { events, dispatched, workers, timers, window, send, position, start, ready, fire, listeners, elements };
}
test('negotiation uses only CWEP and rejects unsupported protocols and versions', () => {
  const h = harness(); h.send('hello', {}, 'hi');
  assert.equal(h.events[0].protocol, 'cwep');
  assert.equal(h.events[0].payload.plugin.id, 'cwep-stockfish-example');
  assert.deepEqual(h.dispatched, ['cwep-ready', 'cwep-message']);
  for (const protocol of ['cewp', 'CWEP', '', undefined]) {
    h.window.cwepReceiveMessage({ protocol, version: '1.0', type: 'hello', requestId: 'invalid', payload: {} });
    assert.equal(h.events.at(-1).payload.code, 'UNSUPPORTED_PROTOCOL');
    assert.equal(h.events.at(-1).protocol, 'cwep');
  }
  assert.deepEqual(Array.from(h.events[0].payload.supportedVersions), ['1.0']);
  h.send('hello', {}, 'bad', 'cwep', '2.0');
  assert.equal(h.events.at(-1).payload.code, 'UNSUPPORTED_VERSION');
  h.window.cwepReceiveMessage('{'); assert.equal(h.events.at(-1).payload.code, 'INVALID_PAYLOAD');
  h.window.cwepReceiveMessage(null); assert.equal(h.events.at(-1).type, 'error');
});
test('waits for both handshakes, preserves move history and combines limits', () => {
  const h = harness(); h.send('setPosition', { fen, moves: ['e2e4', 'e7e5'] }); h.start('a');
  const w = h.workers[0]; assert.deepEqual(w.commands, ['uci']);
  w.line('uciok'); assert.equal(w.commands.at(-1), 'isready'); assert.ok(!w.commands.some(x => x.startsWith('go')));
  w.line('readyok'); assert.ok(!w.commands.some(x => x.startsWith('go')));
  w.line('readyok'); assert.ok(w.commands.includes(`position fen ${fen} moves e2e4 e7e5`));
  assert.equal(w.commands.at(-1), 'go depth 8 movetime 200');
  w.line('bestmove g1f3'); assert.equal(h.events.at(-1).payload.bestMove, 'g1f3'); w.line('readyok'); assert.equal(h.timers.size, 0);
});
test('replacement and stop while loading retain one worker and complete pending requests', () => {
  const h = harness(); h.position(); h.start('a'); const w = h.workers[0]; h.start('b');
  assert.ok(!w.terminated); assert.equal(h.events.at(-1).requestId, 'a'); assert.equal(h.events.at(-1).payload.stoppedBy, 'replaced');
  h.send('stopAnalysis', { analysisRequestId: 'a' }, 'stop-wrong'); assert.equal(h.events.at(-1).payload.code, 'INVALID_REQUEST');
  h.send('stopAnalysis', {}, 'stop-id'); assert.equal(h.events.at(-1).requestId, 'b'); assert.equal(h.events.at(-1).payload.stoppedBy, 'stop');
  h.ready(w); assert.equal(w.commands.filter(x => x.startsWith('go')).length, 0);
  assert.equal(h.events.filter(x => x.type === 'analysisComplete').length, 2); assert.equal(h.timers.size, 0);
  h.start('c'); w.line('readyok'); assert.equal(h.workers.length, 1); assert.equal(w.commands.at(-1), 'go depth 8 movetime 200');
});
test('FEN injection, illegal moves, ranges and unknown options never reach engine', () => {
  const h = harness(); h.position(); h.start('a');
  for (const payload of [{ fen: fen + '\nquit' }, { fen, moves: ['e2e5'] }, { fen: '8/8/8/8/8/8/8/8 w - - 0 1' }]) h.send('setPosition', payload);
  h.send('startAnalysis', { multiPv: 100 }); h.send('startAnalysis', { limits: { depth: -1 } });
  assert.equal(h.workers.length, 1); assert.ok(!h.workers[0].terminated);
  h.send('stopAnalysis');
  h.send('setOptions', { options: { EvalFile: '/etc/passwd' } }); assert.equal(h.events.at(-1).payload.code, 'UNSUPPORTED_OPTION');
  h.send('setOptions', { options: { threads: 2, hashMb: 2048 } }); assert.equal(h.events.at(-1).payload.code, 'INVALID_PAYLOAD');
  h.start('b'); h.ready(h.workers[0]); assert.ok(h.workers[0].commands.includes('setoption name Threads value 1'));
});
test('MultiPV updates keep rank-1 final score separate and normalize terminal moves', () => {
  const h = harness(); h.position(); h.send('startAnalysis', { multiPv: 2 }, 'a'); const w = h.workers[0]; h.ready(w);
  w.line('info depth 8 multipv 1 score cp 35 pv e2e4 e7e5');
  w.line('info depth 7 multipv 2 score cp 12 upperbound pv d2d4 d7d5');
  assert.equal(h.events.at(-1).payload.score.bound, 'upper');
  w.line('bestmove e2e4'); assert.equal(h.events.at(-1).payload.final.score.value, 35);
  w.line('readyok'); h.start('b'); w.line('readyok'); w.line('bestmove (none)'); assert.equal(h.events.at(-1).payload.bestMove, null);
});
const completes = h => h.events.filter(e => e.type === 'analysisComplete');
const gos = w => w.commands.filter(c => c.startsWith('go'));
test('completed analyses reuse one initialized worker and reapply search options', () => {
  const h = harness(); h.position(); h.start('a'); const w = h.workers[0]; h.ready(w);
  w.line('bestmove e2e4'); w.line('readyok');
  h.send('setOptions', { options: { threads: 2, hashMb: 32, multiPv: 3 } });
  h.start('b'); assert.equal(gos(w).length, 1); w.line('readyok');
  assert.ok(w.commands.includes('setoption name Threads value 2'));
  assert.ok(w.commands.includes('setoption name Hash value 32'));
  assert.ok(w.commands.includes('setoption name MultiPV value 3'));
  w.line('bestmove d2d4'); w.line('readyok');
  assert.equal(h.workers.length, 1); assert.equal(w.commands.filter(c => c === 'uci').length, 1);
  assert.deepEqual(completes(h).map(e => [e.requestId, e.payload.stoppedBy]), [['a', 'limit'], ['b', 'limit']]);
  assert.equal(h.timers.size, 0); assert.ok(!w.terminated);
});
test('replacement waits for bestmove and readiness; old output never crosses requests', () => {
  const h = harness(); h.position(); h.start('a'); const w = h.workers[0]; h.ready(w);
  w.line('info depth 3 score cp 11 pv e2e4'); h.start('b');
  assert.equal(w.commands.at(-1), 'stop'); assert.equal(completes(h)[0].requestId, 'a');
  const count = h.events.length;
  w.line('readyok\ninfo depth 10 score cp 999 pv d2d4');
  assert.equal(gos(w).length, 1); assert.equal(h.events.length, count);
  w.line('bestmove e2e4\ninfo depth 11 score cp 999 pv d2d4');
  assert.equal(gos(w).length, 1); assert.equal(w.commands.at(-1), 'isready');
  w.line('readyok\nbestmove e2e4\ninfo depth 12 score cp 999 pv d2d4');
  assert.equal(gos(w).length, 1); assert.equal(h.events.length, count);
  w.line('readyok\ninfo depth 13 score cp 999 pv d2d4');
  assert.equal(gos(w).length, 2); assert.equal(h.events.length, count);
  w.line('info depth 1 score cp 20 pv g1f3'); assert.equal(h.events.at(-1).requestId, 'b');
  w.line('bestmove g1f3'); assert.equal(completes(h)[1].payload.final.score.value, 20);
  assert.equal(completes(h).length, 2); assert.equal(h.workers.length, 1);
});
test('rapid position changes coalesce pending work and preserve every completion', () => {
  const h = harness(); h.position(); h.start('a'); const w = h.workers[0]; h.ready(w);
  h.send('setPosition', { fen, moves: ['e2e4'] }); h.start('b');
  h.send('setPosition', { fen, moves: ['d2d4'] }); h.start('c'); h.start('d');
  assert.deepEqual(completes(h).map(e => [e.requestId, e.payload.stoppedBy]), [['a', 'positionChanged'], ['b', 'positionChanged'], ['c', 'replaced']]);
  assert.equal(w.commands.filter(c => c === 'stop').length, 1);
  assert.equal(gos(w).length, 1); w.line('bestmove e2e4'); w.line('readyok'); w.line('readyok');
  assert.equal(gos(w).length, 2); assert.equal(w.commands.at(-2), `position fen ${fen} moves d2d4`);
  w.line('bestmove d7d5'); assert.deepEqual(completes(h).map(e => e.requestId), ['a', 'b', 'c', 'd']);
});
test('cancel during search, drain and option preparation never starts canceled work', () => {
  const h = harness(); h.position(); h.start('a'); const w = h.workers[0]; h.ready(w);
  h.send('stopAnalysis', { analysisRequestId: 'a' }); h.start('b');
  h.send('stopAnalysis', { analysisRequestId: 'b' });
  w.line('bestmove e2e4'); w.line('readyok'); assert.equal(gos(w).length, 1);
  h.start('c'); h.send('stopAnalysis'); w.line('readyok'); assert.equal(gos(w).length, 1);
  assert.deepEqual(completes(h).map(e => [e.requestId, e.payload.stoppedBy]), [['a', 'stop'], ['b', 'stop'], ['c', 'stop']]);
  assert.equal(h.timers.size, 0); assert.ok(!w.terminated);
});
test('accepted position, moves and options are snapshots and invalid requests do not stop search', () => {
  const h = harness(); const payload = { fen, moves: ['e2e4'] };
  h.send('setPosition', payload); h.send('setOptions', { options: { threads: 2, hashMb: 32 } });
  const search = { limits: { movetimeMs: 300, depth: 9 }, multiPv: 2 }; h.send('startAnalysis', search, 'a');
  payload.moves[0] = 'd2d4'; search.limits.movetimeMs = 9000; search.multiPv = 8;
  const w = h.workers[0]; h.ready(w);
  assert.equal(w.commands.at(-2), `position fen ${fen} moves e2e4`); assert.equal(w.commands.at(-1), 'go depth 9 movetime 300');
  assert.ok(w.commands.includes('setoption name MultiPV value 2'));
  h.send('startAnalysis', { limits: { depth: -1 } }, 'invalid'); h.send('setPosition', { fen: 'invalid' });
  h.send('stopAnalysis', { analysisRequestId: 'wrong' }); h.send('setOptions', { options: { threads: 1 } });
  assert.equal(completes(h).length, 0); assert.ok(!w.commands.includes('stop'));
  w.line('bestmove e7e5'); assert.equal(completes(h)[0].requestId, 'a');
});
test('startup, readiness and stop timeouts reset once; later requests can restart', () => {
  for (const phase of ['startup', 'preparing', 'stopping', 'draining']) {
    const h = harness(); h.position(); h.start('a'); const old = h.workers[0];
    if (phase === 'preparing') { old.line('uciok'); old.line('readyok'); }
    if (phase === 'stopping' || phase === 'draining') { h.ready(old); h.start('b'); }
    if (phase === 'draining') old.line('bestmove e2e4');
    h.fire(phase === 'stopping' ? 2000 : 15000);
    assert.ok(old.terminated); assert.equal(h.timers.size, 0); assert.equal(h.workers.length, 1);
    assert.equal(h.events.at(-2).payload.code, 'ENGINE_TIMEOUT'); assert.equal(h.events.at(-1).payload.stoppedBy, 'error');
    h.start('later'); const w = h.workers[1];
    const count = h.events.length; old.line('uciok\nreadyok\ninfo depth 3 score cp 99 pv e2e4\nbestmove e2e4'); old.onerror();
    assert.equal(h.events.length, count); h.ready(w); w.line('bestmove d2d4'); w.line('readyok');
    assert.equal(completes(h).at(-1).requestId, 'later'); assert.equal(h.timers.size, 0);
  }
});
test('search watchdog stops once and reuses a responsive worker; missing stop discards it', () => {
  for (const responds of [true, false]) {
    const h = harness(); h.position(); h.start('a'); const w = h.workers[0]; h.ready(w); h.fire(1200);
    assert.equal(completes(h)[0].payload.stoppedBy, 'timeout'); assert.equal(w.commands.at(-1), 'stop');
    if (responds) { w.line('bestmove e2e4'); w.line('readyok'); assert.ok(!w.terminated); }
    else { h.fire(2000); assert.ok(w.terminated); }
    assert.equal(completes(h).length, 1); assert.equal(h.timers.size, 0);
    h.start('b'); assert.equal(h.workers.length, responds ? 1 : 2);
  }
});
test('worker errors and command failures release resources without automatic restart', () => {
  for (const failure of ['onerror', 'onmessageerror', 'postMessage']) {
    const h = harness(); h.position(); h.start('a'); const w = h.workers[0]; h.ready(w);
    if (failure === 'postMessage') { w.postMessage = () => { throw new Error('closed'); }; w.line('bestmove e2e4'); }
    else w[failure]();
    assert.ok(w.terminated); assert.equal(h.timers.size, 0); assert.equal(completes(h).length, 1);
    assert.equal(h.workers.length, 1); h.start('b'); assert.equal(h.workers.length, 2);
  }
});
test('pagehide releases idle or busy worker and all timers; pageshow permits explicit restart', () => {
  for (const phase of ['startup', 'search', 'stopping', 'idle']) {
    const h = harness(); h.position(); h.start('a'); const w = h.workers[0];
    if (phase !== 'startup') h.ready(w);
    if (phase === 'stopping') h.start('b');
    if (phase === 'idle') { w.line('bestmove e2e4'); w.line('readyok'); }
    h.listeners.get('pagehide')(); assert.ok(w.terminated); assert.equal(h.timers.size, 0);
    const count = completes(h).length; w.line('bestmove e2e4'); assert.equal(completes(h).length, count);
    h.start('hidden'); assert.equal(h.events.at(-1).payload.code, 'ENGINE_UNAVAILABLE');
    h.listeners.get('pageshow')(); h.start('later'); assert.equal(h.workers.length, 2);
  }
});

test('synchronous host submissions during replacement cannot lose accepted requests', () => {
  const h = harness(); h.position(); h.start('a'); const w = h.workers[0]; h.ready(w);
  const dispatch = h.window.dispatchEvent;
  h.window.dispatchEvent = event => {
    dispatch(event);
    if (event.detail?.type === 'analysisComplete' && event.detail.requestId === 'a') h.start('nested');
  };
  h.start('outer');
  assert.deepEqual(completes(h).map(e => [e.requestId, e.payload.stoppedBy]), [['a', 'replaced'], ['outer', 'replaced']]);
  w.line('bestmove e2e4'); w.line('readyok'); w.line('readyok'); w.line('bestmove d2d4');
  assert.deepEqual(completes(h).map(e => e.requestId), ['a', 'outer', 'nested']);
});
