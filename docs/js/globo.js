// Globo 3D (CesiumJS): fundo de satélite, relevo, máscara de território,
// navegação estilo Earth e os provedores de imagem do Mapa Fácil.
import { CFG } from './config.js';
import { ProvedorMascara, rotularVizinhos } from './territorio.js';

const Cesium = window.Cesium;
const rad = (graus) => (graus * Math.PI) / 180; // sem tocar no Cesium na carga do módulo
const NIVEL_MINIMO = 9;

// ---------------------------------------------------------------- provedores
/** Imagem dinâmica de um MapServer do Mapa Fácil (operação "export"), em blocos. */
export function provedorExport(url, { camadas, formato = 'png32', transparente = true, tamanho = 512,
  retangulo, nivelMinimo = NIVEL_MINIMO, nivelMaximo = 20, credito } = {}) {
  const p = new URLSearchParams({
    bboxSR: '3857', imageSR: '3857', size: `${tamanho},${tamanho}`,
    format: formato, transparent: String(transparente), f: 'image',
  });
  if (camadas) p.set('layers', `show:${camadas.join(',')}`);
  return new Cesium.UrlTemplateImageryProvider({
    url: `${url}/export?bbox={westProjected},{southProjected},{eastProjected},{northProjected}&${p}`,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    tileWidth: tamanho, tileHeight: tamanho,
    rectangle: retangulo, maximumLevel: nivelMaximo, enablePickFeatures: false, credit: credito,
    // Com o retângulo de Goiânia, o nível 9 cabe em 4 blocos: evita pedir ao
    // servidor municipal imagens do mundo inteiro quando a câmera está longe.
    // (As ortofotos em cache exigem nível maior — ver "nivel_minimo" em camadas.json.)
    minimumLevel: retangulo ? nivelMinimo : 0,
  });
}

/**
 * Recolore um bloco da cartografia municipal para leitura sobre satélite:
 * traços e textos escuros viram brancos com halo; preenchimentos claros somem.
 */
export function realcar(img, T) {
  const a = document.createElement('canvas');
  a.width = a.height = T;
  const ga = a.getContext('2d', { willReadFrequently: true });
  ga.drawImage(img, 0, 0, T, T);
  if (img.close) img.close();
  const dados = ga.getImageData(0, 0, T, T);
  const px = dados.data;
  for (let i = 0; i < px.length; i += 4) {
    const alfa = px[i + 3];
    if (alfa < 8) { px[i + 3] = 0; continue; }
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 42) {
      const k = Math.min(1, Math.max(0, (0.93 - lum) / 0.45));
      px[i] = px[i + 1] = px[i + 2] = 255;
      px[i + 3] = alfa * k;
    } else {
      px[i] = r + (255 - r) * 0.55; px[i + 1] = g + (255 - g) * 0.55; px[i + 2] = b + (255 - b) * 0.55;
    }
  }
  ga.putImageData(dados, 0, 0);
  const o = document.createElement('canvas');
  o.width = o.height = T;
  const go = o.getContext('2d');
  go.shadowColor = 'rgba(0,0,0,.95)';
  go.shadowBlur = 2.5;
  go.drawImage(a, 0, 0);
  go.drawImage(a, 0, 0);
  return o;
}

/** Camada "Nomes e divisas": Mapa Básico exportado transparente e realçado. */
export class ProvedorRealce {
  constructor(url, { retangulo, tamanho = 512, credito } = {}) {
    this._url = url; this._ret = retangulo; this._T = tamanho;
    this._grade = new Cesium.WebMercatorTilingScheme();
    this._erro = new Cesium.Event();
    this._credito = credito ? new Cesium.Credit(credito) : undefined;
  }
  get tileWidth() { return this._T; }
  get tileHeight() { return this._T; }
  get minimumLevel() { return this._ret ? NIVEL_MINIMO : 0; }
  get maximumLevel() { return 20; }
  get tilingScheme() { return this._grade; }
  get rectangle() { return this._ret || this._grade.rectangle; }
  get tileDiscardPolicy() { return undefined; }
  get errorEvent() { return this._erro; }
  get credit() { return this._credito; }
  get proxy() { return undefined; }
  get hasAlphaChannel() { return true; }
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(true); }
  getTileCredits() { return undefined; }
  pickFeatures() { return undefined; }
  requestImage(x, y, nivel, request) {
    const r = this._grade.tileXYToNativeRectangle(x, y, nivel);
    const url = `${this._url}/export?bbox=${r.west},${r.south},${r.east},${r.north}` +
      `&bboxSR=3857&imageSR=3857&size=${this._T},${this._T}&format=png32&transparent=true&f=image`;
    const pedido = new Cesium.Resource({ url, request }).fetchImage({ preferImageBitmap: true });
    if (!pedido) return undefined; // limitado pelo agendador do Cesium: ele tenta de novo
    return pedido.then((img) => realcar(img, this._T));
  }
}

function provedorSatelite() {
  const s = CFG.satelite;
  return new Cesium.UrlTemplateImageryProvider({
    url: s.url, maximumLevel: s.nivelMaximo, credit: s.credito, enablePickFeatures: false,
    tileDiscardPolicy: new Cesium.DiscardMissingTileImagePolicy({
      missingImageUrl: s.blocoAusente,
      pixelsToCheck: [new Cesium.Cartesian2(0, 0), new Cesium.Cartesian2(120, 140),
        new Cesium.Cartesian2(130, 130), new Cesium.Cartesian2(200, 200), new Cesium.Cartesian2(255, 255)],
      disableCheckIfAllPixelsAreTransparent: true,
    }),
  });
}

/** Satélite do Google (Map Tiles API) — só quando CFG.googleMapsApiKey está preenchida. */
async function provedorGoogle() {
  const chave = CFG.googleMapsApiKey;
  const resp = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(chave)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'satellite', language: 'pt-BR', region: 'BR' }),
  });
  if (!resp.ok) throw new Error(`Google Map Tiles: HTTP ${resp.status}`);
  const { session } = await resp.json();
  return new Cesium.UrlTemplateImageryProvider({
    url: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${encodeURIComponent(chave)}`,
    maximumLevel: 21, credit: 'Imagem de satélite: Google', enablePickFeatures: false,
  });
}

// --------------------------------------------------------------------- globo
export class Globo {
  constructor(territorio, catalogo) {
    this.territorio = territorio;
    this.catalogo = catalogo;
    this.ret = territorio.retangulo(0.02);
    const [o, s, l, n] = territorio.bbox;
    this.centro = [(o + l) / 2, (s + n) / 2];

    Cesium.Ion.defaultAccessToken = ''; // nada do Cesium ion é usado
    // No máximo 4 imagens simultâneas no servidor municipal: não o sobrecarrega e
    // deixa conexões livres para as consultas de clique e de busca.
    Cesium.RequestScheduler.requestsByServer[`${new URL(CFG.rest).host}:443`] = 4;
    const viewer = new Cesium.Viewer('globo', {
      baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
      sceneModePicker: false, navigationHelpButton: false, animation: false, timeline: false,
      fullscreenButton: false, infoBox: false, selectionIndicator: false, scene3DOnly: true,
      requestRenderMode: true, maximumRenderTimeChange: Infinity,
      creditContainer: document.getElementById('creditos-cesium'),
      contextOptions: { webgl: { preserveDrawingBuffer: true } }, // permite "Salvar imagem"
    });
    this.viewer = viewer;
    const cena = viewer.scene;
    cena.globe.baseColor = Cesium.Color.fromCssColorString(CFG.cores.fora);
    cena.globe.depthTestAgainstTerrain = true;
    cena.globe.enableLighting = false;
    cena.globe.showGroundAtmosphere = false;
    cena.fog.enabled = true;
    cena.highDynamicRange = false;
    cena.screenSpaceCameraController.minimumZoomDistance = CFG.camera.distanciaMinima;
    cena.screenSpaceCameraController.maximumZoomDistance = 3e7;
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    // Luz fixa vinda do noroeste, 50° acima do horizonte: sombreamento estável dos edifícios.
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(...this.centro));
    const az = rad(315), elev = rad(50);
    const doSol = new Cesium.Cartesian3(Math.sin(az) * Math.cos(elev), Math.cos(az) * Math.cos(elev), Math.sin(elev));
    const dir = Cesium.Matrix4.multiplyByPointAsVector(enu, doSol, new Cesium.Cartesian3());
    cena.light = new Cesium.DirectionalLight({
      direction: Cesium.Cartesian3.negate(Cesium.Cartesian3.normalize(dir, dir), new Cesium.Cartesian3()),
      intensity: 2.2,
    });

    // Pilha de imagens (de baixo para cima): base A, base B (comparação),
    // temas do Mapa Fácil, nomes e divisas, máscara de território.
    this.camadaBase = null;
    this.camadaBaseB = null;
    this.chaveBase = null;
    this.chaveBaseB = null;
    this.camadaRealce = null;
    this.camadaMascara = viewer.imageryLayers.addImageryProvider(new ProvedorMascara(territorio));
    this.rotulos = rotularVizinhos(viewer, territorio);

    this.relevoAtivo = false;
    this.provedorRelevo = null;
    this._aoMudarRelevo = [];

    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(this.centro[0], this.centro[1], 1.25e7) });
    viewer.camera.moveEnd.addEventListener(() => this._conterCamera());
  }

  get cena() { return this.viewer.scene; }
  get camera() { return this.viewer.camera; }
  redesenhar() { this.cena.requestRender(); }

  // ------------------------------------------------------------------- bases
  basesDisponiveis() {
    const lista = [{ chave: 'satelite', titulo: 'Satélite (atual)', curto: 'Atual', ano: null, tipo: 'satelite' }];
    for (const b of this.catalogo.bases) {
      lista.push(b.ano
        ? { ...b, curto: String(b.ano), tipo: 'orto' }
        : { ...b, curto: 'Mapa', tipo: 'mapa' });
    }
    return lista;
  }

  async _provedorBase(chave) {
    if (chave === 'satelite') {
      if (CFG.googleMapsApiKey) {
        try { return await provedorGoogle(); } catch (e) { console.warn('Google indisponível, usando Esri:', e); }
      }
      return provedorSatelite();
    }
    const b = this.catalogo.bases.find((x) => x.chave === chave);
    if (!b) throw new Error(`base desconhecida: ${chave}`);
    return provedorExport(b.url, {
      formato: 'jpg', transparente: false, retangulo: this.ret, nivelMaximo: 21,
      nivelMinimo: Math.max(NIVEL_MINIMO, b.nivel_minimo || NIVEL_MINIMO),
      credito: `${b.titulo}: Prefeitura de Goiânia`,
      // No serviço de 2011 a camada 2 é a ortofoto de 2011 (a 1 é a de 2006).
      camadas: chave === 'orto2011' ? [2] : undefined,
    });
  }

  async definirBase(chave) {
    const provedor = await this._provedorBase(chave);
    const nova = new Cesium.ImageryLayer(provedor, { rectangle: this.ret });
    const camadas = this.viewer.imageryLayers;
    camadas.add(nova, 0);
    if (this.camadaBase) camadas.remove(this.camadaBase, true);
    this.camadaBase = nova;
    this.chaveBase = chave;
    this._aplicarDivisao();
    this.redesenhar();
  }

  /** Comparação lado a lado: chave da base da direita, ou null para desligar. */
  async definirComparacao(chave) {
    const camadas = this.viewer.imageryLayers;
    if (this.camadaBaseB) { camadas.remove(this.camadaBaseB, true); this.camadaBaseB = null; }
    this.chaveBaseB = chave || null;
    if (chave) {
      const provedor = await this._provedorBase(chave);
      this.camadaBaseB = new Cesium.ImageryLayer(provedor, { rectangle: this.ret });
      camadas.add(this.camadaBaseB, 1);
    }
    this._aplicarDivisao();
    this.redesenhar();
  }

  _aplicarDivisao() {
    const D = Cesium.SplitDirection;
    if (this.camadaBase) this.camadaBase.splitDirection = this.camadaBaseB ? D.LEFT : D.NONE;
    if (this.camadaBaseB) this.camadaBaseB.splitDirection = D.RIGHT;
  }

  definirDivisor(fracao) { this.cena.splitPosition = fracao; this.redesenhar(); }

  /** Liga/desliga "Nomes e divisas" (cartografia municipal realçada sobre o satélite). */
  definirRealce(ligado, opacidade = 1) {
    const camadas = this.viewer.imageryLayers;
    const h = this.catalogo.hibrido;
    if (ligado && !this.camadaRealce && h) {
      this.camadaRealce = new Cesium.ImageryLayer(
        new ProvedorRealce(h.url, { retangulo: this.ret, credito: 'Cartografia: Prefeitura de Goiânia' }),
        // Só entra de perto (a ~20 km do chão): na vista da cidade inteira os nomes viram ruído.
        { rectangle: this.ret, minimumTerrainLevel: 11 });
      camadas.add(this.camadaRealce);
      this.organizarPilha();
    } else if (!ligado && this.camadaRealce) {
      camadas.remove(this.camadaRealce, true);
      this.camadaRealce = null;
    }
    if (this.camadaRealce) this.camadaRealce.alpha = opacidade;
    this.redesenhar();
  }

  /** Mantém "nomes e divisas" e a máscara sempre por cima dos temas. */
  organizarPilha() {
    const camadas = this.viewer.imageryLayers;
    if (this.camadaRealce) camadas.raiseToTop(this.camadaRealce);
    camadas.raiseToTop(this.camadaMascara);
  }

  /** Adiciona a camada de um tema acima das bases e abaixo dos rótulos/máscara. */
  adicionarTema(provedor, opacidade = 1) {
    const camada = new Cesium.ImageryLayer(provedor, { rectangle: this.ret, alpha: opacidade });
    this.viewer.imageryLayers.add(camada);
    this.organizarPilha();
    this.redesenhar();
    return camada;
  }

  removerTema(camada) {
    if (camada) this.viewer.imageryLayers.remove(camada, true);
    this.redesenhar();
  }

  // ------------------------------------------------------------------ relevo
  aoMudarRelevo(fn) { this._aoMudarRelevo.push(fn); }

  async definirRelevo(ligado) {
    try {
      if (ligado && !this.provedorRelevo) {
        this.provedorRelevo = await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(CFG.relevo.url);
      }
      this.viewer.terrainProvider = ligado ? this.provedorRelevo : new Cesium.EllipsoidTerrainProvider();
      this.relevoAtivo = !!ligado;
    } catch (e) {
      console.warn('Relevo indisponível:', e);
      this.viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      this.relevoAtivo = false;
      throw e;
    } finally {
      this._aoMudarRelevo.forEach((fn) => fn(this.relevoAtivo));
      this.redesenhar();
    }
  }

  definirExagero(fator) {
    this.cena.verticalExaggeration = fator;
    this._aoMudarRelevo.forEach((fn) => fn(this.relevoAtivo));
    this.redesenhar();
  }

  /** Altitude do terreno (m) para uma lista de [lon,lat]; zeros se o relevo estiver desligado. */
  async altitudes(pontos) {
    if (!this.relevoAtivo || !this.provedorRelevo) return pontos.map(() => 0);
    const cartos = pontos.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat));
    for (const nivel of [CFG.relevo.nivelAmostra, CFG.relevo.nivelAmostra - 2]) {
      try {
        const res = await Cesium.sampleTerrain(this.provedorRelevo, nivel, cartos);
        return res.map((c) => (Number.isFinite(c.height) ? c.height : 0));
      } catch (e) { console.warn(`Amostragem do relevo (nível ${nivel}) falhou:`, e); }
    }
    return pontos.map(() => 0);
  }

  // ------------------------------------------------------------------ câmera
  /** Ponto do terreno numa posição da tela → {lon, lat, alt, cartesiano} ou null. */
  pontoNaTela(posicao) {
    const raio = this.camera.getPickRay(posicao);
    const c = (raio && this.cena.globe.pick(raio, this.cena)) || this.camera.pickEllipsoid(posicao);
    if (!c) return null;
    const g = Cesium.Cartographic.fromCartesian(c);
    return { lon: Cesium.Math.toDegrees(g.longitude), lat: Cesium.Math.toDegrees(g.latitude), alt: g.height, cartesiano: c };
  }

  centroDaTela() {
    const tela = this.cena.canvas;
    return this.pontoNaTela(new Cesium.Cartesian2(tela.clientWidth / 2, tela.clientHeight / 2));
  }

  /** Metros por pixel no centro da tela (para a escala do mapa). */
  metrosPorPixel() {
    const alvo = this.centroDaTela();
    if (!alvo) return null;
    const dist = Cesium.Cartesian3.distance(this.camera.positionWC, alvo.cartesiano);
    const tela = this.cena.canvas;
    const fovy = this.camera.frustum.fovy || (this.camera.frustum.fov / Math.max(1, tela.clientWidth / tela.clientHeight));
    return (2 * dist * Math.tan(fovy / 2)) / tela.clientHeight;
  }

  /** Denominador da escala aproximada (1:N) a 96 dpi, como o servidor de mapas calcula. */
  escala() {
    const mpp = this.metrosPorPixel();
    return mpp ? (mpp * 96) / 0.0254 : null;
  }

  irParaInicio(duracao = 2.2) {
    const v = CFG.visaoInicial;
    const alvo = Cesium.Cartesian3.fromDegrees(this.centro[0], this.centro[1], 760);
    return new Promise((ok) => this.camera.flyToBoundingSphere(new Cesium.BoundingSphere(alvo, 1), {
      offset: new Cesium.HeadingPitchRange(rad(v.rumo), rad(v.inclinacao), v.distancia),
      duration: duracao, complete: ok, cancel: ok,
    }));
  }

  /** Voa até um ponto ou extensão, mantendo o rumo atual. */
  voarPara({ lon, lat, extensao, distancia, inclinacao = -50, duracao = 1.8 }) {
    let alvo, alcance = distancia;
    if (extensao) {
      const [o, s, l, n] = extensao;
      lon = (o + l) / 2; lat = (s + n) / 2;
      const diag = Cesium.Cartesian3.distance(Cesium.Cartesian3.fromDegrees(o, s), Cesium.Cartesian3.fromDegrees(l, n));
      alcance = alcance || Math.max(350, diag * 1.5);
    }
    const alt = this.cena.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat)) || 760;
    alvo = Cesium.Cartesian3.fromDegrees(lon, lat, alt * this.cena.verticalExaggeration);
    return new Promise((ok) => this.camera.flyToBoundingSphere(new Cesium.BoundingSphere(alvo, 1), {
      offset: new Cesium.HeadingPitchRange(this.camera.heading, rad(inclinacao), alcance || 900),
      duration: duracao, complete: ok, cancel: ok,
    }));
  }

  /** Gira/inclina em torno do centro da tela. */
  orbitar({ rumo, inclinacao, dRumo = 0, dInclinacao = 0, fator = 1 }) {
    const alvo = this.centroDaTela();
    if (!alvo) return;
    const dist = Cesium.Cartesian3.distance(this.camera.positionWC, alvo.cartesiano) * fator;
    const h = rumo !== undefined ? rumo : this.camera.heading + dRumo;
    let p = inclinacao !== undefined ? inclinacao : this.camera.pitch + dInclinacao;
    p = Math.max(-Math.PI / 2, Math.min(rad(-8), p));
    const max = CFG.camera.distanciaMaxima * 1.3;
    this.camera.flyToBoundingSphere(new Cesium.BoundingSphere(alvo.cartesiano, 1), {
      offset: new Cesium.HeadingPitchRange(h, p, Math.max(CFG.camera.distanciaMinima * 2, Math.min(max, dist))),
      duration: 0.45,
    });
  }

  liberarLimites() { this.cena.screenSpaceCameraController.maximumZoomDistance = CFG.camera.distanciaMaxima; }

  _conterCamera() {
    // Mantém a navegação em Goiânia: se o usuário se afastar demais, volta ao início.
    if (this.cena.screenSpaceCameraController.maximumZoomDistance > CFG.camera.distanciaMaxima) return;
    const alvo = this.centroDaTela();
    const [o, s, l, n] = this.territorio.bbox, f = CFG.camera.folgaGraus;
    if (!alvo || alvo.lon < o - f || alvo.lon > l + f || alvo.lat < s - f || alvo.lat > n + f) this.irParaInicio(1.4);
  }

  /** Estado da câmera para o link de compartilhamento. */
  visao() {
    const g = this.camera.positionCartographic;
    return [Cesium.Math.toDegrees(g.longitude).toFixed(5), Cesium.Math.toDegrees(g.latitude).toFixed(5),
      Math.round(g.height), Math.round(Cesium.Math.toDegrees(this.camera.heading)) % 360,
      Math.round(Cesium.Math.toDegrees(this.camera.pitch))].join(',');
  }

  aplicarVisao(texto) {
    const [lon, lat, alt, rumo, incl] = String(texto).split(',').map(Number);
    if (![lon, lat, alt].every(Number.isFinite)) return false;
    this.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, Math.min(alt, CFG.camera.distanciaMaxima)),
      orientation: { heading: rad(rumo || 0), pitch: rad(Number.isFinite(incl) ? incl : -90), roll: 0 },
    });
    return true;
  }

  /** PNG da vista atual. */
  capturar() {
    this.cena.render();
    return new Promise((ok) => this.cena.canvas.toBlob(ok, 'image/png'));
  }
}
