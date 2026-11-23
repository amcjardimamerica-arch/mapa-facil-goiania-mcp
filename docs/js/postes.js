// Postes do Jardim América e do Nova Suíça (painel Bairros): todos os postes do levantamento (KML),
// com ou sem iluminação, juntos com o cadastro de iluminação do Mapa Fácil.
// Cada poste é um cilindro 3D na cor da rede (amarelo = baixa tensão, laranja = alta, vermelho = com
// transformador) e tem no topo um prisma cuja cor a pessoa escolhe. Os postes do resto de Goiânia
// (painel Camadas) não mudam.
import { CFG } from './config.js';
import { el, aviso, pedirJSON, fmtNum, memoria } from './util.js';
import { botaoManutencao } from './manutencao.js';

const Cesium = window.Cesium;
const COR_REDE = { transformador: '#d32f2f', Alta: '#f57c00', Baixa: '#ffee58', '': '#9e9e9e' };
const MATERIAL = { R: 'Concreto redondo (R)', Q: 'Concreto quadrado (Q)', M: 'Madeira (M)', '': 'Não informado' };
const CHAVE_PRISMA = 'bussola:postes:prisma';
const CHAVE_HIST = 'bussola:postes:historico';

export const corDaRede = (p) => (p.transformador ? COR_REDE.transformador : COR_REDE[p.tensao] || COR_REDE['']);
export const corPrismaPadrao = (p) => (p.iluminacao || p.lampada ? '#4fc3f7' : '#616161');

export class Postes {
  constructor({ globo, identificar }) {
    this.globo = globo;
    this.identificar = identificar;
    this.dados = null;
    this.primitiva = null;
    this.prismas = memoria.ler(CHAVE_PRISMA, {});
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
    const exagero = this.globo.cena.verticalExaggeration || 1;
    const perto = new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(0, 2500);
    const instancias = [];
    for (const p of lista) {
      const chao = (this._alt[p.i] || 0) * exagero;
      const h = p.altura * exagero;
      const haste = new Cesium.CylinderGeometry({ length: h, topRadius: 0.13, bottomRadius: 0.2, slices: 10 });
      instancias.push(new Cesium.GeometryInstance({ id: { poste: p, parte: 'haste' }, geometry: haste,
        modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, chao + h / 2)),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(corDaRede(p))), distanceDisplayCondition: perto } }));
      const prisma = new Cesium.CylinderGeometry({ length: 0.9 * exagero, topRadius: 0.38, bottomRadius: 0.38, slices: 6 });
      instancias.push(new Cesium.GeometryInstance({ id: { poste: p, parte: 'prisma' }, geometry: prisma,
        modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, chao + h + 0.45 * exagero)),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(this.corPrisma(p))), distanceDisplayCondition: perto } }));
    }
    this.primitiva = this.globo.cena.primitives.add(new Cesium.Primitive({ geometryInstances: instancias, asynchronous: true,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }) }));
    this._ids = new Map(instancias.map((g) => [`${g.id.poste.i}:${g.id.parte}`, g.id]));
    this.globo.redesenhar();
  }

  _remover() {
    if (this.primitiva) { this.globo.cena.primitives.remove(this.primitiva); this.primitiva = null; }
    this.globo.redesenhar();
  }

  corPrisma(p) { return this.prismas[p.codigo] || corPrismaPadrao(p); }

  _pintar(p, parte, css) {
    const id = this._ids?.get(`${p.i}:${parte}`);
    if (!id || !this.primitiva?.ready) return;
    const a = this.primitiva.getGeometryInstanceAttributes(id);
    if (a) a.color = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.fromCssColorString(css));
    this.globo.redesenhar();
  }

  /** Seleção: o poste fica mais claro (haste e prisma) até outra seleção ou o fechamento da ficha. */
  _selecionar(p) {
    const claro = (css) => Cesium.Color.fromCssColorString(css).brighten(0.6, new Cesium.Color()).toCssColorString();
    this._pintar(p, 'haste', claro(corDaRede(p)));
    this._pintar(p, 'prisma', claro(this.corPrisma(p)));
    this.identificar.selecionar(() => { this._pintar(p, 'haste', corDaRede(p)); this._pintar(p, 'prisma', this.corPrisma(p)); });
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

    // Cor do prisma do topo, escolhida pela pessoa.
    const cor = el('input', { type: 'color', value: this.corPrisma(p), 'aria-label': 'Cor do prisma do poste',
      oninput: (e) => { this.prismas[p.codigo] = e.target.value; memoria.gravar(CHAVE_PRISMA, this.prismas); this._pintar(p, 'prisma', e.target.value); } });
    c.append(el('label', { class: 'linha-chave' }, el('span', {}, el('strong', {}, 'Cor do prisma do topo'), el('small', {}, 'marcação livre, guardada neste aparelho')), cor),
      el('button', { class: 'botao-texto', onclick: () => { delete this.prismas[p.codigo]; memoria.gravar(CHAVE_PRISMA, this.prismas); cor.value = this.corPrisma(p); this._pintar(p, 'prisma', cor.value); } }, 'Voltar à cor padrão'));

    c.append(botaoManutencao({ codigo: p.codigo, tipo: 'Poste', titulo: `Poste ${p.plaqueta || p.codigo}`, bairro: p.bairro,
      local: p.local, lon: p.lon, lat: p.lat }));
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
