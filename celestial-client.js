/**
 * Celestial Client v2
 * Registers the SW with the correct scope, exposes encode/navigate API.
 * Also used as the injected page shim (when loaded inside a proxied page).
 */
(function(G) {
  'use strict';

  const PREFIX  = G.__CELESTIAL_PREFIX__ || '/celestial/';
  const BARE    = G.__CELESTIAL_BARE__   || '/bare';
  const XOR_KEY = 0x42;

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
  function toProxyUrl(url, base) {
    try {
      const abs = new URL(url, base || G.location.href).href;
      if (/^(data:|blob:|javascript:|mailto:|tel:)/.test(abs)) return url;
      return PREFIX + encode(abs);
    } catch { return url; }
  }

  const Celestial = {
    encode, decode, toProxyUrl, PREFIX, BARE,
    navigate(url) { G.location.href = toProxyUrl(url); },

    async register() {
      if (!('serviceWorker' in navigator)) throw new Error('SW not supported');
      const swSrc = `/celestial-sw.js?bare=${encodeURIComponent(BARE)}&prefix=${encodeURIComponent(PREFIX)}`;
      const reg = await navigator.serviceWorker.register(swSrc, {
        scope: PREFIX,
        updateViaCache: 'none',
      });
      await new Promise((res, rej) => {
        if (reg.active) { res(); return; }
        const sw = reg.installing || reg.waiting;
        if (!sw) { res(); return; }
        sw.addEventListener('statechange', function() {
          if (this.state === 'activated') res();
          if (this.state === 'redundant')  rej(new Error('SW install failed'));
        });
      });
      return reg;
    },

    async checkBare() {
      try {
        const r = await fetch(BARE, { method: 'GET' });
        if (!r.ok) return false;
        const j = await r.json();
        return Array.isArray(j.versions);
      } catch { return false; }
    },
  };

  // ── Page shim — only runs when injected inside a proxied page ──────────────
  // The SW injects: <script src="/celestial/__celestial-shim__" data-base="..." data-prefix="...">
  // That script tag loads THIS file. We detect the data-base attribute to know we're in a page.
  const shimTag = document.currentScript;
  const realBase = shimTag && shimTag.getAttribute('data-base');

  if (realBase) {
    // Override location
    try {
      const realLoc = G.location;
      const baseObj = new URL(realBase);
      const fakeLoc = new Proxy(realLoc, {
        get(t, p) {
          if (p === 'href')     return realBase;
          if (p === 'origin')   return baseObj.origin;
          if (p === 'host')     return baseObj.host;
          if (p === 'hostname') return baseObj.hostname;
          if (p === 'pathname') return baseObj.pathname;
          if (p === 'search')   return baseObj.search;
          if (p === 'hash')     return baseObj.hash;
          if (p === 'assign')   return (u) => Celestial.navigate(new URL(u, realBase).href);
          if (p === 'replace')  return (u) => Celestial.navigate(new URL(u, realBase).href);
          if (p === 'reload')   return () => G.location.reload();
          const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
        },
        set(t, p, v) {
          if (p === 'href') { Celestial.navigate(new URL(v, realBase).href); return true; }
          t[p] = v; return true;
        },
      });
      Object.defineProperty(G, 'location', { get: () => fakeLoc, configurable: true });
    } catch {}

    // Override document.domain
    try { Object.defineProperty(document, 'domain', { get: () => new URL(realBase).hostname, configurable: true }); } catch {}

    // Override window.open
    const _open = G.open.bind(G);
    G.open = (url, ...a) => url ? _open(toProxyUrl(url, realBase), ...a) : _open(...a);

    // Override fetch
    const _fetch = G.fetch.bind(G);
    G.fetch = (input, init) => {
      try {
        const url = typeof input === 'string' ? input : input.url;
        const abs = new URL(url, realBase).href;
        return _fetch(abs.startsWith(PREFIX) ? input : toProxyUrl(abs), init);
      } catch { return _fetch(input, init); }
    };

    // Override XHR
    const _XHR = G.XMLHttpRequest;
    G.XMLHttpRequest = class extends _XHR {
      open(m, url, ...a) {
        try { url = toProxyUrl(new URL(url, realBase).href); } catch {}
        super.open(m, url, ...a);
      }
    };
  }

  G.Celestial = Celestial;
})(typeof globalThis !== 'undefined' ? globalThis : self);
