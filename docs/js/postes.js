// Postes do Jardim América e do Nova Suíça (painel Bairros): todos os postes do levantamento (KML),
// com ou sem iluminação, juntos com o cadastro de iluminação do Mapa Fácil.
// Cada poste é um cilindro 3D com uma bola no topo na cor da rede (amarelo = baixa tensão, laranja = alta,
// vermelho = com transformador), caixa do transformador no meio quando há, e — nos que têm lâmpada — um
// braço voltado para a rua com a esfera da iluminação (azul = sem pedido, vermelho = manutenção pedida).
// Os postes do resto de Goiânia
// (painel Camadas) não mudam.
import { CFG } from './config.js';
import { el, aviso, pedirJSON, fmtNum, memoria } from './util.js';
import { botaoManutencao, manutencao } from './manutencao.js';

const Cesium = window.Cesium;
const COR_REDE = { transformador: '#d32f2f', Alta: '#f57c00', Baixa: '#ffee58', '': '#9e9e9e' };
const MATERIAL = { R: 'Concreto redondo (R)', Q: 'Concreto quadrado (Q)', M: 'Madeira (M)', '': 'Não informado' };
const CHAVE_HIST = 'bussola:postes:historico';

export const corDaRede = (p) => (p.transformador ? COR_REDE.transformador : COR_REDE[p.tensao] || COR_REDE['']);
export const temLampada = (p) => !!(p.iluminacao || p.lampada);
/** Esfera do braço: azul = iluminação sem pedido; vermelho = manutenção pedida (mau funcionamento). */
export const corLampada = (p) => (manutencao.tem(p.codigo) ? '#f44336' : '#2196f3');
const COR_HASTE = { M: '#8d6e63' }; // madeira; concreto fica cinza-claro
const corHaste = (p) => COR_HASTE[p.material] || '#cfd8dc';
const COR_BRACO = '#90a4ae', COR_TRAFO = '#455a64';

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
    const perto = new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(0, 2500);
    const instancias = [];
    const cor = (css) => ({ color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(css)), distanceDisplayCondition: perto });
    const enu = (lon, lat, alt) => Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
    const esfera = (r) => new Cesium.EllipsoidGeometry({ radii: new Cesium.Cartesian3(r, r, r), stackPartitions: 12, slicePartitions: 12 });
    for (const p of lista) {
      const chao = (this._alt[p.i] || 0) * exagero;
      const h = p.altura * exagero;
      const add = (parte, geometry, modelMatrix, css) => instancias.push(new Cesium.GeometryInstance({ id: { poste: p, parte }, geometry, modelMatrix, attributes: cor(css) }));
      // Haste mais grossa (concreto cinza-claro; madeira marrom).
      add('haste', new Cesium.CylinderGeometry({ length: h, topRadius: 0.24, bottomRadius: 0.34, slices: 14 }), enu(p.lon, p.lat, chao + h / 2), corHaste(p));
      // Bola do topo: cor da tensão (amarelo baixa, laranja alta, vermelho com transformador).
      add('topo', esfera(0.42 * exagero), enu(p.lon, p.lat, chao + h + 0.3 * exagero), corDaRede(p));
      // Transformador: caixa no meio do poste.
      if (p.transformador) {
        add('trafo', Cesium.BoxGeometry.fromDimensions({ dimensions: new Cesium.Cartesian3(1.1, 1.1, 1.5 * exagero) }),
          enu(p.lon, p.lat, chao + h * 0.55), COR_TRAFO);
      }
      // Braço no sentido da rua com a esfera da iluminação na ponta (só nos postes com lâmpada).
      if (temLampada(p)) {
        const rumo = this._rumos[p.i] ?? 0, L = 2.2;
        const zBraco = chao + h - 0.7 * exagero;
        const [cx, cy] = deslocar(p.lon, p.lat, L / 2, rumo);
        const hpr = new Cesium.HeadingPitchRoll(rumo, 0, Math.PI / 2);
        add('braco', new Cesium.CylinderGeometry({ length: L, topRadius: 0.09, bottomRadius: 0.09, slices: 8 }),
          Cesium.Transforms.headingPitchRollToFixedFrame(Cesium.Cartesian3.fromDegrees(cx, cy, zBraco), hpr), COR_BRACO);
        const [lx, ly] = deslocar(p.lon, p.lat, L, rumo);
        add('lampada', esfera(0.55 * exagero), enu(lx, ly, zBraco), corLampada(p));
      }
    }
    this.primitiva = this.globo.cena.primitives.add(new Cesium.Primitive({ geometryInstances: instancias, asynchronous: true,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }) }));
    this._ids = new Map(instancias.map((g) => [`${g.id.poste.i}:${g.id.parte}`, g.id]));
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

  _remover() {
    if (this.primitiva) { this.globo.cena.primitives.remove(this.primitiva); this.primitiva = null; }
    this.globo.redesenhar();
  }

  _pintar(p, parte, css) {
    const id = this._ids?.get(`${p.i}:${parte}`);
    if (!id || !this.primitiva?.ready) return;
    const a = this.primitiva.getGeometryInstanceAttributes(id);
    if (a) a.color = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.fromCssColorString(css));
    this.globo.redesenhar();
  }

  _cores(p) {
    return { haste: corHaste(p), topo: corDaRede(p), trafo: COR_TRAFO, braco: COR_BRACO, lampada: corLampada(p) };
  }

  _aplicarCores(p, claro) {
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
      ['Altura no 3D', `${fmtNum(p.altura, 1)} m`],
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
