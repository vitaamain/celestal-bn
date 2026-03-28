/**
 * Celestial Service Worker
 * Intercepts all fetches inside the /celestial/ scope and rewrites them
 * through the Celestial bare server, similar to how Ultraviolet/Scramjet work.
 *
 * URL scheme:  /celestial/<encoded-url>
 *   encoded-url = btoa(actualUrl) with custom alphabet for URL safety
 */

'use strict';

const BARE_URL = self.__CELESTIAL_BARE__ || '/.netlify/functions/bare';
const PREFIX   = self.__CELESTIAL_PREFIX__ || '/celestial/';
const VERSION  = '1.0.0';

// ── Encoding (XOR + base64 to avoid filter detection) ──────────────────────
const XOR_KEY = 0x42;

function encode(str) {
  const bytes = new TextEncoder().encode(str);
  const xored = bytes.map(b => b ^ XOR_KEY);
  return btoa(String.fromCharCode(...xored))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0) ^ XOR_KEY);
  return new TextDecoder().decode(bytes);
}

// ── URL rewriting helpers ───────────────────────────────────────────────────

function toProxyUrl(targetUrl) {
  return PREFIX + encode(targetUrl);
}

function fromProxyUrl(proxyUrl) {
  const encoded = proxyUrl.slice(PREFIX.length);
  try { return decode(encoded); } catch { return null; }
}

function rewriteUrl(url, baseUrl) {
  try {
    const abs = new URL(url, baseUrl).href;
    // Don't rewrite data:, blob:, javascript:
    if (/^(data|blob|javascript|mailto|tel):/.test(abs)) return url;
    return toProxyUrl(abs);
  } catch { return url; }
}

// ── HTML rewriting ───────────────────────────────────────────────────────────
// Rewrites src, href, action, srcset attributes and inline scripts/styles

function rewriteHTML(html, baseUrl) {
  // Rewrite <script src>, <link href>, <img src>, <a href>, <form action>, <iframe src>
  html = html.replace(
    /(<(?:script|link|img|iframe|source|video|audio|input)[^>]+(?:src|href|action)\s*=\s*)(['"])(.*?)\2/gi,
    (match, prefix, quote, url) => {
      if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#') || url.startsWith('javascript:')) return match;
      return prefix + quote + rewriteUrl(url, baseUrl) + quote;
    }
  );

  // Rewrite srcset
  html = html.replace(/srcset\s*=\s*(['"])(.*?)\1/gi, (match, quote, srcset) => {
    const rewritten = srcset.replace(/([^\s,]+)(\s+[\d.]+[wx])?/g, (m, url, descriptor) => {
      return rewriteUrl(url, baseUrl) + (descriptor || '');
    });
    return 'srcset=' + quote + rewritten + quote;
  });

  // Rewrite CSS url() inside style attributes and <style> tags
  html = html.replace(/url\((['"]?)(.*?)\1\)/gi, (match, quote, url) => {
    if (!url || url.startsWith('data:')) return match;
    return 'url(' + quote + rewriteUrl(url, baseUrl) + quote + ')';
  });

  // Inject our client script right before </head> or </body>
  const inject = `<script src="${PREFIX}celestial-client.js"></script>
<script>__CELESTIAL_BASE__ = ${JSON.stringify(baseUrl)}; __CELESTIAL_PREFIX__ = ${JSON.stringify(PREFIX)};</script>`;

  if (html.includes('</head>')) {
    html = html.replace('</head>', inject + '</head>');
  } else if (html.includes('<body')) {
    html = html.replace(/<body[^>]*>/, m => m + inject);
  } else {
    html = inject + html;
  }

  return html;
}

// Rewrite CSS text
function rewriteCSS(css, baseUrl) {
  return css.replace(/url\((['"]?)(.*?)\1\)/gi, (match, quote, url) => {
    if (!url || url.startsWith('data:')) return match;
    return 'url(' + quote + rewriteUrl(url, baseUrl) + quote + ')';
  });
}

// ── Fetch through bare server ────────────────────────────────────────────────

async function bareFetch(targetUrl, originalRequest) {
  const method = originalRequest.method;
  let body = null;
  if (!['GET', 'HEAD'].includes(method)) {
    body = await originalRequest.arrayBuffer();
  }

  // Forward relevant headers
  const forwardHeaders = {};
  const allowedHeaders = [
    'accept', 'accept-language', 'accept-encoding',
    'content-type', 'content-length', 'cookie',
    'cache-control', 'pragma', 'range',
    'if-modified-since', 'if-none-match',
  ];
  for (const h of allowedHeaders) {
    const v = originalRequest.headers.get(h);
    if (v) forwardHeaders[h] = v;
  }
  // Spoof referer to look like it came from the target site
  forwardHeaders['referer'] = targetUrl;

  const bareHeaders = {
    'X-Bare-URL': targetUrl,
    'X-Bare-Headers': JSON.stringify(forwardHeaders),
    'X-Bare-Forward-Headers': allowedHeaders.join(', '),
    'Content-Type': 'application/octet-stream',
  };

  const bareResponse = await fetch(BARE_URL, {
    method,
    headers: bareHeaders,
    body: body ? body : undefined,
  });

  if (!bareResponse.ok && bareResponse.status !== 304) {
    throw new Error(`Bare server error: ${bareResponse.status}`);
  }

  // Extract response metadata from bare headers
  const status      = parseInt(bareResponse.headers.get('x-bare-status') || '200');
  const statusText  = bareResponse.headers.get('x-bare-status-text') || '';
  const rawHeaders  = bareResponse.headers.get('x-bare-headers') || '{}';
  const resHeaders  = JSON.parse(rawHeaders);
  const contentType = resHeaders['content-type'] || '';

  // Build clean response headers
  const responseHeaders = new Headers();
  for (const [k, v] of Object.entries(resHeaders)) {
    const kl = k.toLowerCase();
    // Skip headers that would cause issues
    if (['content-security-policy', 'x-frame-options', 'x-content-type-options',
         'content-encoding', 'transfer-encoding'].includes(kl)) continue;
    try { responseHeaders.set(k, v); } catch {}
  }
  responseHeaders.set('Content-Type', contentType || 'application/octet-stream');

  const bodyBuffer = await bareResponse.arrayBuffer();

  // Handle redirects — rewrite location header
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = resHeaders['location'];
    if (location) {
      const redirectUrl = new URL(location, targetUrl).href;
      return Response.redirect(toProxyUrl(redirectUrl), status);
    }
  }

  // Rewrite HTML
  if (/text\/html/i.test(contentType)) {
    const text = new TextDecoder().decode(bodyBuffer);
    const rewritten = rewriteHTML(text, targetUrl);
    return new Response(rewritten, { status, statusText, headers: responseHeaders });
  }

  // Rewrite CSS
  if (/text\/css/i.test(contentType)) {
    const text = new TextDecoder().decode(bodyBuffer);
    const rewritten = rewriteCSS(text, targetUrl);
    return new Response(rewritten, { status, statusText, headers: responseHeaders });
  }

  // Rewrite JS — inject location/document overrides
  if (/javascript/i.test(contentType)) {
    const text = new TextDecoder().decode(bodyBuffer);
    const wrapped = `(function(){
var __cBase=${JSON.stringify(targetUrl)};
var __cPrefix=${JSON.stringify(PREFIX)};
${text}
})();`;
    return new Response(wrapped, { status, statusText, headers: responseHeaders });
  }

  // Binary / everything else — pass through as-is
  return new Response(bodyBuffer, { status, statusText, headers: responseHeaders });
}

// ── Service Worker lifecycle ─────────────────────────────────────────────────

self.addEventListener('install', e => {
  console.log('[Celestial SW] Installing v' + VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  console.log('[Celestial SW] Activated');
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  const urlObj = new URL(url);

  // Only intercept requests under our prefix
  if (!urlObj.pathname.startsWith(PREFIX)) return;

  // Special: serve our own scripts
  if (urlObj.pathname === PREFIX + 'celestial-client.js') return; // served statically

  const targetUrl = fromProxyUrl(urlObj.pathname);
  if (!targetUrl) {
    e.respondWith(new Response('Bad proxy URL', { status: 400 }));
    return;
  }

  e.respondWith(
    bareFetch(targetUrl, e.request).catch(err => {
      console.error('[Celestial SW] Fetch error:', err);
      return new Response(
        `<!DOCTYPE html><html><body style="background:#000;color:#4fc3ff;font-family:monospace;padding:40px">
        <h2>🌌 Celestial Proxy Error</h2>
        <p>${err.message}</p>
        <p>Target: ${targetUrl}</p>
        <button onclick="history.back()" style="background:#1a6fff;color:#000;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;margin-top:16px">← Go Back</button>
        </body></html>`,
        { status: 500, headers: { 'Content-Type': 'text/html' } }
      );
    })
  );
});
