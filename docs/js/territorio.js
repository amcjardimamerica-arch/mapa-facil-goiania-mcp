// Território: Goiânia em destaque, limítrofes em cinza e o resto do globo neutro.
//
// A máscara é uma camada de imagem desenhada em <canvas>, bloco a bloco, a
// partir do contorno oficial. Por ser a última camada do globo ela cobre o
// satélite E qualquer tema do Mapa Fácil fora de Goiânia, em qualquer zoom,
// com borda sempre nítida e sem depender de rede.
import { CFG } from './config.js';
import { mercX, mercY, pontoNaGeometria } from './util.js';

const Cesium = window.Cesium;

function projetar(geom) {
  // GeoJSON Polygon/MultiPolygon -> lista de polígonos; cada um é uma lista de
  // anéis em Float64Array [x0,y0,x1,y1…] (Web Mercator) + caixa envolvente.
  const polis = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polis.map((aneis) => {
    let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
    const proj = aneis.map((anel) => {
      const v = new Float64Array(anel.length * 2);
      anel.forEach(([lon, lat], i) => {
        const x = mercX(lon), y = mercY(lat);
        v[2 * i] = x; v[2 * i + 1] = y;
        if (x < o) o = x; if (x > l) l = x; if (y < s) s = y; if (y > n) n = y;
      });
      return v;
    });
    return { aneis: proj, caixa: [o, s, l, n] };
  });
}

export class Territorio {
  constructor(geojson) {
    this.bbox = geojson.bbox; // [O,S,L,N] de Goiânia em graus
    this.goiania = null;
    this.vizinhos = [];
    for (const f of geojson.features) {
      const item = { ...f.properties, geometria: f.geometry, poligonos: projetar(f.geometry) };
      if (f.properties.tipo === 'goiania') this.goiania = item; else this.vizinhos.push(item);
    }
    if (!this.goiania) throw new Error('territorio.geojson sem o município de Goiânia');
    const todas = [this.goiania, ...this.vizinhos].flatMap((m) => m.poligonos.map((p) => p.caixa));
    this.caixaTotal = [
      Math.min(...todas.map((c) => c[0])), Math.min(...todas.map((c) => c[1])),
      Math.max(...todas.map((c) => c[2])), Math.max(...todas.map((c) => c[3])),
    ];
  }

  /** O ponto está dentro de Goiânia? */
  contem(lon, lat) {
    const [o, s, l, n] = this.bbox;
    return lon >= o && lon <= l && lat >= s && lat <= n && pontoNaGeometria(lon, lat, this.goiania.geometria);
  }

  /** Nome do município no ponto: Goiânia, um limítrofe ou null (fora da área mapeada). */
  municipioEm(lon, lat) {
    if (this.contem(lon, lat)) return this.goiania;
    return this.vizinhos.find((v) => pontoNaGeometria(lon, lat, v.geometria)) || null;
  }

  /** Retângulo Cesium de Goiânia com folga (limita o que as camadas pedem à rede). */
  retangulo(folga = 0.02) {
    const [o, s, l, n] = this.bbox;
    return Cesium.Rectangle.fromDegrees(o - folga, s - folga, l + folga, n + folga);
  }
}

const cruza = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Provedor de imagem que desenha a máscara cinza (interface ImageryProvider do Cesium). */
export class ProvedorMascara {
  constructor(territorio, cores = CFG.cores) {
    this._t = territorio;
    this._cores = cores;
    this._grade = new Cesium.WebMercatorTilingScheme();
    this._erro = new Cesium.Event();
    this._liso = null; // bloco totalmente "fora", reaproveitado
  }
  get tileWidth() { return 256; }
  get tileHeight() { return 256; }
  get minimumLevel() { return 0; }
  get maximumLevel() { return 21; }
  get tilingScheme() { return this._grade; }
  get rectangle() { return this._grade.rectangle; }
  get tileDiscardPolicy() { return undefined; }
  get errorEvent() { return this._erro; }
  get credit() { return undefined; }
  get proxy() { return undefined; }
  get hasAlphaChannel() { return true; }
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(true); }
  getTileCredits() { return undefined; }
  pickFeatures() { return undefined; }

  requestImage(x, y, nivel) {
    return Promise.resolve(this.desenhar(x, y, nivel));
  }

  desenhar(x, y, nivel) {
    const r = this._grade.tileXYToNativeRectangle(x, y, nivel);
    const caixa = [r.west, r.south, r.east, r.north];
    const T = 256, c = this._cores;
    if (!cruza(caixa, this._t.caixaTotal)) {
      if (!this._liso) {
        this._liso = document.createElement('canvas');
        this._liso.width = this._liso.height = T;
        const g = this._liso.getContext('2d');
        g.fillStyle = c.fora; g.fillRect(0, 0, T, T);
      }
      return this._liso;
    }
    const tela = document.createElement('canvas');
    tela.width = tela.height = T;
    const g = tela.getContext('2d');
    const ex = T / (r.east - r.west), ey = T / (r.north - r.south);
    const caminho = (poligonos) => {
      g.beginPath();
      for (const p of poligonos) {
        if (!cruza(caixa, p.caixa)) continue;
        for (const v of p.aneis) {
          g.moveTo((v[0] - r.west) * ex, (r.north - v[1]) * ey);
          for (let i = 2; i < v.length; i += 2) g.lineTo((v[i] - r.west) * ex, (r.north - v[i + 1]) * ey);
          g.closePath();
        }
      }
    };
    g.fillStyle = c.fora;
    g.fillRect(0, 0, T, T);
    g.lineJoin = 'round';
    for (const viz of this._t.vizinhos) {
      caminho(viz.poligonos);
      g.fillStyle = c.vizinho; g.fill('evenodd');
      g.strokeStyle = c.divisaVizinho; g.lineWidth = 1.2; g.stroke();
    }
    // Goiânia: recorta a janela e desenha a divisa com contorno escuro por baixo.
    caminho(this._t.goiania.poligonos);
    g.globalCompositeOperation = 'destination-out';
    g.fill('evenodd');
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 5; g.stroke();
    g.strokeStyle = c.contorno; g.lineWidth = 2; g.stroke();
    return tela;
  }
}

/** Nomes dos municípios limítrofes (só a indicação do território, sem dados). */
export function rotularVizinhos(viewer, territorio) {
  const fonte = new Cesium.CustomDataSource('vizinhos');
  for (const v of territorio.vizinhos) {
    fonte.entities.add({
      id: `vizinho:${v.nome}`,
      position: Cesium.Cartesian3.fromDegrees(v.rotulo[0], v.rotulo[1]),
      label: {
        text: v.nome.toUpperCase(),
        font: '600 12px system-ui, "Segoe UI", Roboto, sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#e3e6ea'),
        outlineColor: Cesium.Color.fromCssColorString('#2a2d31'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(9000, 420000),
        scaleByDistance: new Cesium.NearFarScalar(30000, 1.15, 300000, 0.8),
      },
    });
  }
  viewer.dataSources.add(fonte);
  return fonte;
}
