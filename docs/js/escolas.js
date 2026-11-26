// Escolas e cursos do Jardim América e do Nova Suíça (painel Bairros), em marcadores próprios:
// escolas públicas e particulares por nível (infantil, fundamental, médio e superior) e "Aulas diversas"
// (idiomas, lutas e esportes, dança, música, artes, informática, preparatórios e demais cursos).
//
// Fontes no levantamento: áreas públicas de Educação (escolas públicas) e empresas pelo CNAE (Receita Federal),
// ligadas ao lote. As empresas do mesmo lote e da mesma categoria formam um marcador.
import { noChao } from './globo.js';
import { el, fmtNum, semAcento } from './util.js';

const Cesium = window.Cesium;

// Tudo em verde, do mais claro ao mais escuro: aulas diversas, depois as particulares (claras) e as públicas
// (escuras), com um tom diferente para cada nível de ensino.
export const NIVEIS = [
  { id: 'infantil', nome: 'Educação infantil', cor: '#b9f6ca', corPublica: '#43a047' },
  { id: 'fundamental', nome: 'Ensino fundamental', cor: '#8de0a0', corPublica: '#2e7d32' },
  { id: 'medio', nome: 'Ensino médio', cor: '#66cc80', corPublica: '#1b5e20' },
  { id: 'superior', nome: 'Ensino superior', cor: '#4cb868', corPublica: '#0b3d14' },
];
export const AULAS = { id: 'aulas', nome: 'Aulas diversas', cor: '#e3fce8' };
/** Cor do marcador: verde claro nas particulares e aulas; verde escuro nas públicas; um tom por nível. */
export const corEscola = (tipo, nivel) => (tipo === 'aulas' ? AULAS.cor : tipo === 'publica' ? nivel.corPublica : nivel.cor);
const BORDA = { publica: '#ffffff', particular: '#1f2226' };

/** Nível (ou "aulas") pelo CNAE da empresa. */
export function categoriaDoCnae(cnae) {
  const c = String(cnae || '').replace(/\D/g, '');
  if (/^851[12]/.test(c)) return 'infantil';
  if (/^8513/.test(c)) return 'fundamental';
  if (/^852/.test(c) || /^8541/.test(c)) return 'medio'; // médio e técnico de nível médio
  if (/^853/.test(c)) return 'superior';
  if (/^8550301/.test(c)) return null;                    // caixa escolar: é a escola pública, que vem das áreas
  if (/^85(5|9)/.test(c)) return 'aulas';                 // apoio, esportes, artes, idiomas, cursos
  return null;
}

/** Nível da escola pública pelo nome (CMEI e creche: infantil; colégio/escola estadual: fundamental e médio…). */
export function niveisDaPublica(nome) {
  const n = semAcento(nome);
  if (/cmei|creche|infantil|cepi|pre.?escola/.test(n)) return ['infantil'];
  if (/universidade|faculdade|instituto federal|\bif\b|ufg|pucgo|puc/.test(n)) return ['superior'];
  if (/estadual|colegio|cepmg|ensino medio/.test(n)) return ['fundamental', 'medio'];
  return ['fundamental'];
}

export class Escolas {
  constructor({ globo, identificar }) {
    this.globo = globo;
    this.identificar = identificar;
    this.fonte = new Cesium.CustomDataSource('escolas');
    globo.viewer.dataSources.add(this.fonte);
    this.itens = null;
  }

  /** Monta a lista de escolas e cursos a partir do levantamento já carregado. */
  preparar(lev) {
    if (this.itens) return this.itens;
    const d = lev.dados, itens = [];
    // Públicas: áreas públicas de Educação.
    const ca = d.colunas_area;
    for (const a of d.areas) {
      if (a.cat !== 'Educação') continue;
      const anel = a.aneis[0];
      const c = anel.reduce((s, p) => [s[0] + p[0] / anel.length, s[1] + p[1] / anel.length], [0, 0]);
      const nome = (a.v && (a.v[ca.indexOf('Ocupante / estabelecimento')] || a.v[ca.indexOf('Nome / identificação')])) || a.nome;
      itens.push({ tipo: 'publica', niveis: niveisDaPublica(`${nome} ${a.nome}`), nome, lon: c[0], lat: c[1], area: a, bairro: a.v?.[ca.indexOf('Bairro')] || '' });
    }
    // Particulares e cursos: empresas de ensino pelo CNAE, agrupadas por lote e categoria.
    const ce = d.empresas.colunas, kC = ce.indexOf('CNAE principal'), kN = ce.indexOf('Nome fantasia'), kR = ce.indexOf('Razão social');
    const grupos = new Map();
    for (const e of d.empresas.linhas) {
      const cat = categoriaDoCnae(e.v[kC]);
      if (!cat || !Number.isInteger(e.lote)) continue;
      const k = `${e.lote}|${cat}`;
      if (!grupos.has(k)) grupos.set(k, { cat, lote: d.lotes[e.lote], empresas: [] });
      grupos.get(k).empresas.push(e.v);
    }
    for (const g of grupos.values()) {
      const l = g.lote, anel = l.aneis[0];
      const c = anel.reduce((s, p) => [s[0] + p[0] / anel.length, s[1] + p[1] / anel.length], [0, 0]);
      const nome = g.empresas[0][kN] || g.empresas[0][kR];
      itens.push({ tipo: g.cat === 'aulas' ? 'aulas' : 'particular', niveis: [g.cat], nome: g.empresas.length > 1 ? `${nome} e mais ${g.empresas.length - 1}` : nome,
        lon: c[0], lat: c[1], lote: l, empresas: g.empresas, colunas: ce, bairro: d.bairros[l.b] });
    }
    this.itens = itens;
    return itens;
  }

  contagem() {
    const c = { publica: 0, particular: 0, aulas: 0 };
    for (const i of this.itens || []) c[i.tipo]++;
    return c;
  }

  /** Itens visíveis com os filtros (bairros marcados, pública/particular, níveis e cursos), com a cor de cada um. */
  visiveis(filtros, bairroVisivel = () => true) {
    const out = [];
    for (const i of this.itens || []) {
      if (!bairroVisivel(i.bairro)) continue;
      if (i.tipo === 'aulas' ? !filtros.aulas : !filtros[i.tipo]) continue;
      const nivel = i.tipo === 'aulas' ? AULAS : NIVEIS.find((n) => i.niveis.includes(n.id) && filtros[n.id] !== false);
      if (!nivel) continue;
      out.push({ i, cor: corEscola(i.tipo, nivel) });
    }
    return out;
  }

  /** "Infantil - Público - Nome", "Fundamental/Médio - Público - Nome", "Curso - Privado - Nome". */
  static rotulo(i) {
    const CURTO = { infantil: 'Infantil', fundamental: 'Fundamental', medio: 'Médio', superior: 'Superior' };
    const nivel = i.tipo === 'aulas' ? 'Curso' : i.niveis.map((n) => CURTO[n] || n).join('/');
    const tipo = i.tipo === 'publica' ? 'Público' : 'Privado';
    return `${nivel} - ${tipo} - ${i.nome}`;
  }

  /**
   * Marcadores pequenos: um ponto na cor do nível (borda branca nas públicas, escura nas particulares e cursos) e o
   * nome em cima — "Nível - Público/Privado - Nome". O lote (ou a área pública) da escola é pintado na camada dos
   * lotes, como as demais finalidades (levantamento.js).
   */
  mostrar(ligado, filtros, bairroVisivel = () => true) {
    this.fonte.entities.removeAll();
    if (!ligado || !this.itens) { this.globo.redesenhar(); return; }
    this.fonte.entities.suspendEvents();
    for (const { i, cor } of this.visiveis(filtros, bairroVisivel)) {
      const ent = this.fonte.entities.add({ position: noChao(i.lon, i.lat),
        point: { pixelSize: 8, color: Cesium.Color.fromCssColorString(cor), outlineColor: Cesium.Color.fromCssColorString(i.tipo === 'publica' ? BORDA.publica : BORDA.particular),
          outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000),
          scaleByDistance: new Cesium.NearFarScalar(300, 1.3, 4000, 0.8) },
        label: { text: Escolas.rotulo(i), font: '600 11.5px system-ui, "Segoe UI", Roboto, sans-serif', fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString('#111418'), outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -8),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 900) } });
      ent.ll = [i.lon, i.lat];
      ent.escola = i;
    }
    this.fonte.entities.resumeEvents();
    this.globo.redesenhar();
  }

  aoClicar(pego, abrirArea, abrirLote) {
    const i = pego?.id?.escola;
    if (!i) return false;
    const id = this.identificar, ent = pego.id;
    if (i.area) abrirArea(i.area);
    else {
      id.limparDestaque();
      id.abrir({ titulo: i.nome, subtitulo: `${i.tipo === 'aulas' ? 'Aulas diversas' : `Escola particular · ${NIVEIS.find((n) => n.id === i.niveis[0])?.nome}`} · ${i.bairro}`,
        ponto: { lon: i.lon, lat: i.lat, alt: NaN } });
      for (const e of i.empresas) {
        const nome = e[i.colunas.indexOf('Nome fantasia')] || e[i.colunas.indexOf('Razão social')];
        id.secao(nome, { aberto: i.empresas.length === 1 }).append(id.tabela(i.colunas.map((c, k) => [c, e[k]])
          .filter(([, v]) => v !== null && v !== undefined && v !== '').map(([c, v]) => [c, String(v)])));
      }
      id.corpo.append(el('button', { class: 'botao', onclick: () => abrirLote(i.lote) }, `Ver o lote (Quadra ${i.lote.q} · Lote ${i.lote.l})`));
    }
    ent.point.pixelSize = 13;
    id.selecionar(() => { ent.point.pixelSize = 8; this.globo.redesenhar(); });
    this.globo.redesenhar();
    return true;
  }
}

export { fmtNum };
