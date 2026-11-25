// Service worker da Bússola: guarda no aparelho os arquivos do banco local e dos dados, para o mapa
// abrir de imediato nas próximas vezes e continuar funcionando com a internet fraca.
//
// - banco/ e data/: mostra o que já está guardado e atualiza por trás (o banco muda só a cada nova extração).
// - Páginas, código e estilos: sempre conferidos com o servidor (versão nova aparece na hora).
// - O login (acesso/) segue direto para a rede.
const CACHE = 'bussola-dados-v2'; // (o nome do cache não muda: os dados guardados continuam valendo)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('bussola-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const caminho = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  // Páginas, código e estilos: sempre confere com o servidor se há versão nova (sem esperar o cache de 10 min
  // do GitHub Pages expirar). O login (acesso/) segue direto.
  if (!/^(banco|data|vendor|relevo)\//.test(caminho)) {
    if (/^acesso\//.test(caminho)) return;
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).catch(() => caches.match(e.request).then((r) => r || Response.error())));
    return;
  }
  if (caminho.endsWith('manifesto.json')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const guardado = await cache.match(e.request);
    // Rede instável: uma segunda tentativa antes de desistir.
    const buscar = () => fetch(e.request).catch(() => new Promise((ok) => setTimeout(ok, 500)).then(() => fetch(e.request)));
    const rede = buscar().then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => null);
    if (guardado) { e.waitUntil(rede); return guardado; }
    return (await rede) || new Response('', { status: 504 });
  })());
});
