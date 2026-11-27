// Comparação de lotes (1.33): Ctrl + clique abre cada lote numa janela própria, uma ao lado da outra (até 3),
// com o polígono de cada lote aceso no mapa. A janela usa a mesma ficha de todos os lotes (fichalote.js).
import { el } from './util.js';
import { fichaLote } from './fichalote.js';
import { consultarOuServidor } from './banco.js';

const Cesium = window.Cesium;
const CORES = ['#FFEA00', '#00E5FF', '#FF4081'];

class Janela {
  constructor(comparador, ordem) {
    this.comp = comparador; this.globo = comparador.globo; this.pedido = 0; this.ordem = ordem;
    this.caixa = el('aside', { class: 'ficha-comparar', 'aria-label': 'Lote para comparar' });
    this.tit = el('h2', {}); this.sub = el('small', {});
    this.corpo = el('div', { class: 'ficha-comparar-corpo' });
    this.caixa.append(el('div', { class: 'painel-topo' }, el('div', {}, this.tit, this.sub),
      el('button', { class: 'botao-icone', 'aria-label': 'Fechar', onclick: () => comparador.fechar(this) }, '×')), this.corpo);
    document.body.append(this.caixa);
    this.acoes = {};
  }
  titulo(t, s) { this.tit.textContent = t; if (s !== undefined) this.sub.textContent = s; }
  secao(titulo, { aberto = false, classe = '' } = {}) {
    const c = el('div', { class: 'secao-corpo' });
    this.corpo.append(el('details', { class: `secao ${classe}`, open: aberto }, el('summary', {}, titulo), c));
    return c;
  }
  tabela(pares) { return this.comp.ident.tabela(pares); }
  _anexos(id, alvo) { return this.comp.ident._anexos(id, alvo); }
  fechar() { this.caixa.remove(); }
}

export class Comparador {
  constructor({ globo, identificar }) {
    Object.assign(this, { globo, ident: identificar, janelas: [] });
    this.fonte = new Cesium.CustomDataSource('comparar-lotes');
    globo.viewer.dataSources.add(this.fonte);
  }

  _posicionar() {
    this.janelas.forEach((j, k) => { j.caixa.style.right = `${72 + 360 * (k + 1)}px`; j.ordem = k; });
    this._acender();
  }

  /** Acende o polígono de cada lote em comparação (cor da janela). */
  _acender() {
    this.fonte.entities.removeAll();
    this.janelas.forEach((j, k) => {
      for (const anel of j.aneis || []) {
        const pos = Cesium.Cartesian3.fromDegreesArray(anel.flat());
        const cor = Cesium.Color.fromCssColorString(CORES[k % CORES.length]);
        this.fonte.entities.add({ polygon: { hierarchy: pos, material: cor.withAlpha(0.5), classificationType: Cesium.ClassificationType.TERRAIN } });
        this.fonte.entities.add({ polyline: { positions: [...pos, pos[0]], width: 4, clampToGround: true, material: cor } });
      }
    });
    this.globo.redesenhar();
  }

  fechar(j) {
    j.fechar();
    this.janelas = this.janelas.filter((x) => x !== j);
    this._posicionar();
  }

  /** Abre o lote do ponto numa janela nova (a mais antiga sai quando já há 3). */
  async abrir(ponto) {
    const cons = (c, p) => consultarOuServidor('Feature_Base', c, { f: 'json', geometry: `${ponto.lon},${ponto.lat}`, geometryType: 'esriGeometryPoint',
      inSR: '4326', spatialRel: 'esriSpatialRelIntersects', ...p }).then((r) => r.features || []).catch(() => []);
    const [lotes, quadras, bairros] = await Promise.all([
      cons(0, { outFields: '*', outSR: '3857', returnGeometry: 'true' }),
      cons(1, { outFields: 'nm_qdr', returnGeometry: 'false' }),
      cons(2, { outFields: 'nm_bai', returnGeometry: 'false' }),
    ]);
    const lote = lotes[0];
    if (!lote) return false;
    if (this.janelas.length >= 3) this.fechar(this.janelas[0]);
    const j = new Janela(this, this.janelas.length);
    this.janelas.push(j);
    const R = 6378137;
    j.aneis = (lote.geometry?.rings || []).map((r) => r.map(([x, y]) => [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)]));
    this._posicionar();
    await fichaLote(j, { lote, quadra: quadras[0]?.attributes, bairro: bairros[0]?.attributes?.nm_bai, ponto });
    return true;
  }

  limpar() { for (const j of [...this.janelas]) this.fechar(j); }
}
