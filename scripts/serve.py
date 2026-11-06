"""Petit serveur local pour tester le site : py scripts/serve.py puis http://localhost:8765"""
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class NoCache(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    print(f"Site disponible sur http://localhost:{PORT}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCache).serve_forever()
