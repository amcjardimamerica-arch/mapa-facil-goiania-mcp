// Postes do Jardim América e do Nova Suíça (painel Bairros): todos os postes do levantamento (KML),
// com ou sem iluminação, juntos com o cadastro de iluminação do Mapa Fácil.
// Cada poste é um cilindro 3D com uma bola no topo na cor da rede (amarelo = baixa tensão, laranja = alta,
// vermelho = com transformador), caixa do transformador no meio quando há, e — nos que têm lâmpada — um
// braço voltado para a rua com a esfera da iluminação (ciano #00FFFF = sem pedido, vermelho = manutenção pedida).
// Os postes do resto de Goiânia
// (painel Camadas) não mudam.
import { CFG } from './config.js';
import { el, aviso, pedirJSON, fmtNum, memoria } from './util.js';
import { botaoManutencao, manutencao } from './manutencao.js';

const Cesium = window.Cesium;
const COR_REDE = { transformador: '#d32f2f', Alta: '#ff6600', Baixa: '#ffff00', '': '#9e9e9e' };
const MATERIAL = { R: 'Concreto redondo (R)', Q: 'Concreto quadrado (Q)', M: 'Madeira (M)', '': 'Não informado' };
const CHAVE_HIST = 'bussola:postes:historico';

export const corDaRede = (p) => (p.transformador ? COR_REDE.transformador : COR_REDE[p.tensao] || COR_REDE['']);
export const temLampada = (p) => !!(p.iluminacao || p.lampada);
/** Esfera do braço: ciano (#00FFFF) = iluminação sem pedido; vermelho = manutenção pedida (mau funcionamento). */
export const corLampada = (p) => (manutencao.tem(p.codigo) ? '#f44336' : '#00ffff');
// Medidas padronizadas: todos os postes com a mesma altura; haste e braço 50% maiores que na 1.9.1 e a
// esfera da luminária com o dobro do tamanho.
export const ALTURA_POSTE = 13.5;                 // m (antes 9 m, +50%)
const RAIO_TOPO = 0.36, RAIO_BASE = 0.51;           // haste redonda (+50%)
const LADO_TOPO = 0.6, LADO_BASE = 0.78;            // haste quadrada de concreto
const BRACO_COMPRIMENTO = 3.3, BRACO_RAIO = 0.135;  // braço (+50%)
const RAIO_LAMPADA = 1.1;                           // esfera da luminária (+100%): tamanho mínimo, de perto
// De longe a esfera cresce com a distância da câmera, até 6 vezes (+500%), para ver bairros inteiros.
export const LAMPADA_ESCALA_MAX = 6;
const LAMPADA_ALTURA_REF = 300;                     // m de câmera em que começa a crescer
const LAMPADA_PASSO = 0.25;                         // degraus de escala (refaz as esferas só ao mudar de degrau)
/** Escala da esfera da luminária para a altura da câmera (1 de perto; até 6 de longe). */
export function escalaLampada(alturaCamera) {
  const f = Math.min(LAMPADA_ESCALA_MAX, Math.max(1, alturaCamera / LAMPADA_ALTURA_REF));
  return Math.round(f / LAMPADA_PASSO) * LAMPADA_PASSO;
}
const TRAFO = [2.2, 2.2, 2.8];                      // caixa do transformador, maior
// Cor da haste pelo material: madeira marrom; concreto (redondo ou quadrado) cinza.
const corHaste = (p) => (p.material === 'M' ? '#8d6e63' : '#9e9e9e');
const COR_BRACO = '#90a4ae', COR_TRAFO = '#ff0000';

/** Ponto a `d` metros de (lon, lat) no rumo `rumo` (radianos, a partir do norte, sentido horário). */
function deslocar(lon, lat, d, rumo) {
  return [lon + (d * Math.sin(rumo)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (d * Math.cos(rumo)) / 110540];
}

export class Postes {
  constructor({ globo, identificar }) {
    this.globo = globo;
    this.identificar = identificar;
    this.dados = null;
    this.primitiva = null;
    this.historico = memoria.ler(CHAVE_HIST, {});
    this.ligado = false;
  }

  async carregar() {
    if (!this.dados) {
      const d = await pedirJSON(`${CFG.dados}postes.json`, { tempo: 60000 });
      d.postes.forEach((p, i) => { p.i = i; });
      this.dados = d;
    }
    return this.dados;
  }

  /** Desenha (ou tira) os postes dos bairros visíveis. */
  async mostrar(ligado, bairroVisivel = () => true) {
    this.ligado = ligado;
    if (!ligado) { this._vez = (this._vez || 0) + 1; this._assinatura = null; this._remover(); return; }
    await this.carregar();
    const lista = this.dados.postes.filter((p) => bairroVisivel(p.bairro));
    const assinatura = `${lista.length}|${lista[0]?.codigo}|${lista.at(-1)?.codigo}`;
    if (assinatura === this._assinatura && this.primitiva) return; // nada mudou: não refaz os 4 mil postes
    this._assinatura = assinatura;
    const vez = (this._vez = (this._vez || 0) + 1);
    this._remover();
    if (!this._alt) {
      const alts = await this.globo.altitudes(this.dados.postes.map((p) => [p.lon, p.lat]));
      this._alt = alts;
    }
    if (vez !== this._vez) return;
    if (!this._rumos) this._rumos = await this._rumosDaRua();
    if (vez !== this._vez) return;
    const exagero = this.globo.cena.verticalExaggeration || 1;
    const perto = new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(0, 3000);
    const instancias = [];
    const lampadas = [];
    const cor = (css) => ({ color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(css)), distanceDisplayCondition: perto });
    const enu = (lon, lat, alt) => Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
    const esfera = (r) => new Cesium.EllipsoidGeometry({ radii: new Cesium.Cartesian3(r, r, r), stackPartitions: 12, slicePartitions: 12 });
    for (const p of lista) {
      const chao = (this._alt[p.i] || 0) * exagero;
      const h = ALTURA_POSTE * exagero;
      const rumo = this._rumos[p.i] ?? 0;
      const add = (parte, geometry, modelMatrix, css) => instancias.push(new Cesium.GeometryInstance({ id: { poste: p, parte }, geometry, modelMatrix, attributes: cor(css) }));
      // Haste: concreto quadrado (Q) é um prisma de base quadrada, alinhado com a rua; redondo (R), madeira (M)
      // e não informado são cilindros.
      const centroHaste = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, chao + h / 2);
      if (p.material === 'Q') {
        add('haste', new Cesium.CylinderGeometry({ length: h, topRadius: LADO_TOPO / Math.SQRT2, bottomRadius: LADO_BASE / Math.SQRT2, slices: 4 }),
          Cesium.Transforms.headingPitchRollToFixedFrame(centroHaste, new Cesium.HeadingPitchRoll(rumo + Math.PI / 4, 0, 0)), corHaste(p));
      } else {
        add('haste', new Cesium.CylinderGeometry({ length: h, topRadius: RAIO_TOPO, bottomRadius: RAIO_BASE, slices: 16 }), enu(p.lon, p.lat, chao + h / 2), corHaste(p));
      }
      // Bola do topo: cor da tensão (amarelo baixa, laranja alta, vermelho com transformador).
      add('topo', esfera(0.63 * exagero), enu(p.lon, p.lat, chao + h + 0.45 * exagero), corDaRede(p));
      // Transformador: caixa vermelha no meio do poste, alinhada com a rua.
      if (p.transformador) {
        add('trafo', Cesium.BoxGeometry.fromDimensions({ dimensions: new Cesium.Cartesian3(TRAFO[0], TRAFO[1], TRAFO[2] * exagero) }),
          Cesium.Transforms.headingPitchRollToFixedFrame(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, chao + h * 0.55), new Cesium.HeadingPitchRoll(rumo, 0, 0)), COR_TRAFO);
      }
      // Braço no sentido da rua com a esfera da iluminação na ponta (só nos postes com lâmpada).
      if (temLampada(p)) {
        const L = BRACO_COMPRIMENTO;
        const zBraco = chao + h - 1.05 * exagero;
        const [cx, cy] = deslocar(p.lon, p.lat, L / 2, rumo);
        const hpr = new Cesium.HeadingPitchRoll(rumo, 0, Math.PI / 2);
        add('braco', new Cesium.CylinderGeometry({ length: L, topRadius: BRACO_RAIO, bottomRadius: BRACO_RAIO, slices: 10 }),
          Cesium.Transforms.headingPitchRollToFixedFrame(Cesium.Cartesian3.fromDegrees(cx, cy, zBraco), hpr), COR_BRACO);
        const [lx, ly] = deslocar(p.lon, p.lat, L, rumo);
        lampadas.push({ p, lx, ly, z: zBraco });
      }
    }
    this.primitiva = this.globo.cena.primitives.add(new Cesium.Primitive({ geometryInstances: instancias, asynchronous: true,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }) }));
    this._ids = new Map(instancias.map((g) => [`${g.id.poste.i}:${g.id.parte}`, g.id]));
    this._lampadas = lampadas;
    this._escala = null;
    this._montarLampadas(escalaLampada(this.globo.camera.positionCartographic.height));
    if (!this._ouvinte) {
      this.globo.camera.percentageChanged = Math.min(this.globo.camera.percentageChanged, 0.05);
      this._ouvinte = this.globo.camera.changed.addEventListener(() => {
        if (this._lampadas?.length) this._montarLampadas(escalaLampada(this.globo.camera.positionCartographic.height));
      });
    }
    // A cena só redesenha quando pedida: insiste até a montagem assíncrona dos postes terminar.
    const prim = this.primitiva;
    const t = setInterval(() => { this.globo.redesenhar(); if (prim.ready || this.primitiva !== prim) clearInterval(t); }, 250);
    this.globo.redesenhar();
  }

  /**
   * Rumo de cada poste até a rua mais próxima (segmentos de logradouro da base cadastral, no banco local):
   * o braço da luminária aponta para lá.
   */
  async _rumosDaRua() {
    const ps = this.dados.postes;
    const lons = ps.map((p) => p.lon), lats = ps.map((p) => p.lat);
    const env = [Math.min(...lons) - 0.002, Math.min(...lats) - 0.002, Math.max(...lons) + 0.002, Math.max(...lats) + 0.002].join(',');
    let segs = [];
    try {
      const d = await pedirJSON(`${CFG.baseCadastral}/7/query`, { parametros: { f: 'json', where: '1=1', geometry: env, geometryType: 'esriGeometryEnvelope',
        inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true', outFields: 'OBJECTID' }, tempo: 60000 });
      for (const f of d.features || []) for (const linha of f.geometry?.paths || []) for (let k = 1; k < linha.length; k++) segs.push([...linha[k - 1], ...linha[k]]);
    } catch { segs = []; }
    // Grade simples para achar os segmentos perto de cada poste.
    const T = 0.0015, grade = new Map(), chave = (x, y) => `${Math.floor(x / T)},${Math.floor(y / T)}`;
    for (const s of segs) {
      for (let gx = Math.floor(Math.min(s[0], s[2]) / T); gx <= Math.floor(Math.max(s[0], s[2]) / T); gx++)
        for (let gy = Math.floor(Math.min(s[1], s[3]) / T); gy <= Math.floor(Math.max(s[1], s[3]) / T); gy++) {
          const k = `${gx},${gy}`; if (!grade.has(k)) grade.set(k, []); grade.get(k).push(s);
        }
    }
    return ps.map((p) => {
      const kx = Math.cos((p.lat * Math.PI) / 180);
      let melhor = null;
      const gx = Math.floor(p.lon / T), gy = Math.floor(p.lat / T);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const s of grade.get(`${gx + dx},${gy + dy}`) || []) {
        const ax = (s[0] - p.lon) * kx, ay = s[1] - p.lat, bx = (s[2] - p.lon) * kx, by = s[3] - p.lat;
        const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1e-18;
        const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l2));
        const qx = ax + t * vx, qy = ay + t * vy, d2 = qx * qx + qy * qy;
        if (!melhor || d2 < melhor.d2) melhor = { d2, qx, qy };
      }
      return melhor ? Math.atan2(melhor.qx, melhor.qy) : 0;
    });
  }

  /**
   * Esferas das luminárias numa primitiva à parte, refeita quando a escala muda de degrau: de perto ficam no
   * tamanho mínimo; ao afastar crescem até 6×. A nova só substitui a antiga quando fica pronta (sem piscar).
   */
  _montarLampadas(escala) {
    if (escala === this._escala || !this._lampadas) return;
    this._escala = escala;
    const exagero = this.globo.cena.verticalExaggeration || 1;
    const r = RAIO_LAMPADA * escala * exagero;
    const geometria = new Cesium.EllipsoidGeometry({ radii: new Cesium.Cartesian3(r, r, r), stackPartitions: 12, slicePartitions: 12 });
    const longe = new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(0, 20000);
    const instancias = this._lampadas.map(({ p, lx, ly, z }) => new Cesium.GeometryInstance({ id: { poste: p, parte: 'lampada' }, geometry: geometria,
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lx, ly, z + (r - RAIO_LAMPADA * exagero))),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(this._corAtual(p, 'lampada'))), distanceDisplayCondition: longe } }));
    const nova = this.globo.cena.primitives.add(new Cesium.Primitive({ geometryInstances: instancias, asynchronous: true,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }) }));
    this._lampIds = new Map(instancias.map((g) => [g.id.poste.i, g.id]));
    const antiga = this.primLampadas;
    this.primLampadas = nova;
    const t = setInterval(() => {
      this.globo.redesenhar();
      if (nova.ready || this.primLampadas !== nova) {
        clearInterval(t);
        if (antiga && !antiga.isDestroyed()) this.globo.cena.primitives.remove(antiga);
      }
    }, 150);
  }

  /** Cor da parte agora (considera a seleção, que clareia o poste escolhido). */
  _corAtual(p, parte) {
    const css = this._cores(p)[parte];
    return this._selecionado === p ? Cesium.Color.fromCssColorString(css).brighten(0.6, new Cesium.Color()).toCssColorString() : css;
  }

  _remover() {
    if (this.primLampadas) { this.globo.cena.primitives.remove(this.primLampadas); this.primLampadas = null; }
    this._lampadas = null; this._escala = null;
    if (this.primitiva) { this.globo.cena.primitives.remove(this.primitiva); this.primitiva = null; }
    this.globo.redesenhar();
  }

  _pintar(p, parte, css) {
    const prim = parte === 'lampada' ? this.primLampadas : this.primitiva;
    const id = parte === 'lampada' ? this._lampIds?.get(p.i) : this._ids?.get(`${p.i}:${parte}`);
    if (!id || !prim?.ready) return;
    const a = prim.getGeometryInstanceAttributes(id);
    if (a) a.color = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.fromCssColorString(css));
    this.globo.redesenhar();
  }

  _cores(p) {
    return { haste: corHaste(p), topo: corDaRede(p), trafo: COR_TRAFO, braco: COR_BRACO, lampada: corLampada(p) };
  }

  _aplicarCores(p, claro) {
    this._selecionado = claro ? p : (this._selecionado === p ? null : this._selecionado);
    const c = (css) => (claro ? Cesium.Color.fromCssColorString(css).brighten(0.6, new Cesium.Color()).toCssColorString() : css);
    for (const [parte, css] of Object.entries(this._cores(p))) this._pintar(p, parte, c(css));
  }

  /** Seleção: o poste inteiro fica mais claro até outra seleção ou o fechamento da ficha. */
  _selecionar(p) {
    this._aplicarCores(p, true);
    this.identificar.selecionar(() => this._aplicarCores(p, false));
  }

  historicoDe(p) { return this.historico[p.codigo] || [...p.datas]; }
  _gravarHistorico(p, datas) { this.historico[p.codigo] = datas; memoria.gravar(CHAVE_HIST, this.historico); }

  aoClicar(pego) {
    const p = pego?.id?.poste;
    if (!p) return false;
    this.abrir(p);
    return true;
  }

  abrir(p) {
    const id = this.identificar;
    id.limparDestaque();
    id.abrir({ titulo: `Poste ${p.codigo}`, subtitulo: [p.plaqueta && `plaqueta ${p.plaqueta}`, p.local, p.bairro].filter(Boolean).join(' · '),
      ponto: { lon: p.lon, lat: p.lat, alt: NaN } });
    this._selecionar(p);
    const c = id.corpo;
    const ilum = p.iluminacao || {};
    c.append(id.tabela([
      ['Material', MATERIAL[p.material] || p.material],
      ['Tensão da rede', p.tensao ? `${p.tensao} tensão` : 'Não informada'],
      ['Transformador', p.transformador ? 'Sim' : 'Não'],
      ['Iluminação', p.iluminacao || p.lampada ? [p.lampada || ilum['Tipo de lâmpada'], p.potencia || ilum['Potência (W)'] ? `${p.potencia || ilum['Potência (W)']} W` : ''].filter(Boolean).join(' · ') || 'Sim' : 'Sem lâmpada'],
      ['Código da iluminação', ilum['Código para manutenção'] || ''],
      ['Altura no 3D', `${fmtNum(ALTURA_POSTE, 1)} m (padrão para todos os postes)`],
      ['Nome no levantamento', p.nome], ['Pasta no levantamento', p.pasta],
      ['Observações', p.obs.join(' · ')],
      ['Origem', p.origem === 'KML' ? (p.casamento ? `KML do levantamento + cadastro de iluminação (${p.casamento})` : 'KML do levantamento (sem lâmpada no cadastro)') : 'Cadastro de iluminação (não está no KML)'],
    ].filter(([, v]) => v)));

    // Histórico de pedidos de manutenção: datas editáveis (as do KML entram como ponto de partida).
    const hist = el('div', { class: 'poste-historico' });
    const montarHist = () => {
      hist.textContent = '';
      const datas = this.historicoDe(p);
      datas.forEach((d, k) => hist.append(el('div', { class: 'linha-botoes' },
        el('input', { class: 'campo', type: 'text', value: d, 'aria-label': `Data do pedido ${k + 1}`,
          onchange: (e) => { const n = this.historicoDe(p); n[k] = e.target.value.trim(); this._gravarHistorico(p, n); } }),
        el('button', { class: 'botao-texto perigo', title: 'Tirar esta data', onclick: () => { const n = this.historicoDe(p); n.splice(k, 1); this._gravarHistorico(p, n); montarHist(); } }, 'Tirar'))));
      if (!datas.length) hist.append(el('p', { class: 'nota' }, 'Nenhum pedido anterior registrado.'));
      hist.append(el('button', { class: 'botao-texto', onclick: () => { const n = this.historicoDe(p); n.push(new Date().toLocaleDateString('pt-BR')); this._gravarHistorico(p, n); montarHist(); } }, 'Adicionar data'));
      if (this.historico[p.codigo] && p.datas.length) hist.append(el('p', { class: 'nota' }, `No KML original: ${p.datas.join(', ')}`));
    };
    montarHist();
    id.secao('Histórico de pedidos de manutenção', { aberto: true }).append(hist);

    // Pedir manutenção acende de vermelho a esfera da luminária (mau funcionamento); retirar o pedido volta ao azul.
    c.append(botaoManutencao({ codigo: p.codigo, tipo: 'Poste', titulo: `Poste ${p.plaqueta || p.codigo}`, bairro: p.bairro,
      local: p.local, lon: p.lon, lat: p.lat }, { aoMudar: () => this._aplicarCores(p, true) }));
    if (ilum && Object.keys(ilum).length) id.secao('Cadastro de iluminação (Mapa Fácil)', { aberto: false }).append(id.tabela(Object.entries(ilum).map(([k, v]) => [k, String(v)])));
    if (!this.ligado) aviso('Ligue "Postes" no painel Bairros para ver os postes em 3D.');
  }

  /** Busca por código, plaqueta ou nome. */
  buscar(q) {
    if (!this.dados) return [];
    const t = q.trim().toUpperCase().replace(/\s+/g, '');
    return this.dados.postes.filter((p) => p.codigo === t || (p.plaqueta && p.plaqueta.replace(/\s/g, '') === t)).slice(0, 10);
  }
}
