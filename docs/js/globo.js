// Globo 3D (CesiumJS): fundo (fotos aéreas e mapa do banco local), relevo próprio, máscara de território,
// navegação estilo Earth e os provedores de imagem do Mapa Fácil.
import { CFG } from './config.js';
import { ProvedorMascara, rotularVizinhos } from './territorio.js';
import { ProvedorVetorial } from './mapavetorial.js';
import { imagemLocal } from './banco.js';

const Cesium = window.Cesium;
const rad = (graus) => (graus * Math.PI) / 180; // sem tocar no Cesium na carga do módulo
const NIVEL_MINIMO = 9;

// ---------------------------------------------------------------- provedores
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
  // O sistema não pede imagem a nenhum servidor: o que não está no banco local fica em branco.
  return new ProvedorVazio(opcoes.retangulo);
}

// ------------------------------------------------------------------ relevo próprio
/**
 * Relevo de Goiânia guardado no site (relevo/goiania.bin.gz, Copernicus DEM GLO-30, ~30 m): uma grade só,
 * lida uma vez e amostrada em blocos para o Cesium. Fora da grade repete a borda (o entorno é só território).
 */
async function lerGradeRelevo() {
  const base = CFG.relevo.grade;
  const meta = await (await fetch(`${base}.json`)).json();
  const resp = await fetch(`${base}.bin.gz`);
  if (!resp.ok) throw new Error(`relevo: HTTP ${resp.status}`);
  const bruto = await new Response(resp.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const dif = new Int16Array(bruto);
  const { largura: L, altura: A, escala } = meta;
  const alt = new Float32Array(L * A);
  for (let y = 0; y < A; y++) {
    let v = 0;
    for (let x = 0; x < L; x++) { v += dif[y * L + x]; alt[y * L + x] = v * escala; }
  }
  return { ...meta, alt };
}

function provedorRelevoLocal(grade) {
  const { largura: L, altura: A, oeste, norte, passo, alt } = grade;
  const amostra = (lon, lat) => {
    const cx = Math.min(L - 1.001, Math.max(0, (lon - oeste) / passo - 0.5));
    const cy = Math.min(A - 1.001, Math.max(0, (norte - lat) / passo - 0.5));
    const x0 = Math.floor(cx), y0 = Math.floor(cy), fx = cx - x0, fy = cy - y0, i = y0 * L + x0;
    return (alt[i] * (1 - fx) + alt[i + 1] * fx) * (1 - fy) + (alt[i + L] * (1 - fx) + alt[i + L + 1] * fx) * fy;
  };
  const N = 32;
  const esquema = new Cesium.GeographicTilingScheme();
  return new Cesium.CustomHeightmapTerrainProvider({
    width: N, height: N, tilingScheme: esquema, credit: CFG.relevo.credito,
    callback: (x, y, nivel) => {
      const r = esquema.tileXYToRectangle(x, y, nivel);
      const o = Cesium.Math.toDegrees(r.west), l = Cesium.Math.toDegrees(r.east);
      const n = Cesium.Math.toDegrees(r.north), s = Cesium.Math.toDegrees(r.south);
      const h = new Float32Array(N * N);
      for (let j = 0; j < N; j++) {
        const lat = n + ((s - n) * j) / (N - 1);
        for (let i = 0; i < N; i++) h[j * N + i] = amostra(o + ((l - o) * i) / (N - 1), lat);
      }
      return h;
    },
  });
}

// --------------------------------------------------------------------- altura do chão
// Marcadores de tela (números das quadras, bocas de lobo, escolas…) não usam CLAMP_TO_GROUND (recalcular a altura de
// centenas deles a cada bloco de relevo travava a tela). A altura vem direto da grade do relevo do site — a mesma de
// onde o terreno é desenhado —, com o exagero vertical aplicado; com o relevo desligado, o chão é o elipsoide (0 m).
// Antes ela vinha de globe.getHeight(): lida antes de o relevo chegar, ficava 0 m (ou 760 m) guardada para sempre e
// os marcadores saíam deslocados das quadras ao inclinar ou aproximar a câmera (1.26.0).
const CHAO = { grade: null, ativo: false, exagero: 1 };
function amostraGrade(lon, lat) {
  const { largura: L, altura: A, oeste, norte, passo, alt } = CHAO.grade;
  const cx = Math.min(L - 1.001, Math.max(0, (lon - oeste) / passo - 0.5));
  const cy = Math.min(A - 1.001, Math.max(0, (norte - lat) / passo - 0.5));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), fx = cx - x0, fy = cy - y0, i = y0 * L + x0;
  return (alt[i] * (1 - fx) + alt[i + 1] * fx) * (1 - fy) + (alt[i + L] * (1 - fx) + alt[i + L + 1] * fx) * fy;
}
export function alturaChao(lon, lat) {
  if (!CHAO.ativo || !CHAO.grade) return 1.5;
  return amostraGrade(lon, lat) * CHAO.exagero + 1.5;
}
export const noChao = (lon, lat) => Cesium.Cartesian3.fromDegrees(lon, lat, alturaChao(lon, lat));

// --------------------------------------------------------------------- globo
export class Globo {
  constructor(territorio, catalogo) {
    this.territorio = territorio;
    this.catalogo = catalogo;
    this.ret = territorio.retangulo(0.02);
    const [o, s, l, n] = territorio.bbox;
    this.centro = [(o + l) / 2, (s + n) / 2];

    Cesium.Ion.defaultAccessToken = ''; // nada do Cesium ion é usado
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
    // Satélite atual da Esri (fundo padrão); depois a foto aérea da Prefeitura (banco local) e o Mapa.
    const lista = [{ chave: 'satelite', titulo: 'Satélite', curto: 'Satélite', ano: null, tipo: 'satelite' }];
    // Só Satélite e Mapa (decisão do titular, 1.25.1): sem a foto aérea da Prefeitura nem o Mapa Básico.
    lista.push({ chave: 'mapa', titulo: 'Mapa', curto: 'Mapa', ano: null, tipo: 'vetor' });
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

  /** Fundo padrão: a foto aérea mais recente guardada no banco; sem nenhuma, o Mapa. */
  get basePadrao() { return 'satelite'; }

  async _provedorBase(chave) {
    if (chave === 'mapa') {
      return new ProvedorVetorial({ modo: 'mapa', bairros: this.catalogo.bairros || [], retangulo: this.ret, territorio: this.territorio });
    }
    if (chave === 'satelite') {
      const s = CFG.satelite;
      return new Cesium.UrlTemplateImageryProvider({ url: s.url, maximumLevel: s.nivelMaximo, credit: s.credito, enablePickFeatures: false,
        tileDiscardPolicy: new Cesium.NeverTileDiscardPolicy() }); // sem conferência pixel a pixel (travava a tela)
    }
    if (chave.startsWith('sat-')) {
      const v = this.basesDisponiveis().find((x) => x.chave === chave);
      if (!v) throw new Error(`data de satélite desconhecida: ${chave}`);
      return new Cesium.UrlTemplateImageryProvider({ url: v.url, maximumLevel: v.nivelMaximo, enablePickFeatures: false,
        credit: `Satélite de ${v.captura}: Esri World Imagery Wayback${v.fonte ? `, ${v.fonte}` : ''}`, tileDiscardPolicy: new Cesium.NeverTileDiscardPolicy() });
    }
    if (chave === 'foto' || chave.startsWith('foto-')) {
      const v = this.basesDisponiveis().find((x) => x.chave === chave);
      const local = v && imagemLocal(v.servico);
      if (!local) throw new Error(`foto aérea indisponível no banco local: ${chave}`);
      return local;
    }
    const b = this.catalogo.bases.find((x) => x.chave === chave && !x.ano);
    if (!b) throw new Error(`base desconhecida: ${chave}`);
    const local = imagemLocal(b.url.split('/MapServer')[0].split('/').pop());
    if (!local) throw new Error(`${b.titulo} indisponível no banco local`);
    return local;
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
    if (this.camadaDrenagem && camadas.contains(this.camadaDrenagem)) camadas.raiseToTop(this.camadaDrenagem);
    if (this.camadaGeo360 && camadas.contains(this.camadaGeo360)) camadas.raiseToTop(this.camadaGeo360);
    // Divisas dos Conselhos Tutelares e das zonas eleitorais por cima das divisas de bairro e dos nomes (1.26.0).
    if (this.camadaEleicao && camadas.contains(this.camadaEleicao)) camadas.raiseToTop(this.camadaEleicao);
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
        this._grade = this._grade || await lerGradeRelevo();
        this.provedorRelevo = provedorRelevoLocal(this._grade);
      }
      this.viewer.terrainProvider = ligado ? this.provedorRelevo : new Cesium.EllipsoidTerrainProvider();
      this.relevoAtivo = !!ligado;
      Object.assign(CHAO, { grade: this._grade || null, ativo: !!ligado, exagero: this.cena.verticalExaggeration || 1 });
    } catch (e) {
      console.warn('Relevo indisponível:', e);
      this.viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      this.relevoAtivo = false;
      CHAO.ativo = false;
      throw e;
    } finally {
      this._aoMudarRelevo.forEach((fn) => fn(this.relevoAtivo));
      this.redesenhar();
    }
  }

  definirExagero(fator) {
    this.cena.verticalExaggeration = fator;
    CHAO.exagero = fator || 1;
    this._aoMudarRelevo.forEach((fn) => fn(this.relevoAtivo));
    this.redesenhar();
  }

  /** Altitude do terreno (m) para uma lista de [lon,lat]; zeros se o relevo estiver desligado. Lida direto da grade. */
  async altitudes(pontos) {
    if (!this.relevoAtivo || !this._grade) return pontos.map(() => 0);
    const { largura: L, altura: A, oeste, norte, passo, alt } = this._grade;
    return pontos.map(([lon, lat]) => {
      const cx = Math.min(L - 1.001, Math.max(0, (lon - oeste) / passo - 0.5)), cy = Math.min(A - 1.001, Math.max(0, (norte - lat) / passo - 0.5));
      const x0 = Math.floor(cx), y0 = Math.floor(cy), fx = cx - x0, fy = cy - y0, i = y0 * L + x0;
      return (alt[i] * (1 - fx) + alt[i + 1] * fx) * (1 - fy) + (alt[i + L] * (1 - fx) + alt[i + L + 1] * fx) * fy;
    });
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
  voarPara({ lon, lat, extensao, distancia, inclinacao = -50, duracao = 1.8, rumo }) {
    this._chegando = false; // interrompe a animação de chegada
    let alvo, alcance = distancia;
    if (extensao) {
      const [o, s, l, n] = extensao;
      lon = (o + l) / 2; lat = (s + n) / 2;
      const diag = Cesium.Cartesian3.distance(Cesium.Cartesian3.fromDegrees(o, s), Cesium.Cartesian3.fromDegrees(l, n));
      alcance = alcance || Math.max(350, diag * 1.5);
    }
    alvo = Cesium.Cartesian3.fromDegrees(lon, lat, alturaChao(lon, lat));
    return new Promise((ok) => this.camera.flyToBoundingSphere(new Cesium.BoundingSphere(alvo, 1), {
      offset: new Cesium.HeadingPitchRange(rumo ?? this.camera.heading, rad(inclinacao), alcance || 900),
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
    this.camera.cancelFlight(); // um voo em andamento não pode levar a câmera de volta depois
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
