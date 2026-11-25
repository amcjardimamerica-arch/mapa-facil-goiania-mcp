// Mapas de eleição (painel Camadas, cidade inteira): Zonas Eleitorais e Regiões do Conselho Tutelar.
//
// Cada mapa tem a sua finalidade: as zonas são do TSE; os 6 Conselhos Tutelares juntam, cada um, duas das 12 Regiões
// da SEPLAM (Resolução CMDCA 85/2023; data/conselho_regioes.geojson, gerado por scripts/regioes_conselho.py).
// As divisas são duas linhas pretas com uma vermelha (#FF0000) no meio — diferentes das divisas de
// bairro (preta, amarela, preta) — e cada área tem uma cor clara própria. Com um desses mapas ligado, o clique
// seleciona a zona/região inteira (ou o colégio de votação), nunca quadra ou lote.
import { CFG } from './config.js';
import { el, pedirJSON, fmtNum } from './util.js';

const Cesium = window.Cesium;
const CORES = ['#8ecae6', '#ffb4a2', '#b5e48c', '#cdb4db', '#ffd6a5', '#a0c4ff', '#caffbf', '#ffc6ff', '#fdffb6', '#bdb2ff'];

function dentro(aneis, x, y) {
  let d = false;
  for (const a of aneis) for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    if ((a[i][1] > y) !== (a[j][1] > y) && x < ((a[j][0] - a[i][0]) * (y - a[i][1])) / (a[j][1] - a[i][1]) + a[i][0]) d = !d;
  }
  return d;
}

export class Eleicoes {
  constructor({ globo, identificar }) {
    Object.assign(this, { globo, identificar });
    this.fonte = new Cesium.CustomDataSource('eleicoes');
    globo.viewer.dataSources.add(this.fonte);
    this.modo = '';          // '' | 'zonas' | 'conselho'
    this.areas = [];         // [{ nome, aneis (lon/lat), cor, info }]
  }

  async _zonas() {
    if (this._cacheZonas) return this._cacheZonas;
    const d = await pedirJSON(`${CFG.ms}/Mapa_Limites/MapServer/10/query`, { parametros: { f: 'json', where: '1=1', outFields: '*', outSR: '4326', returnGeometry: 'true' } });
    this._cacheZonas = (d.features || []).map((f, i) => ({ nome: `Zona ${String(f.attributes.nm_zoe || f.attributes.nm || f.attributes.id).replace(/^zona\s*/i, '')}`,
      aneis: f.geometry.rings, cor: CORES[i % CORES.length], info: f.attributes }));
    return this._cacheZonas;
  }

  async _regioes() {
    if (this._cacheReg) return this._cacheReg;
    const d = await pedirJSON(`${CFG.dados}conselho_regioes.geojson`);
    const aneisDe = (f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).flat();
    // Regiões administrativas da SEPLAM (duas por Conselho): só a divisa interna, tracejada.
    this._subregioes = d.features.filter((f) => f.properties.tipo === 'regiao_administrativa')
      .map((f) => ({ nome: `Região ${f.properties.regiao}`, conselho: f.properties.conselho, aneis: aneisDe(f) }));
    this._cacheReg = d.features.filter((f) => (f.properties.tipo || 'conselho') === 'conselho').map((f, i) => {
      const p = f.properties;
      const km2 = (v) => (v == null ? null : `${String(v).replace('.', ',')} km²`);
      return { nome: `Conselho Tutelar ${p.regiao}`, aneis: aneisDe(f), cor: CORES[(i + 3) % CORES.length], props: p,
        info: { 'Conselho Tutelar': p.regiao, 'Regiões administrativas': (p.regioes_administrativas || []).join(' + '),
          Área: km2(p.area_km2), 'População (Mapa Fácil)': p.populacao, Bairros: p.bairros_n,
          'Locais de votação (2023)': p.locais, Urnas: p.urnas, 'Eleitores aptos (2023)': p.eleitores,
          Sede: p.sede, Telefone: p.telefone, Plantão: p.plantao, Fonte: d.nota } };
    });
    return this._cacheReg;
  }

  /** Liga um dos mapas (ou nenhum). */
  async definir(modo) {
    this.modo = modo;
    this.fonte.entities.removeAll();
    this.areas = modo === 'zonas' ? await this._zonas() : modo === 'conselho' ? await this._regioes() : [];
    if (this.modo !== modo) return;
    for (const a of this.areas) {
      for (const anel of a.aneis) {
        const pos = Cesium.Cartesian3.fromDegreesArray(anel.flat());
        this.fonte.entities.add({ polygon: { hierarchy: pos, material: Cesium.Color.fromCssColorString(a.cor).withAlpha(0.22),
          classificationType: Cesium.ClassificationType.TERRAIN } });
        // Divisa: preta larga por baixo e vermelha no meio = preta, vermelha, preta.
        this.fonte.entities.add({ polyline: { positions: pos, clampToGround: true, width: 7, zIndex: 0, material: Cesium.Color.BLACK } });
        this.fonte.entities.add({ polyline: { positions: pos, clampToGround: true, width: 2.4, zIndex: 1, material: Cesium.Color.fromCssColorString('#FF0000') } });
      }
      const maior = a.aneis.reduce((m, r) => (r.length > m.length ? r : m), a.aneis[0]);
      const c = maior.reduce((s, p) => [s[0] + p[0] / maior.length, s[1] + p[1] / maior.length], [0, 0]);
      this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(c[0], c[1]), label: { text: a.nome,
        font: '800 15px system-ui, "Segoe UI", Roboto, sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.fromCssColorString('#7a0000'),
        outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(1500, 120000) } });
    }
    if (modo === 'conselho') for (const r of this._subregioes || []) for (const anel of r.aneis) {
      this.fonte.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(anel.flat()), clampToGround: true, width: 1.6, zIndex: 2,
        material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE.withAlpha(0.9), dashLength: 14 }) } });
    }
    this.globo.redesenhar();
  }

  /** Clique: seleciona a zona/região inteira. */
  aoClicar(ponto) {
    if (!this.modo || !ponto) return false;
    const a = this.areas.find((x) => dentro(x.aneis, ponto.lon, ponto.lat));
    if (!a) return false;
    const id = this.identificar;
    id.limparDestaque();
    id.abrir({ titulo: a.nome, subtitulo: this.modo === 'zonas' ? 'Zona eleitoral · TSE' : 'Conselho Tutelar · Resolução CMDCA 85/2023', ponto });
    id.destacarLonLat(a.aneis, { fechado: true, cor: Cesium.Color.fromCssColorString(a.cor) });
    id.corpo.append(id.tabela(Object.entries(a.info).filter(([, v]) => v !== null && v !== '' && v !== undefined).map(([k, v]) => [k, typeof v === 'number' ? fmtNum(v) : String(v)])));
    if (this.modo === 'conselho' && a.props) {
      const sub = (this._subregioes || []).find((r) => r.conselho === a.props.regiao && dentro(r.aneis, ponto.lon, ponto.lat));
      if (sub) id.corpo.append(el('p', {}, `Ponto clicado: ${sub.nome} (SEPLAM).`));
      const lista = (titulo, itens) => (itens && itens.length
        ? el('details', { class: 'lv-lista' }, el('summary', {}, `${titulo} (${fmtNum(itens.length)})`), el('p', {}, itens.join('; '))) : null);
      for (const bloco of [lista('Locais de votação de 2023', a.props.locais_votacao), lista('Bairros', a.props.bairros),
        lista('Bairros divididos com outro Conselho', a.props.bairros_divididos), lista('Ajustes ao desenho da SEPLAM', a.props.ajustes)]) if (bloco) id.corpo.append(bloco);
      id.corpo.append(el('p', { class: 'nota' }, 'Delimitação oficial: Resolução CMDCA n.º 85/2023 — cada Conselho atende duas Regiões da SEPLAM (Mapa Fácil). Áreas rurais sem bairro ficam sem cor.'));
    }
    return true;
  }
}
