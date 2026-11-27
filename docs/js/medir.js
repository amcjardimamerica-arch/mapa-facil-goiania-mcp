// Régua do Earth: distância (linha/caminho) e área (polígono), sobre o terreno.
import { CFG } from './config.js';
import { el, fmtDistancia, fmtArea, areaM2, aviso } from './util.js';

const Cesium = window.Cesium;

export class Medir {
  constructor(globo, raiz) {
    this.globo = globo;
    this.raiz = raiz;
    this.tipo = null;       // 'distancia' | 'area' | null
    this.pontos = [];       // [{lon, lat, cartesiano}]
    this.cursor = null;
    this.medidas = [];      // concluídas: {id, tipo, pontos:[[lon,lat]], texto, entidades}
    this.fonte = new Cesium.CustomDataSource('medidas');
    globo.viewer.dataSources.add(this.fonte);
    this.cor = Cesium.Color.fromCssColorString(CFG.cores.medida);
    this._montarPainel();
  }

  get ativo() { return !!this.tipo; }

  _montarPainel() {
    this.estado = el('p', { class: 'nota' }, 'Escolha o que medir e clique no mapa.');
    this.lista = el('ul', { class: 'lista-medidas' });
    this.btnConcluir = el('button', { class: 'botao', hidden: true, onclick: () => this.concluir() }, 'Concluir');
    this.btnCancelar = el('button', { class: 'botao-texto', hidden: true, onclick: () => this.cancelar() }, 'Cancelar');
    this.raiz.append(
      el('div', { class: 'linha-botoes' },
        el('button', { class: 'botao', id: 'medir-distancia', onclick: () => this.iniciar('distancia') }, 'Distância'),
        el('button', { class: 'botao', id: 'medir-area', onclick: () => this.iniciar('area') }, 'Área')),
      this.estado,
      el('div', { class: 'linha-botoes' }, this.btnConcluir, this.btnCancelar),
      el('h3', { class: 'subtitulo' }, 'Medições'), this.lista,
      el('button', { class: 'botao-texto', onclick: () => this.limpar() }, 'Apagar todas'));
  }

  iniciar(tipo) {
    this.cancelar();
    this.tipo = tipo;
    this.globo.cena.canvas.style.cursor = 'crosshair';
    this.estado.textContent = tipo === 'area'
      ? 'Clique nos vértices da área. Duplo clique ou “Concluir” fecha o polígono.'
      : 'Clique nos pontos do caminho. Duplo clique ou “Concluir” encerra.';
    this.btnConcluir.hidden = this.btnCancelar.hidden = false;
    const posicoes = new Cesium.CallbackProperty(() => {
      const p = this.pontos.map((x) => x.cartesiano);
      if (this.cursor) p.push(this.cursor.cartesiano);
      if (this.tipo === 'area' && p.length > 2) p.push(p[0]);
      return p;
    }, false);
    this.rascunho = this.fonte.entities.add({
      polyline: { positions: posicoes, clampToGround: true, width: 3, material: this.cor },
      position: new Cesium.CallbackProperty(() => (this.cursor || this.pontos.at(-1))?.cartesiano, false),
      label: this._rotulo(new Cesium.CallbackProperty(() => this._texto(true), false)),
    });
  }

  _rotulo(texto) {
    return {
      text: texto, font: '600 13px system-ui, "Segoe UI", Roboto, sans-serif',
      fillColor: Cesium.Color.WHITE, showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#1f2226').withAlpha(0.88),
      backgroundPadding: new Cesium.Cartesian2(8, 5), pixelOffset: new Cesium.Cartesian2(0, -22),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    };
  }

  _lonlat(comCursor) {
    const p = this.pontos.map((x) => [x.lon, x.lat]);
    if (comCursor && this.cursor) p.push([this.cursor.lon, this.cursor.lat]);
    return p;
  }

  static comprimento(pontos, fechar = false) {
    let total = 0;
    const lista = fechar && pontos.length > 2 ? [...pontos, pontos[0]] : pontos;
    for (let i = 1; i < lista.length; i++) {
      total += new Cesium.EllipsoidGeodesic(
        Cesium.Cartographic.fromDegrees(lista[i - 1][0], lista[i - 1][1]),
        Cesium.Cartographic.fromDegrees(lista[i][0], lista[i][1])).surfaceDistance;
    }
    return total;
  }

  _texto(comCursor) {
    const p = this._lonlat(comCursor);
    if (this.tipo === 'area') {
      return p.length < 3 ? 'Área: marque 3 pontos' : `${fmtArea(areaM2(p))}\nperímetro ${fmtDistancia(Medir.comprimento(p, true))}`;
    }
    return p.length < 2 ? 'Clique para iniciar' : fmtDistancia(Medir.comprimento(p));
  }

  clique(ponto) {
    if (!ponto) return;
    this.pontos.push(ponto);
    this.fonte.entities.add({ position: ponto.cartesiano, point: this._ponto() }).rascunho = true;
    // 1.29.0: a medida parcial também no painel (antes só no rótulo do mapa, que some atrás de prédios e do relevo).
    if (this.tipo && this.pontos.length >= (this.tipo === 'area' ? 3 : 2)) {
      this.estado.textContent = `Até aqui: ${this._texto(false).replace('\n', ' · ')}. Duplo clique ou “Concluir” encerra.`;
    }
    this.globo.redesenhar();
  }

  _ponto() {
    return { pixelSize: 8, color: Cesium.Color.WHITE, outlineColor: this.cor, outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY };
  }

  mover(ponto) {
    if (!this.ativo) return;
    this.cursor = ponto;
    this.globo.redesenhar();
  }

  desfazer() {
    if (!this.ativo || !this.pontos.length) return;
    this.pontos.pop();
    const pts = this.fonte.entities.values.filter((e) => e.rascunho);
    if (pts.length) this.fonte.entities.remove(pts.at(-1));
    this.globo.redesenhar();
  }

  _limparRascunho() {
    for (const e of this.fonte.entities.values.filter((x) => x.rascunho)) this.fonte.entities.remove(e);
    if (this.rascunho) { this.fonte.entities.remove(this.rascunho); this.rascunho = null; }
    this.pontos = [];
    this.cursor = null;
    this.tipo = null;
    this.globo.cena.canvas.style.cursor = '';
    this.btnConcluir.hidden = this.btnCancelar.hidden = true;
    this.globo.redesenhar();
  }

  cancelar() {
    if (!this.ativo) return;
    this._limparRascunho();
    this.estado.textContent = 'Escolha o que medir e clique no mapa.';
  }

  concluir() {
    if (!this.ativo) return;
    const tipo = this.tipo, pontos = this._lonlat(false);
    const minimo = tipo === 'area' ? 3 : 2;
    if (pontos.length < minimo) { aviso(`Marque pelo menos ${minimo} pontos.`, 'alerta'); return; }
    this.cursor = null;
    const texto = this._texto(false);
    const cart = this.pontos.map((x) => x.cartesiano);
    this._limparRascunho();
    const entidades = [];
    const linha = tipo === 'area' ? [...cart, cart[0]] : cart;
    entidades.push(this.fonte.entities.add({ polyline: { positions: linha, clampToGround: true, width: 3, material: this.cor } }));
    if (tipo === 'area') {
      entidades.push(this.fonte.entities.add({ polygon: { hierarchy: new Cesium.PolygonHierarchy(cart),
        material: this.cor.withAlpha(0.22), classificationType: Cesium.ClassificationType.TERRAIN } }));
    }
    for (const c of cart) entidades.push(this.fonte.entities.add({ position: c, point: this._ponto() }));
    const ancora = tipo === 'area'
      ? Cesium.BoundingSphere.fromPoints(cart).center : cart.at(-1);
    entidades.push(this.fonte.entities.add({ position: ancora, label: this._rotulo(texto) }));
    const medida = { id: Date.now(), tipo, pontos, texto: texto.replace('\n', ' · '), entidades };
    this.medidas.push(medida);
    this._listar();
    this.estado.textContent = `Medição concluída: ${medida.texto}.`;
    this.globo.redesenhar();
  }

  remover(id) {
    const m = this.medidas.find((x) => x.id === id);
    if (!m) return;
    m.entidades.forEach((e) => this.fonte.entities.remove(e));
    this.medidas = this.medidas.filter((x) => x.id !== id);
    this._listar();
    this.globo.redesenhar();
  }

  limpar() {
    this.cancelar();
    [...this.medidas].forEach((m) => this.remover(m.id));
  }

  _listar() {
    this.lista.textContent = '';
    if (!this.medidas.length) { this.lista.append(el('li', { class: 'vazio' }, 'Nenhuma medição ainda.')); return; }
    for (const m of this.medidas) {
      this.lista.append(el('li', {},
        el('span', {}, el('strong', {}, m.tipo === 'area' ? 'Área' : 'Distância'), ` ${m.texto}`),
        el('button', { class: 'botao-icone', title: 'Apagar', 'aria-label': 'Apagar medição', onclick: () => this.remover(m.id) }, '×')));
    }
  }
}
