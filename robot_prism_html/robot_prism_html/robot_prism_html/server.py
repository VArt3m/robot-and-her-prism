"""Local dev server that correctly serves ES modules (.js as application/javascript)."""
import http.server, mimetypes, sys

mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('application/javascript', '.mjs')
mimetypes.add_type('text/css', '.css')

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
handler = http.server.SimpleHTTPRequestHandler
handler.extensions_map.update({'.js': 'application/javascript', '.css': 'text/css'})

with http.server.HTTPServer(('', port), handler) as httpd:
    print(f'Serving at http://127.0.0.1:{port}')
    httpd.serve_forever()
