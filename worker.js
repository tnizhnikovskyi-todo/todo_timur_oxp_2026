// Воркер сторінки: статика зі dist/ плюс два маленькі API для вкладки «Подія» —
// спільний запис «хто на які доповіді йде» і міст до Event Hub в Odoo.
//
// Стан лежить у Durable Object із SQLite-сховищем: один об’єкт на всю поїздку,
// без окремих ресурсів, які треба створювати руками — деплой сам робить
// міграцію з wrangler.toml. Дані маленькі: чотирнадцять людей × список slug-ів.
//
// Автентифікації немає свідомо: сторінка й так публічна за посиланням, а тут
// нічого, крім прізвищ і назв доповідей. Хто саме пише — вибирається на
// сторінці й перевіряється лише за списком учасників.
//
// Міст до Odoo (модуль td_event_hub, бот @TDEventHub_bot) вмикається, коли в
// налаштуваннях воркера є ODOO_URL, ODOO_DB, ODOO_LOGIN і ODOO_API_KEY. Тоді
// раз на кілька хвилин і через кілька секунд після кожної позначки:
//   • позначки «Йду» з бота (td.event.attendance) підтягуються на сайт;
//   • позначки з сайту створюються в Odoo, зняті на сайті — знімаються в Odoo;
//   • по кожній доповіді береться кількість нотаток і хто їх писав.
// Наружу йдуть лише лічильники та прізвища — тексти нотаток лишаються в Odoo.

const WHO = {
  bardakov: "Бардаков Олексій",
  nizhnikovskyi: "Ніжніковський Тимур",
  pryvolnieva: "Привольнєва Марія",
  kovryzhnykh: "Коврижних Сергій",
  popov: "Попов Андрій",
  zadorozhna: "Задорожна Катерина",
  adamenko: "Адаменко Олесь",
  dzhoshkun: "Джошкун Олександр-Джеміль",
  kutko: "Кутько Ігор",
  zvirik: "Звірік Юлія",
  lavrenko: "Лавренко Владислав",
  horai: "Горай Альона",
  mazurenko: "Мазуренко Ігор",
  prokopenko: "Прокопенко Людмила",
};

// Slug доповіді на сайті Odoo: латиниця, цифри, дефіси; найдовший у програмі — 291 знак.
// Той самий рядок лежить у td.event.session.external_ref — по нього і зшиваємось.
const SLUG = /^[a-z0-9][a-z0-9-]{0,400}$/;
const MAX_PER_PERSON = 300;
const MAX_BODY = 64 * 1024;

// Через скільки після позначки штовхати її в Odoo; і як часто тягнути звідти,
// коли ніхто нічого не натискає (крон у wrangler.toml).
const PUSH_DELAY_MS = 8000;
const STALE_MS = 3 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status) {
  const h = new Headers(CORS);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  return new Response(JSON.stringify(body), { status: status || 200, headers: h });
}

// Прізвище без орфографічних розбіжностей: у боті «Звірик» і «Ніжніковский»,
// у нас — «Звірік» і «Ніжніковський». Порівнюємо перше слово, і/і/ї/й → и, без ь.
function surnameKey(name) {
  const w = String(name || "").trim().split(/\s+/)[0] || "";
  return w.toLowerCase().replace(/[іїй]/g, "и").replace(/ь/g, "");
}
function surname(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

function bridgeEnabled(env) {
  return !!(env && env.ODOO_URL && env.ODOO_DB && env.ODOO_LOGIN && env.ODOO_API_KEY);
}

// ---- Odoo JSON-RPC ----------------------------------------------------------

async function rpc(env, service, method, args) {
  const r = await fetch(String(env.ODOO_URL).replace(/\/+$/, "") + "/jsonrpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params: { service, method, args } }),
  });
  if (!r.ok) throw new Error("odoo http " + r.status);
  const j = await r.json();
  if (j.error) {
    const d = j.error.data || {};
    throw new Error("odoo: " + (d.message || j.error.message || "error").split("\n")[0].slice(0, 200));
  }
  return j.result;
}

class Odoo {
  constructor(env, uid) { this.env = env; this.uid = uid; }
  static async login(env) {
    const uid = await rpc(env, "common", "authenticate", [env.ODOO_DB, env.ODOO_LOGIN, env.ODOO_API_KEY, {}]);
    if (!uid) throw new Error("odoo: authenticate failed");
    return new Odoo(env, uid);
  }
  call(model, method, args, kwargs) {
    return rpc(this.env, "object", "execute_kw", [this.env.ODOO_DB, this.uid, this.env.ODOO_API_KEY, model, method, args, kwargs || {}]);
  }
  searchRead(model, domain, fields, limit) {
    return this.call(model, "search_read", [domain], { fields, limit: limit || 5000 });
  }
}

// ---- Durable Object ---------------------------------------------------------

export class Picks {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async read() {
    return (await this.state.storage.get("picks")) || { updated: null, people: {} };
  }

  async bridgeState() {
    const st = (await this.state.storage.get("bridge.status")) || {};
    return {
      enabled: bridgeEnabled(this.env),
      at: st.at || null,
      ok: st.ok === undefined ? null : st.ok,
      error: st.error || null,
      stats: st.stats || null,
    };
  }

  async schedulePush() {
    if (!bridgeEnabled(this.env)) return;
    const cur = await this.state.storage.getAlarm();
    if (cur === null || cur === undefined) {
      await this.state.storage.setAlarm(Date.now() + PUSH_DELAY_MS);
    }
  }

  async alarm() {
    await this.sync();
  }

  // Повний обмін з Odoo. Виконується під блокуванням, щоб POST /api/picks не
  // вклинився між читанням і записом стану.
  async sync() {
    if (!bridgeEnabled(this.env)) return { enabled: false };
    const stats = { imported: 0, created: 0, removed: 0, droppedFromSite: 0, notes: 0 };
    try {
      await this.state.blockConcurrencyWhile(async () => {
        const env = this.env;
        let odoo;
        const cachedUid = await this.state.storage.get("odoo.uid");
        if (cachedUid) {
          odoo = new Odoo(env, cachedUid);
        } else {
          odoo = await Odoo.login(env);
          await this.state.storage.put("odoo.uid", odoo.uid);
        }

        let sessions;
        try {
          sessions = await odoo.searchRead("td.event.session", [["external_ref", "!=", false]], ["id", "external_ref", "note_count"]);
        } catch (e) {
          // Протух uid або змінили ключ — один раз перелогінюємось.
          await this.state.storage.delete("odoo.uid");
          odoo = await Odoo.login(env);
          await this.state.storage.put("odoo.uid", odoo.uid);
          sessions = await odoo.searchRead("td.event.session", [["external_ref", "!=", false]], ["id", "external_ref", "note_count"]);
        }
        const byRef = {}, byId = {};
        for (const s of sessions) {
          if (typeof s.external_ref === "string" && SLUG.test(s.external_ref)) {
            byRef[s.external_ref] = s.id;
            byId[s.id] = s.external_ref;
          }
        }

        // Люди бота ↔ ключі сайту, за прізвищем.
        const tgUsers = await odoo.searchRead("td.event.tg.user", [], ["id", "name"]);
        const whoByKey = {};
        for (const k of Object.keys(WHO)) whoByKey[surnameKey(WHO[k])] = k;
        const tgToWho = {}, whoToTg = {}, tgName = {};
        for (const u of tgUsers) {
          tgName[u.id] = u.name;
          const k = whoByKey[surnameKey(u.name)];
          if (k && !whoToTg[k]) { whoToTg[k] = u.id; tgToWho[u.id] = k; }
        }

        // Що є в Odoo зараз.
        const att = await odoo.searchRead("td.event.attendance", [], ["id", "session_id", "tg_user_id"]);
        const inOdoo = {}; // who -> slug -> attendance id
        for (const a of att) {
          const who = tgToWho[a.tg_user_id && a.tg_user_id[0]];
          const slug = byId[a.session_id && a.session_id[0]];
          if (!who || !slug) continue;
          (inOdoo[who] = inOdoo[who] || {})[slug] = a.id;
        }

        const picks = await this.read();
        const known = (await this.state.storage.get("bridge.known")) || {}; // "who|slug" -> attendance id
        let picksChanged = false;
        const has = (who, slug) => Array.isArray(picks.people[who]) && picks.people[who].indexOf(slug) >= 0;
        const add = (who, slug) => {
          const list = Array.isArray(picks.people[who]) ? picks.people[who] : (picks.people[who] = []);
          if (list.indexOf(slug) < 0 && list.length < MAX_PER_PERSON) { list.push(slug); picksChanged = true; }
        };
        const drop = (who, slug) => {
          const list = picks.people[who];
          if (!Array.isArray(list)) return;
          const i = list.indexOf(slug);
          if (i >= 0) { list.splice(i, 1); picksChanged = true; }
        };

        // 1. Нове з бота → на сайт.
        for (const who of Object.keys(inOdoo)) {
          for (const slug of Object.keys(inOdoo[who])) {
            const key = who + "|" + slug;
            if (!known[key]) {
              known[key] = inOdoo[who][slug];
              if (!has(who, slug)) { add(who, slug); stats.imported++; }
            }
          }
        }

        // 2. Сайт → Odoo: створити те, чого там нема; а те, що знали й що
        //    зникло в Odoo (зняли в боті) — зняти й на сайті.
        for (const who of Object.keys(picks.people)) {
          const tg = whoToTg[who];
          if (!tg) continue;
          for (const slug of (picks.people[who] || []).slice()) {
            const sid = byRef[slug];
            if (!sid) continue;
            const key = who + "|" + slug;
            if (inOdoo[who] && inOdoo[who][slug]) continue;
            if (known[key]) {
              delete known[key];
              drop(who, slug); stats.droppedFromSite++;
              continue;
            }
            const id = await odoo.call("td.event.attendance", "create", [{
              session_id: sid,
              tg_user_id: tg,
              date_confirmed: new Date().toISOString().slice(0, 19).replace("T", " "),
            }]);
            known[key] = id;
            stats.created++;
          }
        }

        // 3. Зняте на сайті → зняти в Odoo (лише те, що ми вже бачили).
        for (const who of Object.keys(inOdoo)) {
          for (const slug of Object.keys(inOdoo[who])) {
            const key = who + "|" + slug;
            if (known[key] && !has(who, slug)) {
              await odoo.call("td.event.attendance", "unlink", [[inOdoo[who][slug]]]);
              delete known[key];
              stats.removed++;
            }
          }
        }

        // 4. Нотатки: скільки і хто, без текстів.
        const notesRaw = await odoo.searchRead("td.event.note", [], ["id", "session_id", "tg_user_id", "state"]);
        const notes = {};
        for (const n of notesRaw) {
          const slug = byId[n.session_id && n.session_id[0]];
          if (!slug) continue;
          const who = tgToWho[n.tg_user_id && n.tg_user_id[0]];
          const name = who ? surname(WHO[who]) : surname(tgName[n.tg_user_id && n.tg_user_id[0]] || (n.tg_user_id && n.tg_user_id[1]) || "");
          const e = (notes[slug] = notes[slug] || { n: 0, done: 0, by: [] });
          e.n++;
          if (n.state === "done") e.done++;
          if (name && e.by.indexOf(name) < 0) e.by.push(name);
          stats.notes++;
        }

        if (picksChanged) {
          picks.updated = new Date().toISOString();
          await this.state.storage.put("picks", picks);
        }
        await this.state.storage.put("bridge.known", known);
        await this.state.storage.put("bridge.notes", { updated: new Date().toISOString(), notes });
        await this.state.storage.put("bridge.status", { at: new Date().toISOString(), ok: true, error: null, stats });
      });
      return { enabled: true, ok: true, stats };
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 300);
      await this.state.storage.put("bridge.status", { at: new Date().toISOString(), ok: false, error: msg, stats });
      return { enabled: true, ok: false, error: msg };
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/sync") {
      // Внутрішній виклик із крону; назовні воркер цей шлях не віддає.
      return json(await this.sync());
    }

    if (url.pathname === "/api/notes") {
      const bridge = await this.bridgeState();
      if (!bridge.enabled) {
        // Воркер без доступу до Odoo: обмін робить щогодинна рутина і кладе
        // підсумок у static/notes.json — віддаємо його з тими ж заголовками.
        try {
          const r = await this.env.ASSETS.fetch(new Request(new URL("/notes.json", url).toString()));
          if (r.ok) return json(await r.json());
        } catch (e) {}
        return json({ updated: null, notes: {}, bridge });
      }
      const cached = (await this.state.storage.get("bridge.notes")) || { updated: null, notes: {} };
      // Давно не тягнули — підштовхнемо у фоні, відповідь віддаємо з кешу.
      if (bridge.enabled && (!bridge.at || Date.now() - Date.parse(bridge.at) > STALE_MS)) {
        await this.schedulePush();
      }
      return json({ updated: cached.updated, notes: cached.notes, bridge });
    }

    if (request.method === "GET") {
      return json(await this.read());
    }
    if (request.method !== "POST") {
      return json({ error: "method" }, 405);
    }
    const len = Number(request.headers.get("content-length") || 0);
    if (len > MAX_BODY) return json({ error: "too large" }, 413);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    if (!body || typeof body !== "object") return json({ error: "bad json" }, 400);

    const who = String(body.who || "");
    if (!WHO[who]) return json({ error: "unknown who" }, 400);

    const data = await this.read();
    let list = Array.isArray(data.people[who]) ? data.people[who].slice() : [];

    if (Array.isArray(body.slugs)) {
      // Повна заміна списку — так переносяться позначки, зроблені до вибору себе.
      const seen = {};
      list = [];
      for (const s of body.slugs) {
        if (typeof s === "string" && SLUG.test(s) && !seen[s]) { seen[s] = 1; list.push(s); }
      }
    } else if (typeof body.slug === "string" && SLUG.test(body.slug)) {
      const idx = list.indexOf(body.slug);
      if (body.going && idx < 0) list.push(body.slug);
      if (!body.going && idx >= 0) list.splice(idx, 1);
    } else {
      return json({ error: "bad slug" }, 400);
    }

    data.people[who] = list.slice(0, MAX_PER_PERSON);
    data.updated = new Date().toISOString();
    await this.state.storage.put("picks", data);
    await this.schedulePush();
    return json(data);
  }
}

function stub(env) {
  return env.PICKS.get(env.PICKS.idFromName("oxp-2026"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/picks" || url.pathname === "/api/notes") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (url.pathname === "/api/notes" && request.method !== "GET") {
        return json({ error: "method" }, 405);
      }
      return stub(env).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },

  // Крон із wrangler.toml: періодичний обмін з Odoo, навіть коли на сайті тихо.
  async scheduled(event, env, ctx) {
    if (!bridgeEnabled(env)) return;
    ctx.waitUntil(stub(env).fetch("https://picks/sync", { method: "POST" }));
  },
};
