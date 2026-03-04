#!/usr/bin/env python3
"""Dual HTTP + HTTPS threaded server.
- HTTP  on :8080  (desktop preview)
- HTTPS on :8443  (mobile, required for DeviceOrientation API)
"""
import http.server
import socketserver
import ssl
import os
import threading

DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERT = os.path.join(DIR, 'cert.pem')
KEY = os.path.join(DIR, 'key.pem')

os.chdir(DIR)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'application/javascript',
        '.ply': 'application/octet-stream',
        '.ksplat': 'application/octet-stream',
    }

    def log_message(self, format, *args):
        print(f'  [{self.server.server_port}] {args[0]}')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if self.path in ('/', '/index'):
            self.send_response(302)
            self.send_header('Location', '/gallery.html')
            self.end_headers()
            return
        if self.path.endswith(('.ply', '.ksplat', '.splat')):
            import gzip as gz
            ae = self.headers.get('Accept-Encoding', '')
            if 'gzip' in ae:
                fpath = self.translate_path(self.path)
                try:
                    with open(fpath, 'rb') as f:
                        data = f.read()
                    compressed = gz.compress(data, compresslevel=6)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Encoding', 'gzip')
                    self.send_header('Content-Length', str(len(compressed)))
                    self.end_headers()
                    self.wfile.write(compressed)
                    return
                except FileNotFoundError:
                    pass
        super().do_GET()


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run_http(port=8080):
    httpd = ThreadedHTTPServer(('0.0.0.0', port), QuietHandler)
    print(f'  HTTP  → http://0.0.0.0:{port}/')
    httpd.serve_forever()


def run_https(port=8443):
    httpd = ThreadedHTTPServer(('0.0.0.0', port), QuietHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f'  HTTPS → https://0.0.0.0:{port}/')
    httpd.serve_forever()


if __name__ == '__main__':
    print('Starting servers...')
    threading.Thread(target=run_http, daemon=True).start()
    threading.Thread(target=run_https, daemon=True).start()
    print('Ready!')
    print(f'  Desktop : http://localhost:8080/')
    print(f'  Phone   : https://<your-ip>:8443/')
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print('\nStopped.')
