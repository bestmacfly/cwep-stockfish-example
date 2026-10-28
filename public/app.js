// CWEP adapter, modified 2026-09-21. Distributed under GPL v3; see LICENSE.
import { Chess } from './vendor/chess.js';

const config = window.CWEP_STOCKFISH_CONFIG || {};
const metadata = { id: 'cwep-stockfish-example', name: 'CWEP Stockfish Example', version: '1.1.0' };
const limits = { depth: { min: 1, max: 30 }, movetimeMs: { min: 1, max: 10000 }, multiPv: { min: 1, max: 8 } };
const options = { threads: 1, hashMb: 16, multiPv: 1 };
let position = null;
// active is the newest unfinished CWEP request; engine.job owns UCI output.
// A completed request may still own a stopping UCI search until bestmove.
let active = null;
let engine = null;
let suspended = false;
let serial = 0;
const ui = Object.fromEntries(['pluginName', 'state', 'engineStatus', 'fen', 'depth', 'score', 'bestMove', 'pv', 'log'].map(id => [id, document.getElementById(id)]));
function show(id, value) { if (ui[id]) ui[id].textContent = String(value); }
function log(message) { if (ui.log) ui.log.textContent = (message + '\n' + ui.log.textContent).slice(0, 12000); }
function emit(context, type, payload) {
  const message = { protocol: 'cwep', version: '1.0', type, payload };
  if (context.requestId !== undefined) message.requestId = context.requestId;
  log(JSON.stringify(message));
  const bridge = window.webkit?.messageHandlers?.cwep;
  if (bridge) bridge.postMessage(message);
  else {
    window.dispatchEvent(new CustomEvent('cwep-message', { detail: message }));
  }
}
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_PAYLOAD', `${name} must be an integer in ${min}..${max}`);
  return value;
}
function finish(job, reason) {
  if (!job || job.completed) return;
  job.completed = true;
  if (active === job) active = null;
  clearTimeout(job.timer);
  const line = job.lines.get(1);
  const bestMove = job.bestMove ?? line?.pv?.[0] ?? null;
  show('state', position ? 'ready' : 'idle');
  show('bestMove', bestMove || '—');
  emit(job, 'analysisComplete', {
    bestMove, final: { bestMove, score: line?.score || null, pv: line?.pv || [] }, stoppedBy: reason
  });
}
function disposeEngine() {
  const old = engine;
  engine = null;
  if (old) {
    clearTimeout(old.timer);
    clearTimeout(old.job?.timer);
    old.worker?.terminate();
  }
  show('engineStatus', 'not running');
}
function engineFailure(owner, code, message) {
  if (engine !== owner) return;
  const job = active;
  disposeEngine();
  if (job && !job.completed) {
    emit(job, 'error', { code, message, recoverable: true });
    finish(job, 'error');
  } else log(message);
  // No automatic restart: a later startAnalysis may create a fresh worker.
}
function command(owner, text) {
  if (engine !== owner) return false;
  try { owner.worker.postMessage(text); return true; }
  catch (error) { engineFailure(owner, 'ENGINE_UNAVAILABLE', error.message); return false; }
}
function deadline(owner, ms, message) {
  clearTimeout(owner.timer);
  owner.timer = setTimeout(() => engineFailure(owner, 'ENGINE_TIMEOUT', message), ms);
}
function cancel(reason) {
  const job = active;
  const owner = engine;
  if (owner?.phase === 'search' && owner.job === job) {
    owner.phase = 'stopping';
    deadline(owner, 2000, 'Engine stop confirmation timed out');
    // Close the CWEP request now, but retain its UCI ownership until bestmove.
    finish(job, reason);
    command(owner, 'stop');
  } else finish(job, reason);
}
function pump() {
  const owner = engine;
  if (!owner || suspended) return;
  if (owner.phase === 'armed') {
    clearTimeout(owner.timer);
    if (!active || owner.job !== active || active.completed) {
      owner.job = null;
      owner.phase = 'idle';
    } else {
      const job = owner.job;
      owner.phase = 'search';
      if (job.movetimeMs !== undefined) {
        job.timer = setTimeout(() => {
          if (engine === owner && active === job) cancel('timeout');
        }, job.movetimeMs + 1000);
      }
      show('state', 'analyzing'); show('engineStatus', 'Stockfish 18 Lite');
      if (command(owner, `position fen ${job.position.fen}${job.position.moves.length ? ' moves ' + job.position.moves.join(' ') : ''}`)) {
        command(owner, `go${job.depth ? ' depth ' + job.depth : ''}${job.movetimeMs !== undefined ? ' movetime ' + job.movetimeMs : ''}`);
      }
      return;
    }
  }
  if (owner.phase !== 'idle' || !active) return;
  owner.job = active;
  owner.phase = 'preparing';
  deadline(owner, 15000, 'Engine readiness timed out');
  // Options and position belong to the accepted request, never mutable globals.
  if (!command(owner, `setoption name Threads value ${active.options.threads}`)) return;
  if (!command(owner, `setoption name Hash value ${active.options.hashMb}`)) return;
  if (!command(owner, `setoption name MultiPV value ${active.multiPv}`)) return;
  command(owner, 'isready');
}
function resetView() {
  for (const id of ['depth', 'score', 'bestMove', 'pv']) show(id, '—');
}
function validatePosition(payload) {
  if (typeof payload.fen !== 'string' || payload.fen.length > 160 || /[\r\n\t]/.test(payload.fen) || payload.fen.split(' ').length !== 6) fail('INVALID_FEN', 'Expected a six-field standard-chess FEN');
  let chess;
  try { chess = new Chess(payload.fen); } catch { fail('INVALID_FEN', 'Invalid FEN'); }
  // The player who just moved cannot have left their own king in check.
  const previousKing = chess.board().flat().find(p => p?.type === 'k' && p.color !== chess.turn());
  if (chess.isAttacked(previousKing.square, chess.turn())) fail('INVALID_FEN', 'The non-moving king is in check');
  const moves = payload.moves ?? [];
  if (!Array.isArray(moves) || moves.length > 512) fail('INVALID_PAYLOAD', 'moves must contain at most 512 UCI moves');
  for (const move of moves) {
    if (typeof move !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) fail('INVALID_MOVE', 'Invalid UCI move');
    try { chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] }); }
    catch { fail('INVALID_MOVE', 'Illegal move sequence'); }
  }
  return { fen: payload.fen, moves: [...moves], finalFen: chess.fen() };
}
function engineLine(owner, text) {
  if (engine !== owner) return;
  for (const raw of text.split(/\r?\n/)) {
    if (engine !== owner) return;
    const line = raw.trim();
    const job = owner.job;
    if (line === 'uciok' && owner.phase === 'uci') {
      owner.phase = 'initializing';
      command(owner, 'isready');
    } else if (line === 'readyok' && ['initializing', 'draining'].includes(owner.phase)) {
      clearTimeout(owner.timer);
      owner.phase = 'idle';
      owner.job = null;
      show('engineStatus', 'ready');
    } else if (line === 'readyok' && owner.phase === 'preparing') {
      owner.phase = 'armed';
    } else if (line.startsWith('bestmove ') && ['search', 'stopping'].includes(owner.phase)) {
      // bestmove ends UCI ownership; readyok by itself never ends a search.
      clearTimeout(job.timer);
      owner.phase = 'draining';
      deadline(owner, 15000, 'Engine readiness timed out');
      if (!job.completed) {
        const move = line.split(/\s+/)[1];
        job.bestMove = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) ? move : null;
        if (job.bestMove === null) job.lines.clear();
        finish(job, 'limit');
      }
      command(owner, 'isready');
    } else if (line.startsWith('info ') && owner.phase === 'search' && !job.completed && active === job) {
      const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/);
      const pvMatch = line.match(/\bpv (.+)$/);
      if (!scoreMatch || !pvMatch) continue;
      const rank = Number(line.match(/\bmultipv (\d+)/)?.[1] || 1);
      if (rank < 1 || rank > job.multiPv) continue;
      const pv = pvMatch[1].split(/\s+/).filter(m => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m));
      const score = { kind: scoreMatch[1], value: Number(scoreMatch[2]), pov: 'sideToMove' };
      const bound = line.match(/\b(lowerbound|upperbound)\b/);
      if (bound) score.bound = bound[1] === 'lowerbound' ? 'lower' : 'upper';
      const update = { depth: Number(line.match(/\bdepth (\d+)/)?.[1] || 0), multipv: rank, score, pv, bestMove: pv[0] || null };
      job.lines.set(rank, update);
      if (rank === 1) {
        show('depth', update.depth); show('score', `${score.value} ${score.kind}`); show('pv', pv.join(' ')); show('bestMove', pv[0] || '—');
      }
      emit(job, 'analysisUpdate', update);
    }
  }
  // Do not start a new search in the middle of an old output batch.
  pump();
}
function start(context, payload) {
  if (!position) fail('INVALID_POSITION', 'Set a position before starting analysis');
  if (payload.limits !== undefined && !object(payload.limits)) fail('INVALID_PAYLOAD', 'limits must be an object');
  const requested = payload.limits || {};
  const depth = requested.depth === undefined ? undefined : integer(requested.depth, 1, 30, 'depth');
  // Only searches without any explicit limit get the default time budget.
  const movetimeMs = requested.movetimeMs === undefined
    ? (depth === undefined ? 1000 : undefined)
    : integer(requested.movetimeMs, 1, 10000, 'movetimeMs');
  const multiPv = integer(payload.multiPv ?? options.multiPv, 1, 8, 'multiPv');
  if (typeof Worker === 'undefined' || !window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') fail('ENGINE_UNAVAILABLE', 'This threaded build requires Web Workers, SharedArrayBuffer and cross-origin isolation (COOP/COEP)');
  const url = new URL(config.stockfishScriptUrl || './stockfish/stockfish-18-lite.js', window.location.href);
  if (url.origin !== window.location.origin) fail('ENGINE_UNAVAILABLE', 'Engine script must be hosted on the same origin');
  if (suspended) fail('ENGINE_UNAVAILABLE', 'Page is not active');
  cancel('replaced');
  resetView();
  active = { ...context, requestId: context.requestId ?? `analysis-${++serial}`, depth, movetimeMs, multiPv,
    position: { ...position, moves: [...position.moves] }, options: { ...options }, lines: new Map(), completed: false };
  show('state', 'loading');
  if (engine) { pump(); return; }
  const owner = { phase: 'uci', job: null, worker: null };
  engine = owner;
  show('engineStatus', 'loading');
  deadline(owner, 15000, 'Engine initialization timed out');
  try {
    owner.worker = new Worker(url.href);
    owner.worker.onmessage = event => engineLine(owner, String(event.data));
    owner.worker.onerror = () => engineFailure(owner, 'ENGINE_UNAVAILABLE', 'Engine worker failed; check assets and isolation headers');
    owner.worker.onmessageerror = () => engineFailure(owner, 'ENGINE_UNAVAILABLE', 'Engine worker message could not be read');
    command(owner, 'uci');
  } catch (error) { engineFailure(owner, 'ENGINE_UNAVAILABLE', error.message); }
}
function receive(input) {
  const context = {};
  try {
    if (typeof input === 'string') {
      if (input.length > 65536) fail('INVALID_PAYLOAD', 'Message exceeds 64 KiB');
      try { input = JSON.parse(input); } catch { fail('INVALID_PAYLOAD', 'Invalid JSON'); }
    }
    if (!object(input)) fail('INVALID_PAYLOAD', 'Expected a message object');
    if (input.requestId !== undefined) {
      if (typeof input.requestId !== 'string' || !input.requestId.length || input.requestId.length > 128) fail('INVALID_PAYLOAD', 'requestId must contain 1..128 characters');
      context.requestId = input.requestId;
    }
    if (input.protocol !== 'cwep') fail('UNSUPPORTED_PROTOCOL', 'Expected cwep');
    if (input.version !== '1.0') fail('UNSUPPORTED_VERSION', 'Supported CWEP versions: 1.0');
    if (JSON.stringify(input).length > 65536) fail('INVALID_PAYLOAD', 'Message exceeds 64 KiB');
    if (!object(input.payload)) fail('INVALID_PAYLOAD', 'payload must be an object');
    const payload = input.payload;
    switch (input.type) {
      case 'hello':
        emit(context, 'helloAck', { plugin: metadata, supportedVersions: ['1.0'], engine: { name: 'Stockfish.js', version: '18.0.0', variant: 'lite-multithreaded' } }); break;
      case 'getCapabilities':
        emit(context, 'capabilities', { features: { analysis: true, multiPv: true, setOptions: true, moves: true, cancellation: true }, variants: ['standard'], limits, options: [
          { key: 'threads', type: 'integer', min: 1, max: 4, default: 1 },
          { key: 'hashMb', type: 'integer', min: 16, max: 128, default: 16 },
          { key: 'multiPv', type: 'integer', min: 1, max: 8, default: 1 }
        ] }); break;
      case 'setPosition': {
        const next = validatePosition(payload);
        cancel('positionChanged'); position = next; resetView(); show('fen', position.finalFen); show('state', 'ready'); break;
      }
      case 'startAnalysis': start(context, payload); break;
      case 'stopAnalysis':
        if (payload.analysisRequestId !== undefined && (typeof payload.analysisRequestId !== 'string' || payload.analysisRequestId !== active?.requestId)) fail('INVALID_REQUEST', 'No matching active analysis');
        cancel('stop'); break;
      case 'setOptions': {
        if (active) fail('BUSY', 'Change options only while idle');
        if (!object(payload.options)) fail('INVALID_PAYLOAD', 'options must be an object');
        const next = { ...options };
        for (const [key, value] of Object.entries(payload.options)) {
          const range = { threads: [1, 4], hashMb: [16, 128], multiPv: [1, 8] }[key];
          if (!Array.isArray(range)) fail('UNSUPPORTED_OPTION', `Unsupported option: ${key}`);
          next[key] = integer(value, ...range, key);
        }
        Object.assign(options, next); break;
      }
      default: fail('UNSUPPORTED_MESSAGE', 'Unknown message type');
    }
  } catch (error) { emit(context, 'error', { code: error.code || 'INTERNAL_ERROR', message: error.code ? error.message : 'Message processing failed', recoverable: true }); }
}
// Browser event listeners can synchronously submit a request during completion.
// Serialize those submissions so replacement cannot overwrite an accepted job.
const inbox = [];
let receiving = false;
window.cwepReceiveMessage = input => {
  inbox.push(input);
  if (receiving) return;
  receiving = true;
  try { while (inbox.length) receive(inbox.shift()); }
  finally { receiving = false; }
};
window.addEventListener('pagehide', () => {
  suspended = true;
  const job = active;
  disposeEngine();
  finish(job, 'stop');
});
window.addEventListener('pageshow', () => { suspended = false; });
show('pluginName', `${metadata.name} ${metadata.version}`);
show('state', 'idle');
show('engineStatus', 'not running');
window.dispatchEvent(new CustomEvent('cwep-ready'));
