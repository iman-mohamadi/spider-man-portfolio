"""Static dev server that tells the browser never to reuse cached files.

`python -m http.server` sends no Cache-Control header, so Chrome keeps heuristically cached copies of the JS modules and
data files and can run a mix of old and new files after an update. Usage (from the repository root):

    python tools/serve.py [port]                # default 8080
    python tools/serve.py [port] --save-clips   # also accepts POST /__save?name=<file>.json from tools/model-lab.html

--save-clips is for converting animation clips: it lets that page write ONE kind of file, a .json (or the manifest) inside
content/spider-raimi/anims/, and nothing else. It is off by default; use it only on localhost.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os, json

ROOT = Path(__file__).resolve().parent.parent
CLIPS = ROOT / 'content' / 'spider-raimi' / 'anims'


class NoCacheHandler(SimpleHTTPRequestHandler):
    save_clips = False

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        if not self.save_clips or not self.path.startswith('/__save'):
            self.send_response(404); self.end_headers(); return
        name = os.path.basename(self.path.split('name=', 1)[-1])
        n = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(n) if 0 < n < 20_000_000 else b''
        if not name.endswith('.json') or not body:
            self.send_response(400); self.end_headers(); return
        CLIPS.mkdir(parents=True, exist_ok=True)
        (CLIPS / name).write_bytes(body)
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'ok': True, 'saved': f'content/spider-raimi/anims/{name}', 'bytes': len(body)}).encode())


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    port = int(args[0]) if args else 8080
    NoCacheHandler.save_clips = '--save-clips' in sys.argv
    server = ThreadingHTTPServer(('', port), partial(NoCacheHandler, directory=str(ROOT)))
    print(f'Serving {ROOT} on http://localhost:{port}/ (no caching{", clip saving ON" if NoCacheHandler.save_clips else ""})')
    server.serve_forever()
