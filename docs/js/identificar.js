// Clique no mapa -> "ficha do local": lote, quadra, bairro, cadastro e o que
// estiver ligado nos temas do Mapa Fácil. Fora de Goiânia a ficha só indica o
// território (limítrofe), sem dados.
import { CFG, ROTULOS_CAMPOS, CAMPOS_OCULTOS, CAMPOS_SIM_NAO } from './config.js';
import { $, el, pedirJSON, mercX, mercY, deMercator, paraUTM, fmtNum, fmtGraus, aviso, extensaoDe } from './util.js';

const Cesium = window.Cesium;
const AMARELO = () => Cesium.Color.fromCssColorString(CFG.cores.destaque);

const vazio = (v) => v === null || v === undefined || ['', 'null', 'nan', '<null>'].includes(String(v).trim().toLowerCase());

/** Atributos de uma feição -> pares [rótulo, valor] limpos e legíveis. */
export function atributosLegiveis(atributos) {
  const pares = [];
  for (const [campo, valor] of Object.entries(atributos || {})) {
    const chave = campo.toLowerCase();
    if (CAMPOS_OCULTOS.has(chave) || chave.startsWith('shape') && !ROTULOS_CAMPOS[campo] || vazio(valor)) continue;
    let v = String(valor).trim();
    if (CAMPOS_SIM_NAO.has(chave) && (v === '0' || v === '1')) v = v === '1' ? 'Sim' : 'Não';
    else if (/^-?\d+,\d+$/.test(v)) v = fmtNum(parseFloat(v.replace(',', '.')), 2);
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
    this.fonte.entities.removeAll();
    this.globo.redesenhar();
  }

  // ------------------------------------------------------------------ destaque
  destacar(geometria, { limpar = true, cor = AMARELO(), preencher = true } = {}) {
    if (limpar) this.fonte.entities.removeAll();
    const { linhas, ponto, fechado } = linhasDaGeometria(geometria);
    this._desenhar(linhas, ponto, fechado, cor, preencher);
    return linhas.length ? extensaoDe(linhas.flat()) : null;
  }

  destacarLonLat(linhas, { fechado = false, limpar = true, cor = AMARELO(), preencher = false } = {}) {
    if (limpar) this.fonte.entities.removeAll();
    this._desenhar(linhas, null, fechado, cor, preencher);
  }

  _desenhar(linhas, ponto, fechado, cor, preencher) {
    for (const linha of linhas) {
      if (linha.length < 2) continue;
      const pos = Cesium.Cartesian3.fromDegreesArray(linha.flat());
      this.fonte.entities.add({ polyline: { positions: pos, clampToGround: true, width: 3.5, material: cor } });
      if (fechado && preencher && linha.length >= 4) {
        this.fonte.entities.add({ polygon: {
          hierarchy: new Cesium.PolygonHierarchy(pos), material: cor.withAlpha(0.2),
          classificationType: Cesium.ClassificationType.TERRAIN,
        } });
      }
    }
    if (ponto) this.alfinete(ponto[0], ponto[1], cor);
    this.globo.redesenhar();
  }

  alfinete(lon, lat, cor = AMARELO()) {
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
          href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lon}` }, 'Street View'),
        el('a', { class: 'botao-texto', target: '_blank', rel: 'noopener',
          href: `${CFG.portal}?center=${p.lon},${p.lat},4326&scale=2000` }, 'Mapa Fácil')));
  }

  secao(titulo, { aberto = false, classe = '' } = {}) {
    const corpo = el('div', { class: 'secao-corpo' });
    const s = el('details', { class: `secao ${classe}`, open: aberto }, el('summary', {}, titulo), corpo);
    this.corpo.append(s);
    return corpo;
  }

  tabela(pares) {
    return el('dl', { class: 'atributos' }, pares.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
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
    const estado = el('p', { class: 'nota carregando' }, 'Consultando o Mapa Fácil…');
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
    const nomeBairro = bairro?.attributes.nm || bairro?.attributes.nm1;
    const partes = [];
    if (lote && !vazio(lote.attributes.nm_lot)) partes.push(`Lote ${lote.attributes.nm_lot.trim()}`);
    if (quadra && !vazio(quadra.attributes.nm_qdr)) partes.push(`Quadra ${quadra.attributes.nm_qdr.trim()}`);
    this.titulo(partes.join(' · ') || nomeBairro || 'Local em Goiânia',
      partes.length ? [nomeBairro, 'Goiânia'].filter(Boolean).join(' · ') : (nomeBairro ? 'Bairro · Goiânia' : 'Goiânia'));
    const alvo = lote || quadra;
    if (alvo?.geometry) { this.destacar(alvo.geometry); this.alfinete(ponto.lon, ponto.lat); }

    if (lote) {
      const corpo = this.secao('Lote', { aberto: true });
      corpo.append(this.tabela(atributosLegiveis(lote.attributes)));
      const ci = String(lote.attributes.ci || '').trim();
      if (/^\d{6,}$/.test(ci)) {
        const alvoCad = el('div', {});
        corpo.append(el('button', { class: 'botao', onclick: (ev) => { ev.target.remove(); this._cadastro(ci, alvoCad); } },
          'Ver cadastro imobiliário do lote'), alvoCad);
      }
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
        this.tabela(atributosLegiveis(r.attributes))));
    }
    if (resultados.length > 15) corpo.append(el('p', { class: 'nota' }, `Mais ${resultados.length - 15} resultado(s) não exibidos.`));
  }

  async _cadastro(ci, alvo) {
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
        ['Bairro', t(u0.nmbairro)],
        ['Área do terreno', u0.areaterr ? `${fmtNum(u0.areaterr, 2)} m²` : ''],
        ['Área total edificada', u0.areattedif ? `${fmtNum(u0.areattedif, 2)} m²` : ''],
        ['Pavimentos', u0.nrpaviment || ''],
      ].filter(([, v]) => !vazio(v))));
      const linhas = us.slice(0, 200).map((u) => el('tr', {},
        el('td', {}, t(u.nrinscr)), el('td', {}, t(u.incompl) || '—'),
        el('td', { class: 'num' }, u.areaedif ? fmtNum(u.areaedif, 2) : '—'),
        el('td', { class: 'num' }, u.vlvenal ? fmtNum(u.vlvenal, 2) : '—')));
      alvo.append(el('div', { class: 'rolagem' }, el('table', { class: 'unidades' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Inscrição'), el('th', {}, 'Complemento'),
          el('th', { class: 'num' }, 'Área edif. (m²)'), el('th', { class: 'num' }, 'Valor venal (R$)'))),
        el('tbody', {}, linhas))),
      el('p', { class: 'nota' }, `${us.length > 200 ? `Exibidas 200 de ${us.length} inscrições. ` : ''}` +
        'Valor venal conforme a base publicada (o serviço não informa o exercício de referência).'));
    } catch (e) {
      alvo.textContent = '';
      alvo.append(el('p', { class: 'nota erro' }, `Cadastro indisponível: ${e.message}`));
    }
  }

  /** Ficha de um edifício do modelo 3D. */
  edificio(e, mpp) {
    this.fonte.entities.removeAll();
    this.abrir({ titulo: e.n, subtitulo: 'Edifício em altura · Goiânia', ponto: { lon: e.c[0], lat: e.c[1], alt: NaN } });
    this.corpo.append(this.tabela([
      ['Pavimentos', e.p || 'não informado'],
      ['Altura estimada', `${fmtNum(Math.max(e.p, 1) * mpp)} m (${fmtNum(mpp, 1)} m por pavimento)`],
      ['Apartamentos', e.a || '—'],
      ['Área do terreno', e.t ? `${fmtNum(e.t)} m²` : '—'],
      ['Ano de averbação', e.ano || '—'],
      ['Inscrição cadastral (CI)', e.ci || '—'],
    ]), el('button', { class: 'botao', onclick: () => this.emPonto({ lon: e.c[0], lat: e.c[1], alt: NaN }) },
      'Ver lote e cadastro'),
    el('p', { class: 'nota' }, 'Volume esquemático: a base é aproximada a partir do lote e a altura vem do número de pavimentos do cadastro.'));
  }
}
