// Service worker da Bússola: guarda no aparelho os arquivos do banco local e dos dados, para o mapa
// abrir de imediato nas próximas vezes e continuar funcionando com a internet fraca.
//
// - banco/ e data/: mostra o que já está guardado e atualiza por trás (o banco muda só a cada nova extração).
// - O resto (páginas, código, login) segue direto para a rede, sem passar por aqui.
const CACHE = 'bussola-dados-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('bussola-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const caminho = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (!/^(banco|data)\//.test(caminho) || caminho.endsWith('manifesto.json')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const guardado = await cache.match(e.request);
    const rede = fetch(e.request).then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => null);
    if (guardado) { e.waitUntil(rede); return guardado; }
    return (await rede) || new Response('', { status: 504 });
  })());
});
