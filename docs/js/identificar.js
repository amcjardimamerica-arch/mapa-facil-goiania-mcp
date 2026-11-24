// Clique no mapa -> "ficha do local": lote, quadra, bairro, cadastro e o que
// estiver ligado nos temas do Mapa Fácil. Fora de Goiânia a ficha só indica o
// território (limítrofe), sem dados.
import { CFG, ROTULOS_CAMPOS, CAMPOS_OCULTOS, CAMPOS_SIM_NAO } from './config.js';
import { $, el, pedirJSON, mercX, mercY, deMercator, paraUTM, fmtNum, fmtGraus, aviso, extensaoDe, nomeBairro } from './util.js';
import { cofreDisponivel, cofreAberto, abrirCofre, camposPessoais } from './banco.js';

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
    return pedirJSON(`${url}/identify`, { parametros: {
      f: 'json', geometry: `${x},${y}`, geometryType: 'esriGeometryPoint', sr: '3857',
      layers: `${modo}:${ids.join(',')}`, tolerance: tolerancia,
      mapExtent: [x - (mpp * L) / 2, y - (mpp * A) / 2, x + (mpp * L) / 2, y + (mpp * A) / 2].join(','),
      imageDisplay: `${L},${A},96`, returnGeometry: 'true', geometryPrecision: 2,
    } });
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
        .catch((e) => n === this.pedido && this.corpo.append(el('p', { class: 'nota erro' },
          `A base cadastral não respondeu (${e.message}). `,
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

  _mostrarBase(resultados, ponto) {
    const por = (id) => resultados.find((r) => r.layerId === id);
    const lote = por(0), quadra = por(1), bairro = por(2);
    const nomeDoBairro = nomeBairro(bairro?.attributes.nm || bairro?.attributes.nm1 || '') || undefined;
    const partes = [];
    if (lote && !vazio(lote.attributes.nm_lot)) partes.push(`Lote ${lote.attributes.nm_lot.trim()}`);
    if (quadra && !vazio(quadra.attributes.nm_qdr)) partes.push(`Quadra ${quadra.attributes.nm_qdr.trim()}`);
    this.titulo(partes.join(' · ') || nomeDoBairro || 'Local em Goiânia',
      partes.length ? [nomeDoBairro, 'Goiânia'].filter(Boolean).join(' · ') : (nomeDoBairro ? 'Bairro · Goiânia' : 'Goiânia'));
    // O que se seleciona depende do que aparece no mapa: sem quadras (acima de 5 km), o bairro inteiro; com
    // quadras (5 km a 2,5 km), a quadra; com os números de lote (2,5 km ou menos), o lote.
    const h = this.globo.camera.positionCartographic.height;
    const alvo = h > 5000 ? bairro : h > 2500 ? (quadra || bairro) : (lote || quadra || bairro);
    if (alvo?.geometry) this.destacar(alvo.geometry);

    if (lote) {
      const corpo = this.secao('Lote', { aberto: true });
      corpo.append(this.tabela(atributosLegiveis(lote.attributes)));
      if (lote.geometry?.rings && this.acoes.editarPoligono) {
        const a = lote.attributes, qd = quadra?.attributes?.nm_qdr;
        corpo.append(el('button', { class: 'botao destaque', onclick: () => this.acoes.editarPoligono({
          aneis: lote.geometry.rings.map((r) => r.map(([x, y]) => deMercator(x, y))),
          quadra: String(qd || '').trim(), lote: String(a.nm_lot || '').trim(), bairro: nomeDoBairro || '',
          ci: String(a.ci || '').trim(), id: String(a.id || '').trim() }) }, 'Editar como polígono'));
      }
      this._anexos(String(lote.attributes.id || '').trim(), corpo);
      const ci = String(lote.attributes.ci || '').trim();
      if (/^\d{6,}$/.test(ci)) this.cadastroNaFicha(ci, ponto);
    }
    if (quadra) this.secao('Quadra').append(this.tabela(atributosLegiveis(quadra.attributes)),
      el('button', { class: 'botao-texto', onclick: () => this.destacar(quadra.geometry) }, 'Destacar no mapa'));
    if (bairro) this.secao('Bairro', { aberto: !lote }).append(this.tabela(atributosLegiveis(bairro.attributes)),
      el('button', { class: 'botao-texto', onclick: () => this.destacar(bairro.geometry, { preencher: false }) }, 'Destacar no mapa'));
    const outros = resultados.filter((r) => ![0, 1, 2].includes(r.layerId));
    if (outros.length) this._mostrarTema({ titulo: 'Base Cadastral' }, outros);
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
      const r = await pedirJSON(`${CFG.baseCadastral}/11/query`, { parametros: {
        f: 'json', where: `ID_OBJ = '${idLote.replace(/'/g, '')}'`, outFields: '*', returnGeometry: 'false' } });
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
      const r = await pedirJSON(`${CFG.ms}/Mapa_Tributario_Web/MapServer/0/query`, { parametros: {
        f: 'json', geometry: `${ponto.lon},${ponto.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false' } });
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
      const r = await pedirJSON(`${CFG.baseCadastral}/3/query`, { parametros: {
        f: 'json', where: `ci = '${ci.replace(/'/g, '')}'`, returnGeometry: 'false', orderByFields: 'nrinscr',
        outFields: 'nrinscr,tplogradou,nmlogradou,nrimovel,incompl,nrquadra,nrlote,nmbairro,areaterr,areaedif,areattedif,nrpaviment,nmedificio,vlvenal',
      } });
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
