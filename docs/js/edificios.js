// Edifícios 3D: volumes gerados do cadastro "Edifício em altura" do Mapa Fácil
// (número de pavimentos × altura por pavimento, sobre a base aproximada do lote) e prédios conferidos pelo IPTU
// (predios.json: desenho do Mapa Fácil ou base estimada pela imagem de satélite).
import { CFG } from './config.js';
import { el, pedirJSON, semAcento, debounce, fmtNum, aviso } from './util.js';

const Cesium = window.Cesium;

export class Edificios {
  constructor(globo, identificar) {
    this.globo = globo;
    this.identificar = identificar;
    this.raiz = null; // caixa no projeto Edificações (painel Camadas)
    this.lista = [];
    this.mpp = 3;
    this.primitiva = null;
    // Uma só chave liga os volumes: a cidade inteira (projeto Edificações) ou só bairros escolhidos
    // (busca "Lotes por bairro" e painel Bairros). Nada aparece sem ser pedido.
    this.cidade = false;
    this.bairros = new Map(); // id -> { nome, aneis: [[[lon, lat]…]] }
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
      // O Mapa Fácil que já tinha o prédio cede o lugar ao registro conferido, que mantém o mesmo desenho (campo `mf`).
      // Prédios novos chegam com a base estimada pela imagem de satélite; `lote` é só o terreno e nunca sobe inteiro.
      const trocados = new Set((lv.substitui || []).map(String));
      const cis = new Set(lv.predios.map((p) => p.ci).filter(Boolean));
      // Condomínio horizontal: um volume só, ocupando o lote inteiro, com 1 pavimento (sem casas separadas).
      const predios = lv.predios.map((p) => (p.uso === 'horizontal' && p.lote ? { ...p, f: p.lote, fx: [], p: 1,
        base_3d: 'Lote inteiro, 1 pavimento (condomínio horizontal)' } : p));
      lista = lista.filter((e) => !(trocados.has(String(e.id)) || cis.has(String(e.ci || '')))).concat(predios);
      this.conferidos = lv.predios.length;
    } catch (e) { this.conferidos = 0; }
    lista.sort((a, b) => b.p - a.p);
    this.lista = lista.map((e, i) => ({ ...e, i, k: semAcento(e.n) }));
    this._montarPainel();
  }

  get ativo() { return this.cidade || this.bairros.size > 0; }

  /** Liga ou desliga os volumes na cidade inteira. */
  async ligar(ligado) {
    this.cidade = !!ligado;
    await this._atualizar();
  }

  /** Liga ou desliga os volumes só dentro de um bairro (aneis em graus; sem eles, pede o limite ao Mapa Fácil). */
  async definirBairro(id, nome, ligado, aneis = null) {
    if (!ligado) this.bairros.delete(id);
    else {
      if (!aneis) {
        const d = await pedirJSON(`${CFG.baseCadastral}/2/query`, { parametros: { f: 'json', where: `id = '${String(id).replace(/'/g, '')}'`,
          outFields: 'id', returnGeometry: 'true', outSR: '4326', geometryPrecision: '6' } });
        aneis = d.features?.[0]?.geometry?.rings;
        if (!aneis) { aviso(`Limite de ${nome} não encontrado.`, 'alerta'); return; }
      }
      this.bairros.set(id, { nome, aneis });
    }
    await this._atualizar();
  }

  bairroLigado(id) { return this.bairros.has(id); }

  async _atualizar() {
    if (this.ativo) {
      try { await this.carregar(); await this._construir(); }
      catch (e) { this.cidade = false; this.bairros.clear(); this._remover(); aviso(`Edifícios 3D indisponíveis: ${e.message}`, 'alerta'); }
    } else { this._vez = (this._vez || 0) + 1; this._remover(); }
    this._sincronizar();
    this.aoMudar();
  }

  /** Edifícios a desenhar: todos (cidade) ou os que ficam dentro dos bairros escolhidos. */
  _visiveis() {
    if (this.cidade) return this.lista;
    const dentro = (aneis, x, y) => {
      let d = false;
      for (const a of aneis) for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
        const [xi, yi] = a[i], [xj, yj] = a[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
      }
      return d;
    };
    const bairros = [...this.bairros.values()];
    return this.lista.filter((e) => bairros.some((b) => dentro(b.aneis, e.c[0], e.c[1])));
  }

  /** Condomínios horizontais pintados no chão (GroundPrimitive), com a cor do condomínio e contorno. */
  _chao(lista) {
    if (this.primitivaChao) { this.globo.cena.groundPrimitives.remove(this.primitivaChao); this.primitivaChao = null; }
    if (!lista.length) return;
    const inst = lista.map((e) => new Cesium.GeometryInstance({
      id: this._id(e.i, 0),
      geometry: new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(e.f.flat())) }),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(this.corDe(e).withAlpha(0.7)),
        show: new Cesium.ShowGeometryInstanceAttribute(e.p >= this.minimo) },
    }));
    this.primitivaChao = this.globo.cena.groundPrimitives.add(new Cesium.GroundPrimitive({ geometryInstances: inst,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }), classificationType: Cesium.ClassificationType.TERRAIN, asynchronous: true }));
  }

  _remover() {
    if (this.primitivaChao) { this.globo.cena.groundPrimitives.remove(this.primitivaChao); this.primitivaChao = null; }
    this.fonteTetos?.entities.removeAll();
    if (this.primitiva) { this.globo.cena.primitives.remove(this.primitiva); this.primitiva = null; }
    this.globo.redesenhar();
  }

  /**
   * Número do lote (ou dos lotes) chapado no teto de cada condomínio/prédio conferido, no mesmo formato dos números
   * de lote do mapa (sem quadra): o volume não esconde a identificação do lote.
   */
  _tetos(lista, altitudes, exagero) {
    if (!this.fonteTetos) { this.fonteTetos = new Cesium.CustomDataSource('tetos'); this.globo.viewer.dataSources.add(this.fonteTetos); }
    this.fonteTetos.entities.removeAll();
    const perto = new Cesium.DistanceDisplayCondition(0, 2500);
    lista.forEach((e, j) => {
      if (!e.l || !e.q || !e.f) return;
      const anel = e.f;
      const lons = anel.map((p) => p[0]), lats = anel.map((p) => p[1]);
      const kx = 111320 * Math.cos((e.c[1] * Math.PI) / 180);
      const wm = (Math.max(...lons) - Math.min(...lons)) * kx, hm = (Math.max(...lats) - Math.min(...lats)) * 110540;
      if (wm < 2 || hm < 2) return;
      const W = 512, H = Math.max(64, Math.min(1024, Math.round((W * hm) / wm)));
      const tela = document.createElement('canvas'); tela.width = W; tela.height = H;
      const g = tela.getContext('2d');
      // Só o número do lote (ou dos lotes), no mesmo formato dos números de lote do mapa: texto escuro com contorno
      // claro, sem "Lt" e sem quadra (o número da quadra fica no marcador próprio).
      // Mesma grafia dos números de lote do mapa (numeroNoLote em mapavetorial.js): mesma fonte e peso, mesmas
      // cores do fundo em uso (satélite: branco com contorno escuro; mapa: castanho com contorno branco), lotes
      // separados por "/" e altura de letra de ~3,5 m, como o número no chão visto de perto.
      const lote = String(e.l).replace(/\s*;\s*/g, '/');
      const noMapa = this.globo.chaveBase === 'mapa';
      const cor = noMapa ? '#7d7465' : 'rgba(255,255,255,.92)', halo = noMapa ? 'rgba(255,255,255,.95)' : 'rgba(0,0,0,.85)';
      const px = Math.max(10, Math.min(H * 0.6, (W * 0.85) / Math.max(1, lote.length * 0.6), (H * 3.5) / hm));
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.font = `600 ${px.toFixed(1)}px system-ui, "Segoe UI", Roboto, sans-serif`;
      g.lineWidth = Math.max(2, px / 4); g.strokeStyle = halo; g.strokeText(lote, W / 2, H / 2);
      g.fillStyle = cor; g.fillText(lote, W / 2, H / 2);
      const teto = (altitudes[j] + Math.max(e.p, 1) * this.mpp) * exagero + 0.25;
      this.fonteTetos.entities.add({ polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(anel.flat()), height: teto, perPositionHeight: false,
        material: new Cesium.ImageMaterialProperty({ image: tela, transparent: true }), distanceDisplayCondition: perto } });
    });
  }

  async _construir() {
    const vez = (this._vez = (this._vez || 0) + 1);
    const lista = this._visiveis();
    const altitudes = await this.globo.altitudes(lista.map((e) => e.c));
    if (vez !== this._vez || !this.ativo) return;
    const exagero = this.globo.cena.verticalExaggeration || 1;
    if (!lista.length) { this._remover(); return; }
    // Condomínio horizontal: o lote inteiro pintado sobre o terreno (sem volume). Um volume plano de 1 pavimento
    // "quebrava" onde o terreno do lote tem desnível: o chão atravessava o teto e as paredes. Pintado no chão, o lote
    // aparece inteiro e acompanha o relevo; o número do lote é o do próprio mapa.
    const ehChao = (e) => e.uso === 'horizontal';
    this._chao(lista.filter(ehChao));
    const instancias = lista.flatMap((e, j) => (ehChao(e) ? [] : this._partes(e)).map((anel, k) => new Cesium.GeometryInstance({
      id: this._id(e.i, k),
      geometry: new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(anel.flat())),
        height: (altitudes[j] - 15) * exagero,
        extrudedHeight: (altitudes[j] + Math.max(e.p, 1) * this.mpp) * exagero,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(this.corDe(e)),
        show: new Cesium.ShowGeometryInstanceAttribute(e.p >= this.minimo),
      },
    })));
    const nova = new Cesium.Primitive({
      geometryInstances: instancias,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
      asynchronous: true,
    });
    this._remover();
    this.primitiva = this.globo.cena.primitives.add(nova);
    this._tetos(lista.map((e) => (ehChao(e) ? { ...e, l: null } : e)), altitudes, exagero);
    this.selecionado = -1;
    // Em modo "renderizar sob demanda" é preciso pedir quadros até a geometria ficar pronta.
    const espera = setInterval(() => {
      this.globo.redesenhar();
      if (nova.ready || nova.isDestroyed() || this.primitiva !== nova) clearInterval(espera);
    }, 200);
  }

  /** Bases do registro: a torre (`f`) e, em casas de condomínio horizontal e prédios baixos, as demais construções (`fx`). */
  _partes(e) { return [e.f, ...(e.fx || [])]; }

  _id(i, k) { return k ? `edi:${i}:${k}` : `edi:${i}`; }

  _atributos(i) {
    if (!this.lista[i]) return [];
    const prim = this.lista[i].uso === 'horizontal' ? this.primitivaChao : this.primitiva;
    if (!prim || !prim.ready) return [];
    try { prim.getGeometryInstanceAttributes(this._id(i, 0)); } catch { return []; }
    const partes = this.lista[i].uso === 'horizontal' ? [0] : this._partes(this.lista[i]);
    return partes.map((_, k) => prim.getGeometryInstanceAttributes(this._id(i, k))).filter(Boolean);
  }

  filtrar(minimo) {
    this.minimo = minimo;
    if (!this.primitiva || !this.primitiva.ready) return;
    for (const e of this.lista) {
      for (const a of this._atributos(e.i)) a.show = Cesium.ShowGeometryInstanceAttribute.toValue(e.p >= minimo, a.show);
    }
    this.globo.redesenhar();
  }

  _pintar(i, cor) {
    for (const a of this._atributos(i).filter(Boolean)) a.color = Cesium.ColorGeometryInstanceAttribute.toValue(cor, a.color);
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
    if (!this.cidade) await this.ligar(true);
    const altura = Math.max(e.p, 1) * this.mpp;
    await this.globo.voarPara({ lon: e.c[0], lat: e.c[1], distancia: Math.max(420, altura * 4.5), inclinacao: -28 });
    this.selecionar(e.i);
  }

  /** Trata um clique: devolve true se acertou um edifício. */
  aoClicar(pego) {
    if (!pego || typeof pego.id !== 'string' || !pego.id.startsWith('edi:')) return false;
    this.selecionar(+pego.id.split(':')[1]);
    return true;
  }

  /** Monta os controles no projeto Edificações do painel Camadas. */
  montarEm(caixa) {
    this.raiz = caixa;
    this.chave = el('input', { type: 'checkbox', id: 'edi-liga', checked: this.cidade, onchange: (ev) => this.ligar(ev.target.checked) });
    this.caixaBairros = el('div', { class: 'edi-bairros' });
    this.detalhes = el('div', { id: 'edi-detalhes' });
    caixa.append(
      el('label', { class: 'linha-chave' },
        el('span', {}, el('strong', {}, 'Edificações')),
        el('span', { class: 'interruptor' }, this.chave, el('span', {}))),
      this.caixaBairros, this.detalhes);
    this._sincronizar();
    if (this.lista.length) this._montarPainel();
  }

  _sincronizar() {
    if (this.chave) this.chave.checked = this.cidade;
    if (!this.caixaBairros) return;
    this.caixaBairros.textContent = '';
    if (this.bairros.size) {
      this.caixaBairros.append(el('p', { class: 'nota' }, 'Também ligado só nos bairros:'),
        el('ul', { class: 'edi-lista-bairros' }, [...this.bairros].map(([id, b]) => el('li', {}, el('span', {}, b.nome),
          el('button', { class: 'botao-texto', onclick: () => this.definirBairro(id, b.nome, false) }, 'Tirar')))));
    }
  }

  _montarPainel() {
    const alvo = this.detalhes;
    if (!alvo) return;
    const total = this.lista.length;
    const maximo = this.lista[0]?.p || 50;
    const saida = el('output', {}, 'todos');
    const faixa = el('input', { type: 'range', min: 0, max: Math.min(40, maximo), step: 1, value: this.minimo,
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
    alvo.textContent = '';
    // 1.39: só a barra de pavimentos (sem legenda de cores, lista dos mais altos nem textos explicativos)
    void legenda; void altos;
    alvo.append(
      el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Mostrar a partir de ', saida), faixa));
    return;
    alvo.append(
      el('p', { class: 'nota' }, `${fmtNum(total)} edifícios: o tema “Edificações” do cadastro municipal e, no Jardim América e no Nova Suíça, ${fmtNum(this.conferidos || 0)} prédios e condomínios conferidos pelo IPTU de cada lote.`), el('p', { class: 'nota' }, ` Altura = pavimentos × ${fmtNum(this.mpp, 1)} m. ` +
        'Prédios que já estavam no cadastro municipal mantêm o desenho anterior; os novos têm a base estimada pela construção vista na imagem de satélite, ' +
        'só a torre sobe (estacionamento e lote agregado ficam no chão). É um modelo aproximado, não um levantamento das construções.'));
  }

  serializarBairros() { return [...this.bairros.keys()].join('.'); }
}
