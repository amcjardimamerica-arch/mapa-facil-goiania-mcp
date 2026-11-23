// Mapa desenhado no navegador a partir dos dados vetoriais do Mapa Fácil:
//
// - ProvedorVetorial, modo "mapa": fundo abstrato, sem fotos, no espírito do mapa
//   do Google Earth — quadras, ruas com hierarquia e nomes, relevo sombreado e
//   nomes de bairro. Modo "sobre": só nomes e traçados, transparente, por cima do satélite.
// - ProvedorLotes: os lotes de um ou mais bairros escolhidos, carregados sob demanda
//   e desenhados aqui mesmo, sem pedir o mapa de Goiânia inteira ao servidor.
import { CFG } from './config.js';

const Cesium = window.Cesium;
const MUNDO = 20037508.342789244;
const NIVEL_MINIMO = 9;
// Aproximação progressiva, como no Mapa Fácil: primeiro as divisas dos bairros, depois as
// quadras, depois quadras e lotes. Os números aparecem e crescem conforme a aproximação.
export const NIVEIS = { bairros: 11, quadras: 15, numeroQuadra: 16, lotes: 17, numeroLote: 17 };

// ---------------------------------------------------------------- fila de pedidos
/** Limita as consultas simultâneas ao servidor municipal (não o sobrecarrega). */
class Fila {
  constructor(maximo) { this.maximo = maximo; this.ativos = 0; this.espera = []; }
  rodar(tarefa, cancelada = () => false) {
    return new Promise((ok, erro) => {
      const iniciar = () => {
        if (cancelada()) { erro(new Error('cancelado')); this._proximo(); return; }
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
    const corpo = new URLSearchParams({ f: 'json', ...parametros });
    const r = await fetch(`${CFG.baseCadastral}/${camada}/query`, { method: 'POST', body: corpo,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || 'erro do servidor');
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
class Quadro {
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
class ProvedorCanvas {
  constructor({ retangulo, tamanho = 512, credito, nivelMinimo = NIVEL_MINIMO, nivelMaximo = 21 }) {
    this._T = tamanho; this._ret = retangulo; this._min = nivelMinimo; this._max = nivelMaximo;
    this._grade = new Cesium.WebMercatorTilingScheme();
    this._erro = new Cesium.Event();
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

/** Relevo sombreado (Esri World Hillshade): bloco do mesmo nível, ou do ancestral recortado. */
function blocoRelevo(x, y, nivel, request) {
  const z = Math.min(nivel, 16), d = nivel - z;
  const ax = x >> d, ay = y >> d;
  const url = `https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/${z}/${ay}/${ax}`;
  const pedido = new Cesium.Resource({ url, request }).fetchImage({ preferImageBitmap: true });
  if (!pedido) return undefined;
  const lado = 256 >> d;
  return pedido.then((img) => ({ img, sx: (x - (ax << d)) * lado, sy: (y - (ay << d)) * lado, lado }), () => null);
}

export class ProvedorVetorial extends ProvedorCanvas {
  /** modo: 'mapa' (fundo abstrato) ou 'sobre' (nomes e traçados por cima do satélite). */
  constructor({ modo = 'mapa', bairros = [], retangulo, territorio }) {
    super({ retangulo, credito: modo === 'mapa' ? 'Mapa: Prefeitura de Goiânia (Mapa Fácil) · Relevo: Esri' : 'Nomes: Prefeitura de Goiânia' });
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
    let relevo = Promise.resolve(null);
    if (this.modo === 'mapa') {
      relevo = blocoRelevo(x, y, nivel, request);
      if (!relevo) return undefined; // o agendador do Cesium pede de novo depois
    }
    return Promise.all([relevo, this._dados(ret, nivel, cancelada)]).then(([r, dados]) => this._desenhar(ret, nivel, r, dados));
  }

  async _dados(ret, nivel, cancelada) {
    const q = new Quadro(ret, this._T);
    const folga = (ret.east - ret.west) * 0.04;
    const env = [ret.west - folga, ret.south - folga, ret.east + folga, ret.north + folga].join(',');
    const comum = { geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '3857', outSR: '3857',
      spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true', geometryPrecision: '1',
      maxAllowableOffset: String(Math.max(0.3, q.mpp * 0.7)) };
    const sobre = this.modo === 'sobre';
    const nivelQuadras = NIVEIS.quadras;
    const filtroVias = nivel >= (sobre ? 15 : 14) ? '1=1' : nivel >= 12 ? 'in_hie >= 21' : 'in_hie >= 40';
    const [limites, quadras, vias, lotes] = await Promise.all([
      nivel >= NIVEIS.bairros ? consultar(2, { ...comum, outFields: 'OBJECTID', where: '1=1', maxAllowableOffset: String(Math.max(1, q.mpp)) }, cancelada).catch(() => []) : [],
      nivel >= nivelQuadras ? consultar(1, { ...comum, outFields: nivel >= NIVEIS.numeroQuadra ? 'nm_qdr' : 'OBJECTID', where: '1=1' }, cancelada).catch(() => []) : [],
      consultar(7, { ...comum, outFields: 'nm,in_hie', where: filtroVias }, cancelada).catch(() => []),
      // Divisas dos lotes dentro das quadras, carregadas por bloco do mapa conforme a aproximação.
      nivel >= NIVEIS.lotes ? consultar(0, { ...comum, outFields: nivel >= NIVEIS.numeroLote ? 'nm_lot' : 'OBJECTID', where: '1=1',
        maxAllowableOffset: String(Math.max(0.15, q.mpp * 0.5)) }, cancelada).catch(() => []) : [],
    ]);
    return { limites, quadras, vias, lotes };
  }

  _desenhar(ret, nivel, relevo, { limites = [], quadras, vias, lotes = [] }) {
    const T = this._T, e = this.estilo, q = new Quadro(ret, T);
    const tela = this._tela(), g = tela.getContext('2d');
    const mapa = this.modo === 'mapa';

    if (mapa) { g.fillStyle = nivel >= NIVEIS.quadras ? e.fundo : e.urbano; g.fillRect(0, 0, T, T); }

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

    // Vias, das menores para as maiores: contorno de todas e depois o miolo.
    const porClasse = Object.fromEntries(ORDEM.map((c) => [c, []]));
    for (const f of vias) if (f.geometry?.paths) porClasse[classeVia(f.attributes.in_hie)].push(f);
    const largura = (c) => Math.min(30, Math.max(LARGURA_MIN[c], LARGURA_M[c] / q.mpp));
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const etapa of [0, 1]) {
      for (const c of ORDEM) {
        const [contorno, miolo] = e.via[c];
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
    // Nomes de bairro (vista de bairros)
    if (nivel >= 12 && nivel <= 15) {
      const { fonte, lista } = this._bairrosDoNivel(nivel);
      for (const b of lista) {
        if (b.c.x1 < ret.west || b.c.x0 > ret.east || b.c.y1 < ret.south || b.c.y0 > ret.north) continue;
        r.texto(b.n, q.x(b.x), q.y(b.y), { fonte, cor: e.bairro, halo: e.halo, forcar: true });
      }
    }
    // Nomes de rua: arteriais desde o nível 14, todas a partir do 16.
    const nomeadas = [...porClasse.expressa, ...porClasse.arterial, ...(nivel >= 15 ? porClasse.coletora : []), ...(nivel >= 16 ? porClasse.local : [])];
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
    // Número do lote (de perto), maior quanto mais perto.
    if (nivel >= NIVEIS.numeroLote && lotes.length) {
      const px = nivel >= 20 ? 14 : nivel >= 19 ? 12.5 : nivel >= 18 ? 11 : 9.5;
      const fonte = `500 ${px}px system-ui, "Segoe UI", Roboto, sans-serif`;
      for (const f of lotes) {
        const nm = String(f.attributes.nm_lot || '').trim();
        const anel = f.geometry?.rings?.[0];
        if (!nm || !anel) continue;
        let sx = 0, sy = 0;
        for (const [a, b] of anel) { sx += a; sy += b; }
        r.texto(nm, q.x(sx / anel.length), q.y(sy / anel.length), { fonte, cor: e.loteTexto, halo: e.halo });
      }
    }
    // Número da quadra, a partir da vista de quadras, maior quanto mais perto.
    if (nivel >= NIVEIS.numeroQuadra) {
      const px = nivel >= 19 ? 15 : nivel >= 18 ? 13.5 : nivel >= 17 ? 12 : 10.5;
      const fonte = `700 ${px}px system-ui, "Segoe UI", Roboto, sans-serif`;
      for (const f of quadras) {
        const nm = String(f.attributes.nm_qdr || '').trim();
        const anel = f.geometry?.rings?.[0];
        if (!nm || !anel) continue;
        let sx = 0, sy = 0;
        for (const [a, b] of anel) { sx += a; sy += b; }
        r.texto(`Qd. ${nm}`, q.x(sx / anel.length), q.y(sy / anel.length), { fonte, cor: e.quadraTexto, halo: e.halo, forcar: nivel >= NIVEIS.lotes });
      }
    }
    return tela;
  }
}

// ------------------------------------------------------------------- lotes
export class ProvedorLotes extends ProvedorCanvas {
  constructor({ lotes, retangulo, borda = '#ffd54a', credito = 'Lotes: Prefeitura de Goiânia', nivelMinimo = 12, rotulos = () => true }) {
    super({ retangulo, credito, nivelMinimo });
    this.rotulos = rotulos; // false quando o mapa de baixo já escreve o número do lote (evita número duplicado)
    this.lotes = lotes; // [{ aneis: [[[x,y]…]], ext: [o,s,l,n], nm, cor }]
    this.borda = borda; // cor da divisa, ou null para usar a cor de cada lote
  }
  requestImage(x, y, nivel) {
    const ret = this._grade.tileXYToNativeRectangle(x, y, nivel);
    const T = this._T, q = new Quadro(ret, T);
    const tela = this._tela(), g = tela.getContext('2d');
    if (nivel < NIVEIS.lotes) return Promise.resolve(tela); // lotes só de perto
    const dentro = this.lotes.filter((l) => l.ext[0] < ret.east && l.ext[2] > ret.west && l.ext[1] < ret.north && l.ext[3] > ret.south);
    if (!dentro.length) return Promise.resolve(tela);
    for (const l of dentro) {
      g.beginPath(); q.caminho(g, l.aneis);
      g.fillStyle = l.cor; g.fill('evenodd');
    }
    g.beginPath();
    for (const l of dentro) q.caminho(g, l.aneis);
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(20,24,28,.55)'; g.lineWidth = nivel >= 17 ? 2.6 : 1.8; g.stroke();
    if (this.borda) { g.strokeStyle = this.borda; g.lineWidth = nivel >= 17 ? 1.3 : 0.8; g.stroke(); }
    if (nivel >= NIVEIS.numeroLote && this.rotulos()) {
      const r = new Rotulos(g, T);
      const fonte = `600 ${nivel >= 20 ? 14 : nivel >= 19 ? 12.5 : nivel >= 18 ? 11 : 9.5}px system-ui, "Segoe UI", Roboto, sans-serif`;
      for (const l of dentro) {
        if (!l.nm) continue;
        const px = q.x(l.centro[0]), py = q.y(l.centro[1]);
        r.texto(l.nm, px, py, { fonte, cor: '#1f2226', halo: 'rgba(255,255,255,.9)' });
      }
    }
    return Promise.resolve(tela);
  }
}

/**
 * Desenho livre por cima do mapa (usado nos locais de votação): polígonos com preenchimento e borda
 * próprios e linhas (tracejadas ou não). Tudo em imagem, sem custo de geometria 3D, e visível
 * desde a vista da cidade: polígono pequeno demais vira um quadrado de 7 px.
 */
export class ProvedorDesenho extends ProvedorCanvas {
  constructor({ poligonos = [], linhas = [], retangulo, credito = 'Levantamento da Associação', nivelMinimo = 10 }) {
    super({ retangulo, credito, nivelMinimo });
    this.poligonos = poligonos; // [{ aneis (mercator), ext, cor, borda, largura }]
    this.linhas = linhas;       // [{ de: [x,y], para: [x,y], cor, contorno, largura, tracejado }]
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
    return Promise.resolve(tela);
  }
}
