// Utilitários sem dependência do Cesium (testáveis isoladamente).

export const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
export const $$ = (seletor, raiz = document) => [...raiz.querySelectorAll(seletor)];

/** Cria um elemento: el('button', {class:'x', onclick: fn}, 'texto', outroNo) */
export function el(tag, atributos = {}, ...filhos) {
  const no = document.createElement(tag);
  for (const [k, v] of Object.entries(atributos || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') no.className = v;
    else if (k === 'html') no.innerHTML = v;
    else if (k === 'dataset') Object.assign(no.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') no.addEventListener(k.slice(2), v);
    else no.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    no.append(f.nodeType ? f : document.createTextNode(String(f)));
  }
  return no;
}

export const semAcento = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** GET/POST JSON com tempo limite; rejeita no erro "200 com error" do ArcGIS. */
export async function pedirJSON(url, { parametros, post = false, tempo = 25000, sinal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('tempo esgotado', 'TimeoutError')), tempo);
  if (sinal) sinal.addEventListener('abort', () => ctrl.abort(sinal.reason), { once: true });
  try {
    const qs = parametros ? new URLSearchParams(parametros).toString() : '';
    const resp = post
      ? await fetch(url, { method: 'POST', body: qs, signal: ctrl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      : await fetch(qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const dados = await resp.json();
    if (dados && dados.error) throw new Error(dados.error.message || 'erro do servidor de mapas');
    return dados;
  } finally {
    clearTimeout(timer);
  }
}

const nf = (casas) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
export const fmtNum = (n, casas = 0) => (Number.isFinite(+n) ? nf(casas).format(+n) : '—');

export function fmtDistancia(m) {
  if (!Number.isFinite(m)) return '—';
  return m >= 1000 ? `${fmtNum(m / 1000, m >= 100000 ? 0 : 2)} km` : `${fmtNum(m, m < 100 ? 1 : 0)} m`;
}

export function fmtArea(m2) {
  if (!Number.isFinite(m2)) return '—';
  if (m2 >= 1e6) return `${fmtNum(m2 / 1e6, 2)} km²`;
  if (m2 >= 1e4) return `${fmtNum(m2 / 1e4, 2)} ha`;
  return `${fmtNum(m2, m2 < 100 ? 1 : 0)} m²`;
}

export const fmtGraus = (lat, lon) =>
  `${Math.abs(lat).toFixed(5)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(5)}° ${lon < 0 ? 'O' : 'L'}`;

// ------------------------------------------------------------------ UTM (EPSG:31982)
// SIRGAS 2000 / UTM fuso 22 S — o sistema de coordenadas do Mapa Fácil.
// Série de Krüger (precisão sub-milimétrica na extensão do fuso).
const A = 6378137, F = 1 / 298.257222101, K0 = 0.9996, LON0 = -51, FE = 500000, FN = 10000000;
const N = F / (2 - F);
const AA = (A / (1 + N)) * (1 + N * N / 4 + N ** 4 / 64);
const ALFA = [N / 2 - (2 * N * N) / 3 + (5 * N ** 3) / 16, (13 * N * N) / 48 - (3 * N ** 3) / 5, (61 * N ** 3) / 240];
const BETA = [N / 2 - (2 * N * N) / 3 + (37 * N ** 3) / 96, (N * N) / 48 + N ** 3 / 15, (17 * N ** 3) / 480];
const DELTA = [2 * N - (2 * N * N) / 3 - 2 * N ** 3, (7 * N * N) / 3 - (8 * N ** 3) / 5, (56 * N ** 3) / 15];
const RAD = Math.PI / 180;

export function paraUTM(lon, lat) {
  const fi = lat * RAD, dl = (lon - LON0) * RAD;
  const c = (2 * Math.sqrt(N)) / (1 + N);
  const t = Math.sinh(Math.atanh(Math.sin(fi)) - c * Math.atanh(c * Math.sin(fi)));
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let e = eta, n = xi;
  for (let j = 1; j <= 3; j++) {
    e += ALFA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    n += ALFA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return { e: FE + K0 * AA * e, n: FN + K0 * AA * n, fuso: '22S' };
}

export function deUTM(e, n) {
  const xi = (n - FN) / (K0 * AA), eta = (e - FE) / (K0 * AA);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 3; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let fi = chi;
  for (let j = 1; j <= 3; j++) fi += DELTA[j - 1] * Math.sin(2 * j * chi);
  const lon = LON0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) / RAD;
  return { lon, lat: fi / RAD };
}

// ------------------------------------------------------------------ Web Mercator
const R = 6378137;
export const mercX = (lon) => lon * RAD * R;
export const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) * R;
export const deMercator = (x, y) => [x / R / RAD, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / RAD];

// ------------------------------------------------------------------ geometria
/** Ponto em anel [[lon,lat],…] (regra par-ímpar). */
export function pontoNoAnel(lon, lat, anel) {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

/** Ponto em geometria GeoJSON Polygon/MultiPolygon. */
export function pontoNaGeometria(lon, lat, geom) {
  const polis = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polis.some((aneis) =>
    pontoNoAnel(lon, lat, aneis[0]) && !aneis.slice(1).some((furo) => pontoNoAnel(lon, lat, furo)));
}

/** Distância geodésica aproximada (haversine) em metros. */
export function distanciaM(lon1, lat1, lon2, lat2) {
  const dfi = (lat2 - lat1) * RAD, dl = (lon2 - lon1) * RAD;
  const h = Math.sin(dfi / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Área (m²) de um anel [[lon,lat],…] em projeção local equivalente. */
export function areaM2(anel) {
  if (anel.length < 3) return 0;
  const lat0 = anel.reduce((s, p) => s + p[1], 0) / anel.length;
  const kx = Math.cos(lat0 * RAD) * R * RAD, ky = R * RAD;
  let soma = 0;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    soma += (anel[j][0] * kx) * (anel[i][1] * ky) - (anel[i][0] * kx) * (anel[j][1] * ky);
  }
  return Math.abs(soma) / 2;
}

/** Extensão [O,S,L,N] de uma lista de pontos [lon,lat]. */
export function extensaoDe(pontos) {
  let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
  for (const [x, y] of pontos) { o = Math.min(o, x); s = Math.min(s, y); l = Math.max(l, x); n = Math.max(n, y); }
  return [o, s, l, n];
}

// ------------------------------------------------------------------ interface
export function aviso(texto, tipo = 'info', ms = 4200) {
  const caixa = $('#avisos');
  if (!caixa) return;
  const no = el('div', { class: `aviso aviso-${tipo}`, role: 'status' }, texto);
  caixa.append(no);
  setTimeout(() => { no.classList.add('sai'); setTimeout(() => no.remove(), 300); }, ms);
}

export function baixarArquivo(nome, conteudo, tipo = 'text/plain') {
  const blob = conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: nome });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const escaparXML = (s) => String(s ?? '').replace(/[<>&'"]/g,
  (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/** Guarda/recupera JSON no armazenamento local sem quebrar se estiver indisponível. */
export const memoria = {
  ler(chave, padrao) {
    try { const v = localStorage.getItem(chave); return v === null ? padrao : JSON.parse(v); } catch { return padrao; }
  },
  gravar(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* modo privado etc. */ }
  },
};
