/**
 * Celestial Service Worker v2
 * Correctly scoped, config read from SW URL search params
 */
'use strict';

// Read config from SW registration URL params
const swUrl   = new URL(location.href);
const BARE    = swUrl.searchParams.get('bare')   || '/bare';
const PREFIX  = swUrl.searchParams.get('prefix') || '/celestial/';
const XOR_KEY = 0x42;

// ── Encoding ────────────────────────────────────────────────────────────────
function encode(str) {
  const bytes = new TextEncoder().encode(str);
  const xored = bytes.map(b => b ^ XOR_KEY);
  return btoa(String.fromCharCode(...xored))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function decode(str) {
  try {
    const p = str.replace(/-/g,'+').replace(/_/g,'/');
    const b = atob(p);
    const bytes = Uint8Array.from(b, c => c.charCodeAt(0) ^ XOR_KEY);
    return new TextDecoder().decode(bytes);
  } catch { return null; }
}
function toProxy(url)  { return PREFIX + encode(url); }
function fromProxy(p)  { return decode(p.slice(PREFIX.length)); }

// ── Rewriters ────────────────────────────────────────────────────────────────
function rewriteUrl(url, base) {
  try {
    const abs = new URL(url, base).href;
    if (/^(data:|blob:|javascript:|mailto:|tel:|#)/.test(abs)) return url;
    return toProxy(abs);
  } catch { return url; }
}

function rewriteHTML(html, base) {
  // rewrite src / href / action / data attributes
  html = html.replace(
    /((?:src|href|action|data-src)\s*=\s*)(['"])((?!data:|blob:|javascript:|#|mailto:|tel:)[^'"]*)\2/gi,
    (m, attr, q, url) => attr + q + rewriteUrl(url, base) + q
  );
  // rewrite srcset
  html = html.replace(/srcset\s*=\s*(['"])(.*?)\1/gi, (m, q, set) => {
    const rw = set.replace(/([^\s,]+)(\s+[\d.]+[wx])?/g, (m, u, d) => rewriteUrl(u, base) + (d||''));
    return 'srcset=' + q + rw + q;
  });
  // rewrite CSS url()
  html = html.replace(/url\((['"]?)((?!data:)[^)'"]+)\1\)/gi,
    (m, q, u) => 'url(' + q + rewriteUrl(u, base) + q + ')');
  // strip CSP & x-frame-options meta tags
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]?(content-security-policy|x-frame-options)['"]?[^>]*>/gi, '');
  // inject client shim before </head>
  const shim = `<script src="${PREFIX}__celestial-shim__" data-base="${base}" data-prefix="${PREFIX}"><\/script>`;
  return html.includes('</head>') ? html.replace('</head>', shim+'</head>') : shim + html;
}

function rewriteCSS(css, base) {
  return css.replace(/url\((['"]?)((?!data:)[^)'"]+)\1\)/gi,
    (m, q, u) => 'url(' + q + rewriteUrl(u, base) + q + ')');
}

// ── Bare fetch ────────────────────────────────────────────────────────────────
async function bareFetch(targetUrl, req) {
  const method = req.method;
  const fwdHeaders = {};
  for (const h of ['accept','accept-language','content-type','cookie','range','cache-control','pragma']) {
    const v = req.headers.get(h);
    if (v) fwdHeaders[h] = v;
  }
  fwdHeaders['referer'] = targetUrl;
  fwdHeaders['origin']  = new URL(targetUrl).origin;

  const body = ['GET','HEAD'].includes(method) ? undefined : await req.arrayBuffer();

  const res = await fetch(BARE, {
    method,
    headers: {
      'x-bare-url':            targetUrl,
      'x-bare-headers':        JSON.stringify(fwdHeaders),
      'x-bare-forward-headers':'accept,accept-language,cookie,range',
      'content-type':          'application/octet-stream',
    },
    body,
  });

  if (!res.ok && res.status !== 304) throw new Error('Bare: ' + res.status);

  const status     = parseInt(res.headers.get('x-bare-status') || '200');
  const statusText = res.headers.get('x-bare-status-text') || '';
  const resHdrs    = JSON.parse(res.headers.get('x-bare-headers') || '{}');
  const ct         = (resHdrs['content-type'] || '').toLowerCase();

  // Handle redirects
  if ([301,302,303,307,308].includes(status)) {
    const loc = resHdrs['location'];
    if (loc) return Response.redirect(toProxy(new URL(loc, targetUrl).href), status);
  }

  const buf = await res.arrayBuffer();

  const outHeaders = new Headers();
  for (const [k,v] of Object.entries(resHdrs)) {
    const kl = k.toLowerCase();
    if (['content-security-policy','x-frame-options','x-content-type-options',
         'content-encoding','transfer-encoding','connection'].includes(kl)) continue;
    try { outHeaders.set(k, Array.isArray(v) ? v.join(', ') : v); } catch {}
  }
  outHeaders.set('content-type', ct || 'application/octet-stream');

  if (/text\/html/.test(ct)) {
    const text = new TextDecoder().decode(buf);
    return new Response(rewriteHTML(text, targetUrl), { status, statusText, headers: outHeaders });
  }
  if (/text\/css/.test(ct)) {
    const text = new TextDecoder().decode(buf);
    return new Response(rewriteCSS(text, targetUrl), { status, statusText, headers: outHeaders });
  }
  return new Response(buf, { status, statusText, headers: outHeaders });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only handle requests under our prefix
  if (!url.pathname.startsWith(PREFIX)) return;

  // Special: serve the inline client shim script
  if (url.pathname === PREFIX + '__celestial-shim__') {
    // The actual shim JS is injected inline — this just needs to 200
    e.respondWith(new Response('/* celestial shim loaded via inline injection */', {
      headers: { 'content-type': 'application/javascript' }
    }));
    return;
  }

  const target = fromProxy(url.pathname);
  if (!target) {
    e.respondWith(new Response('Bad proxy URL', { status: 400 }));
    return;
  }

  e.respondWith(
    bareFetch(target, e.request).catch(err =>
      new Response(
        `<!DOCTYPE html><html><head><title>Celestial Error</title></head>
        <body style="background:#000510;color:#4fc3ff;font-family:monospace;padding:40px;margin:0">
        <h2 style="background:linear-gradient(90deg,#a0d8ff,#4fc3ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent">
        🌌 Celestial Error</h2>
        <p style="color:#a0d8ff;margin:16px 0">${err.message}</p>
        <p style="color:rgba(160,216,255,.4);font-size:12px">Target: ${target}</p>
        <button onclick="history.back()"
          style="margin-top:20px;background:linear-gradient(135deg,#4fc3ff,#1a6fff);color:#000;
          border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-weight:700">← Back</button>
        </body></html>`,
        { status: 500, headers: { 'content-type': 'text/html' } }
      )
    )
  );
});
