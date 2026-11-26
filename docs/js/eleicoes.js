// Mapas de eleição (painel Camadas, cidade inteira): Zonas Eleitorais e Regiões do Conselho Tutelar.
//
// Cada mapa tem a sua finalidade: as zonas são do TSE; os 6 Conselhos Tutelares juntam, cada um, duas das 12 Regiões
// da SEPLAM (Resolução CMDCA 85/2023; data/conselho_regioes.geojson, gerado por scripts/regioes_conselho.py e levado
// até o limite do município por scripts/conselho_ate_limite.py). Dentro de cada Conselho não há divisa desenhada.
// As divisas são duas linhas pretas com uma vermelha (#FF0000) no meio, as três da mesma largura (1.26.0) — diferentes das divisas de
// bairro (preta, amarela, preta) — e cada área tem uma cor clara própria. Com um desses mapas ligado, o clique
// seleciona a zona/região inteira (ou o colégio de votação), nunca quadra ou lote.
import { CFG } from './config.js';
import { el, pedirJSON, fmtNum } from './util.js';
import { ProvedorDesenho } from './mapavetorial.js';

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
    this._cacheZonas = (d.features || []).map((f, i) => ({ nome: ((z) => (/zona/i.test(z) ? z.replace(/^zona\s*/i, '').trim() : `Zona ${z}`))(String(f.attributes.nm_zoe || f.attributes.nm || f.attributes.id)),
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
      const poligonos = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      return { nome: `Conselho Tutelar ${p.regiao}`, aneis: aneisDe(f), poligonos, cor: CORES[(i + 3) % CORES.length], props: p,
        info: { 'Conselho Tutelar': p.regiao, 'Regiões administrativas': (p.regioes_administrativas || []).join(' + '),
          Área: km2(p.area_km2), 'População (Mapa Fácil)': p.populacao, Bairros: p.bairros_n,
          'Locais de votação (2023)': p.locais, Urnas: p.urnas, 'Eleitores aptos (2023)': p.eleitores,
          'Divisas nas áreas sem bairro': (p.referencias_divisa || []).join('; ') || null,
          Sede: p.sede, Telefone: p.telefone, Plantão: p.plantao, Fonte: d.nota } };
    });
    return this._cacheReg;
  }

  /** Liga um dos mapas (ou nenhum). */
  async definir(modo) {
    this.modo = modo;
    this.fonte.entities.removeAll();
    if (this.camada) { this.globo.viewer.imageryLayers.remove(this.camada, true); this.camada = null; this.globo.camadaEleicao = null; }
    this.areas = modo === 'zonas' ? await this._zonas() : modo === 'conselho' ? await this._regioes() : [];
    if (this.modo !== modo) return;
    // Cor de cada área e divisa preta-vermelha-preta desenhadas numa camada de imagem, como a divisa dos bairros no
    // mapa: não somem com a distância nem com o relevo (linhas grudadas no chão sumiam em parte das vistas).
    const R = 6378137, mx = (lon) => (lon * Math.PI / 180) * R, my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
    const poligonos = [], divisas = [];
    for (const a of this.areas) {
      const aneis = a.aneis.map((r) => r.map(([lo, la]) => [mx(lo), my(la)]));
      let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
      for (const r of aneis) for (const [x, y] of r) { o = Math.min(o, x); l = Math.max(l, x); s = Math.min(s, y); n = Math.max(n, y); }
      const cor = Cesium.Color.fromCssColorString(a.cor).withAlpha(0.24).toCssColorString();
      poligonos.push({ aneis, ext: [o, s, l, n], centro: [(o + l) / 2, (s + n) / 2], cor, borda: 'rgba(0,0,0,0)', largura: 0.01 });
      for (const r of aneis) divisas.push({ pontos: r });
    }
    this.camada = this.globo.viewer.imageryLayers.addImageryProvider(new ProvedorDesenho({ poligonos, divisas, retangulo: this.globo.ret, nivelMinimo: 8,
      credito: modo === 'zonas' ? 'Zonas eleitorais: TSE' : 'Conselho Tutelar: Resolução CMDCA 85/2023' }));
    this.globo.camadaEleicao = this.camada;
    this.globo.organizarPilha();
    for (const a of this.areas) {
      const maior = a.aneis.reduce((m, r) => (r.length > m.length ? r : m), a.aneis[0]);
      const c = a.props?.rotulo || maior.reduce((s, p) => [s[0] + p[0] / maior.length, s[1] + p[1] / maior.length], [0, 0]);
      this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(c[0], c[1]), label: { text: a.nome,
        font: '800 15px system-ui, "Segoe UI", Roboto, sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.fromCssColorString('#7a0000'),
        outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(1500, 120000) } });
    }
    // As 12 Regiões da SEPLAM não são desenhadas: dentro de cada Conselho não há divisa (só a ficha diz a Região).
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
      // Divisas com cada Conselho vizinho e as ruas, avenidas, rodovias e rios que elas seguem (scripts/conselho_divisas.py).
      pedirJSON(`${CFG.dados}conselho_divisas.json`).then((dv) => {
        const meus = (dv.divisas || []).filter((x) => x.conselhos.includes(a.props.regiao));
        if (!meus.length) return;
        const caixa = el('details', { class: 'lv-lista', open: true }, el('summary', {}, `Divisas com os Conselhos vizinhos (${meus.length})`));
        for (const x of meus) {
          const outro = x.conselhos.find((c) => c !== a.props.regiao);
          caixa.append(el('p', {}, el('strong', {}, `${outro} — ${fmtNum(Math.round(x.extensao_m / 100) / 10, 1)} km: `),
            x.referencias.slice(0, 12).map((r) => r.nome).join('; ') || 'divisas de bairro'));
        }
        id.corpo.append(caixa);
      }).catch(() => {});
      id.corpo.append(el('p', { class: 'nota' }, 'Delimitação oficial: Resolução CMDCA n.º 85/2023 — cada Conselho atende duas Regiões da SEPLAM. As áreas do município sem bairro vão até o limite de Goiânia, com divisas por rodovias, avenidas, estradas e cursos d\'água.'));
    }
    return true;
  }
}
