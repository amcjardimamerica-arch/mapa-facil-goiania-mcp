// Globo 3D (CesiumJS): fundo de satélite, relevo, máscara de território,
// navegação estilo Earth e os provedores de imagem do Mapa Fácil.
import { CFG } from './config.js';
import { ProvedorMascara, rotularVizinhos } from './territorio.js';
import { ProvedorVetorial } from './mapavetorial.js';
import { imagemLocal } from './banco.js';

const Cesium = window.Cesium;
const rad = (graus) => (graus * Math.PI) / 180; // sem tocar no Cesium na carga do módulo
const NIVEL_MINIMO = 9;

// ---------------------------------------------------------------- provedores
/** Imagem dinâmica de um MapServer do Mapa Fácil (operação "export"), em blocos. */
/** Provedor vazio: nada é pedido a lugar nenhum (o sistema não consulta mais o servidor da Prefeitura). */
class ProvedorVazio {
  constructor(retangulo) { this._g = new Cesium.WebMercatorTilingScheme(); this._r = retangulo; this._e = new Cesium.Event(); }
  get tileWidth() { return 256; } get tileHeight() { return 256; } get minimumLevel() { return 0; } get maximumLevel() { return 21; }
  get tilingScheme() { return this._g; } get rectangle() { return this._r || this._g.rectangle; } get tileDiscardPolicy() { return undefined; }
  get errorEvent() { return this._e; } get credit() { return undefined; } get proxy() { return undefined; } get hasAlphaChannel() { return true; }
  get ready() { return true; } get readyPromise() { return Promise.resolve(true); }
  getTileCredits() { return undefined; } pickFeatures() { return undefined; }
  requestImage() { const c = document.createElement('canvas'); c.width = c.height = 1; return Promise.resolve(c); }
}

export function provedorExport(url, opcoes = {}) {
  // Desligado do Mapa Fácil: nenhuma imagem é pedida ao servidor municipal.
  if (CFG.bancoSoLocal && /portalmapa\.goiania/.test(url)) return new ProvedorVazio(opcoes.retangulo);
  return provedorExportServidor(url, opcoes);
}

function provedorExportServidor(url, { camadas, formato = 'png32', transparente = true, tamanho = 512,
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
    const lista = [
      { chave: 'satelite', titulo: 'Satélite', curto: 'Satélite', ano: null, tipo: 'satelite' },
      { chave: 'mapa', titulo: 'Mapa', curto: 'Mapa', ano: null, tipo: 'vetor' },
    ];
    // As ortofotos antigas (2006, 2011, 2016) ficam de fora: o fundo é o satélite ou o mapa.
    for (const b of this.catalogo.bases) if (!b.ano && (!CFG.bancoSoLocal || imagemLocal(b.url.split('/MapServer')[0].split('/').pop()))) lista.push({ ...b, titulo: 'Mapa Básico da Prefeitura', curto: 'Básico', tipo: 'mapa' });
    // Datas anteriores do satélite (Esri World Imagery Wayback), da mais nova para a mais antiga.
    for (const v of [...(this.catalogo.satelite || [])].reverse()) {
      const quando = new Date(`${v.captura}T12:00:00Z`);
      const mes = quando.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      lista.push({ chave: `sat-${v.captura}`, titulo: `Satélite de ${mes}`, curto: `Sat. ${v.captura.slice(0, 4)}`,
        ano: null, tipo: 'historico', url: v.url, fonte: v.fonte, resolucao: v.resolucao_m,
        nivelMaximo: v.nivel_maximo || 17, captura: v.captura });
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
    if (chave === 'mapa') {
      return new ProvedorVetorial({ modo: 'mapa', bairros: this.catalogo.bairros || [], retangulo: this.ret, territorio: this.territorio });
    }
    if (chave.startsWith('sat-')) {
      const v = this.basesDisponiveis().find((x) => x.chave === chave);
      if (!v) throw new Error(`data de satélite desconhecida: ${chave}`);
      return new Cesium.UrlTemplateImageryProvider({
        url: v.url, maximumLevel: v.nivelMaximo, enablePickFeatures: false,
        credit: `Satélite de ${v.captura}: Esri World Imagery Wayback${v.fonte ? `, ${v.fonte}` : ''}`,
      });
    }
    const b = this.catalogo.bases.find((x) => x.chave === chave && !x.ano);
    if (!b) throw new Error(`base desconhecida: ${chave}`);
    const local = imagemLocal(b.url.split('/MapServer')[0].split('/').pop());
    if (local) return local;
    return provedorExport(b.url, {
      formato: 'jpg', transparente: false, retangulo: this.ret, nivelMaximo: 21,
      nivelMinimo: Math.max(NIVEL_MINIMO, b.nivel_minimo || NIVEL_MINIMO),
      credito: `${b.titulo}: Prefeitura de Goiânia`,
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

  /**
   * Liga/desliga "Ruas e quadras" sobre o satélite: nomes de rua e de bairro, eixos
   * viários e divisas de quadra, desenhados a partir dos dados vetoriais (sem lotes).
   */
  definirRealce(ligado, opacidade = 1) {
    const camadas = this.viewer.imageryLayers;
    if (ligado && !this.camadaRealce) {
      this.camadaRealce = new Cesium.ImageryLayer(
        new ProvedorVetorial({ modo: 'sobre', bairros: this.catalogo.bairros || [], retangulo: this.ret, territorio: this.territorio }),
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
    if (this.camadaQuadras) camadas.raiseToTop(this.camadaQuadras); // número das quadras por cima de lotes e temas
    camadas.raiseToTop(this.camadaMascara);
  }

  /** Camada dos números de quadra (marcadores), refeita quando a altura de exibição muda de faixa. */
  definirQuadras(provedor) {
    const camadas = this.viewer.imageryLayers;
    if (this.camadaQuadras) camadas.remove(this.camadaQuadras, true);
    this.camadaQuadras = provedor ? camadas.addImageryProvider(provedor) : null;
    this.organizarPilha();
    this.redesenhar();
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
    this._chegando = false; // interrompe a animação de chegada
    const v = CFG.visaoInicial;
    const alvo = Cesium.Cartesian3.fromDegrees(this.centro[0], this.centro[1], 760);
    return new Promise((ok) => this.camera.flyToBoundingSphere(new Cesium.BoundingSphere(alvo, 1), {
      offset: new Cesium.HeadingPitchRange(rad(v.rumo), rad(v.inclinacao), v.distancia),
      duration: duracao, complete: ok, cancel: ok,
    }));
  }

  /**
   * Chegada ao abrir: começa olhando o mapa de cima, bem alto sobre Goiânia, e desce girando 180° até perto
   * da cidade (aproximação grande).
   */
  chegada(duracao = 6) {
    // Começa bem alto, olhando de cima, e desce girando meia volta (180°) até perto da cidade.
    const v = CFG.visaoInicial;
    const alvo = Cesium.Cartesian3.fromDegrees(this.centro[0], this.centro[1], 760);
    const ini = { dist: 260000, pitch: -89.9, rumo: v.rumo + 180 }, fim = { dist: 14000, pitch: -52, rumo: v.rumo };
    const suave = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    // Qualquer gesto da pessoa ou outra mudança de vista (busca, link, botão) interrompe a chegada.
    this._chegando = true;
    const parar = () => { this._chegando = false; };
    const tela = this.cena.canvas;
    for (const ev of ['pointerdown', 'wheel', 'touchstart', 'keydown']) tela.addEventListener(ev, parar, { once: true, passive: true });
    return new Promise((ok) => {
      const t0 = performance.now();
      const passo = (agora) => {
        if (!this._chegando) { this.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); ok(); return; }
        const t = Math.min(1, (agora - t0) / (duracao * 1000)), e = suave(t);
        const dist = Math.exp(Math.log(ini.dist) + (Math.log(fim.dist) - Math.log(ini.dist)) * e);
        const pitch = ini.pitch + (fim.pitch - ini.pitch) * Math.min(1, e * 1.15);
        const rumo = ini.rumo + (fim.rumo - ini.rumo) * e;
        this.camera.lookAt(alvo, new Cesium.HeadingPitchRange(rad(rumo), rad(pitch), dist));
        this.redesenhar();
        if (t < 1) requestAnimationFrame(passo);
        else { this._chegando = false; this.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); ok(); }
      };
      requestAnimationFrame(passo);
    });
  }

  /** Voa até um ponto ou extensão, mantendo o rumo atual. */
  voarPara({ lon, lat, extensao, distancia, inclinacao = -50, duracao = 1.8 }) {
    this._chegando = false; // interrompe a animação de chegada
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
    this._chegando = false; // interrompe a animação de chegada
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
