// Воркер сторінки: статика зі dist/ плюс один маленький API — спільний запис
// «хто на які доповіді йде» для вкладки «Подія».
//
// Стан лежить у Durable Object із SQLite-сховищем: один об’єкт на всю поїздку,
// без окремих ресурсів, які треба створювати руками — деплой сам робить
// міграцію з wrangler.toml. Дані маленькі: чотирнадцять людей × список slug-ів.
//
// Автентифікації немає свідомо: сторінка й так публічна за посиланням, а тут
// нічого, крім прізвищ і назв доповідей. Хто саме пише — вибирається на
// сторінці й перевіряється лише за списком учасників.

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
const SLUG = /^[a-z0-9][a-z0-9-]{0,400}$/;
const MAX_PER_PERSON = 300;
const MAX_BODY = 64 * 1024;

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

export class Picks {
  constructor(state) {
    this.state = state;
  }

  async read() {
    return (await this.state.storage.get("picks")) || { updated: null, people: {} };
  }

  async fetch(request) {
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
    return json(data);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/picks") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }
      const id = env.PICKS.idFromName("oxp-2026");
      return env.PICKS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
