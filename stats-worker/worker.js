// Rooted In Liberty stats collector (Cloudflare Worker)
// Logs page visits, signups and downloads to the D1 database "ril-stats"
// (binding name: DB). Geo comes from Cloudflare; no IP address or cookie is stored.
//
//   POST /e            body: {"type":"visit|signup|download","source":"...","page":"...","referrer":"..."}
//   GET  /dl?src=email logs a download, then sends the reader to the PDF

const SITE = "https://rootedinliberty.com";
const PDF = SITE + "/downloads/25-Lessons-From-George-Washington.pdf";
const ALLOWED_ORIGINS = [SITE, "https://www.rootedinliberty.com"];
const TYPES = new Set(["visit", "signup", "download"]);
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|lighthouse|monitor/i;

function device(ua) {
  if (/ipad|tablet|kindle|silk/i.test(ua)) return "tablet";
  if (/mobi|iphone|android/i.test(ua)) return "mobile";
  return "desktop";
}

function clip(v, n) { return v ? String(v).slice(0, n) : null; }

async function log(env, request, type, source, page, referrer) {
  const ua = request.headers.get("user-agent") || "";
  if (BOT.test(ua)) return;
  const cf = request.cf || {};
  await env.DB.prepare(
    "INSERT INTO events (type, source, page, country, region, city, referrer, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(type, clip(source, 40), clip(page, 120), cf.country || null, cf.region || null, cf.city || null,
         clip(referrer, 200), device(ua)).run();
}

function cors(request) {
  const origin = request.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : SITE,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/dl") {
      ctx.waitUntil(log(env, request, "download", url.searchParams.get("src") || "link", "/dl",
                        request.headers.get("referer")).catch(() => {}));
      return Response.redirect(PDF, 302);
    }

    if (url.pathname === "/e") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      const origin = request.headers.get("origin");
      if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("forbidden", { status: 403 });
      let body = {};
      try { body = JSON.parse(await request.text()); } catch (e) {}
      if (!TYPES.has(body.type)) return new Response("bad type", { status: 400, headers: cors(request) });
      ctx.waitUntil(log(env, request, body.type, body.source, body.page, body.referrer).catch(() => {}));
      return new Response(null, { status: 204, headers: cors(request) });
    }

    return new Response("Rooted In Liberty stats", { status: 200 });
  },
};
