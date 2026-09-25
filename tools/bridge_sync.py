#!/usr/bin/env python3
"""Міст сайт ↔ Event Hub, коли воркер без доступу до Odoo: обмін робить
щогодинна рутина через MCP-коннектор, а цей скрипт рахує різницю.

Вхід (файли JSON):
  site.json        — GET /api/picks
  odoo_att.json    — [[att_id, session_id, external_ref, tg_name], ...]
                     (td.event.attendance через web_search_read)
  odoo_notes.json  — [[external_ref, tg_name, state], ...]
  sessions.json    — [[session_id, external_ref], ...] (лише для slug-ів, яких
                     бракує; зі списку need_sessions попереднього plan)
Стан:  state/bridge.json  — {"known": {"who|slug": att_id}, ...}
Вихід: plan → plan.json (що створити/зняти в Odoo, що дописати на сайт,
       вміст notes.json); apply → static/notes.json, state, POST на сайт.

  python3 tools/bridge_sync.py plan  <dir>
  python3 tools/bridge_sync.py apply <dir> [--created id,id,...] [--unlinked] [--no-post]

`apply --created` приймає ids, які повернув create в Odoo, у порядку plan.create.
Зняття в Odoo (unlink) у plan лише перелічуються — виконуються окремо і тільки
після явної згоди; `--unlinked` каже, що їх виконали.
"""
import json, os, re, sys, urllib.request, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://todo-timur-oxp-2026.t-nizhnikovskyi.workers.dev/api/picks"
WHO = {
    "bardakov": "Бардаков Олексій", "nizhnikovskyi": "Ніжніковський Тимур",
    "pryvolnieva": "Привольнєва Марія", "kovryzhnykh": "Коврижних Сергій",
    "popov": "Попов Андрій", "zadorozhna": "Задорожна Катерина",
    "adamenko": "Адаменко Олесь", "dzhoshkun": "Джошкун Олександр-Джеміль",
    "kutko": "Кутько Ігор", "zvirik": "Звірік Юлія", "lavrenko": "Лавренко Владислав",
    "horai": "Горай Альона", "mazurenko": "Мазуренко Ігор", "prokopenko": "Прокопенко Людмила",
}
# td.event.tg.user.id у нашій Odoo; Прокопенко в боті немає.
TG = {"adamenko": 10, "bardakov": 11, "horai": 7, "dzhoshkun": 9, "zadorozhna": 2, "zvirik": 3,
      "kovryzhnykh": 6, "kutko": 1, "lavrenko": 8, "mazurenko": 12, "nizhnikovskyi": 4, "popov": 13,
      "pryvolnieva": 5}
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,400}$")

def skey(name):
    w = (name or "").strip().split()
    w = w[0] if w else ""
    return re.sub("ь", "", re.sub("[іїй]", "и", w.lower()))

BYKEY = {skey(v): k for k, v in WHO.items()}
def who_of(name): return BYKEY.get(skey(name))
def surname(who): return WHO[who].split()[0]

def load(d, name, default):
    p = os.path.join(d, name)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else default

def now(): return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def plan(d):
    site = load(d, "site.json", {"people": {}})
    att = load(d, "odoo_att.json", [])
    notes_raw = load(d, "odoo_notes.json", [])
    # Кеш «slug → id сесії» живе в репозиторії й поповнюється; sessions.json у
    # робочій папці — свіжі відповіді Odoo на need_sessions попереднього плану.
    sessions = load(ROOT, "state/sessions.json", {})
    for sid, ref in load(d, "sessions.json", []): sessions[ref] = sid
    state = load(ROOT, "state/bridge.json", {"known": {}})
    known = state["known"]
    people = {k: list(v) for k, v in site["people"].items()}

    in_odoo = {}
    for att_id, sid, ref, name in att:
        who = who_of(name)
        if not who or not SLUG.match(ref or ""): continue
        in_odoo.setdefault(who, {})[ref] = att_id
        sessions.setdefault(ref, sid)

    imports = {}   # who -> [slug] додати на сайт
    creates, need, unlinks, drops = [], [], [], []
    # 1. з бота, чого сайт ще не бачив → на сайт
    for who, m in in_odoo.items():
        for slug, att_id in m.items():
            key = who + "|" + slug
            if key not in known:
                known[key] = att_id
                if slug not in people.get(who, []):
                    people.setdefault(who, []).append(slug); imports.setdefault(who, []).append(slug)
    # 2. сайт → Odoo
    for who, slugs in people.items():
        if who not in TG: continue
        for slug in list(slugs):
            key = who + "|" + slug
            if who in in_odoo and slug in in_odoo[who]: continue
            if key in known:          # знали, а в Odoo зникло — зняли в боті
                drops.append([who, slug]); del known[key]; people[who].remove(slug); continue
            if slug in sessions:
                creates.append({"who": who, "slug": slug, "tg_user_id": TG[who], "session_id": sessions[slug]})
            else:
                need.append(slug)
    # 3. зняте на сайті → зняти в Odoo (лише відоме)
    for who, m in in_odoo.items():
        for slug, att_id in m.items():
            key = who + "|" + slug
            if key in known and slug not in people.get(who, []):
                unlinks.append({"who": who, "slug": slug, "id": att_id})
    # 4. нотатки
    notes = {}
    for ref, name, st in notes_raw:
        if not SLUG.match(ref or ""): continue
        who = who_of(name)
        e = notes.setdefault(ref, {"n": 0, "done": 0, "by": []})
        e["n"] += 1
        if st == "done": e["done"] += 1
        nm = surname(who) if who else (name or "").split()[0]
        if nm and nm not in e["by"]: e["by"].append(nm)

    json.dump(sessions, open(os.path.join(ROOT, "state/sessions.json"), "w", encoding="utf-8"), ensure_ascii=False)
    out = {"creates": creates, "need_sessions": sorted(set(need)), "unlinks": unlinks,
           "drops_from_site": drops, "imports": imports, "people": people, "known": known, "notes": notes}
    json.dump(out, open(os.path.join(d, "plan.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items() if k in ("creates", "need_sessions", "unlinks", "drops_from_site", "imports", "notes")}, ensure_ascii=False))
    if creates:
        print("CREATE vals:", json.dumps([{"session_id": c["session_id"], "tg_user_id": c["tg_user_id"], "date_confirmed": now()[:19].replace("T", " ")} for c in creates], ensure_ascii=False))
    if need: print("NEED sessions for:", sorted(set(need)))
    if unlinks: print("UNLINK ids (потрібна згода):", [u["id"] for u in unlinks])

def apply(d, created, unlinked, no_post=False):
    p = load(d, "plan.json", None)
    if p is None: sys.exit("нема plan.json")
    known = p["known"]
    if created:
        if len(created) != len(p["creates"]): sys.exit("кількість created ≠ creates")
        for c, cid in zip(p["creates"], created): known[c["who"] + "|" + c["slug"]] = cid
    if unlinked:
        for u in p["unlinks"]: known.pop(u["who"] + "|" + u["slug"], None)
    stats = {"imported": sum(len(v) for v in p["imports"].values()), "created": len(created),
             "removed": len(p["unlinks"]) if unlinked else 0, "droppedFromSite": len(p["drops_from_site"]),
             "notes": sum(v["n"] for v in p["notes"].values())}
    # На сайт — по одній позначці, а не повним списком: так не затираємо те,
    # що хтось відмітив на сайті між знімком і записом. Стан пишемо ПІСЛЯ
    # запису: позначка з бота, яка не дійшла до сайту, не повинна потрапити в
    # known — інакше наступний план вирішить, що її зняли на сайті, і
    # запропонує зняти її в Odoo.
    def toggle(who, slug, going):
        body = json.dumps({"who": who, "slug": slug, "going": going}).encode()
        req = urllib.request.Request(SITE, body, {"Content-Type": "application/json",
                                                  "User-Agent": "oxp-bridge-sync/1 (+tools/bridge_sync.py)"}, method="POST")
        with urllib.request.urlopen(req, timeout=20) as r: r.read()
    pending = {}
    if no_post:
        pending = {w: list(v) for w, v in p["imports"].items()}
    else:
        for who, slugs in sorted(p["imports"].items()):
            for slug in slugs:
                try:
                    toggle(who, slug, True)
                except Exception as e:
                    pending.setdefault(who, []).append(slug)
                    print("site FAIL", who, slug, e)
            print("site +", who, len(slugs) - len(pending.get(who, [])), "of", len(slugs))
        for who, slug in p["drops_from_site"]:
            toggle(who, slug, False)
            print("site -", who, slug)
    for who, slugs in pending.items():
        for slug in slugs: known.pop(who + "|" + slug, None)
    if pending:
        stats["pendingImports"] = sum(len(v) for v in pending.values())
        stats["imported"] -= stats["pendingImports"]
    ts = now()
    json.dump({"updated": ts, "notes": p["notes"],
               "bridge": {"enabled": True, "via": "routine", "at": ts, "ok": not pending or no_post, "error": None, "stats": stats}},
              open(os.path.join(ROOT, "static/notes.json"), "w", encoding="utf-8"), ensure_ascii=False)
    json.dump({"known": known, "last": ts, "stats": stats}, open(os.path.join(ROOT, "state/bridge.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("applied:", stats)

if __name__ == "__main__":
    if len(sys.argv) < 3: sys.exit(__doc__)
    cmd, d = sys.argv[1], sys.argv[2]
    if cmd == "plan": plan(d)
    elif cmd == "apply":
        created = []; unlinked = False
        a = sys.argv[3:]
        if "--created" in a: created = [int(x) for x in a[a.index("--created") + 1].split(",") if x]
        if "--unlinked" in a: unlinked = True
        apply(d, created, unlinked, no_post="--no-post" in a)
    else: sys.exit(__doc__)
