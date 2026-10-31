"""Static dev server that tells the browser never to reuse cached files.

`python -m http.server` sends no Cache-Control header, so Chrome keeps heuristically cached copies of the JS modules and
data files and can run a mix of old and new files after an update. Usage (from the repository root):

    python tools/serve.py [port]        # default 8080
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(('', port), partial(NoCacheHandler, directory=str(ROOT)))
    print(f'Serving {ROOT} on http://localhost:{port}/ (no caching)')
    server.serve_forever()
