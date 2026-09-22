// Sample UI, modified 2026-09-21. GPL v3; see LICENSE.
import './app.js';
let sequence = 0;
function send(type, payload = {}) {
  window.cwepReceiveMessage({ protocol: 'cwep', version: '1.0', type, requestId: `demo-${++sequence}`, payload });
}
document.getElementById('sample').addEventListener('click', () => {
  send('hello');
  send('getCapabilities');
  send('setPosition', { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' });
  send('startAnalysis', { limits: { movetimeMs: 1000 }, multiPv: 2 });
});
document.getElementById('stop').addEventListener('click', () => send('stopAnalysis'));
