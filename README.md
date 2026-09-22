# CWEP Stockfish Example

A small static demo of the [Chess Web Engine Protocol (CWEP)](https://github.com/bestmacfly/CWEP), using **Stockfish.js 18.0.0 Lite multithreaded**. Analysis runs on the visitor's device in a Web Worker. A host communicates through a JavaScript bridge; there is no HTTP analysis endpoint.

## Run locally

Python 3.9+ is sufficient. All runtime files are included; no install step or CDN is needed.

```sh
git clone https://github.com/bestmacfly/cwep-stockfish-example.git cwep-stockfish-example
cd cwep-stockfish-example
python3 scripts/verify-assets.py
python3 scripts/serve.py
```

Open <http://localhost:8080> and click **Run sample analysis**. The server binds only to localhost and supplies the required isolation headers. A plain `python -m http.server` does not. Run the regression tests with Node.js 20+ using `npm test`.

## Connect a host

Wait until `window.cwepReceiveMessage` exists. WebKit responses go to `window.webkit.messageHandlers.cwep.postMessage`; ordinary browsers receive `cwep-message` events.

```js
window.addEventListener('cwep-message', event => console.log(event.detail));
const send = (type, requestId, payload = {}) =>
  window.cwepReceiveMessage({ protocol: 'cwep', version: '1.0', type, requestId, payload });
send('hello', 'hello-1');
send('getCapabilities', 'caps-1');
send('setPosition', 'position-1', {
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
});
send('startAnalysis', 'analysis-1', { limits: { movetimeMs: 1000 }, multiPv: 2 });
// Later: send('stopAnalysis', 'stop-1', { analysisRequestId: 'analysis-1' });
```

See the [CWEP specification](https://github.com/bestmacfly/CWEP) for messages and semantics. The protocol marker is exclusively `cwep`, the browser response event is `cwep-message`, and the plugin ID is `cwep-stockfish-example`. No config file is needed: the adapter defaults to `./stockfish/stockfish-18-lite.js`. Hosts may set `CWEP_STOCKFISH_CONFIG` before module initialization; only a same-origin `stockfishScriptUrl` is used.

The adapter validates positions/moves, waits for engine readiness and keeps one active search. Limits: depth 1–30, time 1–10,000 ms (default 1,000 even with depth), MultiPV 1–8, threads 1–4, hash 16–128 MiB. The worker initializes on first use and stays loaded across analyses. Initialization/readiness times out after 15 seconds; the search watchdog allows 1 second grace. Cancellation/replacement sends `stop`; the next search waits for `bestmove` and a readiness barrier, keeping only the newest pending request. Missing stop confirmation after 2 seconds or an engine failure discards the worker; a later request can initialize a fresh one. MultiPV scores remain separate by rank. Multiple tabs and suspended browser timers can still consume/delay resources. Native hosts must restrict bridge privileges and not expose app secrets.

## Host over HTTPS

Upload **all of `public/`**, including `source/`, `licenses/` and `licenses.html`, to a static HTTPS server. Relative paths allow a subdirectory. Set:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
```

Serve HTML as `text/html`, JS as `text/javascript`, JSON/maps as `application/json`, WASM as `application/wasm`, license text as `text/plain` and archives as `application/gzip`. The threaded build needs Web Workers, WASM SIMD, SharedArrayBuffer and `crossOriginIsolated`; check support in the actual target WebView.

The bridge itself needs no CORS header. For public cross-origin manifest fetches, allow `Access-Control-Allow-Origin: *` without credentials. The local server permits `GET, HEAD, OPTIONS`; OPTIONS returns 204. No POST API or custom request headers are required. CORS does not replace isolation or authentication. If adding CSP, test the unchanged loader's blob-worker/WASM requirements.

## Sources and licenses

The example retains its [existing GPL license and copyright notices](LICENSE); CWEP is separately MIT licensed. Stockfish JS/WASM, including embedded NNUE, are unchanged upstream artifacts. Adapter changes dated **2026-09-21** cover validation, limits, readiness, cancellation and compatibility; this documentation cleanup changes no analysis behavior.

- [Public licenses and exact upstream source/NNUE downloads](public/licenses.html)
- [Third-party notices and upstream build notes](public/licenses/THIRD_PARTY_NOTICES.md); [full license texts and author notices](public/licenses/THIRD_PARTY_LICENSES.txt)
- [Provenance and checksums](public/source/provenance.json)

Under GPL v3 §6(d), we remain responsible for the required availability and equivalent accessibility of the external corresponding sources.

`public/` contains the page, adapter, vendored runtime, sources and licenses. `scripts/` contains the local server and checksum verifier; `tests/` contains adapter regressions. No framework or build pipeline is needed.
