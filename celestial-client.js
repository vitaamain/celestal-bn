/**
 * Celestial Client Library
 * Registers the service worker and provides the client-side API.
 * Also injected into proxied pages to override location/window APIs.
 */

(function (global) {
  'use strict';

  const PREFIX  = global.__CELESTIAL_PREFIX__  || '/celestial/';
  const BARE    = global.__CELESTIAL_BARE__    || '/.netlify/functions/bare';
  const SW_URL  = PREFIX + '../celestial-sw.js'; // resolves to /celestial-sw.js
  const XOR_KEY = 0x42;

  // ── Encoding ──────────────────────────────────────────────────────────────
  function encode(str) {
    const bytes = new TextEncoder().encode(str);
    const xored = bytes.map(b => b ^ XOR_KEY);
    return btoa(String.fromCharCode(...xored))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function decode(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes  = Uint8Array.from(binary, c => c.charCodeAt(0) ^ XOR_KEY);
    return new TextDecoder().decode(bytes);
  }

  function toProxyUrl(url) {
    try {
      const abs = new URL(url, global.__CELESTIAL_BASE__ || location.href).href;
      return PREFIX + encode(abs);
    } catch { return url; }
  }

  function fromProxyUrl(proxyPath) {
    if (!proxyPath.startsWith(PREFIX)) return null;
    try { return decode(proxyPath.slice(PREFIX.length)); } catch { return null; }
  }

  // ── Exposed API ───────────────────────────────────────────────────────────
  const Celestial = {
    encode,
    decode,
    toProxyUrl,
    fromProxyUrl,
    PREFIX,
    BARE,

    // Navigate to a URL through the proxy
    navigate(url) {
      location.href = toProxyUrl(url);
    },

    // Register the service worker and resolve when ready
    async register() {
      if (!('serviceWorker' in navigator)) {
        throw new Error('Service workers not supported in this browser.');
      }

      // Pass config to the SW via URL params
      const swSrc = `/celestial-sw.js?bare=${encodeURIComponent(BARE)}&prefix=${encodeURIComponent(PREFIX)}`;

      const reg = await navigator.serviceWorker.register(swSrc, { scope: PREFIX });

      // Wait for the SW to be active
      await new Promise((resolve, reject) => {
        if (reg.active) { resolve(); return; }
        const target = reg.installing || reg.waiting;
        if (!target) { resolve(); return; }
        target.addEventListener('statechange', function () {
          if (this.state === 'activated') resolve();
          if (this.state === 'redundant')  reject(new Error('SW install failed'));
        });
      });

      console.log('[Celestial] Service worker registered & active');
      return reg;
    },

    // Check if the bare server is reachable
    async checkBare() {
      try {
        const res = await fetch(BARE, { method: 'GET' });
        if (!res.ok) return false;
        const json = await res.json();
        return Array.isArray(json.versions);
      } catch { return false; }
    },
  };

  // ── Location override (injected into proxied pages) ───────────────────────
  // When Celestial injects this script into a proxied page, __CELESTIAL_BASE__
  // is set to the real origin URL. We override location.href assignment so
  // links/redirects inside the page stay inside the proxy.
  if (global.__CELESTIAL_BASE__) {
    const realBase = global.__CELESTIAL_BASE__;

    // Override location.href setter
    try {
      const locDesc = Object.getOwnPropertyDescriptor(global, 'location');
      if (locDesc && locDesc.configurable) {
        const realLocation = global.location;
        const fakeLocation = new Proxy(realLocation, {
          get(target, prop) {
            if (prop === 'href') return realBase;
            if (prop === 'origin') return new URL(realBase).origin;
            if (prop === 'hostname') return new URL(realBase).hostname;
            if (prop === 'host') return new URL(realBase).host;
            if (prop === 'pathname') return new URL(realBase).pathname;
            if (prop === 'assign') return (url) => Celestial.navigate(url);
            if (prop === 'replace') return (url) => Celestial.navigate(url);
            const val = target[prop];
            return typeof val === 'function' ? val.bind(target) : val;
          },
          set(target, prop, val) {
            if (prop === 'href') { Celestial.navigate(val); return true; }
            target[prop] = val; return true;
          },
        });
        Object.defineProperty(global, 'location', { get: () => fakeLocation, configurable: true });
      }
    } catch (e) {}

    // Override document.domain
    try {
      Object.defineProperty(document, 'domain', {
        get: () => new URL(realBase).hostname,
        configurable: true,
      });
    } catch (e) {}

    // Override window.open to go through proxy
    const _open = global.open.bind(global);
    global.open = function (url, ...args) {
      if (url) return _open(toProxyUrl(url), ...args);
      return _open(...args);
    };

    // Override fetch to go through bare server
    const _fetch = global.fetch.bind(global);
    global.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input.url;
        const abs = new URL(url, realBase).href;
        // If it's already a proxy URL or a relative-to-SW path, leave it
        if (abs.startsWith(PREFIX)) return _fetch(input, init);
        return _fetch(toProxyUrl(abs), init);
      } catch { return _fetch(input, init); }
    };

    // Override XMLHttpRequest
    const _XHR = global.XMLHttpRequest;
    global.XMLHttpRequest = class extends _XHR {
      open(method, url, ...args) {
        try {
          const abs = new URL(url, realBase).href;
          if (!abs.startsWith(PREFIX)) url = toProxyUrl(abs);
        } catch {}
        super.open(method, url, ...args);
      }
    };
  }

  global.Celestial = Celestial;

})(typeof globalThis !== 'undefined' ? globalThis : self);
