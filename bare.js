/**
 * Celestial Bare Server
 * Netlify Function — handles raw HTTP proxying for the Celestial service worker
 * Compatible with the Bare server V2 protocol (same as UV/Scramjet expect)
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');

// Headers the bare server should never forward
const FORBIDDEN_FORWARD = new Set([
  'host','connection','transfer-encoding','keep-alive',
  'upgrade','proxy-authorization','te','trailers',
  'x-forwarded-for','x-forwarded-host','x-forwarded-proto',
]);

// Headers we should strip from responses before sending to client
const FORBIDDEN_RETURN = new Set([
  'transfer-encoding','connection','keep-alive','upgrade',
]);

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: '',
    };
  }

  const path = event.path.replace('/.netlify/functions/bare', '') || '/';

  // ── V2 bare protocol ─────────────────────────────────────────────────────
  // The service worker sends:
  //   X-Bare-URL      — the target URL to fetch
  //   X-Bare-Headers  — JSON stringified headers to forward
  //   X-Bare-Forward-Headers — list of headers to forward from the request

  if (event.httpMethod === 'GET' && path === '/') {
    // Bare server info endpoint — SW checks this to confirm we're a bare server
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        versions: ['v1', 'v2'],
        language: 'NodeJS',
        memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
        maintainer: { email: '', website: 'https://github.com/celestial-proxy/celestial' },
        project: { name: 'Celestial', description: 'A fast web proxy', version: '1.0.0', repository: 'https://github.com/celestial-proxy/celestial', homepage: 'https://github.com/celestial-proxy/celestial' },
      }),
    };
  }

  // ── V1/V2 request proxying ───────────────────────────────────────────────
  try {
    const rawUrl = event.headers['x-bare-url'];
    if (!rawUrl) {
      return { statusCode: 400, headers: corsHeaders(), body: 'Missing X-Bare-URL header' };
    }

    const targetUrl = new URL(rawUrl);
    const isHttps = targetUrl.protocol === 'https:';
    const port = targetUrl.port
      ? parseInt(targetUrl.port)
      : isHttps ? 443 : 80;

    // Parse headers to forward
    let forwardHeaders = {};
    try {
      const raw = event.headers['x-bare-headers'];
      if (raw) forwardHeaders = JSON.parse(raw);
    } catch (e) {}

    // Also forward headers listed in X-Bare-Forward-Headers
    const forwardList = (event.headers['x-bare-forward-headers'] || '')
      .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
    for (const h of forwardList) {
      if (!FORBIDDEN_FORWARD.has(h) && event.headers[h]) {
        forwardHeaders[h] = event.headers[h];
      }
    }

    // Build final request headers
    const reqHeaders = { host: targetUrl.hostname };
    for (const [k, v] of Object.entries(forwardHeaders)) {
      if (!FORBIDDEN_FORWARD.has(k.toLowerCase())) {
        reqHeaders[k] = v;
      }
    }

    // Make the request
    const response = await makeRequest({
      method: event.httpMethod,
      hostname: targetUrl.hostname,
      port,
      path: targetUrl.pathname + targetUrl.search,
      headers: reqHeaders,
      isHttps,
      body: event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : null,
    });

    // Strip forbidden response headers, build return headers
    const returnHeaders = { ...corsHeaders() };
    const passHeaders = {};
    for (const [k, v] of Object.entries(response.headers)) {
      const kl = k.toLowerCase();
      if (!FORBIDDEN_RETURN.has(kl)) {
        passHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      }
    }

    // Encode response headers in X-Bare-Headers
    returnHeaders['x-bare-status']   = String(response.statusCode);
    returnHeaders['x-bare-status-text'] = response.statusMessage || '';
    returnHeaders['x-bare-headers']  = JSON.stringify(passHeaders);
    returnHeaders['content-type']    = passHeaders['content-type'] || 'application/octet-stream';

    // Return body
    const bodyBuf = response.body;
    const isText = /text|json|javascript|xml/.test(returnHeaders['content-type'] || '');

    return {
      statusCode: 200,
      headers: returnHeaders,
      body: isText ? bodyBuf.toString('utf8') : bodyBuf.toString('base64'),
      isBase64Encoded: !isText,
    };

  } catch (err) {
    console.error('Celestial bare error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
}

function makeRequest({ method, hostname, port, path, headers, isHttps, body }) {
  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    const chunks = [];

    const req = lib.request({ method, hostname, port, path, headers,
      rejectUnauthorized: false, // allow self-signed certs
      timeout: 15000,
    }, res => {
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });

    if (body && body.length) req.write(body);
    req.end();
  });
}
