// Núcleo de dados do banco local (passo 3 do roteiro de desempenho).
// Lê, descompacta, decifra, filtra e responde às consultas. NÃO usa window, document nem Cesium: pode rodar
// tanto na página quanto num Web Worker. A fachada (banco.js) cuida do navegador (fetch interceptado, armazenamento
// da chave do cofre, imagens do Cesium) e o desenho dos temas fica em banco-desenho.js.
import { cronometrar, cronometrarSinc, contadores } from './desempenho.js';

export const R = 6378137;
export const ESCALA = 1e6;
export const mx = (lon) => (lon * Math.PI / 180) * R;
export const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
export const lonDe = (x) => (x / R) * 180 / Math.PI;
export const latDe = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

export class NaoSuportado extends Error {}

export const estado = { chave: null, manifesto: null, raiz: 'banco/', cache: new Map(), pedidos: new Map(), fetchOriginal: null, servidor: 0, local: 0 };

// ------------------------------------------------------------------ arquivos
export async function lerArquivo(caminho) {
  if (estado.cache.has(caminho)) {
    contadores.cacheMemoria++;
    const v = estado.cache.get(caminho);
    estado.cache.delete(caminho); estado.cache.set(caminho, v); // mais recente por último
    return v;
  }
  if (estado.pedidos.has(caminho)) return estado.pedidos.get(caminho);
  const p = (async () => {
    const r = await cronometrar('baixar', () => estado.fetchOriginal(estado.raiz + caminho));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`banco local: HTTP ${r.status} em ${caminho}`);
    let bytes = new Uint8Array(await r.arrayBuffer());
    contadores.pedidos++; contadores.bytes += bytes.length;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      bytes = await cronometrar('descompactar', async () => {
        const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(s).arrayBuffer());
      });
    }
    const d = cronometrarSinc('interpretar', () => JSON.parse(new TextDecoder().decode(bytes)));
    estado.cache.set(caminho, d);
    while (estado.cache.size > 800) estado.cache.delete(estado.cache.keys().next().value);
    return d;
  })();
  estado.pedidos.set(caminho, p);
  try { return await p; } finally { estado.pedidos.delete(caminho); }
}

// ------------------------------------------------------------------ cofre (dados pessoais cifrados)
export const camposDe = (info) => (estado.chave && info.pessoais ? [...info.campos, ...info.pessoais] : info.campos);
export const b64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));

export async function decifrar(bytes) {
  const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, estado.chave, bytes.slice(12));
  return new Uint8Array(claro);
}

/** Configura o núcleo: raiz ABSOLUTA do banco, função de busca (fetch) e manifesto. */
export function configurar({ raiz, buscar, manifesto }) {
  if (raiz) estado.raiz = raiz;
  if (buscar) estado.fetchOriginal = buscar;
  if (manifesto !== undefined) estado.manifesto = manifesto;
}

/** Deriva a chave do cofre pela senha (PBKDF2) e confere no texto de teste do manifesto. Não guarda nada. */
export async function derivarChave(senha) {
  const c = estado.manifesto?.cofre;
  if (!c) throw new Error('este banco não tem cofre');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveKey']);
  const chave = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(c.sal), iterations: c.iteracoes },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  const anterior = estado.chave;
  estado.chave = chave;
  try {
    const t = new TextDecoder().decode(await decifrar(b64(c.teste)));
    if (t !== 'bussola-cofre') throw new Error('senha incorreta');
  } catch (e) {
    estado.chave = anterior;
    throw new Error('senha do cofre incorreta');
  }
  estado.chave = anterior;
  return chave;
}

/** Define (ou retira, com null) a chave do cofre; limpa o que foi lido com a chave anterior. */
export async function definirChave(chave) {
  if (chave && !(chave instanceof CryptoKey)) chave = await crypto.subtle.importKey('raw', chave, 'AES-GCM', true, ['decrypt']);
  estado.chave = chave || null;
  indicePessoas = null;
  estado.cache.clear();
}

export function limparCache() { estado.cache.clear(); }
export const chaveAtual = () => estado.chave;
export const manifestoAtual = () => estado.manifesto;

/** Arquivo de dados + campos pessoais do cofre (arquivo .pess ao lado), quando o cofre está aberto. */
export async function lerDados(caminho, info) {
  const a = await lerArquivo(caminho);
  if (!a || !info.pessoais || !estado.chave || a._p) return a;
  const pess = caminho.replace(/\.json\.gz$/, '.pess');
  try {
    const r = await cronometrar('cofre', () => estado.fetchOriginal(estado.raiz + pess));
    if (r.ok) {
      let bytes = await decifrar(new Uint8Array(await r.arrayBuffer()));
      const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      a._p = JSON.parse(new TextDecoder().decode(await new Response(s).arrayBuffer()));
    } else a._p = { v: {} };
  } catch (e) { console.warn('cofre:', pess, e); a._p = { v: {} }; }
  delete a._f;
  return a;
}

export const bancoAtivo = () => !!estado.manifesto;
export const estatisticas = () => ({ local: estado.local, servidor: estado.servidor });
export const temServico = (S) => Object.values(estado.manifesto?.servicos?.[S]?.camadas || {}).some((c) => c.geo || c.copia_de);

export function infoCamada(S, id) {
  const c = estado.manifesto?.servicos?.[S]?.camadas?.[String(id)];
  if (!c) return null;
  if (c.copia_de) {
    const [s2, i2] = String(c.copia_de).includes('/') ? c.copia_de.split('/') : [S, c.copia_de];
    const orig = estado.manifesto.servicos[s2]?.camadas?.[i2];
    return orig ? { ...orig, _s: s2, _id: i2 } : null;
  }
  return { ...c, _s: S, _id: String(id) };
}

export async function metadados(S, id) {
  return lerArquivo(`servicos/${S}/${id}.json`);
}

// ------------------------------------------------------------------ geometria
export function decodificar(geo, enc) {
  if (enc == null) return null;
  if (geo === 'ponto') {
    if (typeof enc[0] === 'number') return { tipo: 'ponto', pts: [[enc[0] / ESCALA, enc[1] / ESCALA]] };
    return { tipo: 'ponto', pts: enc.map((p) => [p[0] / ESCALA, p[1] / ESCALA]) };
  }
  const partes = enc.map((v) => {
    const out = [];
    let x = 0, y = 0;
    for (let i = 0; i < v.length; i += 2) { x += v[i]; y += v[i + 1]; out.push([x / ESCALA, y / ESCALA]); }
    return out;
  });
  return { tipo: geo, partes };
}

export function extensaoGeo(g) {
  let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
  const lista = g.tipo === 'ponto' ? [g.pts] : g.partes;
  for (const p of lista) for (const [x, y] of p) { if (x < o) o = x; if (x > l) l = x; if (y < s) s = y; if (y > n) n = y; }
  return [o, s, l, n];
}

/** Feição do arquivo -> objeto com geometria decodificada sob demanda. */
export function feicoes(arquivo, chaveBloco, info) {
  if (!arquivo) return [];
  if (arquivo._f) return arquivo._f;
  const pess = arquivo._p && info?.pessoais ? arquivo._p.v : null;
  const vazios = pess ? info.pessoais.map(() => null) : null;
  arquivo._f = arquivo.f.map(([oid, valores0, enc]) => {
    const valores = pess ? [...valores0, ...(pess[String(oid)] || vazios)] : valores0;
    const f = { oid, valores, enc, geo: arquivo.g, bloco: chaveBloco };
    Object.defineProperty(f, 'g', { get() { return this._g === undefined ? (this._g = decodificar(this.geo, this.enc)) : this._g; } });
    Object.defineProperty(f, 'ext', { get() { return this._e || (this._e = this.g ? extensaoGeo(this.g) : null); } });
    return f;
  });
  return arquivo._f;
}

export function dentroAnel(anel, x, y) {
  let d = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}
export const dentroPoligono = (aneis, x, y) => aneis.reduce((d, a) => (dentroAnel(a, x, y) ? !d : d), false);

export function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distância (em metros) do ponto à geometria; 0 se dentro do polígono. */
export function distancia(g, lon, lat) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110574;
  const px = lon * kx, py = lat * ky;
  if (g.tipo === 'area' && dentroPoligono(g.partes, lon, lat)) return 0;
  let m = Infinity;
  if (g.tipo === 'ponto') for (const [x, y] of g.pts) m = Math.min(m, Math.hypot(x * kx - px, y * ky - py));
  else for (const p of g.partes) for (let i = 1; i < p.length; i++) m = Math.min(m, distSeg(px, py, p[i - 1][0] * kx, p[i - 1][1] * ky, p[i][0] * kx, p[i][1] * ky));
  return m;
}

export function blocoDe(lon, lat, z) {
  const n = 2 ** z, s = Math.sin(lat * Math.PI / 180);
  return [Math.floor((lon + 180) / 360 * n), Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)];
}

export function blocosNaExtensao(info, ext, visao = false, contar = false) {
  const z = visao ? info.zv : info.z;
  const [x0, y1] = blocoDe(ext[0], ext[1], z), [x1, y0] = blocoDe(ext[2], ext[3], z);
  const n = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (contar) return n;
  const existentes = visao ? (info._conjV || (info._conjV = new Set(info.blocos_v || []))) : (info._conj || (info._conj = new Set(info.blocos || [])));
  const lista = [];
  if (n > 4000) throw new NaoSuportado('área grande demais para o banco local');
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (existentes.has(`${x}_${y}`)) lista.push(`${x}_${y}`);
  return lista;
}

export async function feicoesDosBlocos(info, blocos, visao = false) {
  const S = info._s, id = info._id, pasta = visao ? `v${info.zv}` : info.z;
  const caminho = (b) => (b === 'grandes' ? `dados/${S}/${id}/grandes.json.gz` : `dados/${S}/${id}/${pasta}/${b}.json.gz`);
  const lista = info.grandes && !blocos.includes('grandes') ? [...blocos, 'grandes'] : blocos;
  const arqs = await Promise.all(lista.map((b) => lerDados(caminho(b), info).then((a) => feicoes(a, visao && b !== 'grandes' ? null : b, info))));
  return arqs.flat();
}

/** Feições numa extensão: blocos detalhados de perto; de longe, a visão simplificada (se houver). */
export async function feicoesNaExtensao(info, ext) {
  if (info.z == null) return todasFeicoes(info);
  const n = blocosNaExtensao(info, ext, false, true);
  if (n > 16 && info.zv != null) return feicoesDosBlocos(info, blocosNaExtensao(info, ext, true), true);
  const blocos = blocosNaExtensao(info, ext);
  if (blocos.length > 150) throw new NaoSuportado('muitos blocos');
  return feicoesDosBlocos(info, blocos);
}

export async function todasFeicoes(info) {
  const S = info._s, id = info._id;
  if (info.z == null) return feicoes(await lerDados(`dados/${S}/${id}/todos.json.gz`, info), null, info);
  if ((info.blocos || []).length > 60) throw new NaoSuportado('camada grande: consulta sem área nem índice');
  return feicoesDosBlocos(info, info.blocos);
}

// ------------------------------------------------------------------ cláusula WHERE
/** Avaliador do subconjunto de SQL usado nas consultas ao ArcGIS. */
export function compilarWhere(texto, campos) {
  const t = String(texto || '1=1').trim();
  if (!t || /^1\s*=\s*1$/.test(t)) return () => true;
  const toks = [];
  const re = /\s*(?:('(?:[^']|'')*')|(-?\d+(?:\.\d+)?)|(>=|<=|<>|!=|=|<|>|\(|\)|,)|([A-Za-z_][\w.]*))/y;
  let m, pos = 0;
  while (pos < t.length) {
    re.lastIndex = pos;
    m = re.exec(t);
    if (!m) { if (/^\s*$/.test(t.slice(pos))) break; throw new NaoSuportado(`where: ${t}`); }
    pos = re.lastIndex;
    if (m[1] !== undefined) toks.push({ k: 's', v: m[1].slice(1, -1).replace(/''/g, "'") });
    else if (m[2] !== undefined) toks.push({ k: 'n', v: +m[2] });
    else if (m[3] !== undefined) toks.push({ k: 'o', v: m[3] });
    else toks.push({ k: 'w', v: m[4], u: m[4].toUpperCase() });
  }
  let i = 0;
  const ver = (u) => toks[i] && ((toks[i].k === 'w' && toks[i].u === u) || (toks[i].k === 'o' && toks[i].v === u));
  const pegar = () => toks[i++];
  const idx = new Map(campos.map((c, k) => [c.toUpperCase(), k]));
  function valor() {
    const tk = pegar();
    if (!tk) throw new NaoSuportado('where incompleto');
    if (tk.k === 's' || tk.k === 'n') return () => tk.v;
    if (tk.k === 'o' && tk.v === '(') { const e = valor(); if (!ver(')')) throw new NaoSuportado('('); i++; return e; }
    if (tk.k === 'w') {
      if ((tk.u === 'UPPER' || tk.u === 'LOWER' || tk.u === 'TRIM') && ver('(')) {
        i++; const e = valor(); if (!ver(')')) throw new NaoSuportado(')'); i++;
        return tk.u === 'UPPER' ? (f) => String(e(f) ?? '').toUpperCase() : tk.u === 'LOWER' ? (f) => String(e(f) ?? '').toLowerCase() : (f) => String(e(f) ?? '').trim();
      }
      if (tk.u === 'NULL') return () => null;
      const k = idx.get(tk.u) ?? idx.get(tk.u.split('.').pop());
      if (k === undefined) throw new NaoSuportado(`campo ${tk.v}`);
      return (f) => f.valores[k];
    }
    throw new NaoSuportado(`token ${tk.v}`);
  }
  const igual = (a, b) => (a == null || b == null ? false : typeof b === 'number' ? +a === b : String(a).trim() === String(b).trim() || String(a) === String(b));
  const comparar = (a, b) => (typeof b === 'number' ? (+a > b ? 1 : +a < b ? -1 : 0) : String(a ?? '').localeCompare(String(b ?? '')));
  function predicado() {
    if (ver('NOT')) { i++; const p = predicado(); return (f) => !p(f); }
    if (ver('(')) {
      const salvo = i; i++;
      try { const e = ou(); if (ver(')')) { i++; return e; } } catch (e) { if (!(e instanceof NaoSuportado)) throw e; }
      i = salvo;
    }
    const a = valor();
    if (ver('IS')) { i++; const neg = ver('NOT') ? (i++, true) : false; if (!ver('NULL')) throw new NaoSuportado('IS'); i++;
      return (f) => { const v = a(f); const nulo = v == null || v === ''; return neg ? !nulo : nulo; }; }
    let neg = false;
    if (ver('NOT')) { i++; neg = true; }
    if (ver('IN')) {
      i++; if (!ver('(')) throw new NaoSuportado('IN'); i++;
      const vs = [];
      while (!ver(')')) { vs.push(valor()(null)); if (ver(',')) i++; }
      i++;
      const conj = new Set(vs.map((v) => String(v).trim()));
      return (f) => { const r = conj.has(String(a(f) ?? '').trim()); return neg ? !r : r; };
    }
    if (ver('LIKE')) {
      i++; const pad = String(valor()(null));
      const rx = new RegExp(`^${pad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'is');
      return (f) => { const r = rx.test(String(a(f) ?? '')); return neg ? !r : r; };
    }
    if (ver('BETWEEN')) {
      i++; const b1 = valor(); if (!ver('AND')) throw new NaoSuportado('BETWEEN'); i++; const b2 = valor();
      return (f) => { const v = a(f); return comparar(v, b1(f)) >= 0 && comparar(v, b2(f)) <= 0; };
    }
    const op = pegar();
    if (!op || op.k !== 'o') throw new NaoSuportado('operador');
    const b = valor();
    switch (op.v) {
      case '=': return (f) => igual(a(f), b(f));
      case '<>': case '!=': return (f) => !igual(a(f), b(f));
      case '>': return (f) => a(f) != null && comparar(a(f), b(f)) > 0;
      case '<': return (f) => a(f) != null && comparar(a(f), b(f)) < 0;
      case '>=': return (f) => a(f) != null && comparar(a(f), b(f)) >= 0;
      case '<=': return (f) => a(f) != null && comparar(a(f), b(f)) <= 0;
      default: throw new NaoSuportado(op.v);
    }
  }
  function e() { let p = predicado(); while (ver('AND')) { i++; const q = predicado(), a = p; p = (f) => a(f) && q(f); } return p; }
  function ou() { let p = e(); while (ver('OR')) { i++; const q = e(), a = p; p = (f) => a(f) || q(f); } return p; }
  const r = ou();
  if (i < toks.length) throw new NaoSuportado(`where: ${t}`);
  return r;
}

/** Valores procurados num campo indexado (campo = 'x' ou campo IN (...)), ou null. */
export function valoresDoIndice(where, campo) {
  const t = String(where || '');
  let m = t.match(new RegExp(`^\\s*(?:upper\\s*\\(\\s*)?${campo}\\s*\\)?\\s*=\\s*'([^']*)'\\s*$`, 'i'));
  if (m) return [m[1].trim()];
  m = t.match(new RegExp(`^\\s*${campo}\\s+IN\\s*\\(([^)]*)\\)\\s*$`, 'i'));
  if (m) return m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '').trim());
  return null;
}

// ------------------------------------------------------------------ entrada (geometria da consulta)
export function geometriaDaConsulta(p) {
  if (!p.geometry) return null;
  const sr = String(p.inSR || '').includes('3857') || String(p.inSR || '').includes('102100') ? 3857 : 4326;
  let g;
  const txt = String(p.geometry).trim();
  if (txt.startsWith('{')) g = JSON.parse(txt);
  else {
    const n = txt.split(',').map(Number);
    g = n.length === 4 ? { xmin: n[0], ymin: n[1], xmax: n[2], ymax: n[3] } : { x: n[0], y: n[1] };
  }
  const srg = g.spatialReference?.wkid || g.spatialReference?.latestWkid;
  const merc = srg ? [3857, 102100, 102113, 900913].includes(srg) : sr === 3857;
  const conv = merc ? ([x, y]) => [lonDe(x), latDe(y)] : ([x, y]) => [x, y];
  if ('xmin' in g) {
    const [o, s] = conv([g.xmin, g.ymin]), [l, n] = conv([g.xmax, g.ymax]);
    return { tipo: 'env', ext: [o, s, l, n] };
  }
  if ('x' in g) { const [x, y] = conv([g.x, g.y]); return { tipo: 'pt', x, y, ext: [x, y, x, y] }; }
  if (g.rings) {
    const aneis = g.rings.map((a) => a.map(conv));
    let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
    for (const a of aneis) for (const [x, y] of a) { o = Math.min(o, x); l = Math.max(l, x); s = Math.min(s, y); n = Math.max(n, y); }
    return { tipo: 'poli', aneis, ext: [o, s, l, n] };
  }
  throw new NaoSuportado('geometria da consulta');
}

export function toca(f, q) {
  const e = f.ext;
  if (!e) return false;
  if (e[2] < q.ext[0] || e[0] > q.ext[2] || e[3] < q.ext[1] || e[1] > q.ext[3]) return false;
  if (q.tipo === 'env') return true;
  const g = f.g;
  if (q.tipo === 'pt') {
    if (g.tipo === 'area') return dentroPoligono(g.partes, q.x, q.y);
    return distancia(g, q.x, q.y) < 0.5;
  }
  // polígono: algum vértice da feição dentro, ou algum vértice da consulta dentro da feição
  const vert = g.tipo === 'ponto' ? g.pts : g.partes.flat();
  const passo = Math.max(1, Math.floor(vert.length / 40));
  for (let i = 0; i < vert.length; i += passo) if (dentroPoligono(q.aneis, vert[i][0], vert[i][1])) return true;
  if (g.tipo === 'area') for (const a of q.aneis) for (let i = 0; i < a.length; i += Math.max(1, Math.floor(a.length / 40))) if (dentroPoligono(g.partes, a[i][0], a[i][1])) return true;
  return false;
}

// ------------------------------------------------------------------ saída no formato do ArcGIS
export const TIPO_ESRI = { ponto: 'esriGeometryPoint', linha: 'esriGeometryPolyline', area: 'esriGeometryPolygon' };

export function geometriaEsri(g, merc, casas) {
  if (!g) return null;
  const r = casas == null ? (v) => v : ((k) => (v) => Math.round(v * k) / k)(10 ** casas);
  const c = merc ? ([x, y]) => [r(mx(x)), r(my(y))] : ([x, y]) => [r(x), r(y)];
  if (g.tipo === 'ponto') {
    if (g.pts.length === 1) { const [x, y] = c(g.pts[0]); return { x, y }; }
    return { points: g.pts.map(c) };
  }
  return g.tipo === 'linha' ? { paths: g.partes.map((p) => p.map(c)) } : { rings: g.partes.map((p) => p.map(c)) };
}

export function saidaDe(info, meta, lista, p, merc) {
  const campos = camposDe(info);
  const pedidos = String(p.outFields || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const todos = pedidos.includes('*');
  const ks = todos ? campos.map((_, k) => k) : pedidos.map((n) => campos.findIndex((c) => c.toLowerCase() === n.toLowerCase())).filter((k) => k >= 0);
  const comGeo = String(p.returnGeometry ?? 'true') !== 'false';
  const casas = p.geometryPrecision != null && p.geometryPrecision !== '' ? +p.geometryPrecision : null;
  const fields = (meta?.fields || []).filter((f) => todos || ks.some((k) => campos[k] === f.name));
  return {
    displayFieldName: meta?.displayField || '', objectIdFieldName: info.oid || 'OBJECTID',
    geometryType: TIPO_ESRI[info.geo], spatialReference: { wkid: merc ? 102100 : 4326, latestWkid: merc ? 3857 : 4326 },
    fields,
    features: lista.map((f) => {
      const attributes = {};
      for (const k of ks) attributes[campos[k]] = f.valores[k];
      const o = { attributes };
      if (comGeo && info.geo) o.geometry = geometriaEsri(f.g, merc, casas);
      return o;
    }),
  };
}

// ------------------------------------------------------------------ query
export const oidsConhecidos = new Map(); // "S/id" -> Map(oid -> bloco)

export async function candidatos(info, p) {
  const chave = `${info._s}/${info._id}`;
  const q = geometriaDaConsulta(p);
  // cadastro imobiliário: agrupado pela inscrição do lote
  if (info.agrupado === 'ci') {
    const vs = valoresDoIndice(p.where, 'ci');
    if (!vs) throw new NaoSuportado('cadastro: só por inscrição do lote (ci)');
    const pres = [...new Set(vs.map((v) => v.slice(0, 5)))];
    const arqs = await Promise.all(pres.map((pre) => lerDados(`dados/${info._s}/${info._id}/ci/${pre}.json.gz`, info)));
    return { lista: arqs.flatMap((a) => feicoes(a, null, info)), q };
  }
  if (p.objectIds) {
    const ids = String(p.objectIds).split(',').map(Number);
    if (info.z == null) return { lista: (await todasFeicoes(info)).filter((f) => ids.includes(+f.oid)), q, ids: new Set(ids) };
    const mapa = oidsConhecidos.get(chave);
    const blocos = new Set();
    for (const id of ids) { const b = mapa?.get(id); if (b == null) throw new NaoSuportado('objectIds sem bloco conhecido'); blocos.add(b); }
    return { lista: await feicoesDosBlocos(info, [...blocos]), q, ids: new Set(ids) };
  }
  if (q) {
    return { lista: await feicoesNaExtensao(info, q.ext), q };
  }
  for (const campo of info.indices || []) {
    const vs = valoresDoIndice(p.where, campo);
    if (!vs) continue;
    const baldes = [...new Set(vs.map((v) => v.slice(-2).replace(/[/ ]/g, '_') || '_'))];
    const idx = await Promise.all(baldes.map((b) => lerArquivo(`dados/${info._s}/${info._id}/indice-${campo}/${b}.json.gz`)));
    const blocos = new Set();
    for (const v of vs) for (const m of idx) for (const b of (m?.[v] || [])) blocos.add(b);
    return { lista: await feicoesDosBlocos(info, [...blocos]), q };
  }
  return { lista: await todasFeicoes(info), q };
}

export async function consultar(S, id, p) {
  return cronometrar('filtrar', () => consultarSemMedida(S, id, p));
}

export async function consultarSemMedida(S, id, p) {
  const info = infoCamada(S, id);
  if (!info) throw new NaoSuportado(`${S}/${id} fora do banco`);
  if (p.outStatistics || p.groupByFieldsForStatistics || p.returnDistinctValues === 'true') throw new NaoSuportado('estatísticas');
  const meta = await metadados(info._s, info._id);
  const { lista, q, ids } = await candidatos(info, p);
  const filtro = compilarWhere(p.where, camposDe(info));
  const vistos = new Set();
  let out = [];
  const chave = `${info._s}/${info._id}`;
  if (!oidsConhecidos.has(chave)) oidsConhecidos.set(chave, new Map());
  const conhecidos = oidsConhecidos.get(chave);
  for (const f of lista) {
    if (vistos.has(f.oid)) continue;
    if (ids && !ids.has(+f.oid)) continue;
    if (q && !toca(f, q)) continue;
    if (!filtro(f)) continue;
    vistos.add(f.oid);
    if (f.bloco != null) conhecidos.set(+f.oid, f.bloco);
    out.push(f);
  }
  if (!out.length && info.incompleta && !q) throw new NaoSuportado('camada sem total conhecido e sem resultado no banco');
  if (p.returnCountOnly === 'true') return { count: out.length };
  if (p.returnIdsOnly === 'true') return { objectIdFieldName: info.oid || 'OBJECTID', objectIds: out.map((f) => f.oid) };
  if (p.orderByFields) {
    const ord = String(p.orderByFields).split(',').map((s) => s.trim().split(/\s+/)).map(([c, d]) => [camposDe(info).findIndex((x) => x.toLowerCase() === c.toLowerCase()), /desc/i.test(d || '') ? -1 : 1]).filter(([k]) => k >= 0);
    out.sort((a, b) => { for (const [k, d] of ord) { const x = a.valores[k], y = b.valores[k]; if (x === y) continue; return (x == null ? -1 : y == null ? 1 : x > y ? 1 : -1) * d; } return 0; });
  }
  const ini = +(p.resultOffset || 0), qtd = p.resultRecordCount ? +p.resultRecordCount : Infinity;
  const limite = Math.min(qtd, 1000000);
  const total = out.length;
  out = out.slice(ini, ini + limite);
  const merc = /^(3857|102100|102113|900913)$/.test(String(p.outSR || '').replace(/[^0-9]/g, '')) || /3857|102100/.test(String(p.outSR || ''));
  const r = saidaDe(info, meta, out, p, merc);
  if (ini + limite < total) r.exceededTransferLimit = true;
  return r;
}

// ------------------------------------------------------------------ identify
export async function identificar(S, p) {
  const servico = estado.manifesto.servicos[S];
  if (!servico) throw new NaoSuportado('serviço fora do banco');
  const [modo, lista] = String(p.layers || 'all').split(':');
  let ids = lista ? lista.split(',').map(Number) : Object.keys(servico.camadas).map(Number);
  const geo = typeof p.geometry === 'string' && p.geometry.trim().startsWith('{') ? JSON.parse(p.geometry) : null;
  const merc = /3857|102100/.test(String(p.sr || '')) || (geo?.spatialReference?.wkid && [3857, 102100].includes(geo.spatialReference.wkid));
  let x, y;
  if (geo && 'x' in geo) { x = geo.x; y = geo.y; } else { [x, y] = String(p.geometry).split(',').map(Number); }
  const lon = merc ? lonDe(x) : x, lat = merc ? latDe(y) : y;
  // tolerância em metros a partir da extensão e da tela
  const ext = String(p.mapExtent || '').split(',').map(Number), tela = String(p.imageDisplay || '').split(',').map(Number);
  let mpp = 1;
  if (ext.length === 4 && tela[0]) {
    mpp = (ext[2] - ext[0]) / tela[0];
    if (merc) mpp *= Math.cos(lat * Math.PI / 180); else mpp *= 111320 * Math.cos(lat * Math.PI / 180);
  }
  const tol = Math.max(0.5, (+p.tolerance || 0) * mpp);
  const graus = tol / 100000 + 1e-6;
  const casas = p.geometryPrecision != null && p.geometryPrecision !== '' ? +p.geometryPrecision : null;
  const comGeo = String(p.returnGeometry ?? 'true') !== 'false';
  const resultados = [];
  for (const id of ids) {
    const info = infoCamada(S, id);
    if (!info || !info.geo) continue;
    if (modo === 'top' && resultados.length) break;
    const meta = await metadados(info._s, info._id);
    if (meta?.type === 'Group Layer') continue;
    let feats;
    try {
      feats = info.z == null ? await todasFeicoes(info)
        : await feicoesDosBlocos(info, blocosNaExtensao(info, [lon - graus, lat - graus, lon + graus, lat + graus]));
    } catch (e) { if (e instanceof NaoSuportado) continue; throw e; }
    const vistos = new Set(), achados = [];
    for (const f of feats) {
      if (vistos.has(f.oid) || !f.ext) continue;
      const e = f.ext;
      if (lon < e[0] - graus || lon > e[2] + graus || lat < e[1] - graus || lat > e[3] + graus) continue;
      const d = distancia(f.g, lon, lat);
      if (d > tol) continue;
      vistos.add(f.oid);
      achados.push([d, f]);
    }
    achados.sort((a, b) => a[0] - b[0]); // o que contém o ponto primeiro, depois o mais próximo
    for (const [, f] of achados) {
      const attributes = {};
      camposDe(info).forEach((c, k) => { attributes[c] = f.valores[k]; });
      const disp = meta?.displayField || info.display;
      resultados.push({ layerId: +id, layerName: meta?.name || info.nome, displayFieldName: disp || '',
        value: disp != null && attributes[disp] != null ? String(attributes[disp]) : String(f.oid),
        attributes, geometryType: TIPO_ESRI[info.geo], geometry: comGeo ? { ...geometriaEsri(f.g, merc, casas), spatialReference: { wkid: merc ? 102100 : 4326 } } : undefined });
    }
  }
  return { results: resultados };
}

// ------------------------------------------------------------------ busca de pessoas (cofre aberto)
// Com os dados complementares liberados, a busca do topo acha pessoas pelo nome ou pelo CPF/CNPJ nos cadastros
// que trazem esses campos. O índice é montado uma vez, no próprio navegador, só a partir dos arquivos cifrados
// (.pess) e só enquanto o cofre está aberto; nada é gravado em disco nem enviado a lugar nenhum.
export const PESSOAS = [
  { S: 'Mapa_Tributario_Web', id: '0', nome: 'PROPRIETAR', doc: 'CPF_CNPJ', rotulo: 'Proprietário (cadastro tributário)' },
  { S: 'Mapa_UsoDoSoloNew', id: '16', nome: 'nmcontrib', doc: 'cpf_cgc', rotulo: 'Contribuinte (vazios urbanos)' },
];
export const semAcentoP = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
export let indicePessoas = null;

export async function lerPess(caminho) {
  const r = await estado.fetchOriginal(estado.raiz + caminho);
  if (!r.ok) return null;
  const bytes = await decifrar(new Uint8Array(await r.arrayBuffer()));
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(new TextDecoder().decode(await new Response(s).arrayBuffer()));
}

export async function montarIndicePessoas() {
  const itens = [];
  for (const P of PESSOAS) {
    const info = infoCamada(P.S, P.id);
    if (!info?.pessoais) continue;
    const kN = info.pessoais.indexOf(P.nome), kD = info.pessoais.indexOf(P.doc);
    const base = `dados/${info._s}/${info._id}`;
    const arqs = info.z == null ? [[`${base}/todos.pess`, null]]
      : [...(info.blocos || []).map((b) => [`${base}/${info.z}/${b}.pess`, b]), ...(info.grandes ? [[`${base}/grandes.pess`, 'grandes']] : [])];
    for (let i = 0; i < arqs.length; i += 12) {
      await Promise.all(arqs.slice(i, i + 12).map(async ([caminho, bloco]) => {
        let p = null;
        try { p = await lerPess(caminho); } catch { return; }
        if (!p?.v) return;
        await new Promise((ok) => setTimeout(ok, 0)); // devolve a vez à tela entre arquivos (sem travar)
        for (const [oid, v] of Object.entries(p.v)) {
          const nome = String(v[kN] ?? '').trim(), doc = String(v[kD] ?? '').replace(/\D/g, '');
          if (!nome && !doc) continue;
          itens.push({ P, bloco, oid, nome, doc, n: semAcentoP(nome) });
        }
      }));
    }
  }
  return itens;
}

/** Pessoas pelo nome (todas as palavras) ou pelo CPF/CNPJ (dígitos). Agrupa os vínculos por pessoa. */
export async function buscarPessoas(texto, limite = 15) {
  if (!estado.chave) return [];
  if (!indicePessoas) indicePessoas = montarIndicePessoas().catch((e) => { indicePessoas = null; throw e; });
  const idx = await indicePessoas;
  const t = String(texto || '').trim(), dig = t.replace(/\D/g, '');
  const numerico = dig.length >= 5 && /^[\d.\s/-]+$/.test(t);
  const palavras = semAcentoP(t).split(' ').filter((p) => p.length >= 2);
  if (!numerico && (!palavras.length || semAcentoP(t).length < 4)) return [];
  const pessoas = new Map();
  for (const i of idx) {
    if (numerico ? !i.doc.includes(dig) : !palavras.every((p) => i.n.includes(p))) continue;
    const k = i.doc || i.n;
    if (!pessoas.has(k)) pessoas.set(k, { nome: i.nome, doc: i.doc, vinculos: [] });
    const p = pessoas.get(k);
    if (!p.nome && i.nome) p.nome = i.nome;
    p.vinculos.push({ S: i.P.S, id: i.P.id, rotulo: i.P.rotulo, bloco: i.bloco, oid: i.oid });
    if (pessoas.size > limite * 4) break;
  }
  return [...pessoas.values()].sort((a, b) => b.vinculos.length - a.vinculos.length).slice(0, limite);
}

/** Geometria (lon/lat) e dados de cada vínculo de uma pessoa, para destacar no mapa e mostrar na ficha. */
export async function vinculosDaPessoa(vinculos) {
  const saida = [];
  for (const v of vinculos.slice(0, 60)) {
    const info = infoCamada(v.S, v.id);
    if (!info) continue;
    const base = `dados/${info._s}/${info._id}`;
    const caminho = v.bloco == null ? `${base}/todos.json.gz` : v.bloco === 'grandes' ? `${base}/grandes.json.gz` : `${base}/${info.z}/${v.bloco}.json.gz`;
    const fs = feicoes(await lerDados(caminho, info), v.bloco, info);
    const f = fs.find((x) => String(x.oid) === String(v.oid));
    if (!f) continue;
    const campos = camposDe(info);
    saida.push({ ...v, aneis: f.g?.partes || [], atributos: Object.fromEntries(campos.map((c, k) => [c, f.valores[k]])) });
  }
  return saida;
}

/** Fecha o cofre também apaga o índice de pessoas da memória. */
export function esquecerPessoas() { indicePessoas = null; }


/** Legenda do serviço (servicos/S/legend.json). */
export const legenda = (S) => lerArquivo(`servicos/${S}/legend.json`);

/** Feições de uma camada numa extensão (Web Mercator), para o desenho dos temas (usado a partir do passo 6). */
export async function feicoesParaDesenho(S, camada, ext) {
  const info = infoCamada(S, camada);
  return info ? feicoesNaExtensao(info, ext) : [];
}

/** Fábrica pedida pelo roteiro: o mesmo núcleo, configurado, com a interface de consulta. */
export function criarNucleo({ raiz, buscar, manifesto }) {
  configurar({ raiz, buscar, manifesto });
  return { consultar, identificar, metadados, legenda, definirChave, limparCache, feicoesParaDesenho, buscarPessoas, vinculosDaPessoa };
}
