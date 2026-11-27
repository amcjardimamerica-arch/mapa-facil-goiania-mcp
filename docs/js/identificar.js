// Clique no mapa -> "ficha do local": lote, quadra, bairro, cadastro e o que
// estiver ligado nos temas do Mapa Fácil. Fora de Goiânia a ficha só indica o
// território (limítrofe), sem dados.
import { BASE } from './mapavetorial.js';
import { fichaLote } from './fichalote.js';
import { CFG, ROTULOS_CAMPOS, CAMPOS_OCULTOS, CAMPOS_SIM_NAO } from './config.js';
import { $, el, pedirJSON, mercX, mercY, deMercator, paraUTM, fmtNum, fmtGraus, aviso, extensaoDe, nomeBairro } from './util.js';
import { cofreDisponivel, cofreAberto, abrirCofre, camposPessoais, consultarOuServidor, identificarOuServidor, servicoDe } from './banco.js';

const Cesium = window.Cesium;
const AMARELO = () => Cesium.Color.fromCssColorString(CFG.cores.destaque);

const vazio = (v) => v === null || v === undefined || ['', 'null', 'nan', '<null>'].includes(String(v).trim().toLowerCase());

/** Atributos de uma feição -> pares [rótulo, valor] limpos e legíveis. */
const CAMPOS_BAIRRO = new Set(['nm_bai', 'nmbairro', 'nm_bairro', 'bairro', 'nm1']);
export function atributosLegiveis(atributos) {
  const pares = [];
  for (const [campo, valor] of Object.entries(atributos || {})) {
    const chave = campo.toLowerCase();
    if (CAMPOS_OCULTOS.has(chave) || chave.startsWith('shape') && !ROTULOS_CAMPOS[campo] || vazio(valor)) continue;
    let v = String(valor).trim();
    if (CAMPOS_SIM_NAO.has(chave) && (v === '0' || v === '1')) v = v === '1' ? 'Sim' : 'Não';
    else if (/^-?\d+,\d+$/.test(v)) v = fmtNum(parseFloat(v.replace(',', '.')), 2);
    if (CAMPOS_BAIRRO.has(chave) || (chave === 'nm' && 'tp_bai' in atributos)) v = nomeBairro(v);
    const rotulo = ROTULOS_CAMPOS[campo] || campo;
    if (!pares.some(([r, x]) => r === rotulo && x === v)) pares.push([rotulo, v]); // nm e nm1 costumam repetir
  }
  return pares;
}

/** Geometria Esri JSON em Web Mercator -> lista de linhas [[lon,lat],…] (ou um ponto). */
function linhasDaGeometria(g) {
  if (!g) return { linhas: [], ponto: null };
  if (Number.isFinite(g.x)) return { linhas: [], ponto: deMercator(g.x, g.y) };
  const partes = g.rings || g.paths || [];
  return { linhas: partes.map((p) => p.map(([x, y]) => deMercator(x, y))), ponto: null, fechado: !!g.rings };
}

export class Identificar {
  constructor(globo, camadas, territorio) {
    this.globo = globo;
    this.camadas = camadas;
    this.territorio = territorio;
    this.caixa = $('#ficha');
    this.corpo = $('#ficha-corpo');
    this.pedido = 0;
    this.acoes = {}; // preenchido pelo app: marcar(ponto, nome)
    this.fonte = new Cesium.CustomDataSource('destaque');
    globo.viewer.dataSources.add(this.fonte);
    $('#ficha-fechar').addEventListener('click', () => this.fechar());
  }

  fechar() {
    this.pedido++;
    this.caixa.hidden = true;
    this.limparDestaque();
  }

  /**
   * Seleção padrão do mapa inteiro: o objeto escolhido fica mais claro (cor e linha), sem ponto nem marcador.
   * Cada módulo aplica o próprio clareamento e entrega aqui a função que desfaz; a seleção anterior é
   * desfeita sempre que outra começa ou a ficha fecha.
   */
  selecionar(restaurar) {
    this._restaurar?.();
    this._restaurar = restaurar;
  }

  /** Lotes/locais piscando (amarelo forte) até outra seleção ou o fechamento da ficha. */
  piscar(aneis) {
    this.limparDestaque();
    const t0 = performance.now();
    const fase = () => (Math.floor((performance.now() - t0) / 450) % 2 === 0);
    const cor = new Cesium.CallbackProperty(() => (fase() ? Cesium.Color.fromCssColorString('#FFFF00').withAlpha(0.75) : Cesium.Color.fromCssColorString('#FF00FF').withAlpha(0.25)), false);
    const linha = new Cesium.CallbackProperty(() => (fase() ? Cesium.Color.fromCssColorString('#FF0000') : Cesium.Color.WHITE), false);
    for (const a of aneis) {
      if (a.length < 3) continue;
      const pos = Cesium.Cartesian3.fromDegreesArray(a.flat());
      this.fonte.entities.add({ polygon: { hierarchy: pos, material: new Cesium.ColorMaterialProperty(cor), classificationType: Cesium.ClassificationType.TERRAIN } });
      this.fonte.entities.add({ polyline: { positions: [...pos, pos[0]], clampToGround: true, width: 4, material: new Cesium.ColorMaterialProperty(linha) } });
    }
    const relogio = setInterval(() => this.globo.redesenhar(), 450);
    this.selecionar(() => clearInterval(relogio));
    this.globo.redesenhar();
  }

  limparDestaque() {
    this._restaurar?.();
    this._restaurar = null;
    this.fonte.entities.removeAll();
    this.globo.redesenhar();
  }

  // ------------------------------------------------------------------ destaque
  destacar(geometria, { limpar = true, cor = AMARELO(), preencher = true } = {}) {
    if (limpar) this.limparDestaque();
    const { linhas, ponto, fechado } = linhasDaGeometria(geometria);
    this._desenhar(linhas, ponto, fechado, cor, preencher);
    return linhas.length ? extensaoDe(linhas.flat()) : null;
  }

  destacarLonLat(linhas, { fechado = false, limpar = true, cor = AMARELO(), preencher = true } = {}) {
    if (limpar) this.limparDestaque();
    this._desenhar(linhas, null, fechado, cor, preencher);
  }

  _desenhar(linhas, ponto, fechado, cor, preencher) {
    for (const linha of linhas) {
      if (linha.length < 2) continue;
      const pos = Cesium.Cartesian3.fromDegreesArray(linha.flat());
      // Selecionado = mais claro: linha clara e larga e preenchimento na cor do objeto, mais luminoso.
      const claro = cor.brighten(0.55, new Cesium.Color());
      this.fonte.entities.add({ polyline: { positions: pos, clampToGround: true, width: 5, material: claro.withAlpha(1) } });
      if (fechado && preencher && linha.length >= 4) {
        this.fonte.entities.add({ polygon: {
          hierarchy: new Cesium.PolygonHierarchy(pos), material: claro.withAlpha(0.55),
          classificationType: Cesium.ClassificationType.TERRAIN,
        } });
      }
    }
    if (ponto) this.alfinete(ponto[0], ponto[1], cor);
    this.globo.redesenhar();
  }

  /** Antigo marcador de ponto: a seleção não usa mais ponto nem marcador (mantido para compatibilidade). */
  alfinete() {}

  _alfineteAntigo(lon, lat, cor = AMARELO()) {
    this.fonte.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: { pixelSize: 11, color: cor, outlineColor: Cesium.Color.BLACK.withAlpha(0.8), outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
    this.globo.redesenhar();
  }

  // --------------------------------------------------------------------- ficha
  abrir({ titulo, subtitulo, ponto }) {
    this.caixa.hidden = false;
    $('#ficha-titulo').textContent = titulo;
    $('#ficha-subtitulo').textContent = subtitulo || '';
    this.corpo.textContent = '';
    if (ponto) this.corpo.append(this._blocoCoordenadas(ponto));
  }

  titulo(titulo, subtitulo) {
    $('#ficha-titulo').textContent = titulo;
    if (subtitulo !== undefined) $('#ficha-subtitulo').textContent = subtitulo;
  }

  _blocoCoordenadas(p) {
    const utm = paraUTM(p.lon, p.lat);
    const exagero = this.globo.cena.verticalExaggeration || 1;
    const alt = this.globo.relevoAtivo && Number.isFinite(p.alt) ? `${fmtNum(p.alt / exagero)} m` : '—';
    const textoGraus = `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
    return el('div', { class: 'coordenadas' },
      el('div', {}, el('small', {}, 'Latitude, longitude'), el('span', {}, fmtGraus(p.lat, p.lon))),
      el('div', {}, el('small', {}, 'UTM 22S · SIRGAS 2000'), el('span', {}, `E ${fmtNum(utm.e, 1)}  N ${fmtNum(utm.n, 1)}`)),
      el('div', {}, el('small', {}, 'Altitude do terreno'), el('span', {}, alt)),
      el('div', { class: 'acoes' },
        el('button', { class: 'botao-texto', onclick: () => navigator.clipboard?.writeText(textoGraus)
          .then(() => aviso('Coordenadas copiadas.'), () => aviso('Não foi possível copiar.', 'alerta')) }, 'Copiar'),
        this.acoes.marcar ? el('button', { class: 'botao-texto', onclick: () => this.acoes.marcar(p, $('#ficha-titulo').textContent) }, 'Marcar') : null,
        el('a', { class: 'botao-texto', target: '_blank', rel: 'noopener',
          href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lon}` }, 'Street View')));
  }

  secao(titulo, { aberto = false, classe = '' } = {}) {
    const corpo = el('div', { class: 'secao-corpo' });
    const s = el('details', { class: `secao ${classe}`, open: aberto }, el('summary', {}, titulo), corpo);
    this.corpo.append(s);
    return corpo;
  }

  tabela(pares) {
    // Sem referências ao Mapa Fácil nas fichas: o sistema funciona só com os próprios dados.
    const limpa = (t) => (typeof t === 'string' ? t.replace(/\s*\(Mapa F[aá]cil\)/gi, '').replace(/(do |no )?Mapa F[aá]cil/gi, 'cadastro municipal') : t);
    return el('dl', { class: 'atributos' }, pares.flatMap(([k, v]) => [el('dt', {}, limpa(k)), el('dd', {}, limpa(v))]));
  }

  // ------------------------------------------------------------------ consulta
  async _identify(url, modo, ids, ponto, tolerancia) {
    const tela = this.globo.cena.canvas;
    const x = mercX(ponto.lon), y = mercY(ponto.lat);
    const mpp = (this.globo.metrosPorPixel() || 1) / Math.cos((ponto.lat * Math.PI) / 180);
    const L = tela.clientWidth, A = tela.clientHeight;
    return identificarOuServidor(servicoDe(url).S, {
      f: 'json', geometry: `${x},${y}`, geometryType: 'esriGeometryPoint', sr: '3857',
      layers: `${modo}:${ids.join(',')}`, tolerance: tolerancia,
      mapExtent: [x - (mpp * L) / 2, y - (mpp * A) / 2, x + (mpp * L) / 2, y + (mpp * A) / 2].join(','),
      imageDisplay: `${L},${A},96`, returnGeometry: 'true', geometryPrecision: 2,
    });
  }

  /** Consulta completa de um ponto do mapa. */
  async emPonto(ponto) {
    const n = ++this.pedido;
    this.fonte.entities.removeAll();
    const mun = this.territorio.municipioEm(ponto.lon, ponto.lat);
    if (!mun || mun.tipo !== 'goiania') {
      this.abrir({ titulo: mun ? mun.nome : 'Fora de Goiânia', ponto,
        subtitulo: mun ? 'Município limítrofe' : 'Fora da área do mapa' });
      this.corpo.append(el('p', { class: 'nota' }, mun
        ? (mun.contato === 'vertice'
          ? `${mun.nome} encosta em Goiânia em um único ponto. `
          : `${mun.nome} faz divisa com Goiânia por ${fmtNum(mun.divisa_km, 1)} km. `) +
          'Este mapa traz dados apenas de Goiânia; dos municípios vizinhos é indicado só o território.'
        : 'Este mapa traz dados apenas do município de Goiânia.'));
      this.alfinete(ponto.lon, ponto.lat, Cesium.Color.WHITE);
      return;
    }
    this.abrir({ titulo: 'Consultando…', subtitulo: 'Goiânia', ponto });
    this.alfinete(ponto.lon, ponto.lat);
    const estado = el('p', { class: 'nota carregando' }, 'Consultando…');
    this.corpo.append(estado);

    const base = this.camadas.consultaBase();
    const tarefas = [];
    if (base && base.ids.length) {
      tarefas.push(this._identify(base.tema.url, 'all', base.ids, ponto, 1)
        .then((r) => n === this.pedido && this._mostrarBase(r.results || [], ponto))
        // Uma nova tentativa automática antes de avisar (rede instável no aparelho).
        .catch(() => (n === this.pedido ? new Promise((ok) => setTimeout(ok, 800)).then(() => this._identify(base.tema.url, 'all', base.ids, ponto, 1)
          .then((r) => n === this.pedido && this._mostrarBase(r.results || [], ponto))) : null))
        .catch((e) => n === this.pedido && this.corpo.append(el('p', { class: 'nota erro' },
          `Não foi possível ler os dados do lote agora (${e.message}). Verifique a internet e tente de novo. `,
          el('button', { class: 'botao-texto', onclick: () => this.emPonto(ponto) }, 'Tentar de novo')))));
    }
    for (const { tema, ids } of this.camadas.ativos()) {
      tarefas.push(this._identify(tema.url, 'visible', ids, ponto, 6)
        .then((r) => n === this.pedido && this._mostrarTema(tema, r.results || []))
        .catch((e) => n === this.pedido && this.corpo.append(el('p', { class: 'nota erro' }, `${tema.titulo}: ${e.message}`))));
    }
    await Promise.allSettled(tarefas);
    if (n !== this.pedido) return;
    estado.remove();
    if ($('#ficha-titulo').textContent === 'Consultando…') this.titulo('Local em Goiânia', 'Sem lote cadastrado neste ponto');
  }

  /**
   * O que o clique seleciona depende da altura da câmera (a mesma do rodapé): acima de 5 km, o bairro inteiro;
   * de 5 km a 2,5 km, a quadra; de 2,5 km para baixo, o lote.
   */
  static alvoPelaAltura(h) { return h > 5000 ? 'bairro' : h > 2500 ? 'quadra' : 'lote'; }

  _mostrarBase(resultados, ponto) {
    const por = (id) => resultados.find((r) => r.layerId === id);
    const lote = por(0), quadra = por(1), bairro = por(2);
    const nomeDoBairro = nomeBairro(bairro?.attributes.nm || bairro?.attributes.nm1 || '') || undefined;
    const outros = resultados.filter((r) => ![0, 1, 2].includes(r.layerId));
    const modo = Identificar.alvoPelaAltura(this.globo.camera.positionCartographic.height);
    if (modo === 'bairro' && bairro) { this.fichaBairro(bairro); return; }
    if (modo === 'quadra' && quadra) {
      this.destacar(quadra.geometry);
      const nq = String(quadra.attributes.nm_qdr || '').trim();
      this.titulo(`Quadra ${nq}`, [nomeDoBairro, 'Goiânia'].filter(Boolean).join(' · '));
      const area = Number(quadra.attributes['shape.STArea()']);
      this.secao('Quadra', { aberto: true }).append(this.tabela([['Quadra', nq], ['Bairro', nomeDoBairro || '—'],
        ...(area > 0 ? [['Área aproximada', `${fmtNum(area)} m²`]] : []),
        ['Inscrição da quadra (CI)', String(quadra.attributes.ci || '').trim() || '—']]),
      el('p', { class: 'nota' }, 'Aproxime abaixo de 2,5 km para selecionar o lote; acima de 5 km o clique seleciona o bairro inteiro.'));
      if (bairro) this.secao('Bairro').append(el('button', { class: 'botao-texto', onclick: () => this.fichaBairro(bairro) }, `Ver o levantamento de ${nomeDoBairro || 'todo o bairro'}`));
      if (outros.length) this._mostrarTema({ titulo: 'Base Cadastral' }, outros);
      return;
    }
    const alvo = lote || quadra || bairro;
    if (alvo?.geometry) this.destacar(alvo.geometry);
    if (lote) {
      // Ficha do lote (fichalote.js): a mesma para todos os lotes de Goiânia.
      const a = lote.attributes, qd = quadra?.attributes?.nm_qdr;
      const editar = lote.geometry?.rings && this.acoes.editarPoligono ? () => this.acoes.editarPoligono({
        aneis: lote.geometry.rings.map((r) => r.map(([x, y]) => deMercator(x, y))),
        quadra: String(qd || '').trim(), lote: String(a.nm_lot || '').trim(), bairro: nomeDoBairro || '',
        ci: String(a.ci || '').trim(), id: String(a.id || '').trim() }) : null;
      fichaLote(this, { lote, quadra: quadra?.attributes, bairro: nomeDoBairro, ponto, aoEditarPoligono: editar })
        .then(() => { if (outros.length) this._mostrarTema({ titulo: 'Base Cadastral' }, outros); });
      return;
    }
    this.titulo(nomeDoBairro || 'Local em Goiânia', nomeDoBairro ? 'Bairro · Goiânia' : 'Goiânia');
    if (bairro) this.secao('Bairro', { aberto: true }).append(
      el('button', { class: 'botao-texto', onclick: () => this.fichaBairro(bairro) }, `Ver o levantamento de ${nomeDoBairro || 'todo o bairro'}`));
    if (outros.length) this._mostrarTema({ titulo: 'Base Cadastral' }, outros);
  }

  /** Levantamento de cada bairro (data/bairros_resumo.json, scripts/resumo_bairros.py), lido uma vez. */
  resumoBairros() {
    if (!this._resumo) {
      this._resumo = pedirJSON(`${CFG.dados}bairros_resumo.json`, { tempo: 60000 });
      this._resumo.catch(() => { this._resumo = null; });
    }
    return this._resumo;
  }

  /**
   * Ficha do bairro inteiro: nome do bairro no título, sem coordenadas do ponto clicado nem "Marcar", e o
   * levantamento do bairro — população, quadras, lotes, praças, escolas, igrejas, mercados, condomínios, locais
   * esportivos, feiras e o mais que os dados da Prefeitura trazem —, com os nomes de cada item.
   */
  async fichaBairro(bairro) {
    const n = ++this.pedido;
    const a = bairro.attributes || {};
    const nome = nomeBairro(a.nm || a.nm1 || '') || 'Bairro';
    this.caixa.hidden = false;
    this.titulo(nome, 'Bairro · Goiânia');
    this.corpo.textContent = '';
    if (bairro.geometry) this.destacar(bairro.geometry, { preencher: false });
    const estado = el('p', { class: 'nota carregando' }, 'Levantando os dados do bairro…');
    this.corpo.append(estado);
    let r = null;
    try { r = (await this.resumoBairros()).bairros[String(a.id || '').trim()] || null; } catch { r = null; }
    if (n !== this.pedido) return;
    estado.remove();
    const R = (await this.resumoBairros().catch(() => ({ rotulos: {} }))).rotulos || {};
    if (!r) {
      this.corpo.append(el('p', { class: 'nota' }, 'Levantamento deste bairro indisponível.'));
      return;
    }
    const c = r.c || {}, nomes = r.n || {};
    this.titulo(nome, ['Bairro', r.regiao ? r.regiao.replace(/^REGI[AÃ]O\s+/i, 'Região ').replace(/\B\w+/g, (t) => t.toLowerCase()) : '',
      r.conselho_tutelar ? `Conselho Tutelar ${r.conselho_tutelar}` : ''].filter(Boolean).join(' · '));
    const num = (k) => fmtNum(c[k] || 0);
    const dens = r.area_km2 ? Math.round((r.populacao || 0) / r.area_km2) : 0;
    this.corpo.append(this.tabela([
      ['População', `${fmtNum(r.populacao || 0)} pessoas${r.homens || r.mulheres ? ` (${fmtNum(r.mulheres || 0)} mulheres e ${fmtNum(r.homens || 0)} homens)` : ''}`],
      ['Área', `${fmtNum(r.area_km2 || 0, 2)} km²${dens ? ` · ${fmtNum(dens)} hab./km²` : ''}`],
      ['Quadras', num('quadras')], ['Lotes', num('lotes')], ['Lotes vagos', num('lotes_vagos')],
      ['Empresas e atividades', num('empresas')],
      ['Edifícios cadastrados', `${num('edificios')}${c.edificios ? ` (1 a 3 pav.: ${num('edificios_1')} · 4 a 10: ${num('edificios_2')} · 11 a 20: ${num('edificios_3')} · 21 a 30: ${num('edificios_4')} · mais de 30: ${num('edificios_5')})` : ''}`],
    ]));
    // Grupos do levantamento: cada item com a quantidade e, aberto, os nomes.
    const GRUPOS = [
      ['Praças, parques e áreas verdes', ['pracas', 'parques', 'areas_verdes']],
      ['Esporte e lazer', ['esportivos', 'academias']],
      ['Escolas e cursos', ['educacao_municipal', 'escolas_publicas', 'escolas_privadas', 'cursos']],
      ['Igrejas e locais de religião', ['igrejas', 'religiosos_publicos', 'imoveis_religiosos']],
      ['Supermercados, mercados e feiras', ['supermercados', 'feiras', 'padarias', 'acougues']],
      ['Condomínios e edifícios', ['condominios', 'lotes_condominio', 'edificios']],
      ['Saúde', ['saude_municipal', 'saude_publica', 'saude_privada', 'farmacias']],
      ['Comércio e serviços', ['restaurantes', 'bares', 'combustivel', 'bancos', 'hoteis']],
      ['Comunidade e serviços públicos', ['associacoes', 'comunitarios', 'seguranca', 'outras_areas']],
      ['Transporte e meio ambiente', ['pontos_onibus', 'arvores', 'nascentes']],
      ['Drenagem pluvial (base da A.M.C.)', ['drenagem_bocas', 'drenagem_unidades', 'drenagem_bocas_ruins', 'drenagem_bocas_sem_galeria', 'drenagem_galeria_m',
        'drenagem_pocos', 'drenagem_pocos_fechados', 'drenagem_pontos_baixos', 'drenagem_ruas_sem_boca_m']],
    ];
    for (const [titulo, chaves] of GRUPOS) {
      const itens = chaves.filter((k) => c[k]);
      if (!itens.length) continue;
      const total = itens.reduce((t, k) => t + (c[k] || 0), 0);
      const corpo = this.secao(`${titulo} (${fmtNum(total)})`, { aberto: false });
      for (const k of itens) {
        const lista = nomes[k] || [];
        const rot = `${R[k] || k}: ${fmtNum(c[k])}`;
        if (!lista.length) { corpo.append(el('p', { class: 'lv-item-bairro' }, rot)); continue; }
        corpo.append(el('details', { class: 'lv-empresa' }, el('summary', {}, rot),
          el('ul', { class: 'lista-links' }, lista.map((t) => el('li', {}, t)),
            c[k] > lista.length ? el('li', { class: 'nota' }, `e mais ${fmtNum(c[k] - lista.length)}`) : null)));
      }
    }
    this.corpo.append(el('p', { class: 'nota' }, 'Levantamento a partir do banco do sistema (cadastros da Prefeitura de Goiânia): cada item conta no bairro em que está. Aproxime abaixo de 5 km para selecionar quadras e abaixo de 2,5 km para lotes.'));
  }

  _mostrarTema(tema, resultados) {
    if (!resultados.length) {
      this.secao(`${tema.titulo} — nada neste ponto`, { classe: 'vazia' });
      return;
    }
    const corpo = this.secao(`${tema.titulo} (${resultados.length})`, { aberto: true });
    for (const r of resultados.slice(0, 15)) {
      const nome = !vazio(r.value) && r.value !== r.attributes.OBJECTID ? String(r.value).trim() : '';
      corpo.append(el('div', { class: 'resultado' },
        el('div', { class: 'resultado-topo' }, el('strong', {}, r.layerName), nome ? el('span', {}, nome) : null,
          r.geometry ? el('button', { class: 'botao-texto', onclick: () => this.destacar(r.geometry, { cor: Cesium.Color.CYAN }) }, 'Ver') : null),
        this.tabela(atributosLegiveis(r.attributes)),
        !cofreAberto() && tema.chave && camposPessoais(tema.chave, r.layerId).length ? this._cadeados(camposPessoais(tema.chave, r.layerId)) : null));
    }
    if (resultados.length > 15) corpo.append(el('p', { class: 'nota' }, `Mais ${resultados.length - 15} resultado(s) não exibidos.`));
  }

  /** Documentos anexados ao lote no Mapa Fácil (vistorias, plantas, certidões): lista do banco, arquivo no servidor municipal. */
  async _anexos(idLote, alvo) {
    if (!idLote) return;
    try {
      const r = await consultarOuServidor('Feature_Base', 11, {
        f: 'json', where: `ID_OBJ = '${idLote.replace(/'/g, '')}'`, outFields: '*', returnGeometry: 'false' });
      const fs = (r.features || []).map((f) => f.attributes);
      if (!fs.length) return;
      // Só a lista: o sistema não abre arquivos fora dele.
      const lista = el('ul', { class: 'lista-links' }, fs.map((a) => el('li', {},
        el('span', {}, String(a.NM || a.ATT_NAME || 'Documento').trim()),
        el('small', {}, ` ${a.CONTENT_TYPE || ''} · ${a.DT_INC || ''}`))));
      alvo.append(el('h4', { class: 'subtitulo' }, `Documentos anexados ao lote (${fs.length})`), lista);
    } catch (e) { /* sem anexos no banco */ }
  }

  /** Cadastro imobiliário e dados complementares do lote, já abertos na ficha (sem botão). */
  cadastroNaFicha(ci, ponto) {
    const alvo = this.secao('Cadastro imobiliário e dados complementares', { aberto: true });
    this._cadastro(ci, alvo, ponto);
  }

  /** Campos pessoais com cadeado e sem valor (cofre fechado). */
  _cadeados(campos, titulo = 'Dados complementares') {
    const ROTULO = { PROPRIETAR: 'Proprietário', CPF_CNPJ: 'CPF/CNPJ', RG: 'RG', TELEFONE: 'Telefone', DT_NASCIME: 'Data de nascimento',
      ESTADO_CIV: 'Estado civil', dtnascimen: 'Data de nascimento', NOME_CONTA: 'Contador', NUMR_CPFCN: 'CPF/CNPJ do contador', INFO_CPFCN: 'CPF/CNPJ' };
    const lista = el('dl', { class: 'atributos cadeados' });
    for (const c of campos) lista.append(el('dt', {}, `🔒 ${ROTULO[c] || c}`), el('dd', {}, ''));
    return el('div', {}, el('h4', { class: 'subtitulo' }, `🔒 ${titulo}`), lista);
  }

  /** Formulário da senha do cofre (dados pessoais cifrados no banco local). */
  _formCofre(depois) {
    const campo = el('input', { type: 'password', class: 'campo', placeholder: 'Senha do cofre', autocomplete: 'off', 'aria-label': 'Senha do cofre' });
    const msg = el('p', { class: 'nota' }, 'Nome do proprietário, CPF/CNPJ, RG, telefone e demais dados pessoais estão cifrados no banco. Informe a senha do cofre para ver.');
    const abrir = async () => {
      try { await abrirCofre(campo.value); depois(); }
      catch (e) { msg.textContent = e.message; msg.classList.add('erro'); }
    };
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') abrir(); });
    return el('div', { class: 'cofre' }, msg, campo, el('button', { class: 'botao', onclick: abrir }, 'Abrir dados pessoais'));
  }

  /** Proprietário e dados do bem no cadastro tributário (Mapa_Tributario_Web), pelo ponto do lote. */
  async _proprietario(ponto, alvo) {
    try {
      const r = await consultarOuServidor('Mapa_Tributario_Web', 0, {
        f: 'json', geometry: `${ponto.lon},${ponto.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false' });
      const fs = r.features || [];
      if (!fs.length) return;
      const corpo = el('div', {});
      for (const f of fs.slice(0, 20)) corpo.append(this.tabela(atributosLegiveis(f.attributes)));
      alvo.append(el('h4', { class: 'subtitulo' }, `Cadastro tributário — proprietário e imóvel (${fs.length})`), corpo);
    } catch (e) { /* tema tributário fora do banco */ }
  }

  async _cadastro(ci, alvo, ponto) {
    alvo.append(el('p', { class: 'nota carregando' }, 'Consultando o Cadastro Imobiliário…'));
    try {
      const r = await consultarOuServidor('Feature_Base', 3, {
        f: 'json', where: `ci = '${ci.replace(/'/g, '')}'`, returnGeometry: 'false', orderByFields: 'nrinscr',
        outFields: 'nrinscr,tplogradou,nmlogradou,nrimovel,incompl,nrquadra,nrlote,nmbairro,areaterr,areaedif,areattedif,nrpaviment,nmedificio,vlvenal',
      });
      const us = (r.features || []).map((f) => f.attributes);
      alvo.textContent = '';
      if (!us.length) { alvo.append(el('p', { class: 'nota' }, 'Nenhuma inscrição cadastrada para este lote.')); return; }
      const t = (v) => String(v ?? '').trim();
      const u0 = us[0];
      alvo.append(this.tabela([
        ['Inscrições no lote', fmtNum(us.length)],
        ['Edifício', t(u0.nmedificio)],
        ['Endereço', [t(u0.nmlogradou), t(u0.nrimovel)].filter(Boolean).join(', ')],
        ['Quadra / lote', `${t(u0.nrquadra)} / ${t(u0.nrlote)}`],
        ['Bairro', nomeBairro(t(u0.nmbairro))],
        ['Área do terreno', u0.areaterr ? `${fmtNum(u0.areaterr, 2)} m²` : ''],
        ['Área total edificada', u0.areattedif ? `${fmtNum(u0.areattedif, 2)} m²` : ''],
        ['Pavimentos', u0.nrpaviment || ''],
      ].filter(([, v]) => !vazio(v))));
      // Cada inscrição em bloco vertical, no mesmo plano da ficha (sem barra de rolagem lateral).
      const blocos = us.slice(0, 200).map((u) => el('dl', { class: 'atributos unidade-vertical' },
        el('dt', {}, 'Inscrição'), el('dd', {}, t(u.nrinscr)),
        el('dt', {}, 'Complemento'), el('dd', {}, t(u.incompl) || '—'),
        el('dt', {}, 'Área edificada'), el('dd', {}, u.areaedif ? `${fmtNum(u.areaedif, 2)} m²` : '—'),
        el('dt', {}, 'Valor venal'), el('dd', {}, u.vlvenal ? `R$ ${fmtNum(u.vlvenal, 2)}` : '—')));
      alvo.append(...blocos);
      if (us.length > 200) alvo.append(el('p', { class: 'nota' }, `Exibidas 200 de ${us.length} inscrições.`));
      if (ponto && cofreDisponivel()) {
        if (cofreAberto()) this._proprietario(ponto, alvo);
        else alvo.append(this._cadeados(['PROPRIETAR', 'CPF_CNPJ', 'RG', 'TELEFONE', 'DT_NASCIME', 'ESTADO_CIV'], 'Proprietário (cadastro tributário)'));
      }
    } catch (e) {
      alvo.textContent = '';
      alvo.append(el('p', { class: 'nota erro' }, `Cadastro indisponível: ${e.message}`));
    }
  }

  /** Ficha de um edifício do modelo 3D. */
  edificio(e, mpp) {
    this.fonte.entities.removeAll();
    this.abrir({ titulo: e.n, subtitulo: e.lv ? `${e.tipo} · ${e.b}` : 'Edifício em altura · Goiânia', ponto: { lon: e.c[0], lat: e.c[1], alt: NaN } });
    if (e.lv) {
      const fontes = Object.entries(e.fontes || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ');
      this.corpo.append(this.tabela([
        ['Andares', e.uso === 'horizontal' ? `${e.andares} nas casas (no 3D, 1 andar)` : `${e.p}`],
        ['Uso', { horizontal: 'Condomínio horizontal (casas)', residencial: 'Residencial', comercial: 'Comercial', misto: 'Misto', indefinido: 'Não diferenciado' }[e.uso] || '—'],
        ['Andares: de onde veio', e.base || '—'],
        ['Base no 3D', e.base_3d || '—'],
        ['Andares em cada fonte', fontes || 'nenhuma fonte informa'],
        ['Conferência', e.conf || '—'],
        ['Inscrições de IPTU no lote', e.insc ?? '—'],
        ['Quadra e lote', `Quadra ${e.q}, lote ${e.l}`],
        ['Google Maps', e.google ? `${e.google} — ${e.google_end || ''}` : 'não consultado ou não encontrado'],
      ]));
    }
    this.corpo.append(this.tabela([
      ['Pavimentos', e.p || 'não informado'],
      ['Altura estimada', `${fmtNum(Math.max(e.p, 1) * mpp)} m (${fmtNum(mpp, 1)} m por pavimento)`],
      ['Apartamentos', e.a || '—'],
      ['Área do terreno', e.t ? `${fmtNum(e.t)} m²` : '—'],
      ['Ano de averbação', e.ano || '—'],
      ['Inscrição cadastral (CI)', e.ci || '—'],
    ]), el('button', { class: 'botao', onclick: () => this.emPonto({ lon: e.c[0], lat: e.c[1], alt: NaN }) },
      'Ver lote e cadastro'),
    el('p', { class: 'nota' }, e.lv ? 'Prédio conferido pelo IPTU do lote: a altura vem do maior número de andares entre as fontes. A base é o desenho do cadastro municipal quando ele já tinha o prédio; nos novos, a construção vista na imagem de satélite (só a torre, sem o estacionamento).'
      : 'Volume esquemático: a base é aproximada a partir do lote e a altura vem do número de pavimentos do cadastro.'));
  }
}
