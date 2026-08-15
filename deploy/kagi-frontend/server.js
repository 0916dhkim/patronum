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

function proxyToKagi(query, workflow, cb) {
  const dataKey = WORKFLOW_DATA[workflow];
  const payload = JSON.stringify({ query: query, workflow: workflow });
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
          callOnce(null, { ok: true, workflow: workflow, count: results.length, results: results });
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
    if (active >= MAX_CONCURRENCY) {
      finish(429, { ok: false, error: "Too many concurrent requests, try again shortly" }, { "Retry-After": "5" });
      return;
    }
    active++;
    proxyToKagi(query, workflow, function (err, result) {
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
// Embedded HTML/CSS/JS frontend (mobile-first, system dark mode, XSS-safe).
// Placeholder __NONCE__ is replaced per-response with a fresh CSP nonce.
// NOTE: this template literal must never contain a backtick or "${".
// ============================================================================

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kagi</title>
<link rel="icon" href="data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%231f2937'/%3E%3Ctext x='16' y='22' font-family='Arial' font-size='18' font-weight='bold' text-anchor='middle' fill='%23f5f5f5'%3EK%3C/text%3E%3C/svg%3E">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --surface: #f6f7f8;
    --text: #1a1d21;
    --muted: #6b7280;
    --border: #d7dbe0;
    --accent: #2f6fed;
    --link: #1a5cd7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111216;
      --surface: #1a1c22;
      --text: #e8eaed;
      --muted: #9aa0a8;
      --border: #2a2d35;
      --accent: #5b8def;
      --link: #8ab4f8;
    }
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 16px; }
  header { margin: 8px 0 20px; }
  header h1 { font-size: 28px; margin: 0; }
  header p { margin: 2px 0 0; color: var(--muted); font-size: 14px; }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  form.search { display: flex; gap: 8px; margin-bottom: 12px; }
  input[type="search"] {
    flex: 1; min-width: 0; font-size: 16px; padding: 12px 14px;
    border: 1px solid var(--border); border-radius: 10px;
    background: var(--surface); color: var(--text); outline: none;
  }
  input[type="search"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.15); }
  button[type="submit"] {
    font-size: 16px; padding: 0 18px; border: 0; border-radius: 10px;
    background: var(--accent); color: #fff; cursor: pointer;
  }
  button[type="submit"]:disabled { opacity: 0.6; cursor: default; }
  button[type="submit"].loading::after {
    content: ""; display: inline-block; width: 14px; height: 14px; margin-left: 8px;
    border: 2px solid rgba(255, 255, 255, 0.4); border-top-color: #fff;
    border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: -2px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tabs { display: flex; gap: 6px; overflow-x: auto; margin-bottom: 16px; padding-bottom: 2px; -webkit-overflow-scrolling: touch; }
  .tabs button {
    flex: 0 0 auto; font-size: 14px; padding: 8px 14px; border-radius: 999px;
    border: 1px solid var(--border); background: transparent; color: var(--muted);
    cursor: pointer; white-space: nowrap;
  }
  .tabs button.active { background: var(--surface); color: var(--text); border-color: var(--accent); font-weight: 600; }
  .tabs button:focus-visible, a:focus-visible, input:focus-visible, button:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .status { min-height: 1.4em; color: var(--muted); font-size: 14px; margin-bottom: 8px; }
  .list { display: flex; flex-direction: column; gap: 18px; }
  .result .title { color: var(--link); font-size: 17px; font-weight: 600; text-decoration: none; }
  .result .title:hover { text-decoration: underline; }
  .meta { color: var(--muted); font-size: 13px; margin-top: 2px; }
  .meta .date::before { content: " · "; }
  .snippet { margin: 4px 0 0; color: var(--text); font-size: 15px; overflow-wrap: break-word; }
  .thumb-wrap { display: block; margin-bottom: 8px; }
  .thumb {
    display: block; width: 100%; max-width: 320px; aspect-ratio: 16 / 9;
    object-fit: cover; border-radius: 8px; background: var(--surface);
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .cell { display: block; text-decoration: none; color: inherit; }
  .cell img {
    width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 8px;
    background: var(--surface); display: block;
  }
  .cell-title {
    font-size: 13px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--text);
  }
  @media (max-width: 480px) { .wrap { padding: 12px; } }
  @media (prefers-reduced-motion: reduce) {
    button[type="submit"].loading::after { animation: none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Kagi</h1>
    <p>Private search</p>
  </header>
  <form id="search-form" class="search" action="/api/search" method="post">
    <label for="query" class="sr-only">Search</label>
    <input type="search" id="query" name="query" inputmode="search" enterkeyhint="search"
           autofocus placeholder="Search the web" autocomplete="off">
    <button type="submit" id="submit">Search</button>
  </form>
  <div class="tabs" role="tablist" aria-label="Search type">
    <button type="button" role="tab" data-workflow="search" aria-selected="true">Web</button>
    <button type="button" role="tab" data-workflow="images" aria-selected="false">Images</button>
    <button type="button" role="tab" data-workflow="news" aria-selected="false">News</button>
    <button type="button" role="tab" data-workflow="videos" aria-selected="false">Videos</button>
    <button type="button" role="tab" data-workflow="podcasts" aria-selected="false">Podcasts</button>
  </div>
  <div id="status" class="status" aria-live="polite"></div>
  <main id="results" aria-live="polite"></main>
</div>
<script nonce="__NONCE__">
(function () {
  "use strict";
  var form = document.getElementById("search-form");
  var input = document.getElementById("query");
  var resultsEl = document.getElementById("results");
  var statusEl = document.getElementById("status");
  var submitBtn = document.getElementById("submit");
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  var workflow = "search";
  var seq = 0;
  var pending = false;

  // XSS-safe builder: createElement + textContent only. No innerHTML anywhere.
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") {
          node.className = v;
        } else if (k === "text") {
          node.textContent = v;
        } else if (k === "href" || k === "src") {
          if (typeof v === "string" && /^https?:\\/\\//.test(v)) {
            if (k === "href") node.href = v;
            else node.src = v;
          }
        } else if (k === "target" || k === "rel" || k === "loading" || k === "decoding" || k === "alt") {
          node.setAttribute(k, v);
        } else {
          node.setAttribute(k, v);
        }
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (c === null || c === undefined) return;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function setTabs() {
    tabs.forEach(function (t) {
      var active = t.getAttribute("data-workflow") === workflow;
      t.setAttribute("aria-selected", active ? "true" : "false");
      if (active) t.classList.add("active");
      else t.classList.remove("active");
    });
  }

  function render(results) {
    resultsEl.textContent = "";
    if (!results || results.length === 0) {
      setStatus("No results.");
      return;
    }
    setStatus("");
    if (workflow === "images") {
      var grid = el("div", { class: "grid" });
      results.forEach(function (r) {
        if (!r.image) return; // cells without an image URL are skipped
        var cell = el("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", class: "cell" });
        cell.appendChild(el("img", { src: r.image, alt: r.title, loading: "lazy", decoding: "async" }));
        cell.appendChild(el("div", { class: "cell-title", text: r.title }));
        grid.appendChild(cell);
      });
      resultsEl.appendChild(grid);
      return;
    }
    var list = el("div", { class: "list" });
    results.forEach(function (r) {
      var item = el("article", { class: "result" });
      if (r.image && workflow === "videos") {
        var awrap = el("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", class: "thumb-wrap" });
        awrap.appendChild(el("img", { src: r.image, alt: "", loading: "lazy", decoding: "async", class: "thumb" }));
        item.appendChild(awrap);
      }
      item.appendChild(el("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", class: "title", text: r.title }));
      var line = el("div", { class: "meta" });
      var host = "";
      try {
        host = new URL(r.url).hostname;
      } catch (e) { /* ignore */ }
      if (host) line.appendChild(el("span", { class: "host", text: host }));
      if (r.published) line.appendChild(el("span", { class: "date", text: r.published }));
      if (line.childNodes.length) item.appendChild(line);
      if (r.snippet) item.appendChild(el("p", { class: "snippet", text: r.snippet }));
      list.appendChild(item);
    });
    resultsEl.appendChild(list);
  }

  function doSearch() {
    if (pending) return;
    var query = input.value.trim();
    if (!query) {
      setStatus("");
      return;
    }
    pending = true;
    submitBtn.disabled = true;
    submitBtn.classList.add("loading");
    var mySeq = ++seq;
    setStatus("Searching\u2026");
    fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, workflow: workflow })
    }).then(function (resp) {
      if (resp.status === 403) throw { kind: "expired" };
      if (resp.status === 502 || resp.status === 504) throw { kind: "upstream" };
      if (!resp.ok) throw { kind: "error" };
      return resp.json();
    }).then(function (data) {
      if (mySeq !== seq) return;
      render(data.results || []);
    }).catch(function (err) {
      if (mySeq !== seq) return;
      resultsEl.textContent = "";
      if (err && err.kind === "expired") {
        setStatus("Session expired \u2014 reopen the page with your token link.");
      } else if (err && err.kind === "upstream") {
        setStatus("Kagi API error, try again.");
      } else {
        setStatus("Search failed, try again.");
      }
    }).then(function () {
      if (mySeq !== seq) return;
      pending = false;
      submitBtn.disabled = false;
      submitBtn.classList.remove("loading");
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    doSearch();
  });

  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      workflow = t.getAttribute("data-workflow");
      setTabs();
      if (input.value.trim()) doSearch();
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
  });

  setTabs();
  input.focus();
})();
</script>
</body>
</html>
`;
