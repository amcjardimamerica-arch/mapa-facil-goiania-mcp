// Geo360 (atualização 2024-2025) — painel Camadas. Dados públicos do portal Geo360 Goiânia (Prefeitura de Goiânia,
// recadastramento Topocart 2024-2025), obtidos pela Lei de Acesso à Informação, que ainda não vinham do Mapa Fácil:
//   - Condomínios oficiais por tipo (horizontal, horizontal fechado, vertical, vertical informal)
//   - Planta de Valores Genéricos 2016-2025 (o Mapa Fácil ia só até 2023)
//   - Setores de risco geológico (CPRM / Defesa Civil), por tipo e grau
//   - Equipamentos de Guarda Civil Municipal, Cultura e Assistência Social (não existem no Mapa Fácil)
//
// Mesma mecânica da Drenagem Pluvial: tudo desenhado numa camada de imagem própria, por bloco do mapa, a partir de
// um índice em grade feito uma vez na memória. Ligar e desligar cada parte só refaz o desenho, sem baixar de novo.
// Dados em data/geo360/ (scripts/geo360_dados.py). Fonte: Geo360 Goiânia — Prefeitura de Goiânia.
import { CFG } from './config.js';
import { el, pedirJSON, fmtNum, memoria, aviso } from './util.js';
import { ProvedorCanvas, Quadro } from './mapavetorial.js';

const Cesium = window.Cesium;
const R = 6378137;
const mx = (lon) => lon * (Math.PI / 180) * R;
const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
const paraLon = (x) => (x / R) * (180 / Math.PI);
const paraLat = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
const CEL = 400; // célula do índice (m, Web Mercator)

export const COR = {
  condHorizontal: '#4fc3f7', condHorizontalFechado: '#1565c0', condVertical: '#ab47bc', condVerticalInformal: '#ef6c00', condOutro: '#90a4ae',
  pvBaixo: '#1a9850', pvMedio: '#fee08b', pvAlto: '#d73027', pvContorno: 'rgba(0,0,0,.35)',
  riscoAlto: '#d50000', riscoMedio: '#ff6d00', riscoBaixo: '#ffd600', riscoContorno: 'rgba(0,0,0,.6)',
  gcm: '#1e88e5', cultura: '#8e24aa', assist: '#2e7d32',
};

const PADRAO = { condominios: true, condHorizontal: true, condVertical: true, condInformal: true,
  planta: false, risco: true, gcm: true, cultura: true, assist: true };

/** Reconstrói um anel (micrograus delta) para [lon, lat]. */
function decodificar(a) {
  const pts = []; let x = 0, y = 0;
  for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; pts.push([x / 1e6, y / 1e6]); }
  return pts;
}

class Indice {
  constructor() { this.c = new Map(); }
  add(item, o, s, e, n) {
    for (let i = Math.floor(o / CEL); i <= Math.floor(e / CEL); i++) for (let j = Math.floor(s / CEL); j <= Math.floor(n / CEL); j++) {
      const k = `${i}:${j}`; let l = this.c.get(k); if (!l) this.c.set(k, (l = [])); l.push(item);
    }
  }
  busca(o, s, e, n) {
    const out = new Set();
    for (let i = Math.floor(o / CEL); i <= Math.floor(e / CEL); i++) for (let j = Math.floor(s / CEL); j <= Math.floor(n / CEL); j++) {
      for (const it of this.c.get(`${i}:${j}`) || []) out.add(it);
    }
    return out;
  }
}

/** Anéis de um item polígono, em metros Web Mercator, com a caixa envolvente. */
function aneisMetros(g) {
  const aneis = g.map(decodificar).map((r) => r.map(([lo, la]) => [mx(lo), my(la)]));
  let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const r of aneis) for (const [a, b] of r) { o = Math.min(o, a); e = Math.max(e, a); s = Math.min(s, b); n = Math.max(n, b); }
  return { aneis, ext: [o, s, e, n], centro: [(o + e) / 2, (s + n) / 2] };
}

/** Faixa de cor da Planta de Valores (verde→amarelo→vermelho) pelo valor do m². */
function corValor(v, max) {
  if (!v || !max) return COR.pvBaixo;
  const t = Math.min(1, v / max);
  if (t < 0.5) { const k = t / 0.5; return mistura([26, 152, 80], [254, 224, 139], k); }
  const k = (t - 0.5) / 0.5; return mistura([254, 224, 139], [215, 48, 39], k);
}
function mistura(a, b, k) { return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`; }

/** Desenho por bloco do mapa. */
class ProvedorGeo360 extends ProvedorCanvas {
  constructor(geo, retangulo) {
    super({ retangulo, credito: 'Geo360 Goiânia (Prefeitura de Goiânia) · dados públicos (Lei de Acesso à Informação)', nivelMinimo: 11 });
    this.geo = geo;
  }
  requestImage(x, y, nivel) {
    const ret = this._grade.tileXYToNativeRectangle(x, y, nivel);
    const T = this._T, q = new Quadro(ret, T), tela = this._tela(), g = tela.getContext('2d');
    const d = this.geo, op = d.efetivas(), folga = (ret.east - ret.west) * 0.08;
    const itens = d.indice.busca(ret.west - folga, ret.south - folga, ret.east + folga, ret.north + folga);
    g.lineCap = 'round'; g.lineJoin = 'round';
    const porLinha = (lista) => lista.map((it) => it.aneis);
    // Planta de Valores (fundo): preenchimento por faixa de valor do ano mais recente.
    if (op.planta && nivel >= 12) {
      for (const it of itens) {
        if (it.k !== 'pv') continue;
        g.beginPath(); q.caminho(g, it.aneis);
        g.fillStyle = corValor(it.vAtual, d.pvMax); g.globalAlpha = 0.5; g.fill('evenodd'); g.globalAlpha = 1;
        g.lineWidth = 0.6; g.strokeStyle = COR.pvContorno; g.stroke();
      }
    }
    // Condomínios: contorno grosso pela categoria, com leve preenchimento.
    if (op.condominios && nivel >= 13) {
      for (const it of itens) {
        if (it.k !== 'cond' || !d.condVisivel(it)) continue;
        g.beginPath(); q.caminho(g, it.aneis);
        g.fillStyle = it.cor; g.globalAlpha = 0.18; g.fill('evenodd'); g.globalAlpha = 1;
        g.lineWidth = nivel >= 16 ? 2.4 : 1.6; g.strokeStyle = it.cor; g.stroke();
      }
    }
    // Risco geológico: hachura e contorno pela gravidade.
    if (op.risco && nivel >= 12) {
      for (const it of itens) {
        if (it.k !== 'risco') continue;
        g.beginPath(); q.caminho(g, it.aneis);
        g.fillStyle = it.cor; g.globalAlpha = 0.35; g.fill('evenodd'); g.globalAlpha = 1;
        g.lineWidth = 2.2; g.strokeStyle = COR.riscoContorno; g.stroke();
      }
    }
    // Equipamentos (pontos): marcador redondo com inicial.
    if (nivel >= 12) {
      const r0 = nivel >= 16 ? 9 : nivel >= 14 ? 7 : 5;
      for (const it of itens) {
        if (it.k !== 'eq') continue;
        const vis = it.t === 'gcm' ? op.gcm : it.t === 'cultura' ? op.cultura : op.assist;
        if (!vis) continue;
        const cx = q.x(it.m[0]), cy = q.y(it.m[1]);
        g.beginPath(); g.arc(cx, cy, r0, 0, Math.PI * 2);
        g.fillStyle = it.t === 'gcm' ? COR.gcm : it.t === 'cultura' ? COR.cultura : COR.assist; g.fill();
        g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke();
        if (nivel >= 14) {
          g.fillStyle = '#ffffff'; g.font = `800 ${r0}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(it.t === 'gcm' ? 'G' : it.t === 'cultura' ? 'C' : 'A', cx, cy + 0.5);
        }
      }
    }
    return Promise.resolve(tela);
  }
}

export class Geo360 {
  constructor({ globo, identificar }) {
    Object.assign(this, { globo, identificar });
    this.opcoes = { ...PADRAO, ...memoria.ler('bussola:geo360', {}) };
    this.ligado = false;
    // 1.40: Planta de Valores (Edificações) e Risco Geológico (Meio Ambiente) usam estes dados nas camadas que já
    // existiam; condomínios entram na ficha do lote. O projeto "Serviços Públicos" mostra os equipamentos.
    this.externo = { planta: false, risco: false, condominios: false };
    this.camada = null;
  }

  _gravar() { memoria.gravar('bussola:geo360', this.opcoes); }

  condVisivel(it) {
    const op = this.opcoes;
    if (it.tp === 'Vertical') return op.condVertical;
    if (it.tp === 'Vertical informal') return op.condInformal;
    return op.condHorizontal; // horizontal, horizontal fechado e outros
  }

  /** Lê os quatro arquivos (uma vez) e monta o índice em grade. */
  carregar() {
    if (this._carregando) return this._carregando;
    const ler = (n) => pedirJSON(`${CFG.dados}geo360/${n}.json`, { tempo: 120000 });
    this._carregando = Promise.all(['condominios', 'planta_valores', 'risco_geologico', 'equipamentos'].map(ler))
      .then(([cond, pv, risco, eq]) => {
        const ix = new Indice();
        this.condominios = (cond.condominios || []).map((c) => {
          const geom = aneisMetros(c.g);
          const cor = c.tp === 'Horizontal fechado' ? COR.condHorizontalFechado : c.tp === 'Vertical' ? COR.condVertical
            : c.tp === 'Vertical informal' ? COR.condVerticalInformal : c.tp === 'Horizontal' ? COR.condHorizontal : COR.condOutro;
          const it = { k: 'cond', ...geom, cor, tp: c.tp, v: c };
          ix.add(it, ...it.ext); return it;
        });
        this.anosPv = pv.anos || [];
        let max = 0;
        this.planta = (pv.planta || []).map((p) => {
          const geom = aneisMetros(p.g);
          const vAtual = [...p.v].reverse().find((x) => x) || 0;
          max = Math.max(max, vAtual);
          const it = { k: 'pv', ...geom, vAtual, v: p }; ix.add(it, ...it.ext); return it;
        });
        this.pvMax = max;
        this.risco = (risco.risco || []).map((r) => {
          const geom = aneisMetros(r.g);
          const cor = /alto/i.test(r.grau) ? COR.riscoAlto : /m[eé]dio/i.test(r.grau) ? COR.riscoMedio : COR.riscoBaixo;
          const it = { k: 'risco', ...geom, cor, v: r }; ix.add(it, ...it.ext); return it;
        });
        const TP = { 'Guarda Civil Municipal': 'gcm', Cultura: 'cultura', 'Assistência Social': 'assist' };
        this.equipamentos = (eq.equipamentos || []).map((e) => {
          const m = [mx(e.c[0]), my(e.c[1])];
          const it = { k: 'eq', t: TP[e.t] || 'assist', m, v: e }; ix.add(it, m[0], m[1], m[0], m[1]); return it;
        });
        this.indice = ix;
        return this;
      });
    this._carregando.catch(() => { this._carregando = null; });
    return this._carregando;
  }

  /** Equipamentos para a busca geral (lon/lat, nome, tipo). */
  async lugares() {
    try { await this.carregar(); } catch { return []; }
    return this.equipamentos.map((it) => ({ n: it.v.n, r: it.v.t, c: it.v.c, b: it.v.b, k: 'eq360' }));
  }

  /** O que desenhar: equipamentos pelo projeto; Planta e Risco pelas camadas de Edificações e Meio Ambiente. */
  efetivas() {
    const op = this.opcoes, lig = this.ligado;
    return { ...op, condominios: this.externo.condominios, condHorizontal: true, condVertical: true, condInformal: true, planta: this.externo.planta, risco: this.externo.risco,
      gcm: lig && op.gcm, cultura: lig && op.cultura, assist: lig && op.assist };
  }
  get ativo() { return this.ligado || this.externo.planta || this.externo.risco || this.externo.condominios; }

  /** Edificações → Planta de Valores e Meio Ambiente → Risco Geológico ligam estes dados (versão 2016-2025). */
  async definirExterno(ext) {
    Object.assign(this.externo, ext);
    if (!this.ativo) { this._tirar(); return; }
    try { await this.carregar(); } catch { return; }
    this.redesenhar();
  }

  async ligar(ligado) {
    this.ligado = ligado;
    if (!ligado) { if (this.ativo) this.redesenhar(); else this._tirar(); return; }
    try { await this.carregar(); } catch (e) { aviso(`Geo360 indisponível: ${e.message}`, 'alerta'); return; }
    if (this.ligado) { this.redesenhar(); this._montarPainel(); }
  }

  _tirar() {
    if (this.camada) { this.globo.viewer.imageryLayers.remove(this.camada, true); this.camada = null; this.globo.camadaGeo360 = null; }
    this.globo.redesenhar();
  }

  redesenhar() {
    this._tirar();
    if (!this.ativo || !this.indice) return;
    this.camada = this.globo.viewer.imageryLayers.addImageryProvider(new ProvedorGeo360(this, this.globo.ret));
    this.globo.camadaGeo360 = this.camada;
    this.globo.organizarPilha();
    this.globo.redesenhar();
  }

  // ------------------------------------------------------------------ painel (Camadas → Geo360)
  montarEm(caixa) { this.caixa = caixa; this._montarPainel(); }

  _montarPainel() {
    const c = this.caixa;
    if (!c) return;
    c.textContent = '';
    const op = this.opcoes;
    const chave = (id, titulo, cor, n, sub, forma = 'quadro') => el('label', { class: 'linha-chave dren-linha' },
      el('span', { class: 'dren-rotulo' }, el('span', { class: `dren-simbolo ${forma}`, style: `--cor:${cor}` }),
        el('span', {}, el('strong', {}, titulo), sub ? el('small', {}, sub) : null)),
      n != null ? el('small', { class: 'dren-n' }, fmtNum(n)) : null,
      el('span', { class: 'interruptor' }, el('input', { type: 'checkbox', checked: !!op[id], onchange: (e) => { op[id] = e.target.checked; this._gravar(); this.redesenhar(); } }), el('span', {})));
    const grupo = (titulo, ...itens) => el('details', { class: 'dren-grupo', open: true }, el('summary', {}, titulo), ...itens);
    const nC = (f) => (this.condominios ? this.condominios.filter(f).length : null);
    // Padrão (1.46): subtítulo com interruptor; os três equipamentos como itens (caixa de marcação).
    const itens = [['gcm', 'Guarda Civil Municipal'], ['cultura', 'Cultura'], ['assist', 'Assistência Social (CRAS, CREAS)']];
    const linhas = itens.map(([id, rot]) => {
      const l = chave(id, rot, COR[id], this.equipamentos?.filter((e) => e.t === id).length, null, 'circulo');
      l.classList.add('dren-sub-linha');
      return l;
    });
    const geral = el('input', { type: 'checkbox', checked: itens.some(([id]) => op[id]), onchange: (e) => {
      for (const [id] of itens) op[id] = e.target.checked;
      linhas.forEach((l) => { l.querySelector('input').checked = e.target.checked; });
      this._gravar(); this.redesenhar(); } });
    c.append(el('label', { class: 'linha-chave' }, el('span', {}, el('strong', {}, 'Segurança, cultura e assistência social')), el('span', { class: 'interruptor' }, geral, el('span', {}))), ...linhas);
  }

  /** Condomínio oficial (2024-2025) que contém o ponto [lon, lat], para a ficha do lote. */
  async condominioEm(lon, lat) {
    try { await this.carregar(); } catch { return null; }
    const x = mx(lon), y = my(lat);
    for (const it of this.indice.busca(x - 1, y - 1, x + 1, y + 1)) if (it.k === 'cond' && dentroAneis(it.aneis, x, y)) return it.v;
    return null;
  }

  // ------------------------------------------------------------------ clique
  aoClicar(ponto) {
    if (!this.ativo || !this.indice || !ponto) return false;
    const mpp = (this.globo.metrosPorPixel() || 1) / Math.cos((ponto.lat * Math.PI) / 180);
    const x = mx(ponto.lon), y = my(ponto.lat), tol = Math.max(3, mpp * 10);
    const perto = this.indice.busca(x - tol, y - tol, x + tol, y + tol);
    const op = this.efetivas();
    // Equipamento mais perto (ponto).
    let eq = null, de = tol;
    for (const it of perto) if (it.k === 'eq') {
      const vis = it.t === 'gcm' ? op.gcm : it.t === 'cultura' ? op.cultura : op.assist;
      if (!vis) continue;
      const d = Math.hypot(it.m[0] - x, it.m[1] - y); if (d <= de) { de = d; eq = it; }
    }
    if (eq) { this._fichaEquip(eq); return true; }
    // Polígono que contém o ponto: risco, condomínio, planta.
    for (const k of ['risco', 'cond', 'pv']) {
      if (k === 'cond' && !op.condominios) continue;
      if (k === 'pv' && !op.planta) continue;
      if (k === 'risco' && !op.risco) continue;
      for (const it of perto) {
        if (it.k !== k) continue;
        if (k === 'cond' && !this.condVisivel(it)) continue;
        if (dentroAneis(it.aneis, x, y)) { this._fichaPoligono(it); return true; }
      }
    }
    return false;
  }

  _nota() { return el('p', { class: 'nota' }, 'Geo360 Goiânia — Prefeitura de Goiânia (recadastramento 2024-2025); dado público obtido pela Lei de Acesso à Informação.'); }

  _fichaEquip(it) {
    const id = this.identificar, e = it.v;
    const nomes = { gcm: 'Guarda Civil Municipal', cultura: 'Cultura', assist: 'Assistência Social' };
    id.limparDestaque();
    id.abrir({ titulo: e.n || nomes[it.t], subtitulo: `Equipamento de ${nomes[it.t]} · Goiânia`, ponto: { lon: e.c[0], lat: e.c[1], alt: NaN } });
    id.corpo.append(id.tabela([['Tipo', nomes[it.t]], ['Classificação', e.cl], ['Endereço', e.e], ['Bairro', e.b], ['CEP', e.cep]]
      .filter(([, v]) => v)), this._nota());
    this._marcar(it.m);
  }

  _fichaPoligono(it) {
    const id = this.identificar;
    id.limparDestaque();
    const aneis = it.aneis.map((r) => r.map(([a, b]) => [paraLon(a), paraLat(b)]));
    const cor = Cesium.Color.fromCssColorString(it.cor || '#ffd600');
    id.destacarLonLat(aneis, { fechado: true, cor });
    const centro = { lon: paraLon(it.centro[0]), lat: paraLat(it.centro[1]), alt: NaN };
    if (it.k === 'cond') {
      const c = it.v;
      id.abrir({ titulo: c.n || 'Condomínio', subtitulo: `Condomínio ${c.tp.toLowerCase()} · ${c.b || 'Goiânia'}`, ponto: centro });
      id.corpo.append(id.tabela([['Tipo', c.tp], ['Bairro', c.b],
        ['Área privativa total', c.ap ? `${fmtNum(c.ap, 2)} m²` : ''], ['Área comum total', c.ac ? `${fmtNum(c.ac, 2)} m²` : ''],
        ['Área construída privativa', c.acp ? `${fmtNum(c.acp, 2)} m²` : ''], ['Área construída comum', c.acc ? `${fmtNum(c.acc, 2)} m²` : '']]
        .filter(([, v]) => v)), this._nota());
    } else if (it.k === 'pv') {
      const p = it.v;
      id.abrir({ titulo: `Planta de Valores${p.s ? ` · setor ${p.s}` : ''}`, subtitulo: 'Valor venal do m² de terreno (PVG)', ponto: centro });
      const linhas = this.anosPv.map((ano, i) => [String(ano), p.v[i] ? `R$ ${fmtNum(p.v[i], 2)} / m²` : '—']);
      id.corpo.append(id.tabela(linhas), this._nota());
    } else if (it.k === 'risco') {
      const r = it.v;
      id.abrir({ titulo: r.local || 'Setor de risco geológico', subtitulo: `${r.tipo || 'Risco'} · grau ${r.grau || '—'}`, ponto: centro });
      id.corpo.append(id.tabela([['Tipo', r.tipo], ['Material', r.material], ['Grau de risco', r.grau], ['Grau de vulnerabilidade', r.vuln],
        ['Moradias', r.moradias], ['Pessoas', r.pessoas], ['Situação', r.situacao], ['Órgão', r.orgao], ['Levantamento', r.data]]
        .filter(([, v]) => v != null && v !== '')),
      r.desc ? el('p', { class: 'nota' }, `Descrição: ${r.desc}`) : null,
      r.interv ? el('p', { class: 'nota' }, `Intervenção sugerida: ${r.interv}`) : null,
      this._nota());
    }
  }

  _marcar(m) {
    const lon = paraLon(m[0]), lat = paraLat(m[1]), r = 0.00004;
    this.identificar.destacarLonLat([[[lon - r, lat - r], [lon + r, lat - r], [lon + r, lat + r], [lon - r, lat + r], [lon - r, lat - r]]], { fechado: true, cor: Cesium.Color.YELLOW });
  }
}

/** Ponto (x,y Mercator) dentro de um conjunto de anéis (regra par-ímpar). */
function dentroAneis(aneis, x, y) {
  let dentro = false;
  for (const anel of aneis) {
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const xi = anel[i][0], yi = anel[i][1], xj = anel[j][0], yj = anel[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
  }
  return dentro;
}
