// Edifícios 3D: volumes gerados do cadastro "Edifício em altura" do Mapa Fácil
// (número de pavimentos × altura por pavimento, sobre a base aproximada do lote).
import { CFG } from './config.js';
import { el, pedirJSON, semAcento, debounce, fmtNum, aviso, pontoNoAnel } from './util.js';

const Cesium = window.Cesium;

export class Edificios {
  constructor(globo, identificar, raiz) {
    this.globo = globo;
    this.identificar = identificar;
    this.raiz = raiz;
    this.lista = [];
    this.mpp = 3;
    this.primitiva = null;
    this.ativo = false;
    this.minimo = 0;
    this.selecionado = -1;
    this.aoMudar = () => {};
    this._refazer = debounce(() => { if (this.ativo) this._construir(); }, 400);
    globo.aoMudarRelevo(() => this._refazer());
  }

  /** Uso do prédio: o do levantamento (campo `uso`) ou, no cadastro do Mapa Fácil, residencial quando há apartamentos. */
  usoDe(e) {
    if (e.uso) return e.uso;
    return e.a > 0 ? 'residencial' : 'indefinido';
  }

  corDe(e) {
    const u = this.usoDe(e);
    const f = CFG.usosEdificios.find((x) => x.uso === u) || CFG.usosEdificios.at(-1);
    return Cesium.Color.fromCssColorString(f.cor);
  }

  async carregar() {
    if (this.lista.length) return;
    const d = await pedirJSON(`${CFG.dados}edificios.json`, { tempo: 60000 });
    this.mpp = d.metros_por_pavimento || 3;
    let lista = d.edificios;
    // Prédios e condomínios conferidos pelo IPTU de cada lote (levantamento da Associação): substituem os do cadastro
    // "Edifício em altura" no mesmo lote e acrescentam os que o Mapa Fácil não traz.
    try {
      const lv = await pedirJSON(`${CFG.dados}predios.json`, { tempo: 60000 });
      const cis = new Set(lv.predios.map((p) => p.ci).filter(Boolean));
      const caixas = lv.predios.map((p) => {
        const xs = p.f.map((q) => q[0]), ys = p.f.map((q) => q[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), p.f];
      });
      const dentro = (x, y) => caixas.some(([o, s, l, n, f]) => x >= o && x <= l && y >= s && y <= n && pontoNoAnel(x, y, f));
      lista = lista.filter((e) => !(cis.has(String(e.ci || '')) || dentro(e.c[0], e.c[1]))).concat(lv.predios);
      this.conferidos = lv.predios.length;
    } catch (e) { this.conferidos = 0; }
    lista.sort((a, b) => b.p - a.p);
    this.lista = lista.map((e, i) => ({ ...e, i, k: semAcento(e.n) }));
    this._montarPainel();
  }

  async ligar(ligado) {
    this.ativo = ligado;
    if (ligado) {
      try { await this.carregar(); await this._construir(); }
      catch (e) { this.ativo = false; aviso(`Edifícios 3D indisponíveis: ${e.message}`, 'alerta'); }
    } else this._remover();
    const caixa = this.raiz.querySelector('#edi-liga');
    if (caixa) caixa.checked = this.ativo;
    this.aoMudar();
  }

  _remover() {
    if (this.primitiva) { this.globo.cena.primitives.remove(this.primitiva); this.primitiva = null; }
    this.globo.redesenhar();
  }

  async _construir() {
    const vez = (this._vez = (this._vez || 0) + 1);
    const altitudes = await this.globo.altitudes(this.lista.map((e) => e.c));
    if (vez !== this._vez || !this.ativo) return;
    const exagero = this.globo.cena.verticalExaggeration || 1;
    const instancias = this.lista.map((e, i) => new Cesium.GeometryInstance({
      id: `edi:${i}`,
      geometry: new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(e.f.flat())),
        height: (altitudes[i] - 15) * exagero,
        extrudedHeight: (altitudes[i] + Math.max(e.p, 1) * this.mpp) * exagero,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(this.corDe(e)),
        show: new Cesium.ShowGeometryInstanceAttribute(e.p >= this.minimo),
      },
    }));
    const nova = new Cesium.Primitive({
      geometryInstances: instancias,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
      asynchronous: true,
    });
    this._remover();
    this.primitiva = this.globo.cena.primitives.add(nova);
    this.selecionado = -1;
    // Em modo "renderizar sob demanda" é preciso pedir quadros até a geometria ficar pronta.
    const espera = setInterval(() => {
      this.globo.redesenhar();
      if (nova.ready || nova.isDestroyed() || this.primitiva !== nova) clearInterval(espera);
    }, 200);
  }

  _atributos(i) {
    return this.primitiva && this.primitiva.ready ? this.primitiva.getGeometryInstanceAttributes(`edi:${i}`) : null;
  }

  filtrar(minimo) {
    this.minimo = minimo;
    if (!this.primitiva || !this.primitiva.ready) return;
    for (const e of this.lista) {
      const a = this._atributos(e.i);
      if (a) a.show = Cesium.ShowGeometryInstanceAttribute.toValue(e.p >= minimo, a.show);
    }
    this.globo.redesenhar();
  }

  _pintar(i, cor) {
    const a = this._atributos(i);
    if (a) a.color = Cesium.ColorGeometryInstanceAttribute.toValue(cor, a.color);
  }

  limparSelecao() {
    if (this.selecionado >= 0) this._pintar(this.selecionado, this.corDe(this.lista[this.selecionado]));
    this.selecionado = -1;
    this.globo.redesenhar();
  }

  selecionar(i) {
    this.limparSelecao();
    const e = this.lista[i];
    if (!e) return;
    this.selecionado = i;
    this._pintar(i, Cesium.Color.fromCssColorString(CFG.cores.destaque));
    this.identificar.edificio(e, this.mpp);
    this.globo.redesenhar();
  }

  async irPara(e) {
    if (!this.ativo) await this.ligar(true);
    const altura = Math.max(e.p, 1) * this.mpp;
    await this.globo.voarPara({ lon: e.c[0], lat: e.c[1], distancia: Math.max(420, altura * 4.5), inclinacao: -28 });
    this.selecionar(e.i);
  }

  /** Trata um clique: devolve true se acertou um edifício. */
  aoClicar(pego) {
    if (!pego || typeof pego.id !== 'string' || !pego.id.startsWith('edi:')) return false;
    this.selecionar(+pego.id.slice(4));
    return true;
  }

  _montarPainel() {
    const total = this.lista.length;
    const maximo = this.lista[0]?.p || 50;
    const saida = el('output', {}, 'todos');
    const faixa = el('input', { type: 'range', min: 0, max: Math.min(40, maximo), step: 1, value: 0,
      'aria-label': 'Pavimentos mínimos', oninput: (ev) => {
        const v = +ev.target.value;
        const n = this.lista.filter((e) => e.p >= v).length;
        saida.textContent = v ? `${v}+ pavimentos (${fmtNum(n)})` : `todos (${fmtNum(total)})`;
        this.filtrar(v);
      } });
    saida.textContent = `todos (${fmtNum(total)})`;
    const legenda = el('div', { class: 'legenda-faixas legenda-usos' }, CFG.usosEdificios.map((f) =>
      el('span', {}, el('i', { style: `background:${f.cor}` }), f.rotulo)));
    const altos = el('ol', { class: 'lista-links' }, this.lista.slice(0, 12).map((e) =>
      el('li', {}, el('button', { onclick: () => this.irPara(e) },
        el('span', {}, e.n), el('small', {}, `${e.p} pav. · ~${fmtNum(e.p * this.mpp)} m`)))));
    const alvo = this.raiz.querySelector('#edi-detalhes');
    alvo.textContent = '';
    alvo.append(
      el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Mostrar a partir de ', saida), faixa),
      el('h3', { class: 'subtitulo' }, 'Cor pelo uso'), legenda,
      el('h3', { class: 'subtitulo' }, 'Os mais altos do cadastro'), altos,
      el('p', { class: 'nota' }, `${fmtNum(total)} edifícios: o tema “Edificações” do Mapa Fácil e, no Jardim América e no Nova Suíça, ${fmtNum(this.conferidos || 0)} prédios e condomínios conferidos pelo IPTU de cada lote.`), el('p', { class: 'nota' }, ` Altura = pavimentos × ${fmtNum(this.mpp, 1)} m; ` +
        'a base é aproximada a partir do lote. É um modelo esquemático, não um levantamento das construções.'));
  }
}
