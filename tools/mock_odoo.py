#!/usr/bin/env python3
"""Мінімальний макет Odoo JSON-RPC для перевірки мосту в worker.js.
Моделі: td.event.session, td.event.tg.user, td.event.attendance, td.event.note.
Стан у пам'яті; /state віддає його для перевірок."""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8089

SESSIONS = [
    {"id": 466, "external_ref": "opening-keynote-unveiling-odoo-20-auditorium-4000-auditorium-2000-hall-7-a-10881", "note_count": 0},
    {"id": 491, "external_ref": "what-s-new-in-sales-9001", "note_count": 2},
    {"id": 492, "external_ref": "what-s-new-in-javascript-9002", "note_count": 0},
    {"id": 999, "external_ref": False, "note_count": 0},
]
TG = [
    {"id": 1, "name": "Кутько Ігор"},
    {"id": 3, "name": "Звірик Юлія"},
    {"id": 4, "name": "Ніжніковский Тимур"},
    {"id": 9, "name": "Джошкун Джеміль"},
    {"id": 13, "name": "Попов Андрій"},
]
ATT = [  # створене ботом до старту мосту
    {"id": 4, "session_id": [492, "JS"], "tg_user_id": [1, "Кутько Ігор"]},
]
NOTES = [
    {"id": 5, "session_id": [491, "Sales"], "tg_user_id": [1, "Кутько Ігор"], "state": "done"},
    {"id": 6, "session_id": [491, "Sales"], "tg_user_id": [9, "Джошкун Джеміль"], "state": "draft"},
    {"id": 7, "session_id": [466, "Keynote"], "tg_user_id": [4, "Ніжніковский Тимур"], "state": "done"},
]
NEXT = [100]
CALLS = []

def rows(model):
    return {"td.event.session": SESSIONS, "td.event.tg.user": TG,
            "td.event.attendance": ATT, "td.event.note": NOTES}[model]

def match(rec, domain):
    for d in domain:
        f, op, v = d
        val = rec.get(f)
        if op == "!=" and not (val != v): return False
        if op == "=" and not (val == v): return False
    return True

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/state":
            return self._send(200, {"att": ATT, "calls": CALLS})
        self._send(404, {})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); req = json.loads(self.rfile.read(n))
        p = req["params"]; svc, m, a = p["service"], p["method"], p["args"]
        CALLS.append([svc, m, a[3] if svc == "object" else a[1]])
        if svc == "common" and m == "authenticate":
            db, login, key = a[0], a[1], a[2]
            return self._send(200, {"jsonrpc": "2.0", "id": req["id"], "result": 7 if key == "test-key" else False})
        if svc == "object" and m == "execute_kw":
            db, uid, key, model, meth, args = a[0], a[1], a[2], a[3], a[4], a[5]
            kw = a[6] if len(a) > 6 else {}
            if key != "test-key" or uid != 7:
                return self._send(200, {"jsonrpc": "2.0", "id": req["id"], "error": {"message": "Odoo Server Error", "data": {"message": "Access Denied"}}})
            if meth == "search_read":
                dom = args[0] if args else []
                out = [{k: r.get(k) for k in (["id"] + kw.get("fields", [])) } for r in rows(model) if match(r, dom)]
                return self._send(200, {"jsonrpc": "2.0", "id": req["id"], "result": out})
            if meth == "create" and model == "td.event.attendance":
                v = args[0]; NEXT[0] += 1
                ATT.append({"id": NEXT[0], "session_id": [v["session_id"], "s"], "tg_user_id": [v["tg_user_id"], "u"], "date_confirmed": v.get("date_confirmed")})
                return self._send(200, {"jsonrpc": "2.0", "id": req["id"], "result": NEXT[0]})
            if meth == "unlink" and model == "td.event.attendance":
                ids = set(args[0]); ATT[:] = [r for r in ATT if r["id"] not in ids]
                return self._send(200, {"jsonrpc": "2.0", "id": req["id"], "result": True})
        self._send(200, {"jsonrpc": "2.0", "id": req["id"], "error": {"message": "unsupported", "data": {"message": "unsupported " + m}}})

HTTPServer(("127.0.0.1", PORT), H).serve_forever()
