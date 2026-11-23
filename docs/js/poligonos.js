// Polígonos editáveis, no espírito do Google Earth: cada lote pode virar um polígono
// com nome, descrição, estilo (linha e preenchimento), altitude (no chão, relativa
// ao chão ou absoluta, com os lados estendidos até o chão), edição dos vértices
// (arrastar, inserir pelo ponto médio, apagar com o botão direito), desfazer,
// medidas (área e perímetro), vista salva, duplicar, exportar em KML e restaurar o
// desenho oficial do lote. Também desenha um polígono novo, ponto a ponto.
import { el, memoria, baixarArquivo, escaparXML, aviso, fmtArea, fmtDistancia, areaM2, fmtNum, debounce } from './util.js';
import { Medir } from './medir.js';

const Cesium = window.Cesium;
const CHAVE = 'bussola:poligonos';
const MAX_DESFAZER = 50;

const ESTILO_PADRAO = { linha: '#ffd54a', larguraLinha: 3, preenchimento: '#ffd54a', opacidade: 35 };
const ALTITUDE_PADRAO = { modo: 'chao', altura: 0, estender: false };
const MODOS = { chao: 'Fixado no chão', relativo: 'Relativo ao chão', absoluto: 'Absoluto (acima do nível do mar)' };

const cor = (hex, alfa = 1) => Cesium.Color.fromCssColorString(hex).withAlpha(alfa);
const fecharAnel = (p) => (p.length && (p[0][0] !== p.at(-1)[0] || p[0][1] !== p.at(-1)[1]) ? [...p, p[0]] : p);
const abrirAnel = (p) => (p.length > 1 && p[0][0] === p.at(-1)[0] && p[0][1] === p.at(-1)[1] ? p.slice(0, -1) : p);
const centro = (p) => p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);
const arred = (p) => p.map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)]);

/** Cor KML (aabbggrr) a partir de #rrggbb e opacidade 0–1. */
function corKML(hex, alfa = 1) {
  const h = hex.replace('#', '');
  const a = Math.round(Math.max(0, Math.min(1, alfa)) * 255).toString(16).padStart(2, '0');
  return `${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

export class Poligonos {
  constructor(globo, identificar, raiz) {
    Object.assign(this, { globo, identificar, raiz });
    this.lista = memoria.ler(CHAVE, []).filter((p) => Array.isArray(p.pontos) && p.pontos.length >= 3);
    this.fonte = new Cesium.CustomDataSource('poligonos');
    globo.viewer.dataSources.add(this.fonte);
    this.alcas = new Cesium.CustomDataSource('poligonos-alcas');
    globo.viewer.dataSources.add(this.alcas);
    this.editando = null;    // id do polígono em edição de forma
    this.desenho = null;     // { pontos, cursor } quando desenhando um novo
    this.arrasto = null;     // { indice } durante o arraste de um vértice
    this.pilha = [];         // desfazer
    this.aoMudar = () => {};
    this._gravarDepois = debounce(() => this._gravar(), 400);
    this._montarPainel();
    this.lista.forEach((p) => this._desenhar(p));
    this._listar();
  }

  get ocupado() { return !!(this.desenho || this.editando); }

  // ---------------------------------------------------------------- dados
  _gravar() { memoria.gravar(CHAVE, this.lista.map(({ _ent, ...p }) => p)); }

  _novoId() { return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

  /** Cria um polígono a partir de anéis [[lon,lat],…] (o primeiro é o contorno, os outros são vazios). */
  criar({ aneis, nome, descricao = '', origem = null, abrir = true }) {
    const [contorno, ...buracos] = aneis.map((a) => arred(abrirAnel(a)));
    if (!contorno || contorno.length < 3) { aviso('Este desenho não tem pontos suficientes para um polígono.', 'alerta'); return null; }
    const p = { id: this._novoId(), nome: nome || `Polígono ${this.lista.length + 1}`, descricao, pontos: contorno,
      buracos: buracos.filter((b) => b.length >= 3), estilo: { ...ESTILO_PADRAO }, altitude: { ...ALTITUDE_PADRAO },
      visivel: true, rotulo: true, origem, original: origem ? { pontos: contorno, buracos } : null, criado: new Date().toISOString() };
    this.lista.push(p);
    this._gravar();
    this._desenhar(p);
    this._listar();
    if (abrir) this.abrirFicha(p);
    return p;
  }

  /** Lote do Mapa Fácil ou do levantamento -> polígono editável. */
  doLote({ aneis, quadra, lote, bairro, ci, id }) {
    const ja = this.lista.find((p) => p.origem && ((id && p.origem.id === id) || (ci && p.origem.ci === ci && p.origem.lote === lote)));
    if (ja) { this.abrirFicha(ja); aviso('Este lote já está entre os seus polígonos.'); return ja; }
    const nome = [quadra && `Quadra ${quadra}`, lote && `Lote ${lote}`].filter(Boolean).join(' · ') || 'Lote';
    return this.criar({ aneis, nome, descricao: bairro ? `${bairro}, Goiânia` : '',
      origem: { tipo: 'lote', quadra, lote, bairro, ci, id } });
  }

  // ------------------------------------------------------------- desenho
  _hierarquia(p) {
    return new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(p.pontos.flat()),
      (p.buracos || []).map((b) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(b.flat()))));
  }

  _desenhar(p) {
    for (const e of p._ent || []) this.fonte.entities.remove(e);
    p._ent = [];
    if (!p.visivel) { this.globo.redesenhar(); return; }
    const est = p.estilo, alt = p.altitude, preench = cor(est.preenchimento, est.opacidade / 100), linha = cor(est.linha);
    const editando = this.editando === p.id;
    const poligono = { hierarchy: new Cesium.CallbackProperty(() => this._hierarquia(p), false), material: preench };
    if (alt.modo === 'chao') {
      poligono.classificationType = Cesium.ClassificationType.BOTH;
    } else {
      poligono.height = alt.altura;
      poligono.heightReference = alt.modo === 'relativo' ? Cesium.HeightReference.RELATIVE_TO_GROUND : Cesium.HeightReference.NONE;
      if (alt.estender) { poligono.extrudedHeight = 0; poligono.extrudedHeightReference = Cesium.HeightReference.CLAMP_TO_GROUND; }
      poligono.outline = true; poligono.outlineColor = linha; poligono.perPositionHeight = false;
    }
    const corpo = this.fonte.entities.add({ id: `pol:${p.id}`, polygon: poligono });
    corpo.poligono = p;
    p._ent.push(corpo);
    // Contorno: no chão, uma linha presa ao terreno com a largura escolhida.
    const aneis = [p.pontos, ...(p.buracos || [])];
    if (alt.modo === 'chao') {
      aneis.forEach((a, k) => {
        const contorno = this.fonte.entities.add({ polyline: { positions: new Cesium.CallbackProperty(() =>
          Cesium.Cartesian3.fromDegreesArray(fecharAnel(k ? p.buracos[k - 1] : p.pontos).flat()), false),
          clampToGround: true, width: Math.max(1, est.larguraLinha), material: editando ? cor('#ffffff') : linha } });
        contorno.poligono = p;
        p._ent.push(contorno);
      });
    }
    if (p.rotulo && !editando) {
      const [lon, lat] = centro(p.pontos);
      p._ent.push(this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, alt.modo === 'chao' ? 0 : alt.altura),
        label: { text: p.nome, font: '600 13px system-ui, "Segoe UI", Roboto, sans-serif', fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          heightReference: alt.modo === 'absoluto' ? Cesium.HeightReference.NONE : (alt.modo === 'chao' ? Cesium.HeightReference.CLAMP_TO_GROUND : Cesium.HeightReference.RELATIVE_TO_GROUND),
          disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2500) } }));
    }
    this.globo.redesenhar();
  }

  // ------------------------------------------------------------ edição da forma
  editarForma(p) {
    if (this.desenho) this.cancelarDesenho();
    if (this.editando && this.editando !== p.id) this.concluirEdicao();
    this.editando = p.id;
    this.pilha = [];
    this._desenhar(p);
    this._alcas(p);
    this.abrirFicha(p);
    aviso('Arraste os pontos brancos para mover. Clique num ponto pequeno para inserir um vértice. Botão direito num vértice apaga.', 'info', 6500);
  }

  concluirEdicao() {
    const p = this._atual();
    this.editando = null;
    this.arrasto = null;
    this.alcas.entities.removeAll();
    this.globo.cena.screenSpaceCameraController.enableInputs = true;
    if (p) { this._desenhar(p); this._gravar(); this.abrirFicha(p); }
    this.globo.redesenhar();
  }

  _atual() { return this.lista.find((p) => p.id === this.editando) || null; }

  _alcas(p) {
    this.alcas.entities.removeAll();
    const ponto = (pos, tipo, i, tam) => {
      const e = this.alcas.entities.add({ position: pos, point: { pixelSize: tam, color: tipo === 'v' ? Cesium.Color.WHITE : Cesium.Color.WHITE.withAlpha(0.75),
        outlineColor: cor(p.estilo.linha), outlineWidth: tipo === 'v' ? 3 : 2,
        heightReference: p.altitude.modo === 'chao' ? Cesium.HeightReference.CLAMP_TO_GROUND : Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      e.alca = { tipo, i, id: p.id };
    };
    const h = p.altitude.modo === 'chao' ? 0 : p.altitude.altura;
    p.pontos.forEach((q, i) => ponto(new Cesium.CallbackProperty(() => Cesium.Cartesian3.fromDegrees(p.pontos[i][0], p.pontos[i][1], h), false), 'v', i, 13));
    p.pontos.forEach((q, i) => {
      const j = (i + 1) % p.pontos.length;
      ponto(new Cesium.CallbackProperty(() => {
        const a = p.pontos[i], b = p.pontos[j] || p.pontos[0];
        return Cesium.Cartesian3.fromDegrees((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, h);
      }, false), 'm', i, 8);
    });
    this.globo.redesenhar();
  }

  _empilhar(p) {
    this.pilha.push(JSON.stringify(p.pontos));
    if (this.pilha.length > MAX_DESFAZER) this.pilha.shift();
  }

  desfazer() {
    if (this.desenho) { this.desenho.pontos.pop(); this.globo.redesenhar(); return; }
    const p = this._atual();
    if (!p || !this.pilha.length) return;
    p.pontos = JSON.parse(this.pilha.pop());
    this._alcas(p);
    this._atualizarMedidas(p);
    this._gravarDepois();
  }

  /** Botão do mouse pressionado: começa a arrastar um vértice (ou insere um novo pelo ponto médio). */
  aoPressionar(pego) {
    const a = pego?.id?.alca;
    if (!a || a.id !== this.editando) return false;
    const p = this._atual();
    this._empilhar(p);
    let i = a.i;
    if (a.tipo === 'm') {
      const b = p.pontos[(i + 1) % p.pontos.length];
      p.pontos.splice(i + 1, 0, [(p.pontos[i][0] + b[0]) / 2, (p.pontos[i][1] + b[1]) / 2]);
      i += 1;
      this._alcas(p);
    }
    this.arrasto = { indice: i };
    this.globo.cena.screenSpaceCameraController.enableInputs = false;
    return true;
  }

  aoMover(ponto) {
    if (this.desenho) { this.desenho.cursor = ponto; this.globo.redesenhar(); return; }
    if (!this.arrasto || !ponto) return;
    const p = this._atual();
    p.pontos[this.arrasto.indice] = [+ponto.lon.toFixed(7), +ponto.lat.toFixed(7)];
    this._atualizarMedidas(p);
    this.globo.redesenhar();
  }

  aoSoltar() {
    if (!this.arrasto) return false;
    this.arrasto = null;
    this.globo.cena.screenSpaceCameraController.enableInputs = true;
    const p = this._atual();
    if (p) { this._alcas(p); this._gravarDepois(); }
    return true;
  }

  /** Botão direito: apaga o vértice clicado (mínimo de 3) ou desfaz o último ponto do desenho. */
  aoBotaoDireito(pego) {
    if (this.desenho) { this.desfazer(); return true; }
    const a = pego?.id?.alca;
    if (!a || a.tipo !== 'v' || a.id !== this.editando) return false;
    const p = this._atual();
    if (p.pontos.length <= 3) { aviso('Um polígono precisa de pelo menos 3 vértices.', 'alerta'); return true; }
    this._empilhar(p);
    p.pontos.splice(a.i, 1);
    this._alcas(p);
    this._atualizarMedidas(p);
    this._gravarDepois();
    return true;
  }

  // --------------------------------------------------------- polígono novo
  novo() {
    if (this.editando) this.concluirEdicao();
    this.desenho = { pontos: [], cursor: null };
    this.globo.cena.canvas.style.cursor = 'crosshair';
    const pos = new Cesium.CallbackProperty(() => {
      const p = [...this.desenho.pontos];
      if (this.desenho.cursor) p.push([this.desenho.cursor.lon, this.desenho.cursor.lat]);
      return p.length >= 2 ? Cesium.Cartesian3.fromDegreesArray(fecharAnel(p).flat()) : [];
    }, false);
    this.rascunho = this.fonte.entities.add({ polyline: { positions: pos, clampToGround: true, width: 3, material: cor(ESTILO_PADRAO.linha) } });
    aviso('Clique nos vértices do polígono. Duplo clique conclui; botão direito desfaz o último ponto.', 'info', 6000);
    this.btnNovo.textContent = 'Clique no mapa…';
  }

  clique(ponto) {
    if (!this.desenho || !ponto) return false;
    this.desenho.pontos.push([+ponto.lon.toFixed(7), +ponto.lat.toFixed(7)]);
    this.globo.redesenhar();
    return true;
  }

  concluirDesenho() {
    if (!this.desenho) return;
    const pts = this.desenho.pontos.filter((q, i, a) => i === 0 || q[0] !== a[i - 1][0] || q[1] !== a[i - 1][1]);
    this.cancelarDesenho();
    if (pts.length >= 3) this.criar({ aneis: [pts] });
    else aviso('Marque pelo menos 3 pontos.', 'alerta');
  }

  cancelarDesenho() {
    if (this.rascunho) { this.fonte.entities.remove(this.rascunho); this.rascunho = null; }
    this.desenho = null;
    this.globo.cena.canvas.style.cursor = '';
    this.btnNovo.textContent = 'Novo polígono';
    this.globo.redesenhar();
  }

  // ------------------------------------------------------------- ações
  aoClicar(pego) {
    const p = pego?.id?.poligono;
    if (!p) return false;
    this.abrirFicha(p);
    return true;
  }

  irPara(p) {
    if (p.vista) {
      const v = p.vista;
      this.globo.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.alt),
        orientation: { heading: v.rumo, pitch: v.inclinacao, roll: v.giro || 0 }, duration: 1.6 });
      return;
    }
    const xs = p.pontos.map((q) => q[0]), ys = p.pontos.map((q) => q[1]);
    this.globo.voarPara({ extensao: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], inclinacao: -55 });
  }

  capturarVista(p) {
    const c = this.globo.camera, g = c.positionCartographic;
    p.vista = { lon: Cesium.Math.toDegrees(g.longitude), lat: Cesium.Math.toDegrees(g.latitude), alt: g.height,
      rumo: c.heading, inclinacao: c.pitch, giro: c.roll };
    this._gravar();
    aviso('Vista salva. “Voar até” volta para ela.');
  }

  duplicar(p) {
    const d = (dx) => p.pontos.map(([x, y]) => [x + dx, y]);
    const copia = this.criar({ aneis: [d(0.00003), ...(p.buracos || []).map((b) => b.map(([x, y]) => [x + 0.00003, y]))],
      nome: `${p.nome} (cópia)`, descricao: p.descricao, abrir: false });
    if (!copia) return;
    copia.estilo = { ...p.estilo }; copia.altitude = { ...p.altitude }; copia.rotulo = p.rotulo;
    this._desenhar(copia); this._gravar(); this._listar(); this.abrirFicha(copia);
  }

  restaurar(p) {
    if (!p.original) return;
    p.pontos = JSON.parse(JSON.stringify(p.original.pontos));
    p.buracos = JSON.parse(JSON.stringify(p.original.buracos || []));
    if (this.editando === p.id) this._alcas(p);
    this._desenhar(p); this._gravar(); this.abrirFicha(p);
    aviso('Desenho oficial do lote restaurado.');
  }

  remover(p) {
    if (this.editando === p.id) this.concluirEdicao();
    for (const e of p._ent || []) this.fonte.entities.remove(e);
    this.lista = this.lista.filter((x) => x.id !== p.id);
    this._gravar(); this._listar();
    if (this._fichaDe === p.id) this.identificar.fechar();
    this.globo.redesenhar();
  }

  alternar(p, visivel) {
    p.visivel = visivel;
    this._desenhar(p); this._gravar(); this._listar();
  }

  // ------------------------------------------------------------- medidas
  medidas(p) {
    const area = areaM2(p.pontos) - (p.buracos || []).reduce((s, b) => s + areaM2(b), 0);
    return { area, perimetro: Medir.comprimento(p.pontos, true), vertices: p.pontos.length };
  }

  _atualizarMedidas(p) {
    if (!this._caixaMedidas || this._fichaDe !== p.id) return;
    const m = this.medidas(p);
    this._caixaMedidas.textContent = '';
    this._caixaMedidas.append(this.identificar.tabela([['Área', fmtArea(m.area)], ['Perímetro', fmtDistancia(m.perimetro)], ['Vértices', fmtNum(m.vertices)]]));
  }

  // ------------------------------------------------------- ficha (propriedades)
  abrirFicha(p) {
    const id = this.identificar;
    this._fichaDe = p.id;
    id.fonte.entities.removeAll();
    const [lon, lat] = centro(p.pontos);
    id.abrir({ titulo: p.nome, subtitulo: p.origem?.tipo === 'lote' ? 'Polígono do lote · editável' : 'Polígono', ponto: { lon, lat, alt: NaN } });
    const mudar = (f) => (ev) => { f(ev.target); this._desenhar(p); this._gravarDepois(); this._listar(); };
    const editando = this.editando === p.id;

    id.corpo.append(el('div', { class: 'linha-botoes' },
      editando
        ? el('button', { class: 'botao destaque', onclick: () => this.concluirEdicao() }, 'Concluir edição')
        : el('button', { class: 'botao destaque', onclick: () => this.editarForma(p) }, 'Editar forma'),
      editando ? el('button', { class: 'botao', onclick: () => this.desfazer(), disabled: false }, 'Desfazer') : null,
      el('button', { class: 'botao', onclick: () => this.irPara(p) }, 'Voar até')));

    const s1 = id.secao('Nome e descrição', { aberto: true });
    s1.append(
      el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Nome'),
        el('input', { class: 'campo', id: 'pol-nome', value: p.nome, maxlength: 120, oninput: mudar((t) => { p.nome = t.value.trim() || 'Polígono'; document.querySelector('#ficha-titulo').textContent = p.nome; }) })),
      el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Descrição'),
        el('textarea', { class: 'campo area', id: 'pol-descricao', maxlength: 4000, oninput: mudar((t) => { p.descricao = t.value; }) }, p.descricao || '')),
      el('label', { class: 'linha-chave' }, el('span', {}, el('strong', {}, 'Mostrar o nome no mapa')),
        el('span', { class: 'interruptor' }, el('input', { type: 'checkbox', checked: p.rotulo, onchange: mudar((t) => { p.rotulo = t.checked; }) }), el('span', {}))));

    const s2 = id.secao('Estilo', { aberto: true });
    s2.append(el('div', { class: 'pol-estilo' },
      el('label', {}, el('span', {}, 'Cor da linha'), el('input', { type: 'color', id: 'pol-cor-linha', value: p.estilo.linha, oninput: mudar((t) => { p.estilo.linha = t.value; }) })),
      el('label', {}, el('span', {}, 'Largura da linha'), el('input', { type: 'number', class: 'campo', min: 1, max: 12, step: 1, value: p.estilo.larguraLinha,
        oninput: mudar((t) => { p.estilo.larguraLinha = Math.max(1, Math.min(12, +t.value || 1)); }) })),
      el('label', {}, el('span', {}, 'Cor do preenchimento'), el('input', { type: 'color', id: 'pol-cor-fundo', value: p.estilo.preenchimento, oninput: mudar((t) => { p.estilo.preenchimento = t.value; }) })),
      el('label', {}, el('span', {}, 'Opacidade'), el('input', { type: 'range', id: 'pol-opacidade', min: 0, max: 100, step: 5, value: p.estilo.opacidade,
        oninput: mudar((t) => { p.estilo.opacidade = +t.value; }) }))));

    const s3 = id.secao('Altitude', { aberto: p.altitude.modo !== 'chao' });
    const campoAltura = el('input', { type: 'number', class: 'campo', id: 'pol-altura', step: 0.5, value: p.altitude.altura, disabled: p.altitude.modo === 'chao',
      oninput: mudar((t) => { p.altitude.altura = +t.value || 0; if (this.editando === p.id) this._alcas(p); }) });
    const estender = el('input', { type: 'checkbox', id: 'pol-estender', checked: p.altitude.estender, disabled: p.altitude.modo === 'chao',
      onchange: mudar((t) => { p.altitude.estender = t.checked; }) });
    s3.append(
      el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Modo'),
        el('select', { class: 'campo', id: 'pol-modo', onchange: mudar((t) => {
          p.altitude.modo = t.value; campoAltura.disabled = estender.disabled = t.value === 'chao';
          if (t.value !== 'chao' && !p.altitude.altura) { p.altitude.altura = 3; campoAltura.value = 3; }
          if (this.editando === p.id) this._alcas(p);
        }) }, Object.entries(MODOS).map(([k, v]) => el('option', { value: k, selected: p.altitude.modo === k }, v)))),
      el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Altura (metros)'), campoAltura),
      el('label', { class: 'lembrar-linha' }, estender, ' Estender os lados até o chão (volume em 3D)'));

    const s4 = id.secao('Medidas', { aberto: true });
    this._caixaMedidas = el('div', {});
    s4.append(this._caixaMedidas);
    this._atualizarMedidas(p);

    if (p.origem?.tipo === 'lote') {
      const o = p.origem;
      id.secao('Lote de origem', { aberto: false }).append(id.tabela([['Bairro', o.bairro || '—'], ['Quadra', o.quadra || '—'], ['Lote', o.lote || '—'],
        ['Inscrição (CI)', o.ci || '—']].filter(([, v]) => v !== undefined)));
    }

    id.corpo.append(el('div', { class: 'linha-botoes' },
      el('button', { class: 'botao', onclick: () => this.capturarVista(p) }, 'Salvar esta vista'),
      el('button', { class: 'botao', onclick: () => this.duplicar(p) }, 'Duplicar'),
      p.original ? el('button', { class: 'botao', onclick: () => this.restaurar(p) }, 'Restaurar desenho oficial') : null,
      el('button', { class: 'botao', onclick: () => this.exportarKML([p]) }, 'Exportar KML'),
      el('button', { class: 'botao', onclick: () => this.alternar(p, !p.visivel) }, p.visivel ? 'Ocultar' : 'Mostrar'),
      el('button', { class: 'botao perigo', onclick: (ev) => {
        if (ev.target.dataset.ok !== '1') { ev.target.dataset.ok = '1'; ev.target.textContent = 'Confirmar exclusão'; return; }
        this.remover(p);
      } }, 'Excluir')),
    el('p', { class: 'nota' }, editando
      ? 'Arraste um vértice para movê-lo. Clique no ponto pequeno entre dois vértices para inserir outro. Botão direito num vértice apaga. Ctrl+Z desfaz.'
      : 'Os polígonos ficam salvos neste navegador e entram no KML exportado em “Marcar”.'));
  }

  // ------------------------------------------------------------- painel
  _montarPainel() {
    this.ul = el('ul', { class: 'lista-medidas' });
    this.btnNovo = el('button', { class: 'botao', id: 'poligono-novo', onclick: () => (this.desenho ? this.concluirDesenho() : this.novo()) }, 'Novo polígono');
    this.raiz.append(
      el('h3', { class: 'subtitulo' }, 'Polígonos'),
      el('div', { class: 'linha-botoes' }, this.btnNovo,
        el('button', { class: 'botao-texto', onclick: () => this.exportarKML(this.lista) }, 'Exportar polígonos (KML)')),
      el('p', { class: 'nota' }, 'Clique num lote e use “Editar como polígono”, ou desenhe um polígono novo.'),
      this.ul);
  }

  _listar() {
    this.ul.textContent = '';
    if (!this.lista.length) { this.ul.append(el('li', { class: 'vazio' }, 'Nenhum polígono ainda.')); return; }
    for (const p of this.lista) {
      const m = this.medidas(p);
      this.ul.append(el('li', {},
        el('input', { type: 'checkbox', checked: p.visivel, 'aria-label': `Mostrar ${p.nome}`, onchange: (ev) => this.alternar(p, ev.target.checked) }),
        el('span', { class: 'lv-cor', style: `background:${p.estilo.preenchimento}` }),
        el('button', { class: 'marcador-linha botao-texto', onclick: () => { this.abrirFicha(p); this.irPara(p); } },
          el('span', {}, p.nome), el('small', {}, `${fmtArea(m.area)} · ${m.vertices} vértices`)),
        el('button', { class: 'botao-icone', title: 'Apagar', 'aria-label': `Apagar ${p.nome}`, onclick: () => this.remover(p) }, '×')));
    }
    this.aoMudar();
  }

  // ------------------------------------------------------------- KML
  placemarks(lista = this.lista) {
    return lista.map((p) => {
      const a = p.altitude, h = a.modo === 'chao' ? 0 : a.altura;
      const anel = (q) => fecharAnel(q).map(([x, y]) => `${x.toFixed(7)},${y.toFixed(7)},${h}`).join(' ');
      const modo = { chao: 'clampToGround', relativo: 'relativeToGround', absoluto: 'absolute' }[a.modo];
      const estilo = `<Style><LineStyle><color>${corKML(p.estilo.linha)}</color><width>${p.estilo.larguraLinha}</width></LineStyle>` +
        `<PolyStyle><color>${corKML(p.estilo.preenchimento, p.estilo.opacidade / 100)}</color></PolyStyle></Style>`;
      const vista = p.vista ? `<Camera><longitude>${p.vista.lon}</longitude><latitude>${p.vista.lat}</latitude><altitude>${p.vista.alt}</altitude>` +
        `<heading>${Cesium.Math.toDegrees(p.vista.rumo)}</heading><tilt>${90 + Cesium.Math.toDegrees(p.vista.inclinacao)}</tilt><altitudeMode>absolute</altitudeMode></Camera>` : '';
      return `<Placemark><name>${escaparXML(p.nome)}</name><visibility>${p.visivel ? 1 : 0}</visibility>` +
        `<description>${escaparXML(p.descricao || '')}</description>${vista}${estilo}` +
        `<Polygon>${a.estender && a.modo !== 'chao' ? '<extrude>1</extrude>' : ''}<tessellate>1</tessellate><altitudeMode>${modo}</altitudeMode>` +
        `<outerBoundaryIs><LinearRing><coordinates>${anel(p.pontos)}</coordinates></LinearRing></outerBoundaryIs>` +
        (p.buracos || []).map((b) => `<innerBoundaryIs><LinearRing><coordinates>${anel(b)}</coordinates></LinearRing></innerBoundaryIs>`).join('') +
        '</Polygon></Placemark>';
    }).join('');
  }

  exportarKML(lista) {
    if (!lista.length) { aviso('Nenhum polígono para exportar.', 'alerta'); return; }
    const kml = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
      `<name>${escaparXML(lista.length === 1 ? lista[0].nome : 'Polígonos da Bússola')}</name><Folder><name>Polígonos</name>${this.placemarks(lista)}</Folder></Document></kml>`;
    const nome = lista.length === 1 ? lista[0].nome.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'poligono' : 'poligonos';
    baixarArquivo(`${nome}.kml`, kml, 'application/vnd.google-earth.kml+xml');
  }
}
