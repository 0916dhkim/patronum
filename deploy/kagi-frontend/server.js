"use strict";

// Private token-gated Kagi search frontend.
// Zero-dependency Node.js server: http, https, url, crypto only.
// Follows the plan at /var/lib/patronum/projects/kagi-frontend-plan.md exactly.

const http = require("http");
const https = require("https");
const crypto = require("crypto");

// ---- Config (env only; nothing secret is written into this file) ----
const PORT = process.env.PORT || "3000";
const KAGI_API_KEY = (process.env.KAGI_API_KEY || "").trim();
const FRONTEND_TOKEN = (process.env.FRONTEND_TOKEN || "").trim();

if (!KAGI_API_KEY) {
  console.error("KAGI_API_KEY environment variable is missing or empty");
  process.exit(1);
}
if (!FRONTEND_TOKEN) {
  console.error("FRONTEND_TOKEN environment variable is missing or empty");
  process.exit(1);
}

const COOKIE_NAME = "kagi_auth";
const COOKIE_MAX_AGE = 86400;
const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 8192;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_CONCURRENCY = 4;
const PAGE_SIZE = 10;
const VALID_WORKFLOWS = ["search", "images", "videos", "news", "podcasts"];
const WORKFLOW_DATA = {
  search: "search",
  images: "image",
  videos: "video",
  news: "news",
  podcasts: "podcast",
};

let active = 0;

// ---- Response helpers ----

function safeHeaders(extra) {
  const h = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
  if (extra) {
    for (const k of Object.keys(extra)) h[k] = extra[k];
  }
  return h;
}

function sendPlain(res, status, body, extra) {
  const headers = safeHeaders(Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, extra || {}));
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj, extra) {
  const headers = safeHeaders(Object.assign({ "Content-Type": "application/json; charset=utf-8" }, extra || {}));
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function sendHtml(res, status, html, nonce) {
  const headers = safeHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'nonce-" +
      nonce +
      "'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.writeHead(status, headers);
  res.end(html);
}

function setAuthCookie(extra) {
  const h = Object.assign({}, extra || {});
  h["Set-Cookie"] =
    COOKIE_NAME + "=" + FRONTEND_TOKEN + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" + COOKIE_MAX_AGE;
  return h;
}

// ---- Auth ----
// Constant-time comparison over sha256 hashes (length-safe, no timing oracle).
function tokenMatches(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const a = crypto.createHash("sha256").update(FRONTEND_TOKEN).digest();
  const b = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach(function (part) {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (!name) return;
    try {
      value = decodeURIComponent(value);
    } catch (e) {
      /* keep raw value */
    }
    out[name] = value;
  });
  return out;
}

// ---- Normalization ----

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}

// HTML -> plain text: decode entities (single pass), strip tags, collapse whitespace.
function stripHtml(html) {
  let s = html.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, entity) {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        if (entity.charAt(0) === "#") {
          try {
            const hex = entity.charAt(1).toLowerCase() === "x";
            const code = hex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
          } catch (e) {
            /* fall through */
          }
        }
        return m;
    }
  });
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return truncate(s, 1000);
}

// Whitelist-only mapping; everything else in Kagi's item is discarded.
function normalizeItem(item) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const url = typeof item.url === "string" ? item.url.trim() : "";
  if (!/^https?:\/\//.test(url)) return null;
  const title = truncate(typeof item.title === "string" ? item.title.trim() : "", 300);
  const snippet = typeof item.snippet === "string" ? stripHtml(item.snippet) : "";
  let image = null;
  let width = null;
  let height = null;
  if (item.image && typeof item.image === "object" && typeof item.image.url === "string" && /^https?:\/\//.test(item.image.url)) {
    image = item.image.url;
    if (typeof item.image.width === "number" && Number.isFinite(item.image.width)) width = item.image.width;
    if (typeof item.image.height === "number" && Number.isFinite(item.image.height)) height = item.image.height;
  }
  const published =
    typeof item.published === "string" && item.published.length > 0
      ? item.published
      : typeof item.time === "string" && item.time.length > 0
        ? item.time
        : null;
  const out = { url: url, title: title, snippet: snippet, image: image, published: published };
  if (width !== null) out.width = width;
  if (height !== null) out.height = height;
  return out;
}

// ---- Kagi upstream ----

function proxyToKagi(query, workflow, page, cb) {
  const dataKey = WORKFLOW_DATA[workflow];
  const payload = JSON.stringify({ query: query, workflow: workflow, page: page, limit: PAGE_SIZE, safe_search: false });
  const controller = new AbortController();
  let called = false;
  const timer = setTimeout(function () {
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);

  const callOnce = function (err, result) {
    if (called) return;
    called = true;
    clearTimeout(timer);
    cb(err, result);
  };

  const req = https.request(
    {
      hostname: "kagi.com",
      port: 443,
      path: "/api/v1/search",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + KAGI_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "kagi-frontend/1.0 (private gateway)",
        "Content-Length": Buffer.byteLength(payload),
      },
      signal: controller.signal,
    },
    function (upstream) {
      let size = 0;
      const chunks = [];

      upstream.on("data", function (chunk) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          controller.abort();
          callOnce({ status: 502, message: "Kagi API error" });
          return;
        }
        chunks.push(chunk);
      });

      upstream.on("end", function () {
        const status = upstream.statusCode || 502;
        if (status === 200) {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (e) {
            callOnce({ status: 502, message: "Kagi API error" });
            return;
          }
          if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
            // Log only error type/count, never error text (may echo query fragments).
            console.log("kagi_errors=" + parsed.errors.length);
            callOnce({ status: 502, message: "Kagi API error" });
            return;
          }
          const data = (parsed && parsed.data) || {};
          const items = Array.isArray(data[dataKey]) ? data[dataKey] : [];
          const results = [];
          for (const it of items) {
            const n = normalizeItem(it);
            if (n) results.push(n);
          }
          callOnce(null, {
            ok: true,
            workflow: workflow,
            page: page,
            count: results.length,
            has_next: items.length >= PAGE_SIZE && page < 10,
            has_prev: page > 1,
            results: results,
          });
          return;
        }
        if (status === 401 || status === 403) {
          console.log("kagi_auth_error");
          callOnce({ status: 502, message: "Kagi API authentication error" });
          return;
        }
        if (status === 429) {
          console.log("kagi_http=429");
          callOnce({ status: 502, message: "Kagi API rate limited" });
          return;
        }
        console.log("kagi_http=" + status);
        callOnce({ status: 502, message: "Kagi API error" });
      });

      upstream.on("error", function () {
        callOnce({ status: 502, message: "Kagi API error" });
      });
    }
  );

  req.on("error", function (err) {
    if (err && err.name === "AbortError") {
      console.log("kagi_timeout");
      callOnce({ status: 504, message: "Kagi API timeout" });
      return;
    }
    callOnce({ status: 502, message: "Kagi API error" });
  });

  req.end(payload);
}

// ---- POST /api/search ----

function handleSearch(req, res, via) {
  const chunks = [];
  let size = 0;
  let done = false;

  const finish = function (status, obj, extra) {
    if (done) return;
    done = true;
    const headers = via === "query" ? setAuthCookie(extra) : Object.assign({}, extra || {});
    sendJson(res, status, obj, headers);
  };

  req.on("data", function (chunk) {
    if (done) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      finish(413, { ok: false, error: "Request body too large" });
      req.resume(); // drain remaining body; destroying the socket here could truncate the 413 on slow clients
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", function () {
    if (done) return;
    let parsed = null;
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      finish(400, { ok: false, error: "Invalid JSON body" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      finish(400, { ok: false, error: "Invalid JSON body" });
      return;
    }
    const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    if (query.length < 1 || query.length > 256) {
      finish(400, { ok: false, error: "query must be a 1-256 character string" });
      return;
    }
    let workflow = parsed.workflow;
    if (workflow === undefined || workflow === null) workflow = "search";
    if (typeof workflow !== "string" || VALID_WORKFLOWS.indexOf(workflow) === -1) {
      finish(400, { ok: false, error: "invalid workflow" });
      return;
    }
    let page = 1;
    if (parsed.page !== undefined && parsed.page !== null) {
      if (!Number.isInteger(parsed.page) || parsed.page < 1 || parsed.page > 10) {
        finish(400, { ok: false, error: "page must be an integer between 1 and 10" });
        return;
      }
      page = parsed.page;
    }
    if (active >= MAX_CONCURRENCY) {
      finish(429, { ok: false, error: "Too many concurrent requests, try again shortly" }, { "Retry-After": "5" });
      return;
    }
    active++;
    proxyToKagi(query, workflow, page, function (err, result) {
      active--;
      if (err) {
        finish(err.status, { ok: false, error: err.message });
        return;
      }
      finish(200, result);
    });
  });

  req.on("error", function () {
    if (done) return;
    done = true;
    sendJson(res, 400, { ok: false, error: "Invalid request" });
  });
}

// ---- Server ----

const server = http.createServer(function (req, res) {
  const start = Date.now();
  let pathname = "/";
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch (e) {
    /* keep "/" */
  }
  // Logging policy: METHOD pathname status duration_ms. Pathname only — never the query string.
  res.on("finish", function () {
    console.log(req.method + " " + pathname + " " + res.statusCode + " " + (Date.now() - start));
  });

  if (pathname === "/health") {
    if (req.method !== "GET") {
      sendPlain(res, 405, "Method Not Allowed");
      return;
    }
    sendPlain(res, 200, "OK");
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, "http://localhost");
  } catch (e) {
    sendPlain(res, 400, "Bad Request");
    return;
  }

  // Auth: cookie first, then ?token= query fallback.
  let via = "none";
  const cookies = parseCookies(req.headers.cookie || "");
  if (tokenMatches(cookies[COOKIE_NAME])) {
    via = "cookie";
  } else {
    const tok = parsedUrl.searchParams.get("token");
    if (tokenMatches(tok)) via = "query";
  }
  if (via === "none") {
    sendPlain(res, 403, "Forbidden");
    return;
  }

  if (pathname === "/api/search") {
    if (req.method !== "POST") {
      sendPlain(res, 405, "Method Not Allowed");
      return;
    }
    handleSearch(req, res, via);
    return;
  }

  if (req.method !== "GET") {
    sendPlain(res, 405, "Method Not Allowed");
    return;
  }

  // Token-in-URL linger hardening: a valid ?token= on ANY GET is 302-stripped
  // (token removed from the query string, other params preserved, cookie set) —
  // even when a cookie already matches — so the token never lingers in the
  // address bar or history. GET /?token=... still resolves to a clean "/", per
  // the plan. The 302 carries the full safeHeaders set: it is cacheable by
  // default and is the exact response bearing the token URL + Set-Cookie.
  const queryTok = parsedUrl.searchParams.get("token");
  if (queryTok !== null && tokenMatches(queryTok)) {
    parsedUrl.searchParams.delete("token");
    const clean = parsedUrl.pathname + parsedUrl.search;
    const headers = safeHeaders(
      setAuthCookie({ Location: clean, "Content-Type": "text/plain; charset=utf-8" })
    );
    res.writeHead(302, headers);
    res.end("");
    return;
  }

  if (pathname === "/") {
    const nonce = crypto.randomBytes(16).toString("base64");
    const html = HTML_TEMPLATE.split("__NONCE__").join(nonce);
    sendHtml(res, 200, html, nonce);
    return;
  }

  sendPlain(res, 404, "Not Found");
});

server.on("error", function (err) {
  console.error("Server error: " + err.message);
  process.exit(1);
});

server.listen(Number(PORT), function () {
  console.log("kagi-frontend listening on port " + PORT);
  console.log("FRONTEND_TOKEN " + FRONTEND_TOKEN.slice(0, 4) + "...");
  console.log("KAGI_API_KEY length " + KAGI_API_KEY.length);
});

// ============================================================================
// Embedded HTML/CSS/JS frontend — single-page "Launcher" with two visual states
// (body.start centered prompt / body.results sticky bar + results list) toggled
// by a class on <body>. Mobile-first, system dark mode, XSS-safe.
// Placeholder __NONCE__ is replaced per-response with a fresh CSP nonce.
// NOTE: this template literal must never contain a backtick or "${".
// ============================================================================

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kagi</title>
<link rel="icon" href="data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230d0e11'/%3E%3Ctext x='16' y='22' font-family='Arial' font-size='18' font-weight='bold' text-anchor='middle' fill='%233ddc84'%3EK%3C/text%3E%3C/svg%3E">
<style>
  :root {
    color-scheme: light dark;
    --bg: #0d0e11;
    --text: #d7dadd;
    --muted: #717980;
    --border: #262a31;
    --accent: #3ddc84;
    --surface: #13151a;
    --link: #6fc3df;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f4f0;
      --text: #1d1f1e;
      --muted: #858b86;
      --border: #d8dcd4;
      --accent: #1a7f37;
      --surface: #ffffff;
      --link: #0b5c7a;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--mono);
    line-height: 1.55;
    min-height: 100vh;
    -webkit-text-size-adjust: 100%;
  }
  a { color: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ---- Start state: centered prompt ---- */
  body.start {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 20px;
  }
  body.start .topbar {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
  }
  body.start .brand-start {
    display: block;
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 2px;
    margin-bottom: 26px;
  }
  body.start .brand-results { display: none; }
  body.start .prompt {
    display: flex;
    align-items: center;
    width: min(640px, 88vw);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.28);
  }
  body.start .prompt:focus-within { border-color: var(--accent); }
  body.start .prompt .chev { color: var(--accent); font-weight: 700; padding: 0 0 0 16px; font-size: 16px; }
  body.start .prompt input {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 15px;
    padding: 16px 14px;
    border: none;
    background: transparent;
    color: var(--text);
    outline: none;
    caret-color: var(--accent);
  }
  body.start .prompt input::placeholder { color: var(--muted); }
  body.start .prompt .go { color: var(--muted); font-size: 14px; padding: 0 16px 0 0; white-space: nowrap; }
  body.start .hints { margin-top: 20px; display: flex; gap: 20px; font-size: 11px; color: var(--muted); }
  body.start .hints b { color: var(--accent); font-weight: 700; }
  body.start .wrap { display: none; }

  /* ---- Results state: sticky top bar + results list ---- */
  body.results .topbar {
    position: sticky;
    top: 0;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 14px 20px;
    display: flex;
    align-items: center;
    gap: 14px;
    z-index: 10;
  }
  body.results .brand-start { display: none; }
  body.results .brand-results {
    display: block;
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 1.5px;
    white-space: nowrap;
  }
  body.results .prompt {
    flex: 1;
    display: flex;
    align-items: center;
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  body.results .prompt:focus-within { border-color: var(--accent); }
  body.results .prompt .chev { color: var(--accent); font-weight: 700; padding: 0 0 0 12px; }
  body.results .prompt input {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 14px;
    padding: 10px 12px;
    border: none;
    background: transparent;
    color: var(--text);
    outline: none;
    caret-color: var(--accent);
  }
  body.results .prompt .go { color: var(--muted); font-size: 13px; padding: 0 12px 0 0; }
  body.results .hints { display: none; }
  body.results .wrap { display: block; max-width: 760px; margin: 0 auto; padding: 0 20px 80px; }
  #status { color: var(--muted); font-size: 12px; min-height: 1.2em; }
  body.start #status { text-align: center; margin-top: 18px; width: min(640px, 88vw); }
  body.results #status { max-width: 760px; margin: 18px auto 14px; padding: 0 20px; }
  #status .ok { color: var(--accent); }

  /* ---- Category tabs ---- */
  .cats { display: none; }
  body.results .cats {
    display: flex;
    flex-wrap: wrap;
    max-width: 760px;
    margin: 14px auto 0;
    padding: 0 20px;
  }
  .cats button {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    padding: 6px 12px;
    border: 1px solid var(--border);
    background: transparent;
    cursor: pointer;
    margin-left: -1px;
  }
  .cats button:first-child { margin-left: 0; border-radius: 8px 0 0 8px; }
  .cats button:last-child { border-radius: 0 8px 8px 0; }
  .cats button.on { background: var(--border); color: var(--text); font-weight: 700; }
  .cats button:disabled { opacity: 0.4; cursor: default; }

  /* ---- Image grid ---- */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 12px;
  }
  .cell { display: block; text-decoration: none; color: inherit; }
  .cell img {
    width: 100%;
    aspect-ratio: 1 / 1;
    object-fit: cover;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    display: block;
  }
  .cell-title {
    font-size: 12px;
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }

  /* ---- Pager ---- */
  .pager {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 22px;
  }
  .pager[hidden] { display: none; }
  .pager button {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 13px;
    cursor: pointer;
  }
  .pager button:disabled { opacity: 0.4; cursor: default; }
  .pager .page { color: var(--muted); font-size: 12px; }
  .pager .seg {
    display: flex;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .pager .seg button {
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 7px 12px;
  }
  .pager .seg button:hover:not(:disabled) {
    background: var(--border);
  }
  .pager .seg .mid {
    color: var(--muted);
    font-size: 12px;
    padding: 0 14px;
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
    min-width: 68px;
    text-align: center;
    white-space: nowrap;
  }

  /* ---- Result rows: idx / title+body / thumb ---- */
  .result {
    padding: 15px 0;
    border-top: 1px solid var(--border);
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-areas: "idx title thumb" "idx body thumb";
    column-gap: 14px;
    align-items: start;
  }
  .idx { grid-area: idx; color: var(--muted); line-height: 1.6; }
  .title { grid-area: title; font-size: 15px; color: var(--link); text-decoration: none; font-weight: 700; }
  .title:hover { text-decoration: underline; }
  .body { grid-area: body; min-width: 0; }
  .host { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .host::before { content: "— "; }
  .snippet { font-size: 13px; color: var(--text); opacity: 0.85; margin-top: 4px; }
  .thumb {
    grid-area: thumb;
    width: 72px;
    height: 72px;
    border: 1px solid var(--border);
    border-radius: 6px;
    object-fit: cover;
    background: var(--surface);
    display: block;
  }

  @media (max-width: 480px) {
    body.start .hints { flex-wrap: wrap; gap: 10px; justify-content: center; }
    body.results .topbar { padding: 10px 14px; gap: 10px; }
    body.results .brand-results { display: none; }
    body.results .wrap { padding: 0 14px 70px; }
    body.results #status { padding: 0 14px; }
    body.results .cats { padding: 0 14px; }
    .result { grid-template-areas: "idx title title" "idx body body"; }
    .result.has-thumb { grid-template-areas: "idx title title" "idx body thumb"; }
    .thumb { width: 60px; height: 60px; }
  }
</style>
</head>
<body class="start">
<header class="topbar">
  <span class="brand brand-start">KAGI SEARCH</span>
  <span class="brand brand-results">KAGI</span>
  <form id="search-form" class="prompt" action="/" method="post" autocomplete="off">
    <span class="chev" aria-hidden="true">›</span>
    <input type="search" id="query" name="query" placeholder="type a query…" autofocus spellcheck="false" autocomplete="off" enterkeyhint="search" aria-label="Search query">
    <span class="go" aria-hidden="true">↵</span>
  </form>
</header>
<nav id="cats" class="cats" role="tablist" aria-label="Search categories">
  <button type="button" role="tab" class="on" aria-selected="true" data-workflow="search">web</button>
  <button type="button" role="tab" aria-selected="false" data-workflow="images">images</button>
  <button type="button" role="tab" aria-selected="false" data-workflow="news">news</button>
  <button type="button" role="tab" aria-selected="false" data-workflow="videos">videos</button>
  <button type="button" role="tab" aria-selected="false" data-workflow="podcasts">podcasts</button>
</nav>
<div class="hints">
  <span><b>↵</b> search</span>
  <span><b>/</b> focus</span>
  <span><b>esc</b> clear</span>
</div>
<div id="status" class="status" aria-live="polite"></div>
<main class="wrap">
  <div id="results" aria-live="polite"></div>
  <div class="pager" id="pager" hidden>
    <div class="seg">
      <button type="button" id="pager-prev" aria-label="Previous page">‹</button>
      <span class="mid" id="pager-mid">1 / 10</span>
      <button type="button" id="pager-next" aria-label="Next page">›</button>
    </div>
  </div>
</main>
<script nonce="__NONCE__">
(function () {
  "use strict";
  var form = document.getElementById("search-form");
  var input = document.getElementById("query");
  var statusEl = document.getElementById("status");
  var resultsEl = document.getElementById("results");
  var seq = 0;
  var pending = false;
  var workflow = "search";
  var page = 1;
  var hasNext = false;
  var hasPrev = false;
  var catButtons = Array.prototype.slice.call(document.querySelectorAll("#cats button"));
  var pager = document.getElementById("pager");
  var pagerMid = document.getElementById("pager-mid");
  var prevBtn = document.getElementById("pager-prev");
  var nextBtn = document.getElementById("pager-next");

  function setStatusText(msg) {
    statusEl.textContent = msg || "";
  }

  function setStatusCount(count, p) {
    statusEl.textContent = "";
    var ok = document.createElement("span");
    ok.className = "ok";
    ok.textContent = "✓ ";
    statusEl.appendChild(ok);
    statusEl.appendChild(document.createTextNode(count + " results · page " + p + " · cache: off"));
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return "";
    }
  }

  function schemeOk(url) {
    return typeof url === "string" && (url.indexOf("https://") === 0 || url.indexOf("http://") === 0);
  }

  function renderResults(results, count) {
    resultsEl.textContent = "";
    if (!results || results.length === 0 || count === 0) {
      setStatusText("No results.");
      return;
    }
    setStatusCount(count, page);
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var hasImage = schemeOk(r.image);
      var item = document.createElement("article");
      item.className = hasImage ? "result has-thumb" : "result";

      var idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = "[" + (i + 1) + "]";
      item.appendChild(idx);

      var title = document.createElement("a");
      title.className = "title";
      title.textContent = r.title;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
      if (schemeOk(r.url)) {
        title.href = r.url;
      }
      item.appendChild(title);

      var body = document.createElement("div");
      body.className = "body";
      var host = hostOf(r.url);
      if (host) {
        var hostEl = document.createElement("div");
        hostEl.className = "host";
        hostEl.textContent = host;
        body.appendChild(hostEl);
      }
      if (r.snippet) {
        var p = document.createElement("p");
        p.className = "snippet";
        p.textContent = r.snippet;
        body.appendChild(p);
      }
      item.appendChild(body);

      if (hasImage) {
        var img = document.createElement("img");
        img.className = "thumb";
        img.alt = "";
        img.src = r.image;
        item.appendChild(img);
      }

      resultsEl.appendChild(item);
    }
  }

  function renderGrid(results, count) {
    resultsEl.textContent = "";
    if (!results || results.length === 0 || count === 0) {
      setStatusText("No results.");
      return;
    }
    setStatusCount(count, page);
    var grid = document.createElement("div");
    grid.className = "grid";
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!schemeOk(r.image)) continue;
      var cell = document.createElement("a");
      cell.className = "cell";
      cell.target = "_blank";
      cell.rel = "noopener noreferrer";
      if (schemeOk(r.url)) {
        cell.href = r.url;
      }
      var img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = r.title;
      img.src = r.image;
      cell.appendChild(img);
      var t = document.createElement("div");
      t.className = "cell-title";
      t.textContent = r.title;
      cell.appendChild(t);
      grid.appendChild(cell);
    }
    resultsEl.appendChild(grid);
  }

  function updateTabs() {
    for (var i = 0; i < catButtons.length; i++) {
      var b = catButtons[i];
      var active = b.getAttribute("data-workflow") === workflow;
      if (active) {
        b.classList.add("on");
        b.setAttribute("aria-selected", "true");
      } else {
        b.classList.remove("on");
        b.setAttribute("aria-selected", "false");
      }
    }
  }

  function renderPager() {
    if (!hasPrev && !hasNext) {
      pager.hidden = true;
      return;
    }
    pager.hidden = false;
    pagerMid.textContent = page + " / 10";
    prevBtn.disabled = !hasPrev;
    nextBtn.disabled = !hasNext;
  }

  function buildUrl(q, w, p) {
    return "?q=" + encodeURIComponent(q) + "&wf=" + w + "&p=" + p;
  }

  function syncUrl(q, w, p) {
    history.replaceState(null, "", buildUrl(q, w, p));
  }

  function resetToStart() {
    history.replaceState(null, "", "/");
    input.value = "";
    workflow = "search";
    page = 1;
    hasNext = false;
    hasPrev = false;
    updateTabs();
    document.body.className = "start";
    resultsEl.textContent = "";
    statusEl.textContent = "";
    pager.hidden = true;
    seq++;
    pending = false;
    input.disabled = false;
    setControlsDisabled(false);
    input.focus();
  }

  function readBoot() {
    var sp = new URLSearchParams(location.search);
    var q = sp.get("q");
    if (q) q = q.trim();
    if (!q) return;
    var w = sp.get("wf");
    if (w !== "images" && w !== "videos" && w !== "news" && w !== "podcasts" && w !== "search") {
      w = "search";
    }
    var p = parseInt(sp.get("p"), 10);
    if (!(p >= 1 && p <= 10)) {
      p = 1;
    }
    input.value = q;
    workflow = w;
    page = p;
    updateTabs();
    document.body.className = "results";
    doSearch(p);
  }

  function setControlsDisabled(disabled) {
    for (var i = 0; i < catButtons.length; i++) {
      catButtons[i].disabled = disabled;
    }
    prevBtn.disabled = disabled || !hasPrev;
    nextBtn.disabled = disabled || !hasNext;
  }

  function doSearch(p) {
    if (pending) return;
    var query = input.value.trim();
    if (!query) return;
    if (typeof p === "number" && p >= 1 && p <= 10) {
      page = p;
    }
    var myWorkflow = workflow;
    pending = true;
    input.disabled = true;
    setControlsDisabled(true);
    var mySeq = ++seq;
    setStatusText("Searching…");
    fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, workflow: myWorkflow, page: page })
    }).then(function (resp) {
      if (resp.status === 403) throw { kind: "expired" };
      if (resp.status === 502 || resp.status === 504) throw { kind: "upstream" };
      if (!resp.ok) throw { kind: "error" };
      return resp.json();
    }).then(function (data) {
      if (mySeq !== seq) return;
      var count = (data && typeof data.count === "number") ? data.count : 0;
      var results = (data && Array.isArray(data.results)) ? data.results : [];
      if (data && typeof data.page === "number") page = data.page;
      hasNext = !!(data && data.has_next);
      hasPrev = !!(data && data.has_prev);
      document.body.className = "results";
      input.value = query;
      syncUrl(query, myWorkflow, page);
      if (myWorkflow === "images") {
        renderGrid(results, count);
      } else {
        renderResults(results, count);
      }
      renderPager();
    }).catch(function (err) {
      if (mySeq !== seq) return;
      if (err && err.kind === "expired") {
        setStatusText("Session expired — reopen the page with your token link.");
      } else if (err && err.kind === "upstream") {
        setStatusText("Kagi API error, try again.");
      } else {
        setStatusText("Search failed, try again.");
      }
    }).then(function () {
      if (mySeq !== seq) return;
      pending = false;
      input.disabled = false;
      setControlsDisabled(false);
      input.focus();
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    page = 1;
    doSearch(1);
  });

  for (var ci = 0; ci < catButtons.length; ci++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var wf = btn.getAttribute("data-workflow");
        if (wf === workflow) return;
        workflow = wf;
        page = 1;
        updateTabs();
        if (input.value.trim()) {
          doSearch(1);
        }
      });
    })(catButtons[ci]);
  }

  prevBtn.addEventListener("click", function () {
    if (hasPrev) doSearch(page - 1);
  });
  nextBtn.addEventListener("click", function () {
    if (hasNext) doSearch(page + 1);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    } else if (e.key === "Escape" && document.activeElement === input) {
      e.preventDefault();
      resetToStart();
    }
  });

  readBoot();
  input.focus();
})();
</script>
</body>
</html>
`;
