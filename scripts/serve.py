#!/usr/bin/env python3
"""Local static demo server. No engine API; bind only to localhost."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

PUBLIC = Path(__file__).resolve().parents[1] / 'public'

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def list_directory(self, path):
        self.send_error(403, 'Directory listing disabled')
        return None

    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        resolved = Path(self.translate_path(self.path)).resolve()
        if '..' in path.split('/') or not resolved.is_relative_to(PUBLIC):
            self.send_error(403, 'Path outside public directory')
            return None
        return super().send_head()

if __name__ == '__main__':
    print('CWEP demo: http://localhost:8080', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8080), Handler).serve_forever()
