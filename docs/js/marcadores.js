// Marcadores (os "alfinetes" do Earth), com exportação em KML — o formato do
// Google Earth — e GeoJSON, e importação de KML/KMZ/GeoJSON do usuário.
import { CFG } from './config.js';
import { el, memoria, baixarArquivo, escaparXML, aviso, fmtGraus } from './util.js';

const Cesium = window.Cesium;
const CHAVE = 'bussola:marcadores';

const ALFINETE = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">' +
  '<path d="M15 39C15 39 2 23.5 2 14.5a13 13 0 0 1 26 0C28 23.5 15 39 15 39z" fill="#ffd54a" stroke="#1f2226" stroke-width="2"/>' +
  '<circle cx="15" cy="14.5" r="5" fill="#1f2226"/></svg>');

export class Marcadores {
  constructor(globo, identificar, medir, raiz) {
    Object.assign(this, { globo, identificar, medir, raiz });
    this.lista = memoria.ler(CHAVE, []).filter((m) => Number.isFinite(m.lon) && Number.isFinite(m.lat));
    this.aguardando = false;
    this.importados = [];
    this.fonte = new Cesium.CustomDataSource('marcadores');
    globo.viewer.dataSources.add(this.fonte);
    this._montarPainel();
    this.lista.forEach((m) => this._desenhar(m));
    this._listar();
  }

  _montarPainel() {
    this.ul = el('ul', { class: 'lista-medidas' });
    this.ulImportados = el('ul', { class: 'lista-medidas' });
    this.btnNovo = el('button', { class: 'botao', id: 'marcador-novo', onclick: () => this.pedirPonto() }, 'Novo marcador');
    const arquivo = el('input', { type: 'file', accept: '.kml,.kmz,.geojson,.json', hidden: true,
      onchange: (ev) => { if (ev.target.files[0]) this.importar(ev.target.files[0]); ev.target.value = ''; } });
    this.raiz.append(
      el('div', { class: 'linha-botoes' }, this.btnNovo),
      el('p', { class: 'nota' }, 'Os marcadores ficam salvos neste navegador.'),
      this.ul,
      el('h3', { class: 'subtitulo' }, 'Levar para o Google Earth'),
      el('div', { class: 'linha-botoes' },
        el('button', { class: 'botao', onclick: () => this.exportarKML() }, 'Exportar KML'),
        el('button', { class: 'botao-texto', onclick: () => this.exportarGeoJSON() }, 'GeoJSON')),
      el('p', { class: 'nota' }, 'Inclui marcadores e medições. O KML abre direto no Google Earth.'),
      el('h3', { class: 'subtitulo' }, 'Trazer um arquivo'),
      el('div', { class: 'linha-botoes' }, el('button', { class: 'botao', onclick: () => arquivo.click() }, 'Importar KML, KMZ ou GeoJSON'), arquivo),
      this.ulImportados);
  }

  pedirPonto() {
    this.aguardando = true;
    this.globo.cena.canvas.style.cursor = 'crosshair';
    this.btnNovo.textContent = 'Clique no mapa…';
    aviso('Clique no mapa para posicionar o marcador.');
  }

  cancelarPedido() {
    this.aguardando = false;
    this.globo.cena.canvas.style.cursor = '';
    this.btnNovo.textContent = 'Novo marcador';
  }

  adicionar(ponto, nome) {
    this.cancelarPedido();
    const limpo = nome && !/consultando|local em goiânia/i.test(nome) ? nome : '';
    const m = { id: Date.now(), nome: limpo || `Marcador ${this.lista.length + 1}`, lon: +ponto.lon.toFixed(6), lat: +ponto.lat.toFixed(6) };
    this.lista.push(m);
    this._gravar();
    this._desenhar(m);
    this._listar();
    aviso(`Marcador “${m.nome}” criado.`);
    return m;
  }

  _desenhar(m) {
    const e = this.fonte.entities.add({
      id: `marcador:${m.id}`,
      position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat),
      billboard: { image: ALFINETE, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, width: 30, height: 40,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: m.nome, font: '600 13px system-ui, "Segoe UI", Roboto, sans-serif',
        fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -48),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60000) },
    });
    e.marcador = m;
    this.globo.redesenhar();
  }

  _gravar() { memoria.gravar(CHAVE, this.lista); }

  remover(id) {
    this.lista = this.lista.filter((m) => m.id !== id);
    this.fonte.entities.removeById(`marcador:${id}`);
    this._gravar();
    this._listar();
    this.globo.redesenhar();
  }

  renomear(id, nome) {
    const m = this.lista.find((x) => x.id === id);
    if (!m || !nome.trim()) return;
    m.nome = nome.trim().slice(0, 80);
    const e = this.fonte.entities.getById(`marcador:${id}`);
    if (e) e.label.text = m.nome;
    this._gravar();
    this.globo.redesenhar();
  }

  irPara(m) {
    this.globo.voarPara({ lon: m.lon, lat: m.lat, distancia: 700 });
  }

  /** Trata um clique: devolve true se acertou um marcador. */
  aoClicar(pego) {
    const m = pego?.id?.marcador;
    if (!m) return false;
    this.identificar.fonte.entities.removeAll();
    this.identificar.abrir({ titulo: m.nome, subtitulo: 'Marcador', ponto: { lon: m.lon, lat: m.lat, alt: NaN } });
    this.identificar.corpo.append(el('button', { class: 'botao',
      onclick: () => this.identificar.emPonto({ lon: m.lon, lat: m.lat, alt: NaN }) }, 'Consultar este ponto no Mapa Fácil'));
    return true;
  }

  _listar() {
    this.ul.textContent = '';
    if (!this.lista.length) { this.ul.append(el('li', { class: 'vazio' }, 'Nenhum marcador ainda.')); return; }
    for (const m of this.lista) {
      const nome = el('input', { class: 'campo-nome', value: m.nome, 'aria-label': 'Nome do marcador',
        onchange: (ev) => this.renomear(m.id, ev.target.value) });
      this.ul.append(el('li', {},
        el('div', { class: 'marcador-linha' }, nome, el('small', {}, fmtGraus(m.lat, m.lon))),
        el('button', { class: 'botao-icone', title: 'Ir até o marcador', 'aria-label': 'Ir até o marcador', onclick: () => this.irPara(m) }, '➜'),
        el('button', { class: 'botao-icone', title: 'Apagar', 'aria-label': 'Apagar marcador', onclick: () => this.remover(m.id) }, '×')));
    }
  }

  // ------------------------------------------------------------- exportação
  _temAlgo() {
    if (this.lista.length || this.medir.medidas.length) return true;
    aviso('Crie um marcador ou uma medição antes de exportar.', 'alerta');
    return false;
  }

  kml() {
    const pm = this.lista.map((m) =>
      `<Placemark><name>${escaparXML(m.nome)}</name><styleUrl>#alfinete</styleUrl>` +
      `<Point><coordinates>${m.lon},${m.lat},0</coordinates></Point></Placemark>`);
    const med = this.medir.medidas.map((m) => {
      const coords = (m.tipo === 'area' ? [...m.pontos, m.pontos[0]] : m.pontos).map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},0`).join(' ');
      const geom = m.tipo === 'area'
        ? `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
        : `<LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>`;
      return `<Placemark><name>${escaparXML((m.tipo === 'area' ? 'Área ' : 'Distância ') + m.texto)}</name><styleUrl>#medida</styleUrl>${geom}</Placemark>`;
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
      '<name>Bússola</name><description>Exportado da Bússola (dados: Mapa Fácil, Prefeitura de Goiânia)</description>' +
      '<Style id="alfinete"><IconStyle><color>ff4ad5ff</color><scale>1.1</scale></IconStyle></Style>' +
      '<Style id="medida"><LineStyle><color>ffe1d04d</color><width>3</width></LineStyle><PolyStyle><color>55e1d04d</color></PolyStyle></Style>' +
      `<Folder><name>Marcadores</name>${pm.join('')}</Folder><Folder><name>Medições</name>${med.join('')}</Folder></Document></kml>`;
  }

  geojson() {
    return { type: 'FeatureCollection', features: [
      ...this.lista.map((m) => ({ type: 'Feature', properties: { nome: m.nome, tipo: 'marcador' },
        geometry: { type: 'Point', coordinates: [m.lon, m.lat] } })),
      ...this.medir.medidas.map((m) => ({ type: 'Feature', properties: { nome: m.texto, tipo: m.tipo },
        geometry: m.tipo === 'area'
          ? { type: 'Polygon', coordinates: [[...m.pontos, m.pontos[0]]] }
          : { type: 'LineString', coordinates: m.pontos } })),
    ] };
  }

  exportarKML() {
    if (this._temAlgo()) baixarArquivo('bussola.kml', this.kml(), 'application/vnd.google-earth.kml+xml');
  }

  exportarGeoJSON() {
    if (this._temAlgo()) baixarArquivo('bussola.geojson', JSON.stringify(this.geojson(), null, 2), 'application/geo+json');
  }

  // -------------------------------------------------------------- importação
  async importar(arquivo) {
    const nome = arquivo.name;
    try {
      let fonte;
      if (/\.(kml|kmz)$/i.test(nome)) {
        fonte = await Cesium.KmlDataSource.load(arquivo, {
          camera: this.globo.camera, canvas: this.globo.cena.canvas, clampToGround: true });
      } else {
        fonte = await Cesium.GeoJsonDataSource.load(JSON.parse(await arquivo.text()), {
          clampToGround: true, stroke: Cesium.Color.fromCssColorString(CFG.cores.destaque), strokeWidth: 3,
          fill: Cesium.Color.fromCssColorString(CFG.cores.destaque).withAlpha(0.25), markerColor: Cesium.Color.fromCssColorString(CFG.cores.destaque) });
      }
      fonte.name = nome;
      await this.globo.viewer.dataSources.add(fonte);
      this.importados.push(fonte);
      this._listarImportados();
      this.globo.viewer.flyTo(fonte, { duration: 1.6 }).catch(() => {});
      aviso(`“${nome}” importado (${fonte.entities.values.length} elemento(s)).`);
    } catch (e) {
      console.warn(e);
      aviso(`Não foi possível ler “${nome}”: ${e.message || e}`, 'alerta');
    }
  }

  _listarImportados() {
    this.ulImportados.textContent = '';
    for (const f of this.importados) {
      this.ulImportados.append(el('li', {},
        el('span', {}, f.name),
        el('button', { class: 'botao-icone', title: 'Ir até o arquivo', 'aria-label': 'Ir até o arquivo', onclick: () => this.globo.viewer.flyTo(f).catch(() => {}) }, '➜'),
        el('button', { class: 'botao-icone', title: 'Remover', 'aria-label': 'Remover arquivo', onclick: () => {
          this.globo.viewer.dataSources.remove(f, true);
          this.importados = this.importados.filter((x) => x !== f);
          this._listarImportados();
          this.globo.redesenhar();
        } }, '×')));
    }
  }
}
