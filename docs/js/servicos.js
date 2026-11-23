// Acessibilidade e Serviços: os pontos do Mapa Fácil viram marcadores fixos no mapa,
// como os marcadores do Google Earth: ícone temático por tipo, nome ao lado (branco
// sobre o satélite, preto sobre o mapa sem fotos) e ficha com os dados ao clicar.
import { el, pedirJSON, aviso } from './util.js';

const Cesium = window.Cesium;

// Símbolos (caminhos SVG 24×24) e cores por tipo de serviço.
const SIMBOLOS = {
  escola: 'M12 4 2 9l10 5 8-4v6h2V9zM6 13v4c0 1.7 2.7 3 6 3s6-1.3 6-3v-4l-6 3z',
  creche: 'M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm-5 8h10l-1 5h-2v5h-4v-5H8z',
  saude: 'M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z',
  hospital: 'M5 3h14v18H5zm5 3v3H7v3h3v3h3v-3h3V9h-3V6z',
  compras: 'M7 6h14l-2 8H8.2L7.6 11H5V9h2zM9 18a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm8 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  shopping: 'M6 8h12l1 13H5zm3 0a3 3 0 0 1 6 0h-2a1 1 0 0 0-2 0z',
  banco: 'M12 2 3 7v2h18V7zM5 11h2v7H5zm4 0h2v7H9zm4 0h2v7h-2zm4 0h2v7h-2zM3 20h18v2H3z',
  correio: 'M3 6h18v12H3zm2 2v.5l7 4.5 7-4.5V8l-7 4.5z',
  loterica: 'M12 3a4 4 0 0 1 4 4 4 4 0 0 1 4 4 4 4 0 0 1-4 4h-3v6h-2v-6H8a4 4 0 0 1-4-4 4 4 0 0 1 4-4 4 4 0 0 1 4-4z',
  atendimento: 'M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z',
  onibus: 'M6 3h12a2 2 0 0 1 2 2v11a2 2 0 0 1-1 1.7V20h-3v-2H8v2H5v-2.3A2 2 0 0 1 4 16V5a2 2 0 0 1 2-2zm0 3v5h12V6zm1.5 7.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  terminal: 'M3 9 12 3l9 6v2H3zm2 3h14v8H5zm2 2v4h4v-4zm6 0v4h4v-4z',
  ponto: 'M12 2a6 6 0 0 1 6 6c0 4.5-6 13-6 13S6 12.5 6 8a6 6 0 0 1 6-6zm0 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
};
const CATEGORIAS = [
  // [teste no nome da camada ou do grupo, símbolo, cor]
  [/creche|ber[cç]/i, 'creche', '#f48fb1'],
  [/educa|escola|ensino|alfabet/i, 'escola', '#ffb300'],
  [/hospitalar|pronto|urg[eê]ncia/i, 'hospital', '#e53935'],
  [/sa[uú]de|m[eé]dic|dialise|quimio|radio|defici/i, 'saude', '#ef5350'],
  [/shopping/i, 'shopping', '#ab47bc'],
  [/mercado|lojas|com[eé]rci/i, 'compras', '#8e24aa'],
  [/banc|caixa|finan/i, 'banco', '#2e7d32'],
  [/correio/i, 'correio', '#fdd835'],
  [/loteric/i, 'loterica', '#26a69a'],
  [/vapt|atendimento/i, 'atendimento', '#1e88e5'],
  [/terminal/i, 'terminal', '#3949ab'],
  [/ponto|plataforma|transporte|[oô]nibus/i, 'onibus', '#5c6bc0'],
];

function categoria(nomes) {
  for (const [re, simbolo, cor] of CATEGORIAS) if (nomes.some((n) => re.test(n))) return { simbolo, cor };
  return { simbolo: 'ponto', cor: '#78909c' };
}

const iconeCache = new Map();
/** Marcador no estilo dos pins do Earth: gota colorida com o símbolo branco. */
export function iconeServico(simbolo, cor) {
  const chave = `${simbolo}|${cor}`;
  if (!iconeCache.has(chave)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="52" viewBox="0 0 40 52">` +
      `<path d="M20 2C10.6 2 3 9.6 3 19c0 12.5 17 31 17 31s17-18.5 17-31C37 9.6 29.4 2 20 2z" fill="${cor}" stroke="#ffffff" stroke-width="2.5"/>` +
      `<g transform="translate(9 8) scale(.92)" fill="#ffffff"><path d="${SIMBOLOS[simbolo]}"/></g></svg>`;
    iconeCache.set(chave, `data:image/svg+xml,${encodeURIComponent(svg)}`);
  }
  return iconeCache.get(chave);
}

const CAMPO_NOME = /(^|\.)(nm(_\w+)?|nome|name|unid_escol|unidade escolar|nm_shopp|nome_razao|raz[aã]o social)$/i;
const EXTENSAO_GOIANIA = [-49.55, -16.95, -48.95, -16.38];

export class Servicos {
  constructor({ globo, identificar }) {
    this.globo = globo;
    this.identificar = identificar;
    this.fonte = new Cesium.CustomDataSource('servicos');
    globo.viewer.dataSources.add(this.fonte);
    this.info = new Map();   // "tema:id" -> { tipo: geometryType, campos }
    this.dados = new Map();  // "tema:id" -> entidades
    this.ligadas = new Set();
    this.carregando = new Map();
    this.modoMapa = false;
  }

  /** true quando a camada é de pontos (vira marcador); camadas de linha seguem como imagem. */
  ehMarcador(tema, id) { return this.info.get(`${tema}:${id}`)?.tipo === 'esriGeometryPoint'; }

  async _info(t, id) {
    const k = `${t.chave}:${id}`;
    if (!this.info.has(k)) {
      try { const d = await pedirJSON(`${t.url}/${id}`, { parametros: { f: 'json' } }); this.info.set(k, { tipo: d.geometryType, campos: d.fields || [] }); }
      catch { this.info.set(k, { tipo: 'desconhecido', campos: [] }); }
    }
    return this.info.get(k);
  }

  /** Mostra como marcadores as camadas de ponto em `ids` (as demais saem). */
  async definir(t, ids) {
    const querer = new Set(ids.map((id) => `${t.chave}:${id}`));
    for (const k of [...this.ligadas]) if (k.startsWith(`${t.chave}:`) && !querer.has(k)) this._mostrar(k, false);
    for (const id of ids) {
      const info = await this._info(t, id);
      if (info.tipo !== 'esriGeometryPoint') continue;
      const k = `${t.chave}:${id}`;
      if (!this.dados.has(k)) {
        // Um só carregamento por camada, mesmo com pedidos simultâneos.
        if (!this.carregando.has(k)) this.carregando.set(k, this._carregar(t, id, info).finally(() => this.carregando.delete(k)));
        try { const ents = await this.carregando.get(k); if (!this.dados.has(k)) this.dados.set(k, ents); }
        catch (e) { aviso(`Não foi possível carregar "${t._porId.get(id)?.nome}": ${e.message}`, 'alerta'); continue; }
      }
      if (querer.has(k)) this._mostrar(k, true);
    }
    this.globo.redesenhar();
  }

  _mostrar(k, ligado) {
    for (const e of this.dados.get(k) || []) e.show = ligado;
    if (ligado) this.ligadas.add(k); else this.ligadas.delete(k);
  }

  async _carregar(t, id, info) {
    const camada = t._porId.get(id);
    const nomes = [camada.nome];
    for (let c = t._porId.get(camada.pai); c; c = t._porId.get(c.pai)) nomes.push(c.nome);
    const { simbolo, cor } = categoria(nomes);
    const imagem = iconeServico(simbolo, cor);
    // O servidor não devolve a geometria na consulta comum, mas devolve no "identify". Pede a cidade inteira
    // e, quando a resposta bate no limite de 1.000 pontos, divide a área em quatro e pede de novo.
    const feicoes = [], vistos = new Set();
    const pedir = async ([o, s, l, n], nivel) => {
      const d = await pedirJSON(`${t.url}/identify`, { parametros: { f: 'json', geometry: JSON.stringify({ xmin: o, ymin: s, xmax: l, ymax: n }),
        geometryType: 'esriGeometryEnvelope', sr: '4326', layers: `all:${id}`, tolerance: '0', mapExtent: [o, s, l, n].join(','),
        imageDisplay: '1000,1000,96', returnGeometry: 'true', returnFieldName: 'false' }, tempo: 60000 });
      const r = d.results || [];
      if (r.length >= 1000 && nivel < 6) {
        const mx = (o + l) / 2, my = (s + n) / 2;
        for (const q of [[o, s, mx, my], [mx, s, l, my], [o, my, mx, n], [mx, my, l, n]]) await pedir(q, nivel + 1);
        return;
      }
      for (const f of r) {
        const chave = `${f.geometry?.x},${f.geometry?.y},${JSON.stringify(f.attributes)}`;
        if (!vistos.has(chave)) { vistos.add(chave); feicoes.push(f); }
      }
    };
    await pedir(EXTENSAO_GOIANIA, 0);
    const muitos = feicoes.length > 1500;
    return feicoes.filter((f) => f.geometry && Number.isFinite(f.geometry.x)).map((f) => {
      const campo = Object.keys(f.attributes).find((k) => CAMPO_NOME.test(k));
      const nome = String((campo && f.attributes[campo]) || '').trim();
      const ent = this.fonte.entities.add({
        position: Cesium.Cartesian3.fromDegrees(f.geometry.x, f.geometry.y),
        billboard: { image: imagem, width: 28, height: 36, verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, muitos ? 5000 : 30000) },
        label: nome ? { text: nome, font: '600 12.5px system-ui, "Segoe UI", Roboto, sans-serif', ...this._coresRotulo(),
          style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3, horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.CENTER, pixelOffset: new Cesium.Cartesian2(16, -20),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, muitos ? 900 : 4000) } : undefined,
        show: false,
      });
      ent.servico = { tema: t, camada, nome, atributos: f.attributes, campos: info.campos, lon: f.geometry.x, lat: f.geometry.y, cor };
      return ent;
    });
  }

  /** Nome branco (contorno preto) sobre o satélite; preto (contorno branco) sobre o mapa sem fotos. */
  _coresRotulo() {
    return this.modoMapa
      ? { fillColor: Cesium.Color.fromCssColorString('#111418'), outlineColor: Cesium.Color.WHITE }
      : { fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.fromCssColorString('#111418') };
  }

  /** Chamado quando o fundo muda: 'mapa' (sem fotos) ou outro. */
  definirFundo(chaveBase) {
    const mapa = chaveBase === 'mapa' || chaveBase === 'basico';
    if (mapa === this.modoMapa) return;
    this.modoMapa = mapa;
    const c = this._coresRotulo();
    for (const lista of this.dados.values()) for (const e of lista) if (e.label) { e.label.fillColor = c.fillColor; e.label.outlineColor = c.outlineColor; }
    this.globo.redesenhar();
  }

  aoClicar(pego) {
    const s = pego?.id?.servico;
    if (!s) return false;
    const ent = pego.id;
    const id = this.identificar;
    id.limparDestaque();
    id.abrir({ titulo: s.nome || s.camada.nome, subtitulo: s.camada.nome, ponto: { lon: s.lon, lat: s.lat, alt: NaN } });
    const linhas = Object.entries(s.atributos).filter(([k]) => !/^(FID|OBJECTID|Shape)/i.test(k.split('.').pop()))
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '' && !/^null$/i.test(String(v).trim()))
      .map(([k, v]) => [k.split('.').pop(), String(v)]);
    id.corpo.append(id.tabela(linhas));
    // Seleção: o marcador cresce e clareia (sem marcador extra).
    ent.billboard.scale = 1.45;
    id.selecionar(() => { ent.billboard.scale = 1; this.globo.redesenhar(); });
    this.globo.redesenhar();
    return true;
  }

  total() { return [...this.ligadas].reduce((s, k) => s + (this.dados.get(k)?.length || 0), 0); }
}
