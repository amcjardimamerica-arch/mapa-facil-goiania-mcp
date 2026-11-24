// Banco local: os dados do Mapa Fácil extraídos para o próprio site (docs/banco/).
// Responde no lugar do servidor da Prefeitura às mesmas perguntas que o sistema fazia a ele
// (query, identify, legenda e metadados), e desenha os temas do painel Camadas a partir dos dados.
// Só o que o banco não sabe responder segue para o servidor municipal, se ele estiver no ar.
import { cronometrar, cronometrarSinc, contadores } from './desempenho.js';
import { CFG } from './config.js';

const Cesium = window.Cesium;
const R = 6378137;
const ESCALA = 1e6;
const mx = (lon) => (lon * Math.PI / 180) * R;
const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
const lonDe = (x) => (x / R) * 180 / Math.PI;
const latDe = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

export class NaoSuportado extends Error {}

const estado = { chave: null, manifesto: null, raiz: 'banco/', cache: new Map(), pedidos: new Map(), fetchOriginal: null, servidor: 0, local: 0 };

// ------------------------------------------------------------------ arquivos
async function lerArquivo(caminho) {
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
const camposDe = (info) => (estado.chave && info.pessoais ? [...info.campos, ...info.pessoais] : info.campos);
const b64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));

async function decifrar(bytes) {
  const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, estado.chave, bytes.slice(12));
  return new Uint8Array(claro);
}

export const cofreDisponivel = () => !!estado.manifesto?.cofre;
export const cofreAberto = () => !!estado.chave;

/** Abre o cofre com a senha: deriva a chave (PBKDF2) e confere no texto de teste do manifesto. */
export async function abrirCofre(senha) {
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
  // Liberado por 24 horas para este usuário, neste aparelho (a senha não é guardada; só a chave derivada).
  try { localStorage.setItem(chaveGuardada(), JSON.stringify({ k: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', chave)))), ate: Date.now() + 24 * 3600e3 })); } catch { /* sem armazenamento */ }
  estado.cache.clear();
  return true;
}

export function fecharCofre() {
  estado.chave = null;
  try { localStorage.removeItem(chaveGuardada()); sessionStorage.removeItem('bussola:cofre'); } catch { /* */ }
  estado.cache.clear();
}

const chaveGuardada = () => `bussola:cofre:${window.bussolaSessao?.login || 'anonimo'}`;
/** Até quando os dados complementares estão liberados para este usuário (ou null). */
export function cofreLiberadoAte() {
  try { const g = JSON.parse(localStorage.getItem(chaveGuardada()) || 'null'); return g && g.ate > Date.now() ? new Date(g.ate) : null; } catch { return null; }
}
/** Campos pessoais (do cofre) de uma camada, para mostrar com cadeado quando o cofre está fechado. */
export const camposPessoais = (S, id) => estado.manifesto?.servicos?.[S]?.camadas?.[String(id)]?.pessoais || [];

async function restaurarCofre() {
  try {
    const g = JSON.parse(localStorage.getItem(chaveGuardada()) || 'null');
    if (g && g.ate > Date.now() && estado.manifesto?.cofre) estado.chave = await crypto.subtle.importKey('raw', b64(g.k), 'AES-GCM', true, ['decrypt']);
    else if (g) localStorage.removeItem(chaveGuardada()); // venceram as 24 horas
  } catch { estado.chave = null; }
}

/** Arquivo de dados + campos pessoais do cofre (arquivo .pess ao lado), quando o cofre está aberto. */
async function lerDados(caminho, info) {
  const a = await lerArquivo(caminho);
  if (!a || !info.pessoais || !estado.chave || a._p) return a;
  const pess = caminho.replace(/\.json\.gz$/, '.pess');
  try {
    const r = await estado.fetchOriginal(estado.raiz + pess);
    if (r.ok) {
      let bytes = await decifrar(new Uint8Array(await r.arrayBuffer()));
      const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      a._p = JSON.parse(new TextDecoder().decode(await new Response(s).arrayBuffer()));
    } else a._p = { v: {} };
  } catch (e) { console.warn('cofre:', pess, e); a._p = { v: {} }; }
  delete a._f;
  return a;
}

export async function iniciarBanco() {
  try {
    estado.fetchOriginal = window.fetch.bind(window);
    const r = await estado.fetchOriginal(`${estado.raiz}manifesto.json`, { cache: 'no-cache' });
    if (!r.ok) return null;
    estado.manifesto = await r.json();
    await restaurarCofre();
    instalarInterceptador();
    return estado.manifesto;
  } catch (e) {
    console.warn('Banco local indisponível:', e);
    return null;
  }
}
export const bancoAtivo = () => !!estado.manifesto;
export const estatisticas = () => ({ local: estado.local, servidor: estado.servidor });
export const temServico = (S) => Object.values(estado.manifesto?.servicos?.[S]?.camadas || {}).some((c) => c.geo || c.copia_de);
/** Blocos de imagem guardados no site (serviços que só existem como imagem, ex.: Mapa Básico). */
export function imagemLocal(S) {
  const b = estado.manifesto?.imagens?.[S];
  if (!b) return null;
  const p = new Cesium.UrlTemplateImageryProvider({
    url: `${estado.raiz}blocos/${S}/{z}/{x}/{y}.${b.formato || 'png'}`, minimumLevel: b.min, maximumLevel: b.max,
    rectangle: Cesium.Rectangle.fromDegrees(...b.extensao), credit: `${S}: Prefeitura de Goiânia (Mapa Fácil) · banco local`,
    enablePickFeatures: false, tileDiscardPolicy: new Cesium.NeverTileDiscardPolicy(),
  });
  // Só existem blocos que tocam Goiânia: os do retângulo que ficam fora dela faltam de propósito.
  p.errorEvent.addEventListener((erro) => { if (erro) erro.retry = false; });
  return p;
}

function infoCamada(S, id) {
  const c = estado.manifesto?.servicos?.[S]?.camadas?.[String(id)];
  if (!c) return null;
  if (c.copia_de) {
    const [s2, i2] = String(c.copia_de).includes('/') ? c.copia_de.split('/') : [S, c.copia_de];
    const orig = estado.manifesto.servicos[s2]?.camadas?.[i2];
    return orig ? { ...orig, _s: s2, _id: i2 } : null;
  }
  return { ...c, _s: S, _id: String(id) };
}

async function metadados(S, id) {
  return lerArquivo(`servicos/${S}/${id}.json`);
}

// ------------------------------------------------------------------ geometria
function decodificar(geo, enc) {
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

function extensaoGeo(g) {
  let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
  const lista = g.tipo === 'ponto' ? [g.pts] : g.partes;
  for (const p of lista) for (const [x, y] of p) { if (x < o) o = x; if (x > l) l = x; if (y < s) s = y; if (y > n) n = y; }
  return [o, s, l, n];
}

/** Feição do arquivo -> objeto com geometria decodificada sob demanda. */
function feicoes(arquivo, chaveBloco, info) {
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

function dentroAnel(anel, x, y) {
  let d = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}
const dentroPoligono = (aneis, x, y) => aneis.reduce((d, a) => (dentroAnel(a, x, y) ? !d : d), false);

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distância (em metros) do ponto à geometria; 0 se dentro do polígono. */
function distancia(g, lon, lat) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110574;
  const px = lon * kx, py = lat * ky;
  if (g.tipo === 'area' && dentroPoligono(g.partes, lon, lat)) return 0;
  let m = Infinity;
  if (g.tipo === 'ponto') for (const [x, y] of g.pts) m = Math.min(m, Math.hypot(x * kx - px, y * ky - py));
  else for (const p of g.partes) for (let i = 1; i < p.length; i++) m = Math.min(m, distSeg(px, py, p[i - 1][0] * kx, p[i - 1][1] * ky, p[i][0] * kx, p[i][1] * ky));
  return m;
}

function blocoDe(lon, lat, z) {
  const n = 2 ** z, s = Math.sin(lat * Math.PI / 180);
  return [Math.floor((lon + 180) / 360 * n), Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)];
}

function blocosNaExtensao(info, ext, visao = false, contar = false) {
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

async function feicoesDosBlocos(info, blocos, visao = false) {
  const S = info._s, id = info._id, pasta = visao ? `v${info.zv}` : info.z;
  const caminho = (b) => (b === 'grandes' ? `dados/${S}/${id}/grandes.json.gz` : `dados/${S}/${id}/${pasta}/${b}.json.gz`);
  const lista = info.grandes && !blocos.includes('grandes') ? [...blocos, 'grandes'] : blocos;
  const arqs = await Promise.all(lista.map((b) => lerDados(caminho(b), info).then((a) => feicoes(a, visao && b !== 'grandes' ? null : b, info))));
  return arqs.flat();
}

/** Feições numa extensão: blocos detalhados de perto; de longe, a visão simplificada (se houver). */
async function feicoesNaExtensao(info, ext) {
  if (info.z == null) return todasFeicoes(info);
  const n = blocosNaExtensao(info, ext, false, true);
  if (n > 16 && info.zv != null) return feicoesDosBlocos(info, blocosNaExtensao(info, ext, true), true);
  const blocos = blocosNaExtensao(info, ext);
  if (blocos.length > 150) throw new NaoSuportado('muitos blocos');
  return feicoesDosBlocos(info, blocos);
}

async function todasFeicoes(info) {
  const S = info._s, id = info._id;
  if (info.z == null) return feicoes(await lerDados(`dados/${S}/${id}/todos.json.gz`, info), null, info);
  if ((info.blocos || []).length > 60) throw new NaoSuportado('camada grande: consulta sem área nem índice');
  return feicoesDosBlocos(info, info.blocos);
}

// ------------------------------------------------------------------ cláusula WHERE
/** Avaliador do subconjunto de SQL usado nas consultas ao ArcGIS. */
function compilarWhere(texto, campos) {
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
function valoresDoIndice(where, campo) {
  const t = String(where || '');
  let m = t.match(new RegExp(`^\\s*(?:upper\\s*\\(\\s*)?${campo}\\s*\\)?\\s*=\\s*'([^']*)'\\s*$`, 'i'));
  if (m) return [m[1].trim()];
  m = t.match(new RegExp(`^\\s*${campo}\\s+IN\\s*\\(([^)]*)\\)\\s*$`, 'i'));
  if (m) return m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '').trim());
  return null;
}

// ------------------------------------------------------------------ entrada (geometria da consulta)
function geometriaDaConsulta(p) {
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

function toca(f, q) {
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
const TIPO_ESRI = { ponto: 'esriGeometryPoint', linha: 'esriGeometryPolyline', area: 'esriGeometryPolygon' };

function geometriaEsri(g, merc, casas) {
  if (!g) return null;
  const r = casas == null ? (v) => v : ((k) => (v) => Math.round(v * k) / k)(10 ** casas);
  const c = merc ? ([x, y]) => [r(mx(x)), r(my(y))] : ([x, y]) => [r(x), r(y)];
  if (g.tipo === 'ponto') {
    if (g.pts.length === 1) { const [x, y] = c(g.pts[0]); return { x, y }; }
    return { points: g.pts.map(c) };
  }
  return g.tipo === 'linha' ? { paths: g.partes.map((p) => p.map(c)) } : { rings: g.partes.map((p) => p.map(c)) };
}

function saidaDe(info, meta, lista, p, merc) {
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
const oidsConhecidos = new Map(); // "S/id" -> Map(oid -> bloco)

async function candidatos(info, p) {
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
  return cronometrar('consultar', () => consultarSemMedida(S, id, p));
}

async function consultarSemMedida(S, id, p) {
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

// ------------------------------------------------------------------ interceptador de fetch
function parametrosDe(url, init) {
  const p = Object.fromEntries(new URL(url).searchParams);
  const corpo = init?.body;
  if (corpo) {
    const extra = corpo instanceof URLSearchParams ? corpo : typeof corpo === 'string' ? new URLSearchParams(corpo) : corpo instanceof FormData ? corpo : null;
    if (extra) for (const [k, v] of extra.entries()) p[k] = v;
  }
  return p;
}

async function responderLocal(url, init) {
  const base = `${CFG.ms}/`;
  const resto = url.split('?')[0].slice(base.length);
  const m = resto.match(/^([^/]+)\/MapServer(?:\/(\d+))?(?:\/(query|identify|legend))?\/?$/);
  if (!m) throw new NaoSuportado(resto);
  const [, S, id, op] = m;
  if (!temServico(S)) throw new NaoSuportado(`${S} fora do banco`);
  const p = parametrosDe(url, init);
  if (op === 'query' && id != null) return consultar(S, +id, p);
  if (op === 'identify' && id == null) return identificar(S, p);
  if (op === 'legend' && id == null) { const l = await lerArquivo(`servicos/${S}/legend.json`); if (l) return l; }
  if (!op && id != null) { const l = await metadados(S, id); if (l) return l; }
  if (!op && id == null) { const l = await lerArquivo(`servicos/${S}/MapServer.json`); if (l) return l; }
  throw new NaoSuportado(resto);
}

function instalarInterceptador() {
  const original = estado.fetchOriginal;
  window.fetch = async (entrada, init) => {
    const url = typeof entrada === 'string' ? entrada : entrada?.url;
    if (url && url.startsWith(`${CFG.ms}/`) && (!init?.method || ['GET', 'POST'].includes(String(init.method).toUpperCase()))) {
      try {
        const d = await responderLocal(url, init);
        estado.local++;
        return new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        if (!(e instanceof NaoSuportado)) console.warn('Banco local:', e);
        else console.info(`Banco local sem resposta (${e.message}): ${url.split('?')[0]}`);
        const servico = url.slice(`${CFG.ms}/`.length).split('/')[0];
        if (CFG.bancoSoLocal || (CFG.servicosSoLocais || []).includes(servico)) return new Response(JSON.stringify({ error: { code: 400, message: `Consulta fora do banco local: ${e.message}` } }), { status: 200 });
        estado.servidor++;
      }
    }
    return original(entrada, init);
  };
}

// ------------------------------------------------------------------ desenho dos temas (substitui o "export")
const PT = 96 / 72; // pontos -> pixels

function corCss(c, alfaExtra = 1) {
  if (!c) return null;
  return `rgba(${c[0]},${c[1]},${c[2]},${((c[3] ?? 255) / 255) * alfaExtra})`;
}

const imagens = new Map();
function imagemDe(sim) {
  const chave = sim.url || sim.imageData?.slice(0, 64) + (sim.imageData?.length || 0);
  if (imagens.has(chave)) return imagens.get(chave);
  const img = new Image();
  const p = new Promise((ok) => { img.onload = () => ok(img); img.onerror = () => ok(null); });
  img.src = sim.imageData ? `data:${sim.contentType || 'image/png'};base64,${sim.imageData}` : sim.url;
  const r = { img, p };
  imagens.set(chave, r);
  return r;
}

function simboloDe(renderer, valores, campos) {
  if (!renderer) return null;
  const v = (nome) => { if (!nome) return undefined; const k = campos.findIndex((c) => c.toLowerCase() === String(nome).toLowerCase() || c.toLowerCase().endsWith(`.${String(nome).toLowerCase()}`)); return k >= 0 ? valores[k] : undefined; };
  if (renderer.type === 'simple') return renderer.symbol;
  if (renderer.type === 'uniqueValue') {
    const partes = [renderer.field1, renderer.field2, renderer.field3].filter(Boolean).map((f) => { const x = v(f); return x == null ? '<Null>' : String(x).trim(); });
    const chave = partes.join(renderer.fieldDelimiter || ',');
    if (!renderer._mapa) { renderer._mapa = new Map(); for (const u of renderer.uniqueValueInfos || []) renderer._mapa.set(String(u.value).trim(), u.symbol); }
    return renderer._mapa.get(chave) || renderer._mapa.get(partes[0]) || renderer.defaultSymbol || null;
  }
  if (renderer.type === 'classBreaks') {
    const x = +v(renderer.field);
    if (!Number.isFinite(x)) return renderer.defaultSymbol || null;
    let min = renderer.minValue ?? -Infinity;
    for (const c of renderer.classBreakInfos || []) {
      const lo = c.classMinValue ?? min;
      if (x >= lo && x <= c.classMaxValue) return c.symbol;
      min = c.classMaxValue;
    }
    return renderer.defaultSymbol || null;
  }
  return null;
}

function tracejado(estilo, largura) {
  const w = Math.max(1, largura);
  return { esriSLSDash: [4 * w, 3 * w], esriSLSDot: [w, 2 * w], esriSLSDashDot: [4 * w, 2 * w, w, 2 * w], esriSLSDashDotDot: [4 * w, 2 * w, w, 2 * w, w, 2 * w], esriSLSShortDash: [2 * w, 2 * w], esriSLSLongDash: [8 * w, 3 * w] }[estilo] || [];
}

function desenharMarcador(g, sim, px, py, alfa) {
  if (sim.type === 'esriPMS') {
    const { img } = imagemDe(sim);
    if (!img.complete || !img.naturalWidth) return;
    const w = (sim.width || 12) * PT, h = (sim.height || 12) * PT;
    g.save(); g.globalAlpha = alfa; g.translate(px + (sim.xoffset || 0) * PT, py - (sim.yoffset || 0) * PT);
    if (sim.angle) g.rotate(-sim.angle * Math.PI / 180);
    g.drawImage(img, -w / 2, -h / 2, w, h); g.restore();
    return;
  }
  if (sim.type !== 'esriSMS') return;
  const r = ((sim.size || 6) * PT) / 2;
  g.beginPath();
  switch (sim.style) {
    case 'esriSMSSquare': g.rect(px - r, py - r, 2 * r, 2 * r); break;
    case 'esriSMSDiamond': g.moveTo(px, py - r); g.lineTo(px + r, py); g.lineTo(px, py + r); g.lineTo(px - r, py); g.closePath(); break;
    case 'esriSMSTriangle': g.moveTo(px, py - r); g.lineTo(px + r, py + r); g.lineTo(px - r, py + r); g.closePath(); break;
    case 'esriSMSCross': g.moveTo(px - r, py); g.lineTo(px + r, py); g.moveTo(px, py - r); g.lineTo(px, py + r); break;
    case 'esriSMSX': g.moveTo(px - r, py - r); g.lineTo(px + r, py + r); g.moveTo(px + r, py - r); g.lineTo(px - r, py + r); break;
    default: g.arc(px, py, r, 0, 2 * Math.PI);
  }
  const linha = ['esriSMSCross', 'esriSMSX'].includes(sim.style);
  if (!linha && sim.color) { g.fillStyle = corCss(sim.color, alfa); g.fill(); }
  const o = sim.outline;
  if (linha || (o && o.color && o.width)) { g.lineWidth = Math.max(1, (o?.width || 1) * PT); g.strokeStyle = corCss(o?.color || sim.color, alfa); g.stroke(); }
}

const ESCALA_N0 = 591657527.591555 * Math.cos(16.68 * Math.PI / 180); // escala real no nível 0 em Goiânia

export class ProvedorTema {
  /** Desenha as camadas escolhidas de um tema a partir do banco local, como a imagem "export" do portal. */
  constructor({ servico, camadas, retangulo, tamanho = 512, credito }) {
    this.S = servico;
    this.ids = camadas;
    this._T = tamanho; this._ret = retangulo;
    this._grade = new Cesium.WebMercatorTilingScheme();
    this._erro = new Cesium.Event();
    this._credito = credito ? new Cesium.Credit(credito) : undefined;
    this._metas = null;
  }
  get tileWidth() { return this._T; }
  get tileHeight() { return this._T; }
  get minimumLevel() { return this._ret ? 9 : 0; }
  get maximumLevel() { return 21; }
  get tilingScheme() { return this._grade; }
  get rectangle() { return this._ret || this._grade.rectangle; }
  get tileDiscardPolicy() { return undefined; }
  get errorEvent() { return this._erro; }
  get credit() { return this._credito; }
  get proxy() { return undefined; }
  get hasAlphaChannel() { return true; }
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(true); }
  getTileCredits() { return undefined; }
  pickFeatures() { return undefined; }

  async _carregarMetas() {
    if (this._metas) return this._metas;
    const metas = await Promise.all(this.ids.map(async (id) => ({ id, info: infoCamada(this.S, id), meta: await metadados(this.S, id) })));
    // ArcGIS desenha a camada de id maior primeiro (por baixo)
    this._metas = metas.filter((m) => m.info && m.meta).sort((a, b) => b.id - a.id);
    for (const m of this._metas) for (const s of this._simbolos(m.meta.drawingInfo?.renderer)) if (s?.type === 'esriPMS' || s?.type === 'esriPFS') imagemDe(s);
    await Promise.all([...imagens.values()].map((i) => i.p));
    return this._metas;
  }

  _simbolos(r) {
    if (!r) return [];
    return [r.symbol, r.defaultSymbol, ...(r.uniqueValueInfos || []).map((u) => u.symbol), ...(r.classBreakInfos || []).map((c) => c.symbol)].filter(Boolean);
  }

  _visivel(meta, nivel) {
    const escala = ESCALA_N0 / 2 ** nivel;
    if (meta.minScale && escala > meta.minScale) return false;
    if (meta.maxScale && escala < meta.maxScale) return false;
    return true;
  }

  requestImage(x, y, nivel) {
    return this._desenhar(x, y, nivel).catch((e) => { console.warn('tema local', this.S, e); return this._tela(); });
  }

  _tela() { const c = document.createElement('canvas'); c.width = c.height = this._T; return c; }

  async _desenhar(x, y, nivel) {
    return cronometrar('desenhar-tema', () => this._desenharSemMedida(x, y, nivel));
  }

  async _desenharSemMedida(x, y, nivel) {
    const metas = await this._carregarMetas();
    const ret = this._grade.tileXYToRectangle(x, y, nivel);
    const ext = [ret.west, ret.south, ret.east, ret.north].map((r) => r * 180 / Math.PI);
    const T = this._T;
    const x0 = mx(ext[0]), x1 = mx(ext[2]), y0 = my(ext[1]), y1 = my(ext[3]);
    const kx = T / (x1 - x0), ky = T / (y1 - y0);
    const pxX = (lon) => (mx(lon) - x0) * kx, pxY = (lat) => (y1 - my(lat)) * ky;
    const folga = (ext[2] - ext[0]) * 0.06;
    const caixa = [ext[0] - folga, ext[1] - folga, ext[2] + folga, ext[3] + folga];
    const tela = this._tela();
    const g = tela.getContext('2d');
    g.lineJoin = 'round'; g.lineCap = 'round';
    const rotulos = [];
    for (const { info, meta } of metas) {
      if (!this._visivel(meta, nivel) || !info.geo) continue;
      if (info.z != null && info.zv == null && nivel < info.z - 4) continue; // camada densa: só de perto
      let feats;
      try { feats = await feicoesNaExtensao(info, caixa); }
      catch (e) { if (e instanceof NaoSuportado) continue; throw e; }
      const ren = meta.drawingInfo?.renderer;
      const alfa = 1 - (meta.drawingInfo?.transparency || 0) / 100;
      const escala = ESCALA_N0 / 2 ** nivel;
      const etiquetas = (meta.drawingInfo?.labelingInfo || []).filter((l) => l.labelExpression && (!l.minScale || escala <= l.minScale) && (!l.maxScale || escala >= l.maxScale))
        .map((l) => ({ l, filtro: (() => { try { return compilarWhere(l.where, camposDe(info)); } catch { return () => true; } })() }));
      const vistos = new Set();
      for (const f of feats) {
        if (vistos.has(f.oid)) continue;
        vistos.add(f.oid);
        const e = f.ext;
        if (!e || e[2] < caixa[0] || e[0] > caixa[2] || e[3] < caixa[1] || e[1] > caixa[3]) continue;
        const geo = f.g;
        for (const { l, filtro } of etiquetas) {
          if (!filtro(f)) continue;
          const texto = textoDoRotulo(l.labelExpression, f.valores, camposDe(info));
          if (!texto) continue;
          let px, py;
          if (geo.tipo === 'ponto') [px, py] = [pxX(geo.pts[0][0]), pxY(geo.pts[0][1])];
          else if (geo.tipo === 'linha') { const p = geo.partes[0], m = p[Math.floor(p.length / 2)]; [px, py] = [pxX(m[0]), pxY(m[1])]; }
          else { const e2 = f.ext; [px, py] = [pxX((e2[0] + e2[2]) / 2), pxY((e2[1] + e2[3]) / 2)]; }
          rotulos.push({ texto, px, py, sim: l.symbol, ponto: geo.tipo === 'ponto' });
        }
        const sim = simboloDe(ren, f.valores, camposDe(info));
        if (!sim) continue;
        if (geo.tipo === 'ponto') { for (const [lo, la] of geo.pts) desenharMarcador(g, sim, pxX(lo), pxY(la), alfa); continue; }
        g.beginPath();
        for (const p of geo.partes) {
          p.forEach(([lo, la], i) => (i ? g.lineTo(pxX(lo), pxY(la)) : g.moveTo(pxX(lo), pxY(la))));
          if (geo.tipo === 'area') g.closePath();
        }
        if (geo.tipo === 'area') {
          if (sim.type === 'esriPFS') {
            const { img } = imagemDe(sim);
            if (img.naturalWidth) { g.save(); g.globalAlpha = alfa; g.fillStyle = g.createPattern(img, 'repeat'); g.fill('evenodd'); g.restore(); }
          } else if (sim.color && sim.style !== 'esriSFSNull') {
            g.fillStyle = corCss(sim.color, alfa * (sim.style && sim.style !== 'esriSFSSolid' ? 0.45 : 1));
            g.fill('evenodd');
          }
          const o = sim.outline;
          if (o && o.color && o.width && o.style !== 'esriSLSNull') { g.setLineDash(tracejado(o.style, o.width * PT)); g.lineWidth = Math.max(0.6, o.width * PT); g.strokeStyle = corCss(o.color, alfa); g.stroke(); g.setLineDash([]); }
        } else {
          const linha = sim.type === 'esriSLS' ? sim : sim.outline || sim;
          if (linha.style === 'esriSLSNull' || !linha.color) continue;
          g.setLineDash(tracejado(linha.style, (linha.width || 1) * PT));
          g.lineWidth = Math.max(0.6, (linha.width || 1) * PT);
          g.strokeStyle = corCss(linha.color, alfa);
          g.stroke();
          g.setLineDash([]);
        }
      }
    }
    // rótulos por cima de tudo, sem sobreposição
    const caixas = [];
    for (const r of rotulos) {
      const ts = r.sim || {};
      const tam = ((ts.font?.size || 8) * PT);
      g.font = `${ts.font?.style === 'italic' ? 'italic ' : ''}${ts.font?.weight === 'bold' ? '700 ' : '500 '}${tam}px ${ts.font?.family ? `"${ts.font.family}", ` : ''}system-ui, sans-serif`;
      const w = g.measureText(r.texto).width;
      const x = r.ponto ? r.px + 4 + (ts.xoffset || 0) * PT : r.px - w / 2, y = r.ponto ? r.py - 4 - (ts.yoffset || 0) * PT : r.py + tam / 3;
      const c = [x - 2, y - tam, x + w + 2, y + 3];
      if (c[0] < 0 || c[1] < 0 || c[2] > T || c[3] > T || caixas.some((b) => c[0] < b[2] && c[2] > b[0] && c[1] < b[3] && c[3] > b[1])) continue;
      caixas.push(c);
      g.lineJoin = 'round';
      g.lineWidth = Math.max(2.5, (ts.haloSize || 1.5) * PT * 1.6);
      g.strokeStyle = ts.haloColor ? corCss(ts.haloColor) : 'rgba(255,255,255,.9)';
      g.strokeText(r.texto, x, y);
      g.fillStyle = corCss(ts.color || [0, 0, 0, 255]);
      g.fillText(r.texto, x, y);
    }
    return tela;
  }
}

/** Texto do rótulo a partir da expressão do ArcGIS ("[campo]" e concatenações simples). */
function textoDoRotulo(expr, valores, campos) {
  const v = (nome) => { const n = nome.toLowerCase(); const k = campos.findIndex((c) => c.toLowerCase() === n || c.toLowerCase().endsWith(`.${n.split('.').pop()}`)); return k >= 0 ? valores[k] : ''; };
  const t = String(expr).replace(/\[([^\]]+)\]/g, (_, c) => String(v(c) ?? '').trim())
    .replace(/\s*&\s*/g, '').replace(/"\s*"/g, ' ').replace(/^"|"$/g, '').replace(/\bvbnewline\b/gi, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 58)}…` : t;
}
