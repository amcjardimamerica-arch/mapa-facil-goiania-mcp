// Drenagem Pluvial (painel Camadas): base própria da A.M.C. Jardim América — bocas de lobo, sistema de galerias e
// pontos de inspeção de Goiânia inteira, com as análises da A.M.C. (ruas sem boca de lobo, pontos baixos sem boca,
// conferência com o levantamento de campo). Dados em data/drenagem/ (scripts/drenagem_pluvial.py); fonte de
// pesquisa: cadastro da microdrenagem do PDDU-GYN (UFG, Seinfra e Prefeitura de Goiânia).
//
// Tudo é desenhado numa camada de imagem própria (como a Base Cadastral), por bloco do mapa, a partir de um índice em
// grade feito uma vez na memória: ligar e desligar cada parte só refaz o desenho, sem baixar nada de novo.
import { CFG } from './config.js';
import { el, pedirJSON, fmtNum, memoria, aviso } from './util.js';
import { ProvedorCanvas, Quadro } from './mapavetorial.js';
import { bocaPx } from './postes.js';

const Cesium = window.Cesium;
const R = 6378137;
const mx = (lon) => lon * (Math.PI / 180) * R;
const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
const CEL = 400; // célula do índice (m, Web Mercator)

/** Cores fixas da legenda (as mesmas no mapa e no painel). */
export const COR = {
  galeriaFina: '#7fd3ff', galeriaMedia: '#2f8cff', galeriaGrossa: '#1440a8', contorno: 'rgba(0,0,0,.55)',
  simples: '#ffffff', grelha: '#26c6da', combinada: '#ba68c8', ruim: '#ff1744', naoImplantada: '#9e9e9e',
  conferida: '#00e676', soPddu: '#ffab00', soAmc: '#ff4081',
  poco: '#263238', pocoFechado: '#ff5252', lancamento: '#00b0ff', semBoca: '#ff9100', baixo: '#ff1744',
};

const PADRAO = { bocas: true, simples: true, grelha: true, combinada: true, ruins: true, naoImplantadas: false, conferencia: false,
  rede: true, sentido: true, pocos: true, lancamentos: true, semBoca: false, baixos: true };

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

/** Desenho por bloco do mapa. */
class ProvedorDrenagem extends ProvedorCanvas {
  constructor(dren, retangulo) {
    super({ retangulo, credito: 'Drenagem Pluvial: base própria da A.M.C. Jardim América; fonte de pesquisa PDDU-GYN (UFG/Seinfra/Prefeitura de Goiânia)', nivelMinimo: 11 });
    this.dren = dren;
  }
  requestImage(x, y, nivel) {
    const ret = this._grade.tileXYToNativeRectangle(x, y, nivel);
    const T = this._T, q = new Quadro(ret, T), tela = this._tela(), g = tela.getContext('2d');
    const d = this.dren, op = d.opcoes, folga = (ret.east - ret.west) * 0.06;
    const itens = d.indice.busca(ret.west - folga, ret.south - folga, ret.east + folga, ret.north + folga);
    const por = { rede: [], semBoca: [], boca: [], poco: [], lanc: [], baixo: [] };
    for (const it of itens) por[it.k]?.push(it);
    g.lineCap = 'round'; g.lineJoin = 'round';
    // Análise: trechos de rua sem boca de lobo a 80 m (laranja tracejado).
    if (op.semBoca && nivel >= 13) {
      g.save(); g.setLineDash([6, 4]); g.strokeStyle = COR.semBoca; g.lineWidth = nivel >= 16 ? 4 : 2.5; g.globalAlpha = 0.9;
      g.beginPath(); for (const s of por.semBoca) q.caminho(g, [s.m]); g.stroke(); g.restore();
    }
    // Sistema: galerias pela classe de diâmetro, com contorno escuro.
    if (op.rede && nivel >= 12) {
      const larg = (dm) => (nivel >= 17 ? 2 + dm * 4 : nivel >= 15 ? 1.4 + dm * 2.6 : 0.8 + dm * 1.4);
      for (const etapa of [0, 1]) for (const r of por.rede) {
        g.beginPath(); q.caminho(g, [r.m]);
        g.strokeStyle = etapa ? (r.d >= 1 ? COR.galeriaGrossa : r.d >= 0.5 ? COR.galeriaMedia : COR.galeriaFina) : COR.contorno;
        g.lineWidth = larg(r.d) + (etapa ? 0 : 1.6); g.stroke();
      }
      // Sentido do escoamento (pelo relevo): seta no meio do trecho.
      if (op.sentido && nivel >= 17) {
        g.fillStyle = '#ffffff'; g.strokeStyle = '#0d2a66'; g.lineWidth = 1;
        for (const r of por.rede) {
          const k = Math.floor((r.m.length - 1) / 2), a = r.m[k], b = r.m[k + 1];
          const ax = q.x(a[0]), ay = q.y(a[1]), bx = q.x(b[0]), by = q.y(b[1]);
          if (Math.hypot(bx - ax, by - ay) < 14) continue;
          const cx = (ax + bx) / 2, cy = (ay + by) / 2, ang = Math.atan2(by - ay, bx - ax), s = 5 + r.d * 2;
          g.save(); g.translate(cx, cy); g.rotate(ang); g.beginPath(); g.moveTo(s, 0); g.lineTo(-s, -s * 0.7); g.lineTo(-s * 0.4, 0); g.lineTo(-s, s * 0.7); g.closePath(); g.fill(); g.stroke(); g.restore();
        }
      }
    }
    // Lançamentos (onde a galeria entrega no córrego): triângulo azul.
    if (op.lancamentos && nivel >= 13) {
      for (const l of por.lanc) {
        const cx = q.x(l.m[0]), cy = q.y(l.m[1]), s = nivel >= 16 ? 9 : 6;
        g.beginPath(); g.moveTo(cx, cy - s); g.lineTo(cx + s, cy + s * 0.8); g.lineTo(cx - s, cy + s * 0.8); g.closePath();
        g.fillStyle = COR.lancamento; g.fill(); g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke();
      }
    }
    // Pontos de inspeção: poços de visita (círculo escuro; vermelho quando a tampa está lacrada ou sob o asfalto).
    if (op.pocos && nivel >= 16) {
      const r0 = nivel >= 18 ? 5.5 : 3.8;
      for (const p of por.poco) {
        const cx = q.x(p.m[0]), cy = q.y(p.m[1]);
        g.beginPath(); g.arc(cx, cy, r0, 0, Math.PI * 2); g.fillStyle = COR.poco; g.fill();
        g.lineWidth = 2; g.strokeStyle = p.fechado ? COR.pocoFechado : '#ffffff'; g.stroke();
      }
    }
    // Coleta da galeria (boca de lobo): o mesmo ícone das bocas de lobo da Associação, sem pedido de manutenção.
    // Mesma premissa das luminárias e das bocas da Associação: tamanho real mínimo até 1 km de câmera, crescendo
    // até 6× em 5 km; acima de 6 km não aparecem. O tamanho em pixels do bloco sai dos metros reais.
    if (op.bocas && nivel >= 12 && d.alturaCamera() <= 6000) {
      // Tamanho na tela (o bloco é desenhado em ~1 pixel de tela por pixel do bloco).
      const T = d.escalaBocaAtual;
      for (const b of por.boca) {
        if (!d.bocaVisivel(b)) continue;
        const img = iconeColeta(b.un, b.estado === 'Ruim', b.estado === 'Não implantada');
        g.drawImage(img, q.x(b.m[0]) - T / 2, q.y(b.m[1]) - T / 2, T, T);
      }
    }
    // Análise: ponto baixo de rua sem boca de lobo (losango vermelho com "!").
    if (op.baixos && nivel >= 13) {
      const s = nivel >= 16 ? 9 : 6.5;
      for (const p of por.baixo) {
        const cx = q.x(p.m[0]), cy = q.y(p.m[1]);
        g.beginPath(); g.moveTo(cx, cy - s); g.lineTo(cx + s, cy); g.lineTo(cx, cy + s); g.lineTo(cx - s, cy); g.closePath();
        g.fillStyle = COR.baixo; g.fill(); g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke();
        if (nivel >= 15) { g.fillStyle = '#ffffff'; g.font = `900 ${s}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', cx, cy + 0.5); }
      }
    }
    return Promise.resolve(tela);
  }
}

// Ícone da boca de lobo (o mesmo do mapa da Associação): grelha escura, borda branca (vermelha se em estado
// ruim; tracejada se prevista e não implantada) e o mostrador com o número de unidades.
const icones = new Map();
function iconeColeta(n, ruim, prevista) {
  const chave = `${n}|${ruim ? 1 : 0}|${prevista ? 1 : 0}`;
  if (icones.has(chave)) return icones.get(chave);
  const T = 64, c = document.createElement('canvas'); c.width = c.height = T;
  const g = c.getContext('2d');
  g.lineJoin = 'round';
  const x0 = 6, y0 = 16, w = 44, h = 38;
  g.globalAlpha = prevista ? 0.55 : 1;
  g.fillStyle = '#23272c'; g.strokeStyle = '#000000'; g.lineWidth = 7;
  g.beginPath(); if (g.roundRect) g.roundRect(x0, y0, w, h, 6); else g.rect(x0, y0, w, h); g.stroke();
  if (prevista) g.setLineDash([6, 4]);
  g.strokeStyle = ruim ? '#e53935' : '#ffffff'; g.lineWidth = 4; g.stroke(); g.setLineDash([]); g.fill();
  g.fillStyle = '#c9cfd6';
  for (let i = 0; i < 5; i++) g.fillRect(x0 + 6 + i * 7.6, y0 + 9, 3.6, h - 15);
  g.fillRect(x0 + 4, y0 + 4, w - 8, 3);
  const r = 13, cx = T - r - 2, cy = r + 2;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
  g.lineWidth = 2.5; g.strokeStyle = '#000000'; g.stroke();
  g.fillStyle = '#111418'; g.font = '800 17px system-ui, "Segoe UI", Roboto, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n || 1), cx, cy + 1);
  icones.set(chave, c);
  return c;
}

export class Drenagem {
  constructor({ globo, identificar }) {
    Object.assign(this, { globo, identificar });
    this.opcoes = { ...PADRAO, ...memoria.ler('bussola:drenagem', {}) };
    this.ligado = false;
    this.camada = null;
  }

  _gravar() { memoria.gravar('bussola:drenagem', this.opcoes); }

  bocaVisivel(b) {
    const op = this.opcoes;
    if (b.estado === 'Não implantada') return !!op.naoImplantadas;
    if (b.estado === 'Ruim' && op.ruins) return true;
    return b.tipo === 'Grelha' ? op.grelha : b.tipo === 'Combinada' ? op.combinada : op.simples;
  }

  /** Lê os cinco arquivos (uma vez) e monta o índice em grade. */
  carregar() {
    if (this._carregando) return this._carregando;
    const ler = (n) => pedirJSON(`${CFG.dados}drenagem/${n}.json`, { tempo: 120000 });
    this._carregando = Promise.all(['bocas', 'rede', 'inspecao', 'analises', 'resumo'].map(ler)).then(([bocas, rede, insp, an, resumo]) => {
      const ix = new Indice();
      const cb = Object.fromEntries(bocas.colunas.map((c, i) => [c, i]));
      this.bocas = bocas.linhas.map((v) => {
        const it = { k: 'boca', v, m: [mx(v[0]), my(v[1])], tipo: v[cb.tipo], estado: v[cb.estado], origem: v[cb.origem], un: v[cb.unidades] };
        ix.add(it, it.m[0], it.m[1], it.m[0], it.m[1]); return it;
      });
      this.colBocas = bocas.colunas;
      this.rede = rede.linhas.map((v) => {
        const ll = decodificar(v[7]); const mm = ll.map(([a, b]) => [mx(a), my(b)]);
        let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const [a, b] of mm) { o = Math.min(o, a); e = Math.max(e, a); s = Math.min(s, b); n = Math.max(n, b); }
        const it = { k: 'rede', v, ll, m: mm, d: v[0] || 0.4 }; ix.add(it, o, s, e, n); return it;
      });
      this.colRede = rede.colunas;
      const cp = insp.pocos.colunas;
      for (const v of insp.pocos.linhas) { const it = { k: 'poco', v, col: cp, m: [mx(v[0]), my(v[1])], fechado: v[2] !== 'Acessível' }; ix.add(it, it.m[0], it.m[1], it.m[0], it.m[1]); }
      const cl = insp.lancamentos.colunas;
      for (const v of insp.lancamentos.linhas) { const it = { k: 'lanc', v, col: cl, m: [mx(v[0]), my(v[1])] }; ix.add(it, it.m[0], it.m[1], it.m[0], it.m[1]); }
      for (const s of an.sem_boca) {
        const mm = s.c.map(([a, b]) => [mx(a), my(b)]);
        let o = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
        for (const [a, b] of mm) { o = Math.min(o, a); e = Math.max(e, a); so = Math.min(so, b); n = Math.max(n, b); }
        ix.add({ k: 'semBoca', s, ll: s.c, m: mm }, o, so, e, n);
      }
      const cpb = an.pontos_baixos.colunas;
      for (const v of an.pontos_baixos.linhas) { const it = { k: 'baixo', v, col: cpb, m: [mx(v[0]), my(v[1])] }; ix.add(it, it.m[0], it.m[1], it.m[0], it.m[1]); }
      this.indice = ix; this.resumo = resumo; this.fonte = bocas.fonte;
      return this;
    });
    this._carregando.catch(() => { this._carregando = null; });
    return this._carregando;
  }

  async ligar(ligado) {
    this.ligado = ligado;
    if (!ligado) { this._tirar(); return; }
    try { await this.carregar(); } catch (e) { aviso(`Drenagem Pluvial indisponível: ${e.message}`, 'alerta'); return; }
    if (this.ligado) { this.redesenhar(); this._montarPainel(); }
  }

  _tirar() {
    if (this.camada) { this.globo.viewer.imageryLayers.remove(this.camada, true); this.camada = null; this.globo.camadaDrenagem = null; }
    this.globo.redesenhar();
  }

  alturaCamera() { return this.globo.camera.positionCartographic.height; }

  /** Ao mudar o degrau de escala das bocas (premissa das luminárias), redesenha a camada. */
  _acompanharEscala() {
    if (this._ouvinteEscala) return;
    this.escalaBocaAtual = bocaPx(this.alturaCamera());
    this._ouvinteEscala = this.globo.camera.moveEnd.addEventListener(() => {
      const nova = bocaPx(this.alturaCamera());
      if (nova !== this.escalaBocaAtual) { this.escalaBocaAtual = nova; if (this.ligado && this.opcoes?.bocas) this.redesenhar(); }
    });
  }

  redesenhar() {
    this._tirar();
    if (!this.ligado || !this.indice) return;
    this._acompanharEscala();
    this.camada = this.globo.viewer.imageryLayers.addImageryProvider(new ProvedorDrenagem(this, this.globo.ret));
    this.globo.camadaDrenagem = this.camada;
    this.globo.organizarPilha();
    this.globo.redesenhar();
  }

  // ------------------------------------------------------------------ painel (Camadas → Drenagem Pluvial)
  montarEm(caixa) { this.caixa = caixa; this._montarPainel(); }

  _montarPainel() {
    const c = this.caixa;
    if (!c) return;
    c.textContent = '';
    // 4 filtros (Coleta, Galeria, Ponto de inspeção, Ponto de despejo), cada um com as suas subdivisões, no
    // mesmo padrão dos demais projetos: sem textos nem tópicos grandes. Sem pedido de manutenção (só indicação).
    const op = this.opcoes, cont = (f) => (this.bocas ? this.bocas.filter(f).length : null);
    const chave = (id, titulo, n, sub = false) => el('label', { class: `linha-chave${sub ? ' dren-sub-linha' : ''}` },
      el('span', {}, sub ? titulo : el('strong', {}, titulo)),
      n != null ? el('small', { class: 'dren-n' }, fmtNum(n)) : null,
      el('span', { class: 'interruptor' }, el('input', { type: 'checkbox', checked: !!op[id], onchange: (e) => { op[id] = e.target.checked; this._gravar(); this.redesenhar(); } }), el('span', {})));
    const rs = this.resumo?.cidade;
    const existe = (b) => b.estado !== 'Não implantada';
    c.append(
      chave('bocas', 'Coleta da galeria (boca de lobo)', cont(existe)),
      chave('simples', 'Simples (meio-fio)', cont((b) => b.tipo === 'Simples (guia)' && existe(b)), true),
      chave('grelha', 'Com grelha', cont((b) => b.tipo === 'Grelha' && existe(b)), true),
      chave('combinada', 'Combinada', cont((b) => b.tipo === 'Combinada' && existe(b)), true),
      chave('ruins', 'Em estado ruim', cont((b) => b.estado === 'Ruim'), true),
      chave('naoImplantadas', 'Previstas e não implantadas', cont((b) => !existe(b)), true),
      chave('baixos', 'Pontos baixos sem coleta', rs?.pontos_baixos, true),
      chave('semBoca', 'Ruas sem coleta a 80 m', null, true),
      chave('rede', 'Galeria', this.rede?.length),
      chave('sentido', 'Sentido do escoamento', null, true),
      chave('pocos', 'Ponto de inspeção', rs?.pocos),
      chave('lancamentos', 'Ponto de despejo', rs?.lancamentos));
  }

  // ------------------------------------------------------------------ clique
  /** Item mais perto do clique (dentro de ~10 px), na ordem: boca, poço, lançamento, ponto baixo, galeria, rua sem boca. */
  aoClicar(ponto) {
    if (!this.ligado || !this.indice || !ponto) return false;
    const mpp = (this.globo.metrosPorPixel() || 1) / Math.cos((ponto.lat * Math.PI) / 180);
    const x = mx(ponto.lon), y = my(ponto.lat), tol = Math.max(2, mpp * 10);
    const perto = this.indice.busca(x - tol, y - tol, x + tol, y + tol);
    const h = this.globo.camera.positionCartographic.height, op = this.opcoes;
    const dPt = (it) => Math.hypot(it.m[0] - x, it.m[1] - y);
    const dLn = (it) => { let d = Infinity; for (let i = 1; i < it.m.length; i++) d = Math.min(d, distSeg(x, y, ...it.m[i - 1], ...it.m[i])); return d; };
    const ordem = [
      ['boca', op.bocas && h <= 3500, dPt, (it) => this.bocaVisivel(it)], ['poco', op.pocos && h <= 1500, dPt], ['lanc', op.lancamentos, dPt],
      ['baixo', op.baixos, dPt], ['rede', op.rede, dLn], ['semBoca', op.semBoca, dLn]];
    for (const [k, ativo, dist, filtro] of ordem) {
      if (!ativo) continue;
      let melhor = null, dm = tol;
      for (const it of perto) if (it.k === k && (!filtro || filtro(it))) { const d = dist(it); if (d <= dm) { dm = d; melhor = it; } }
      if (melhor) { this._ficha(melhor, ponto); return true; }
    }
    return false;
  }

  _ficha(it, ponto) {
    const id = this.identificar, t = (pares) => id.tabela(pares.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    id.limparDestaque();
    const nota = el('p', { class: 'nota' }, 'Drenagem Pluvial — base própria da A.M.C. Jardim América (fonte de pesquisa: PDDU-GYN, UFG/Seinfra/Prefeitura de Goiânia).');
    if (it.k === 'boca') {
      const v = it.v, c = Object.fromEntries(this.colBocas.map((n, i) => [n, v[i]]));
      id.abrir({ titulo: `Boca de lobo · ${c.tipo}`, subtitulo: [c.logradouro, c.bairro].filter(Boolean).join(' · '), ponto: { lon: c.lon, lat: c.lat, alt: NaN } });
      id.corpo.append(t([['Unidades lado a lado', c.unidades], ['Tipo', c.tipo], ['Estado', c.estado], ['Origem do dado', c.origem],
        ['Código no levantamento da A.M.C.', c.codigo_amc], ['Logradouro', c.logradouro], ['Bairro', c.bairro],
        ['Referência', c.quadra || c.lote ? `Quadra ${c.quadra || '—'}, lote ${c.lote || '—'}` : ''], ['Altitude do terreno', `${fmtNum(c.altitude_m, 1)} m`],
        ['Distância ao eixo da rua', `${fmtNum(c.dist_rua_m, 1)} m`], ['Ligada à galeria', c.ligada_galeria ? `sim (galeria a ${fmtNum(c.dist_galeria_m, 1)} m)` : `não há galeria a até 15 m (a mais perto a ${fmtNum(c.dist_galeria_m)} m)`],
        ['Poço de visita mais próximo', `${fmtNum(c.dist_poço_visita_m)} m`], ['Bacia', c.bacia]]), nota);
      this._marcar(it.m);
    } else if (it.k === 'rede') {
      const c = Object.fromEntries(this.colRede.map((n, i) => [n, it.v[i]]));
      id.abrir({ titulo: `Galeria pluvial · ${fmtNum(c.diametro_m * 1000)} mm`, subtitulo: `${c.material} · bacia ${c.bacia || '—'}` });
      id.destacarLonLat([it.ll], { fechado: false, cor: Cesium.Color.YELLOW, preencher: false });
      id.corpo.append(t([['Diâmetro', `${fmtNum(c.diametro_m, 2)} m`], ['Material', c.material], ['Comprimento do trecho', `${fmtNum(c.comprimento_m, 1)} m`],
        ['Declividade do terreno', `${fmtNum(c.declividade_pct, 1)}%`], ['Queda no trecho (relevo)', `${fmtNum(c.queda_m, 1)} m`],
        ['Capacidade estimada a seção plena', c.capacidade_m3s ? `${fmtNum(c.capacidade_m3s * 1000)} L/s (estimativa pela fórmula de Manning)` : ''],
        ['Sentido do escoamento', 'do ponto mais alto para o mais baixo do trecho (setas no mapa, de perto)'], ['Bacia', c.bacia]]), nota);
    } else if (it.k === 'poco') {
      const [lon, lat, acesso, bacia, croqui] = it.v;
      id.abrir({ titulo: 'Poço de visita', subtitulo: `Ponto de inspeção · ${acesso}`, ponto: { lon, lat, alt: NaN } });
      id.corpo.append(t([['Acesso à tampa', acesso], ['Croqui no cadastro de origem', croqui ? 'sim' : 'não'], ['Bacia', bacia]]),
        el('p', { class: 'nota' }, acesso === 'Acessível' ? 'Tampa visível no levantamento de origem.' : 'Tampa lacrada ou coberta pelo asfalto: a inspeção e a limpeza da galeria ficam prejudicadas neste ponto.'), nota);
      this._marcar(it.m);
    } else if (it.k === 'lanc') {
      const [lon, lat, corpo, bacia] = it.v;
      id.abrir({ titulo: 'Lançamento de galeria', subtitulo: `Ponto de inspeção · ${corpo}`, ponto: { lon, lat, alt: NaN } });
      id.corpo.append(t([['Corpo d\'água que recebe', corpo], ['Bacia', bacia]]), nota);
      this._marcar(it.m);
    } else if (it.k === 'baixo') {
      const [lon, lat, dist, cruz, desn] = it.v;
      id.abrir({ titulo: 'Ponto baixo sem boca de lobo', subtitulo: cruz, ponto: { lon, lat, alt: NaN } });
      id.corpo.append(t([['Cruzamento', cruz], ['Desnível das ruas que chegam', `pelo menos ${fmtNum(desn, 1)} m acima`], ['Boca de lobo mais próxima', `${fmtNum(dist)} m`]]),
        el('p', { class: 'nota' }, 'Análise da A.M.C.: a água das ruas em volta escorre para este cruzamento e não há boca de lobo cadastrada a até 30 m. Ponto a vistoriar (possível alagamento).'), nota);
      this._marcar(it.m);
    } else if (it.k === 'semBoca') {
      id.abrir({ titulo: it.s.rua || 'Rua sem boca de lobo', subtitulo: 'Análise da A.M.C. · trecho sem boca de lobo a 80 m' });
      id.destacarLonLat([it.ll], { fechado: false, cor: Cesium.Color.ORANGE, preencher: false });
      id.corpo.append(t([['Extensão do trecho', `${fmtNum(it.s.m)} m`], ['Boca de lobo mais próxima', `${fmtNum(it.s.dist)} m`]]),
        el('p', { class: 'nota' }, 'Trecho asfaltado, dentro da área coberta pelo cadastro, sem boca de lobo cadastrada a até 80 m. Confirmar em campo.'), nota);
    }
  }

  _marcar(m) {
    const lon = (m[0] / R) * (180 / Math.PI), lat = (2 * Math.atan(Math.exp(m[1] / R)) - Math.PI / 2) * (180 / Math.PI);
    const r = 0.00004;
    this.identificar.destacarLonLat([[[lon - r, lat - r], [lon + r, lat - r], [lon + r, lat + r], [lon - r, lat + r], [lon - r, lat - r]]], { fechado: true, cor: Cesium.Color.YELLOW });
  }
}

function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}
