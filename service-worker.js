/* PASO A PASO: cachea únicamente el shell y recursos públicos estáticos. Nunca cachea Supabase API/Auth. */
const CACHE_NAME = "paso-a-paso-shell-v1";
const SHELL = ["./seguimiento-personal.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-touch-icon.png"];
const PUBLIC_SCRIPT = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);
    try { await cache.add(new Request(PUBLIC_SCRIPT, { mode: "cors", credentials: "omit" })); } catch (_) { /* optional: shell stays installable if CDN is unavailable */ }
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("paso-a-paso-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET") return;
  // Never intercept/cache authenticated Supabase calls or user data.
  if (url.hostname.endsWith("supabase.co") || url.pathname.includes("/auth/v1/") || url.pathname.includes("/rest/v1/")) return;
  if (request.mode === "navigate") {
    if (url.origin !== self.location.origin) return;
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && url.origin === self.location.origin) { const cache = await caches.open(CACHE_NAME); await cache.put("./seguimiento-personal.html", response.clone()); }
        return response;
      } catch (_) { return (await caches.match(request)) || (await caches.match("./seguimiento-personal.html")); }
    })());
    return;
  }
  const shellUrls = new Set(SHELL.map(path => new URL(path, self.location.href).href));
  if (shellUrls.has(url.href) || url.href === PUBLIC_SCRIPT) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && (url.origin === self.location.origin || url.href === PUBLIC_SCRIPT)) { const cache = await caches.open(CACHE_NAME); await cache.put(request, response.clone()); }
      return response;
    })());
  }
});
