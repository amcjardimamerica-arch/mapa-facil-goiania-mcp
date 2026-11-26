// Mapa desenhado no navegador a partir dos dados vetoriais do Mapa Fácil:
//
// - ProvedorVetorial, modo "mapa": fundo abstrato, sem fotos, no espírito do mapa
//   do Google Earth — quadras, ruas com hierarquia e nomes, relevo sombreado e
//   nomes de bairro. Modo "sobre": só nomes e traçados, transparente, por cima do satélite.
// - ProvedorLotes: os lotes de um ou mais bairros escolhidos, carregados sob demanda
//   e desenhados aqui mesmo, sem pedir o mapa de Goiânia inteira ao servidor.
import { CFG } from './config.js';
import { cronometrarSinc, contadores } from './desempenho.js';
import { consultarOuServidor } from './banco.js';

const Cesium = window.Cesium;
const MUNDO = 20037508.342789244;
const NIVEL_MINIMO = 9;
// Aproximação progressiva, como no Mapa Fácil: primeiro as divisas dos bairros, depois as
// quadras, depois quadras e lotes. Os números aparecem e crescem conforme a aproximação.
export const NIVEIS = { bairros: 11, quadras: 15, numeroQuadra: 16, lotes: 17, numeroLote: 17 };
// Aparecimento pela altura da câmera (a mesma do rodapé): quadras e lotes a partir de 5 km para baixo,
// número da quadra a partir de 4 km e número do lote a partir de 2,5 km (com 3 km não cabiam todos). O nível mínimo do bloco evita pedir a
// cidade inteira de uma vez quando a câmera está inclinada.
export const ALTURA = { camera: Infinity };
export const LIMITE_ALTURA = { quadras: 5000, lotes: 5000, numeroQuadra: 4000, numeroLote: 2500 };
const NIVEL_MINIMO_DE = { quadras: 13, lotes: 14, numeroQuadra: 14, numeroLote: 15 };
export const mostraNaAltura = (item, nivel) => ALTURA.camera <= LIMITE_ALTURA[item] && nivel >= NIVEL_MINIMO_DE[item];
/** Faixa de altura: muda quando a câmera cruza 5, 4 ou 3 km (então os mapas desenhados são refeitos). */
/**
 * Filtro de bairros do painel Bairros: com ele ligado, o mapa desenha quadras, lotes e números de quadra só dentro
 * dos bairros marcados (Jardim América e/ou Nova Suíça). `aneis` são anéis em Web Mercator; null = cidade inteira.
 */
/** Centro exato (centroide de área) de um anel; se a área for nula, a média dos vértices. */
export function centroDoAnel(anel) {
  let A = 0, cx = 0, cy = 0;
  const [x0, y0] = anel[0];
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const xi = anel[i][0] - x0, yi = anel[i][1] - y0, xj = anel[j][0] - x0, yj = anel[j][1] - y0;
    const c = xj * yi - xi * yj;
    A += c; cx += (xj + xi) * c; cy += (yj + yi) * c;
  }
  if (Math.abs(A) < 1e-9) { let sx = 0, sy = 0; for (const [a, b] of anel) { sx += a; sy += b; } return [sx / anel.length, sy / anel.length]; }
  return [x0 + cx / (3 * A), y0 + cy / (3 * A)];
}
/** Tamanho da letra do marcador de quadra (px de tela), pela altura da câmera — o mesmo em quadras.js. */
export const pxMarcadorQuadra = (h) => (h <= 700 ? 12 : h <= 1500 ? 11 : 10);

export const FILTRO_BAIRROS = { aneis: null, ext: null, semNumeroDeLote: false };
/** Caixas (em Web Mercator) dos marcadores de número de quadra: o número do lote que cairia embaixo é deslocado. */
function marcasDeQuadra(quadras, q, pxM) {
  return quadras.map((f) => {
    const a = f.geometry?.rings?.[0], nq = String(f.attributes?.nm_qdr || '').trim();
    if (!a || !nq) return null;
    const [cx, cy] = centroDoAnel(a);
    const w = (nq.length * pxM * 0.62 + pxM) / 2 + 2, h = pxM * 0.75 + 2;
    return { x: q.x(cx), y: q.y(cy), w, h };
  }).filter(Boolean);
}
/**
 * Camadas da Base Cadastral (Feature_Base) controladas por cada opção — também entram na ficha do clique.
 * Lote (0), quadra (1) e bairro (2) entram sempre na ficha, para o clique selecionar o que aparece no mapa.
 */
export const CAMADAS_DA_OPCAO = { areasVerdes: 4, imoveisPublicos: 4, npo: 5, atividades: 9 };
/** Área pública verde (praça, área verde, parque, reserva) x imóvel público (os demais destinos). */
export const ehAreaVerde = (a = {}) => /AREAS VERDES|PARQUES|RESERVAS ECOL/i.test(a.nm_grupo_d || '') || /PRA[CÇ]A|AREA VERDE|PARQUE|BOSQUE/i.test(a.nm_destin || '');
export function idsDaFicha() {
  const ids = [0, 1, 2];
  if (BASE.ligado) for (const [k, id] of Object.entries(CAMADAS_DA_OPCAO)) if (BASE[k]) ids.push(id);
  return [...new Set(ids)].sort((a, b) => a - b);
}
/**
 * Opções da Base Cadastral (painel Camadas): controlam o desenho cadastral na cidade inteira — nomes de rua,
 * quadras, lotes, divisas e nomes de bairro, áreas públicas (verde #00FF00, contorno branco) e atividades econômicas.
 */
export const BASE = Object.assign({ ligado: true, ruas: true, quadras: true, lotes: true, divisas: true, nomesBairros: true, areasVerdes: false, imoveisPublicos: false, atividades: false,
  cadastro: true, npo: false, avenidas: true },
  (() => { try { return JSON.parse(localStorage.getItem('bussola:base') || '{}'); } catch { return {}; } })());
export const gravarBase = () => { try { localStorage.setItem('bussola:base', JSON.stringify(BASE)); } catch { /* nada */ } };
const baseVe = (k) => BASE.ligado && BASE[k];
function dentroAneis(aneis, x, y) {
  let d = false;
  for (const a of aneis) {
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
      const [xi, yi] = a[i], [xj, yj] = a[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
    }
  }
  return d;
}
/** A feição (polígono) entra no filtro pelo ponto médio do primeiro anel. */
export function passaFiltro(f) {
  if (!FILTRO_BAIRROS.aneis) return true;
  const anel = f.geometry?.rings?.[0];
  if (!anel) return false;
  let sx = 0, sy = 0;
  for (const [a, b] of anel) { sx += a; sy += b; }
  return FILTRO_BAIRROS.aneis.some((an) => dentroAneis(an, sx / anel.length, sy / anel.length));
}
/** O bloco do mapa toca a área dos bairros filtrados? (evita consultar fora dela) */
export function blocoNoFiltro(ret) {
  const e = FILTRO_BAIRROS.ext;
  return !e || (ret.west < e[2] && ret.east > e[0] && ret.south < e[3] && ret.north > e[1]);
}

export const faixaAltura = (h) => (h > 5000 ? 0 : h > 4000 ? 1 : h > 2500 ? 2 : 3);

// ---------------------------------------------------------------- fila de pedidos
/** Limita as consultas simultâneas ao servidor municipal (não o sobrecarrega). */
class Fila {
  constructor(maximo) { this.maximo = maximo; this.ativos = 0; this.espera = []; }
  rodar(tarefa, cancelada = () => false) {
    return new Promise((ok, erro) => {
      const iniciar = () => {
        if (cancelada()) { contadores.cancelados++; erro(new Error('cancelado')); this._proximo(); return; }
        this.ativos++;
        tarefa().then(ok, erro).finally(() => { this.ativos--; this._proximo(); });
      };
      if (this.ativos < this.maximo) iniciar(); else this.espera.push(iniciar);
    });
  }
  _proximo() { if (this.espera.length && this.ativos < this.maximo) this.espera.pop()(); } // o mais recente primeiro
}
export const filaMunicipal = new Fila(4);

async function consultar(camada, parametros, cancelada) {
  return filaMunicipal.rodar(async () => {
    // Passo 7: sinal e nível vêm do bloco pedido pelo Cesium (pendurados na função "cancelada").
    const d = await consultarOuServidor('Feature_Base', camada, parametros, { sinal: cancelada?.sinal, nivel: cancelada?.nivel });
    return d.features || [];
  }, cancelada);
}

// ------------------------------------------------------------------------ estilos
/** Classe viária pelo campo in_hie da base municipal. */
export function classeVia(hie) {
  const h = Number(hie) || 0;
  if (h >= 50) return 'expressa';
  if (h >= 31) return 'arterial';
  if (h >= 21) return 'coletora';
  return 'local';
}
const LARGURA_M = { local: 9, coletora: 13, arterial: 19, expressa: 26 };
const LARGURA_MIN = { local: 0.9, coletora: 1.4, arterial: 2.2, expressa: 2.8 };
const ORDEM = ['local', 'coletora', 'arterial', 'expressa'];

const ESTILO = {
  mapa: {
    fundo: '#e9e4da', urbano: '#efebe3', quadra: '#f7f4ee', quadraBorda: '#dcd5c8',
    via: { local: ['#d3ccbf', '#ffffff'], coletora: ['#cdc3b1', '#ffffff'], arterial: ['#e0bd62', '#ffe7a0'], expressa: ['#d49a3a', '#fbcf74'] },
    texto: '#4f545b', halo: 'rgba(255,255,255,.95)', bairro: '#857a69', quadraTexto: '#8f8574', divisa: '#9c8f7a',
    loteBorda: '#cfc6b6', loteTexto: '#7d7465',
  },
  sobre: {
    quadraBorda: 'rgba(255,255,255,.42)',
    via: { local: [null, 'rgba(255,255,255,.30)'], coletora: [null, 'rgba(255,255,255,.45)'], arterial: ['rgba(0,0,0,.25)', 'rgba(255,214,90,.6)'], expressa: ['rgba(0,0,0,.25)', 'rgba(255,185,70,.7)'] },
    viaSemDestaque: { arterial: [null, 'rgba(255,255,255,.5)'], expressa: [null, 'rgba(255,255,255,.55)'] },
    texto: '#ffffff', halo: 'rgba(0,0,0,.85)', bairro: '#ffe9a8', quadraTexto: '#ffffff', divisa: 'rgba(255,233,168,.85)',
    loteBorda: 'rgba(255,255,255,.62)', loteTexto: 'rgba(255,255,255,.92)',
  },
};

/** Nome de logradouro legível: "R C 212" -> "R. C-212", "AV T 63" -> "Av. T-63". */
export function nomeVia(nm) {
  const s = String(nm || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const m = s.match(/^(R|AV|Av|AL|Al|PÇA|Pça|PÇ|Pç|RDV|VIA|Via|TR|TRV|Trv|VL|Vla|ETR|EST|Est|VD|VDP|Vdp|ACS|VEL|PAS)\s+(.*)$/);
  const tipos = { R: 'R.', AV: 'Av.', Av: 'Av.', AL: 'Al.', Al: 'Al.', 'PÇA': 'Pç.', 'Pça': 'Pç.', 'PÇ': 'Pç.', 'Pç': 'Pç.', RDV: 'Rod.', VIA: 'Via', Via: 'Via',
    TR: 'Tv.', TRV: 'Tv.', Trv: 'Tv.', VL: 'Vl.', Vla: 'Vl.', ETR: 'Estr.', EST: 'Estr.', Est: 'Estr.', VD: 'Vd.', VDP: 'Vd.', Vdp: 'Vd.', ACS: 'Ac.', VEL: 'Vel.', PAS: 'Pass.' };
  if (!m) return s;
  const resto = m[2].replace(/^([A-Z]{1,3}) (\d+[A-Z]?)$/, '$1-$2');
  return `${tipos[m[1]] || m[1]} ${resto}`;
}

// ------------------------------------------------------------------ geometria
export class Quadro {
  constructor(ret, T) {
    this.o = ret.west; this.n = ret.north; this.T = T;
    this.kx = T / (ret.east - ret.west); this.ky = T / (ret.north - ret.south);
    this.mpp = (ret.east - ret.west) / T;
  }
  x(v) { return (v - this.o) * this.kx; }
  y(v) { return (this.n - v) * this.ky; }
  caminho(g, partes) {
    for (const p of partes) {
      if (!p.length) continue;
      g.moveTo(this.x(p[0][0]), this.y(p[0][1]));
      for (let i = 1; i < p.length; i++) g.lineTo(this.x(p[i][0]), this.y(p[i][1]));
    }
  }
}

/** Ponto e ângulo no meio de uma linha (em pixels), para o rótulo seguir a rua. */
function meioDaLinha(q, partes) {
  let melhor = null;
  for (const p of partes) {
    const pts = p.map(([x, y]) => [q.x(x), q.y(y)]);
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (!melhor || total > melhor.total) melhor = { pts, total };
  }
  if (!melhor || melhor.total < 1) return null;
  let alvo = melhor.total / 2;
  const { pts } = melhor;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const d = Math.hypot(bx - ax, by - ay);
    if (alvo <= d || i === pts.length - 1) {
      const t = d ? Math.min(1, alvo / d) : 0;
      let ang = Math.atan2(by - ay, bx - ax);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, ang, total: melhor.total };
    }
    alvo -= d;
  }
  return null;
}

/**
 * Número do lote sempre desenhado (nenhum some): a fonte se ajusta ao tamanho do lote na tela, com mínimo legível.
 */
export function numeroNoLote(g, texto, cx, cy, larguraPx, alturaPx, { cor, halo, max = 14, min = 7 }) {
  const px = Math.max(min, Math.min(max, (larguraPx * 0.85) / Math.max(1, texto.length * 0.6), alturaPx * 0.6));
  g.save();
  g.font = `600 ${px.toFixed(1)}px system-ui, "Segoe UI", Roboto, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  g.lineWidth = Math.max(2, px / 4); g.strokeStyle = halo; g.strokeText(texto, cx, cy);
  g.fillStyle = cor; g.fillText(texto, cx, cy);
  g.restore();
}

/** Desenha rótulos sem sobreposição e sem cortar na borda do bloco. */
class Rotulos {
  constructor(g, T) { this.g = g; this.T = T; this.caixas = []; this.nomes = []; }
  _livre(c, folga = 3) {
    if (c.x0 < 2 || c.y0 < 2 || c.x1 > this.T - 2 || c.y1 > this.T - 2) return false;
    return !this.caixas.some((b) => c.x0 < b.x1 + folga && c.x1 > b.x0 - folga && c.y0 < b.y1 + folga && c.y1 > b.y0 - folga);
  }
  texto(t, x, y, { ang = 0, fonte, cor, halo, distanciaNome = 0, forcar = false }) {
    const g = this.g;
    g.font = fonte;
    const w = g.measureText(t).width, h = parseFloat(fonte.match(/(\d+(?:\.\d+)?)px/)[1]);
    const cos = Math.abs(Math.cos(ang)), sen = Math.abs(Math.sin(ang));
    const meiaL = (w * cos + h * sen) / 2 + 2, meiaA = (w * sen + h * cos) / 2 + 2;
    const caixa = { x0: x - meiaL, y0: y - meiaA, x1: x + meiaL, y1: y + meiaA };
    if (!forcar && !this._livre(caixa)) return false;
    if (distanciaNome && this.nomes.some((n) => n.t === t && Math.hypot(n.x - x, n.y - y) < distanciaNome)) return false;
    this.caixas.push(caixa);
    this.nomes.push({ t, x, y });
    g.save();
    g.translate(x, y); g.rotate(ang);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = 3.2; g.strokeStyle = halo; g.strokeText(t, 0, 0);
    g.fillStyle = cor; g.fillText(t, 0, 0);
    g.restore();
    return true;
  }
}

// ------------------------------------------------------- provedor base (Cesium)
export class ProvedorCanvas {
  constructor({ retangulo, tamanho = 512, credito, nivelMinimo = NIVEL_MINIMO, nivelMaximo = 21 }) {
    this._T = tamanho; this._ret = retangulo; this._min = nivelMinimo; this._max = nivelMaximo;
    this._grade = new Cesium.WebMercatorTilingScheme();
    this._erro = new Cesium.Event();
    // Bloco cancelado (saiu da tela durante a navegação) não é erro: o globo pede de novo, sem aviso.
    this._erro.addEventListener((e) => {
      const err = e?.error;
      if (err?.name === 'Cancelado' || err?.name === 'AbortError' || /cancelad/i.test(String(err?.message || e?.message || ''))) { e.retry = true; e.cancelado = true; }
    });
    this._credito = credito ? new Cesium.Credit(credito) : undefined;
  }
  get tileWidth() { return this._T; }
  get tileHeight() { return this._T; }
  get minimumLevel() { return this._ret ? this._min : 0; }
  get maximumLevel() { return this._max; }
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
  _tela() {
    const c = document.createElement('canvas');
    c.width = c.height = this._T;
    return c;
  }
}

/** Relevo sombreado próprio (relevo/sombra, Copernicus DEM): bloco do mesmo nível, ou do ancestral recortado. */
function blocoRelevo(x, y, nivel, request) {
  const z = Math.min(nivel, CFG.relevo.sombraNivelMaximo), d = nivel - z;
  const ax = x >> d, ay = y >> d;
  const url = CFG.relevo.sombra.replace('{z}', z).replace('{x}', ax).replace('{y}', ay);
  const pedido = new Cesium.Resource({ url, request }).fetchImage({ preferImageBitmap: true });
  if (!pedido) return undefined;
  const lado = 256 >> d;
  return pedido.then((img) => ({ img, sx: (x - (ax << d)) * lado, sy: (y - (ay << d)) * lado, lado }), () => null);
}

export class ProvedorVetorial extends ProvedorCanvas {
  /** modo: 'mapa' (fundo abstrato) ou 'sobre' (nomes e traçados por cima do satélite). */
  constructor({ modo = 'mapa', bairros = [], retangulo, territorio }) {
    super({ retangulo, credito: modo === 'mapa' ? 'Mapa: Prefeitura de Goiânia (Mapa Fácil) · Relevo: Copernicus DEM' : 'Nomes: Prefeitura de Goiânia' });
    this.modo = modo;
    this.estilo = ESTILO[modo];
    this.territorio = territorio;
    // Nomes de bairro: os mais populosos primeiro (ganham o espaço quando há disputa).
    // Glebas e fazendas são parcelas rurais, não bairros de rótulo.
    this.bairros = [...bairros].filter((b) => b.c && !['Gleba', 'Faz'].includes(b.t) && !/^(gleba|faz)/i.test(b.b || b.n))
      .sort((a, b) => (b.pop || 0) - (a.pop || 0))
      .map((b) => ({ n: b.n || b.b, x: b.c[0] * (Math.PI / 180) * 6378137, y: Math.log(Math.tan(Math.PI / 4 + (b.c[1] * Math.PI) / 360)) * 6378137 }));
    this._rotulosBairro = new Map();
  }

  /**
   * Nomes de bairro escolhidos uma vez por nível, para a cidade inteira (os mais
   * populosos ganham a disputa). Assim o mesmo nome sai inteiro nos blocos vizinhos.
   */
  _bairrosDoNivel(nivel) {
    if (this._rotulosBairro.has(nivel)) return this._rotulosBairro.get(nivel);
    const mpp = (2 * MUNDO) / (2 ** nivel) / this._T;
    const fonte = `600 ${nivel >= 14 ? 13 : 11.5}px system-ui, "Segoe UI", Roboto, sans-serif`;
    const g = document.createElement('canvas').getContext('2d');
    g.font = fonte;
    const aceitos = [];
    for (const b of this.bairros) {
      const meiaL = (g.measureText(b.n).width / 2 + 8) * mpp, meiaA = 12 * mpp;
      const c = { x0: b.x - meiaL, x1: b.x + meiaL, y0: b.y - meiaA, y1: b.y + meiaA };
      if (aceitos.some((a) => c.x0 < a.c.x1 && c.x1 > a.c.x0 && c.y0 < a.c.y1 && c.y1 > a.c.y0)) continue;
      aceitos.push({ ...b, c });
    }
    const r = { fonte, lista: aceitos };
    this._rotulosBairro.set(nivel, r);
    return r;
  }

  requestImage(x, y, nivel, request) {
    const ret = this._grade.tileXYToNativeRectangle(x, y, nivel);
    const cancelada = () => request && request.state === Cesium.RequestState.CANCELLED;
    const ac = new AbortController();
    cancelada.sinal = ac.signal; cancelada.nivel = nivel;
    let relevo = Promise.resolve(null);
    if (this.modo === 'mapa') {
      relevo = blocoRelevo(x, y, nivel, request);
      if (!relevo) return undefined; // o agendador do Cesium pede de novo depois
    }
    const vigia = setInterval(() => { if (cancelada()) ac.abort(); }, 100);
    return Promise.all([relevo, this._dados(ret, nivel, cancelada)])
      .then(([r, dados]) => { if (ac.signal.aborted) throw new Error('cancelado'); return this._desenhar(ret, nivel, r, dados); })
      .finally(() => clearInterval(vigia));
  }

  async _dados(ret, nivel, cancelada) {
    const q = new Quadro(ret, this._T);
    const folga = (ret.east - ret.west) * 0.04;
    const env = [ret.west - folga, ret.south - folga, ret.east + folga, ret.north + folga].join(',');
    const comum = { geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '3857', outSR: '3857',
      spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true', geometryPrecision: '1',
      maxAllowableOffset: String(Math.max(0.3, q.mpp * 0.7)) };
    const sobre = this.modo === 'sobre';
    const noFiltro = blocoNoFiltro(ret);
    const ver = { quadras: baseVe('quadras') && noFiltro && mostraNaAltura('quadras', nivel), lotes: baseVe('lotes') && noFiltro && mostraNaAltura('lotes', nivel),
      numeroQuadra: mostraNaAltura('numeroQuadra', nivel), numeroLote: baseVe('lotes') && mostraNaAltura('numeroLote', nivel),
      ruas: !BASE.ligado || BASE.ruas, nomesBairros: baseVe('nomesBairros'), areas: (baseVe('areasVerdes') || baseVe('imoveisPublicos')) && nivel >= 12,
      // Cadastro de Atividade Econômica: a partir de 5 km de altura (como quadras e lotes).
      atividades: baseVe('atividades') && ALTURA.camera <= 5000 && nivel >= 13,
      npo: baseVe('npo') && nivel >= 17 };
    const filtroVias = nivel >= (sobre ? 15 : 14) ? '1=1' : nivel >= 12 ? 'in_hie >= 21' : 'in_hie >= 40';
    const [limites, quadras, vias, lotes, areas, atividades, npo] = await Promise.all([
      baseVe('divisas') && nivel >= NIVEIS.bairros ? consultar(2, { ...comum, outFields: 'OBJECTID', where: '1=1', maxAllowableOffset: String(Math.max(1, q.mpp)) }, cancelada).catch(() => []) : [],
      ver.quadras ? consultar(1, { ...comum, outFields: ver.numeroQuadra ? 'nm_qdr' : 'OBJECTID', where: '1=1' }, cancelada).catch(() => []) : [],
      consultar(7, { ...comum, outFields: 'nm,in_hie', where: filtroVias }, cancelada).catch(() => []),
      // Divisas dos lotes dentro das quadras, carregadas por bloco do mapa conforme a aproximação.
      ver.lotes ? consultar(0, { ...comum, outFields: ver.numeroLote ? 'nm_lot' : 'OBJECTID', where: '1=1',
        maxAllowableOffset: String(Math.max(0.15, q.mpp * 0.5)) }, cancelada).catch(() => []) : [],
      ver.areas ? consultar(4, { ...comum, outFields: 'nm_destin,nm_grupo_d', where: '1=1' }, cancelada).catch(() => []) : [],
      ver.atividades ? consultar(9, { ...comum, outFields: 'OBJECTID', where: '1=1' }, cancelada).catch(() => []) : [],
      ver.npo ? consultar(5, { ...comum, outFields: 'nm_npo', where: '1=1' }, cancelada).catch(() => []) : [],
    ]);
    // Painel Associação com bairros marcados: quadras e lotes só deles. Áreas verdes, praças e imóveis públicos
    // (opções da Base Cadastral) valem para Goiânia inteira, com ou sem o painel aberto.
    return { limites, quadras: quadras.filter(passaFiltro), vias, lotes: lotes.filter(passaFiltro), areas, atividades, npo, ver };
  }

  _desenhar(ret, nivel, relevo, dados) {
    return cronometrarSinc('desenhar-mapa', () => this._desenharSemMedida(ret, nivel, relevo, dados));
  }

  _desenharSemMedida(ret, nivel, relevo, { limites = [], quadras, vias, lotes = [], areas = [], atividades = [], npo = [], ver = {} }) {
    const T = this._T, e = this.estilo, q = new Quadro(ret, T);
    const tela = this._tela(), g = tela.getContext('2d');
    const mapa = this.modo === 'mapa';

    if (mapa) { g.fillStyle = ver.quadras ? e.fundo : e.urbano; g.fillRect(0, 0, T, T); }

    // Quadras
    if (quadras.length) {
      g.beginPath();
      for (const f of quadras) if (f.geometry?.rings) q.caminho(g, f.geometry.rings);
      if (mapa) { g.fillStyle = e.quadra; g.fill('evenodd'); }
      g.strokeStyle = e.quadraBorda; g.lineWidth = nivel >= 17 ? 1.2 : 0.8; g.stroke();
    }
    // Lotes: divisas finas dentro das quadras.
    if (lotes.length) {
      g.save();
      g.beginPath();
      for (const f of lotes) if (f.geometry?.rings) q.caminho(g, f.geometry.rings);
      g.lineJoin = 'round';
      g.strokeStyle = e.loteBorda; g.lineWidth = nivel >= 19 ? 1.1 : 0.8; g.stroke();
      g.restore();
    }

    // Áreas públicas (Base Cadastral): verde #00FF00 com contorno branco.
    // Áreas verdes (praças, parques, reservas) em #00FF00 e imóveis públicos (escolas, saúde, institucional…) em
    // azul, os dois com contorno branco; cada grupo tem a sua opção na Base Cadastral.
    for (const [verde, cor] of [[true, '#00FF00'], [false, '#2979FF']]) {
      if (!(verde ? BASE.areasVerdes : BASE.imoveisPublicos)) continue;
      const lista = areas.filter((f) => ehAreaVerde(f.attributes) === verde && f.geometry?.rings);
      if (!lista.length) continue;
      g.save(); g.beginPath();
      for (const f of lista) q.caminho(g, f.geometry.rings);
      g.globalAlpha = 0.55; g.fillStyle = cor; g.fill('evenodd');
      g.globalAlpha = 1; g.lineJoin = 'round'; g.strokeStyle = '#FFFFFF'; g.lineWidth = nivel >= 16 ? 2 : 1.3; g.stroke();
      g.restore();
    }
    // Vias, das menores para as maiores: contorno de todas e depois o miolo.
    const porClasse = Object.fromEntries(ORDEM.map((c) => [c, []]));
    for (const f of vias) if (f.geometry?.paths) porClasse[classeVia(f.attributes.in_hie)].push(f);
    const largura = (c) => Math.min(30, Math.max(LARGURA_MIN[c], LARGURA_M[c] / q.mpp));
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const etapa of [0, 1]) {
      for (const c of ORDEM) {
        // Avenidas e vias principais em amarelo só com a opção "Avenidas principais em destaque" (Sistema Viário).
        const [contorno, miolo] = !mapa && !BASE.avenidas && (c === 'arterial' || c === 'expressa') ? e.viaSemDestaque[c] : e.via[c];
        const cor = etapa === 0 ? contorno : miolo;
        if (!cor || !porClasse[c].length) continue;
        const w = mapa ? largura(c) : Math.min(4, largura(c) * 0.28);
        g.beginPath();
        for (const f of porClasse[c]) q.caminho(g, f.geometry.paths);
        g.strokeStyle = cor;
        g.lineWidth = etapa === 0 ? w + (mapa ? 1.6 : 1.4) : w;
        g.stroke();
      }
    }

    // Relevo sombreado multiplicado por cima de tudo (só no mapa).
    if (mapa && relevo) {
      g.save();
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.42;
      g.imageSmoothingQuality = 'high';
      g.drawImage(relevo.img, relevo.sx, relevo.sy, relevo.lado, relevo.lado, 0, 0, T, T);
      g.restore();
    }

    // Divisa de cada bairro: três linhas da mesma largura, preta, amarela e preta (#000000, #FFFF00, #000000),
    // por cima das ruas e abaixo dos nomes. A preta larga por baixo deixa uma faixa preta de cada lado da amarela.
    if (limites.length) {
      const w = nivel >= 15 ? 2 : 1.4;
      g.save();
      g.beginPath();
      for (const f of limites) if (f.geometry?.rings) q.caminho(g, f.geometry.rings);
      g.setLineDash([]);
      g.lineJoin = 'round';
      g.strokeStyle = '#000000'; g.lineWidth = w * 3; g.stroke();
      g.strokeStyle = '#FFFF00'; g.lineWidth = w; g.stroke();
      g.restore();
    }

    const r = new Rotulos(g, T);
    // Número Predial Oficial: contorno fino e o número.
    if (npo.length) {
      g.save(); g.beginPath();
      for (const f of npo) if (f.geometry?.rings) q.caminho(g, f.geometry.rings);
      g.lineWidth = 1; g.strokeStyle = '#3949ab'; g.stroke();
      g.font = `700 ${nivel >= 19 ? 11 : 9}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      for (const f of npo) {
        const a = f.geometry?.rings?.[0], t = String(f.attributes?.nm_npo ?? '').trim();
        if (!a || !t) continue;
        const [cx, cy] = centroDoAnel(a);
        g.lineWidth = 3; g.strokeStyle = '#ffffff'; g.strokeText(t, q.x(cx), q.y(cy));
        g.fillStyle = '#1a237e'; g.fillText(t, q.x(cx), q.y(cy));
      }
      g.restore();
    }
    // Atividades econômicas (Base Cadastral): ponto por estabelecimento.
    if (atividades.length) {
      g.save();
      for (const f of atividades) {
        const x = f.geometry?.x, y = f.geometry?.y;
        if (x == null) continue;
        g.beginPath(); g.arc(q.x(x), q.y(y), nivel >= 17 ? 3.5 : 2.5, 0, Math.PI * 2);
        g.fillStyle = '#e91e63'; g.fill(); g.lineWidth = 1; g.strokeStyle = '#ffffff'; g.stroke();
      }
      g.restore();
    }
    // Nomes de bairro (vista de bairros)
    if (ver.nomesBairros && nivel >= 12 && nivel <= 15) {
      const { fonte, lista } = this._bairrosDoNivel(nivel);
      for (const b of lista) {
        if (b.c.x1 < ret.west || b.c.x0 > ret.east || b.c.y1 < ret.south || b.c.y0 > ret.north) continue;
        r.texto(b.n, q.x(b.x), q.y(b.y), { fonte, cor: e.bairro, halo: e.halo, forcar: true });
      }
    }
    // Nomes de rua: arteriais desde o nível 14, todas a partir do 16.
    const nomeadas = ver.ruas === false ? [] : [...porClasse.expressa, ...porClasse.arterial, ...(nivel >= 15 ? porClasse.coletora : []), ...(nivel >= 16 ? porClasse.local : [])];
    for (const f of nomeadas) {
      const t = nomeVia(f.attributes.nm);
      if (!t || nivel < 14) continue;
      const m = meioDaLinha(q, f.geometry.paths);
      if (!m) continue;
      const fonte = `${classeVia(f.attributes.in_hie) === 'local' ? 500 : 600} ${nivel >= 17 ? 12.5 : 11.5}px system-ui, "Segoe UI", Roboto, sans-serif`;
      g.font = fonte;
      if (m.total < g.measureText(t).width + 16) continue;
      r.texto(t, m.x, m.y, { ang: m.ang, fonte, cor: e.texto, halo: e.halo, distanciaNome: 220 });
    }
    // Número da quadra: camada própria por cima de tudo (ProvedorQuadras), com marcador preto e número amarelo.
    // Número de todos os lotes, por cima da quadra: nenhum é escondido; a fonte se ajusta ao lote.
    // Dentro dos bairros da Associação (painel aberto com "Lotes por finalidade"), o número do lote sai só do levantamento.
    if (ver.numeroLote && lotes.length && !FILTRO_BAIRROS.semNumeroDeLote) {
      const max = nivel >= 20 ? 14 : nivel >= 19 ? 12.5 : nivel >= 18 ? 11 : 9.5;
      // Caixas dos marcadores de quadra (no centro exato de cada quadra): o número de lote que cair embaixo
      // de um marcador é deslocado um pouco para o lado, para os dois ficarem legíveis.
      const pxM = pxMarcadorQuadra(ALTURA.camera) * 1.3;
      const marcas = marcasDeQuadra(BASE.ligado && BASE.quadras ? quadras || [] : [], q, pxM);
      for (const f of lotes) {
        const nm = String(f.attributes.nm_lot || '').trim();
        const anel = f.geometry?.rings?.[0];
        if (!nm || !anel) continue;
        let sx = 0, sy = 0, o = Infinity, l = -Infinity, s0 = Infinity, n0 = -Infinity;
        for (const [a, b] of anel) { sx += a; sy += b; o = Math.min(o, a); l = Math.max(l, a); s0 = Math.min(s0, b); n0 = Math.max(n0, b); }
        let px = q.x(sx / anel.length), py = q.y(sy / anel.length);
        const meia = (nm.length * max * 0.3) + 2, alt = max * 0.6;
        const m = marcas.find((c) => Math.abs(px - c.x) < c.w + meia && Math.abs(py - c.y) < c.h + alt);
        if (m) px = px <= m.x ? m.x - m.w - meia - 1 : m.x + m.w + meia + 1;
        numeroNoLote(g, nm, px, py, q.x(l) - q.x(o), q.y(s0) - q.y(n0), { cor: e.loteTexto, halo: e.halo, max });
      }
    }
    return tela;
  }
}

// ------------------------------------------------------------------- lotes
export class ProvedorLotes extends ProvedorCanvas {
  constructor({ lotes, retangulo, borda = '#ffd54a', credito = 'Lotes: Prefeitura de Goiânia', nivelMinimo = 12, rotulos = () => true, estiloRotulo = () => 'mapa' }) {
    super({ retangulo, credito, nivelMinimo });
    this.rotulos = rotulos; // false quando o mapa de baixo já escreve o número do lote (evita número duplicado)
    this.estiloRotulo = estiloRotulo; // 'sobre' (número branco sobre a foto) ou 'mapa' (número escuro)
    this.lotes = lotes; // [{ aneis: [[[x,y]…]], ext: [o,s,l,n], nm, cor }]
    this.borda = borda; // cor da divisa, ou null para usar a cor de cada lote
  }
  async requestImage(x, y, nivel) {
    const ret = this._grade.tileXYToNativeRectangle(x, y, nivel);
    const T = this._T, q = new Quadro(ret, T);
    const tela = this._tela(), g = tela.getContext('2d');
    if (!mostraNaAltura('lotes', nivel)) return tela; // lotes a partir de 5 km de altura
    const dentro = this.lotes.filter((l) => l.ext[0] < ret.east && l.ext[2] > ret.west && l.ext[1] < ret.north && l.ext[3] > ret.south);
    if (!dentro.length) return tela;
    for (const l of dentro) {
      g.beginPath(); q.caminho(g, l.aneis);
      g.fillStyle = l.cor; g.fill('evenodd');
    }
    g.beginPath();
    for (const l of dentro) q.caminho(g, l.aneis);
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(20,24,28,.55)'; g.lineWidth = nivel >= 17 ? 2.6 : 1.8; g.stroke();
    if (this.borda) { g.strokeStyle = this.borda; g.lineWidth = nivel >= 17 ? 1.3 : 0.8; g.stroke(); }
    if (mostraNaAltura('numeroLote', nivel) && this.rotulos()) {
      const max = nivel >= 20 ? 14 : nivel >= 19 ? 12.5 : nivel >= 18 ? 11 : 9.5;
      // Marcadores de número da quadra (no centro exato de cada quadra): o número de lote que cair embaixo de um
      // deles vai um pouco para o lado — os dois ficam legíveis, sem sobreposição.
      let marcas = [];
      if (BASE.ligado && BASE.quadras) {
        const folga = (ret.east - ret.west) * 0.15;
        try {
          const qs = await consultar(1, { geometry: [ret.west - folga, ret.south - folga, ret.east + folga, ret.north + folga].join(','),
            geometryType: 'esriGeometryEnvelope', inSR: '3857', outSR: '3857', spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true',
            geometryPrecision: '1', outFields: 'nm_qdr', where: '1=1', maxAllowableOffset: String(Math.max(0.3, q.mpp * 0.7)) });
          marcas = marcasDeQuadra(qs.filter(passaFiltro), q, pxMarcadorQuadra(ALTURA.camera) * 1.3);
        } catch { marcas = []; }
      }
      const sobre = this.estiloRotulo() === 'sobre';
      const estilo = sobre ? { cor: 'rgba(255,255,255,.95)', halo: 'rgba(0,0,0,.85)', max } : { cor: '#1f2226', halo: 'rgba(255,255,255,.9)', max };
      for (const l of dentro) {
        if (!l.nm) continue;
        let px = q.x(l.centro[0]);
        const py = q.y(l.centro[1]);
        const meia = (String(l.nm).length * max * 0.3) + 2, alt = max * 0.6;
        const m = marcas.find((c) => Math.abs(px - c.x) < c.w + meia && Math.abs(py - c.y) < c.h + alt);
        if (m) px = px <= m.x ? m.x - m.w - meia - 1 : m.x + m.w + meia + 1;
        numeroNoLote(g, String(l.nm), px, py, q.x(l.ext[2]) - q.x(l.ext[0]), q.y(l.ext[1]) - q.y(l.ext[3]), estilo);
      }
    }
    return tela;
  }
}

/**
 * Desenho livre por cima do mapa (usado nos locais de votação): polígonos com preenchimento e borda
 * próprios e linhas (tracejadas ou não). Tudo em imagem, sem custo de geometria 3D, e visível
 * desde a vista da cidade: polígono pequeno demais vira um quadrado de 7 px.
 */
export class ProvedorDesenho extends ProvedorCanvas {
  constructor({ poligonos = [], linhas = [], divisas = [], retangulo, credito = 'Levantamento da Associação', nivelMinimo = 10 }) {
    super({ retangulo, credito, nivelMinimo });
    this.poligonos = poligonos; // [{ aneis (mercator), ext, cor, borda, largura }]
    this.linhas = linhas;       // [{ de: [x,y], para: [x,y], cor, contorno, largura, tracejado }]
    // Divisas em três faixas da mesma largura — preta, vermelha e preta (#000000, #FF0000, #000000) —, desenhadas por
    // caminho inteiro: primeiro todo o preto, depois todo o vermelho (sem o preto de um trecho cobrir o vermelho do outro).
    this.divisas = divisas.map((d) => {
      let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
      for (const [x, y] of d.pontos) { o = Math.min(o, x); l = Math.max(l, x); s = Math.min(s, y); n = Math.max(n, y); }
      return { ...d, ext: [o, s, l, n] };
    });
  }
  requestImage(x, y, nivel) {
    const ret = this._grade.tileXYToNativeRectangle(x, y, nivel);
    const T = this._T, q = new Quadro(ret, T);
    const tela = this._tela(), g = tela.getContext('2d');
    const folga = (ret.east - ret.west) * 0.05;
    const toca = (o, s, l, n) => o < ret.east + folga && l > ret.west - folga && s < ret.north + folga && n > ret.south - folga;
    g.lineCap = 'round'; g.lineJoin = 'round';
    const escala = nivel >= 17 ? 1 : nivel >= 15 ? 0.8 : 0.6;
    for (const ln of this.linhas) {
      const [ax, ay] = ln.de, [bx, by] = ln.para;
      if (!toca(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) continue;
      const w = (ln.largura || 3) * escala;
      g.setLineDash(ln.tracejado ? [w * 4, w * 2.5] : []);
      g.beginPath(); g.moveTo(q.x(ax), q.y(ay)); g.lineTo(q.x(bx), q.y(by));
      if (ln.contorno) { g.strokeStyle = ln.contorno; g.lineWidth = w + 2.5; g.stroke(); }
      g.strokeStyle = ln.cor; g.lineWidth = w; g.stroke();
    }
    g.setLineDash([]);
    for (const p of this.poligonos) {
      if (!toca(...p.ext)) continue;
      const lado = Math.max(q.x(p.ext[2]) - q.x(p.ext[0]), q.y(p.ext[1]) - q.y(p.ext[3]));
      g.beginPath();
      if (lado < 7) { const cx = q.x(p.centro[0]), cy = q.y(p.centro[1]); g.rect(cx - 3.5, cy - 3.5, 7, 7); }
      else q.caminho(g, p.aneis);
      g.fillStyle = p.cor; g.fill('evenodd');
      const w = (p.largura || 3) * escala;
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = w + 2; g.stroke();
      g.strokeStyle = p.borda; g.lineWidth = w; g.stroke();
    }
    // Divisas por último, por cima do preenchimento (o preenchimento escurecia o vermelho): três faixas iguais,
    // preta, vermelha #FF0000 e preta, largas o bastante para o vermelho aparecer também na vista da cidade.
    const divisas = this.divisas.filter((d) => toca(...d.ext));
    if (divisas.length) {
      const w = nivel >= 16 ? 5 : nivel >= 13 ? 4.5 : 4;
      g.beginPath();
      for (const d of divisas) q.caminho(g, [d.pontos]);
      g.strokeStyle = '#000000'; g.lineWidth = w * 3.6; g.stroke(); // preta | vermelha | preta: as pretas com folga
      g.strokeStyle = '#FF0000'; g.lineWidth = w; g.stroke();          // para não sumirem ao reduzir o bloco
    }
    return Promise.resolve(tela);
  }
}


/**
 * Número de todas as quadras, sem esconder nenhum: marcador retangular de cantos arredondados, preto, com o número
 * em amarelo (#FFFF00). Fica numa camada própria acima dos lotes, dos condomínios e dos temas (só a máscara de fora
 * do município vai por cima). Aparece a partir de 4 km de altura, sempre no meio da quadra.
 */
export class ProvedorQuadras extends ProvedorCanvas {
  constructor({ retangulo }) {
    super({ retangulo, credito: 'Quadras: Prefeitura de Goiânia (Mapa Fácil), banco local', nivelMinimo: 12 });
  }
  async requestImage(x, y, nivel) {
    const tela = this._tela();
    if (!mostraNaAltura('numeroQuadra', nivel)) return tela;
    const ret = this._grade.tileXYToNativeRectangle(x, y, nivel);
    if (!blocoNoFiltro(ret)) return tela;
    const T = this._T, q = new Quadro(ret, T);
    const folga = (ret.east - ret.west) * 0.15;
    const env = [ret.west - folga, ret.south - folga, ret.east + folga, ret.north + folga].join(',');
    let quadras = [];
    try {
      quadras = await consultar(1, { geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '3857', outSR: '3857',
        spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true', geometryPrecision: '1', outFields: 'nm_qdr', where: '1=1',
        maxAllowableOffset: String(Math.max(0.3, q.mpp * 0.7)) });
    } catch { return tela; }
    const comLotes = mostraNaAltura('numeroLote', nivel);
    const px = comLotes ? (nivel >= 20 ? 14 : nivel >= 19 ? 12.5 : nivel >= 18 ? 11 : 9.5) : (nivel >= 16 ? 11 : 10);
    const g = tela.getContext('2d');
    g.font = `800 ${px}px system-ui, "Segoe UI", Roboto, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const f of quadras) {
      const nm = String(f.attributes.nm_qdr || '').trim();
      const anel = f.geometry?.rings?.[0];
      if (!nm || !anel || !passaFiltro(f)) continue; // com o painel Bairros aberto, só as quadras dos bairros marcados
      const pts = anel.map(([a, b]) => [q.x(a), q.y(b)]);
      let cx = 0, cy = 0;
      for (const [a, b] of pts) { cx += a; cy += b; }
      cx /= pts.length; cy /= pts.length;
      // No meio da quadra, sempre (também de perto).
      const px0 = cx, py0 = cy, ang = 0;
      const texto = nm;
      const w = g.measureText(texto).width + px * 0.9, h = px * 1.45;
      if (px0 < -w || px0 > T + w || py0 < -w || py0 > T + w) continue;
      g.save();
      g.translate(px0, py0); g.rotate(ang);
      g.beginPath();
      if (g.roundRect) g.roundRect(-w / 2, -h / 2, w, h, h * 0.35); else g.rect(-w / 2, -h / 2, w, h);
      g.fillStyle = '#000000'; g.fill();
      g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,0,.55)'; g.stroke();
      g.fillStyle = '#FFFF00'; g.fillText(texto, 0, h * 0.04);
      g.restore();
    }
    return tela;
  }
}
