// Levantamento da Associação: Jardim América e Nova Suíça.
// Lotes classificados por finalidade, limites dos bairros, áreas públicas,
// prédios em 3D e locais de votação, a partir de data/levantamento-nucleo.json (abre o painel) e
// data/levantamento-detalhes.json (fichas e busca, em segundo plano) — scripts/dividir_levantamento.py.
import { noChao } from './globo.js';
import { CFG } from './config.js';
import { el, aviso, fmtNum, pedirJSON, semAcento, memoria } from './util.js';
import { ProvedorLotes, ProvedorDesenho, FILTRO_BAIRROS } from './mapavetorial.js';
import { Postes } from './postes.js';
import { fichaLote, lerClassificacao } from './fichalote.js';
import { Ruas } from './ruas.js';
import { Escolas, NIVEIS, AULAS } from './escolas.js';
import { botaoManutencao, manutencao, relatorioCSV, relatorioImpressao } from './manutencao.js';

const Cesium = window.Cesium;
const R = 6378137;
const mx = (lon) => lon * (Math.PI / 180) * R;
const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
const CORES_LIMITE = ['#ffd54a', '#4fc3f7'];

/** Anel em micrograus com deltas -> [[lon, lat], …]. */
export function decodificarAnel(a) {
  const pts = [];
  let x = 0, y = 0;
  for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; pts.push([x / 1e6, y / 1e6]); }
  return pts;
}

function dentro(aneis, x, y) {
  let d = false;
  for (const a of aneis) for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    const [xi, yi] = a[i], [xj, yj] = a[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}

/** Praças, áreas verdes, canteiros centrais e demais áreas pequenas que não são lotes. */
const ehAreaVerde = (a) => ['Praças', 'Áreas Verdes', 'Canteiros Centrais e Áreas Remanescentes', 'Outras Áreas Públicas'].includes(a.cat);

const comAlfa = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export class Levantamento {
  constructor({ globo, identificar, raiz, sessao }) {
    this.sessao = sessao || { login: '' };
    Object.assign(this, { globo, identificar, raiz });
    this.dados = null;
    this.camadaLotes = null;
    this.fonte = new Cesium.CustomDataSource('levantamento');
    this.ruas = new Ruas({ globo, identificar });
    this.ruas.loteMaisProximo = (lon, lat) => this._loteMaisProximo(lon, lat);
    this.postes = new Postes({ globo, identificar });
    this.escolas = new Escolas({ globo, identificar });
    globo.viewer.dataSources.add(this.fonte);
    const salvo = memoria.ler('bussola:levantamento', {});
    this.opcoes = { limites: true, oficiais: false, lotes: true, imoveis: false, verdes: false, escolas: false, ruas: false, edificacoes: false, eleicao: '', grupos: {}, bocas: false, postes: false, bairros: [true, true], ...salvo.opcoes };
    this.ocultas = new Set(salvo.ocultas || []);
    this.aoMudar = () => {};
    this._montar();
  }

  get ativo() { return !!this.dados && !!this.mostrar; }

  /** Mostra as camadas do levantamento (lotes, limites…) — ao abrir o painel Bairros ou por link. */
  async mostrarBairros() {
    const ass = await this.associacaoDoAcesso();
    if (!ass) {
      // Acesso sem associação cadastrada: nada do levantamento aparece no painel nem no mapa.
      this.mostrar = false;
      this.raiz.textContent = '';
      this.raiz.append(el('p', { class: 'nota' }, 'Nenhuma associação cadastrada para este acesso. Peça à A.M.C. Jardim América o cadastro da sua associação.'));
      return;
    }
    if (!this._tituloFeito) {
      this._tituloFeito = true;
      const outras = ass.ve_todas ? this.associacoes.filter((a) => a !== ass) : [];
      this.raiz.prepend(el('p', { class: 'nota' }, el('strong', {}, ass.nome), ` · ${ass.bairros.join(' e ')}`,
        outras.length ? ` · acesso às demais: ${outras.map((a) => a.nome).join(', ')}` : ''));
    }
    this.mostrar = true;
    await this.carregar();
    this.redesenhar();
  }

  // ------------------------------------------------------------------ dados
  /**
   * Associação do acesso (data/associacoes.json): cada login vê o painel da sua associação; a que tem
   * 've_todas' (A.M.C. Jardim América) vê todas. Sem associação, o painel fica fechado para esse acesso.
   */
  async associacaoDoAcesso() {
    if (this._ass !== undefined) return this._ass;
    try {
      const d = await pedirJSON(`${CFG.dados}associacoes.json`);
      this.associacoes = d.associacoes || [];
      this._ass = this.associacoes.find((a) => (a.logins || []).includes(this.sessao.login)) || null;
    } catch { this.associacoes = []; this._ass = null; }
    return this._ass;
  }

  /**
   * Núcleo do levantamento (levantamento-nucleo.json, ~0,4 MB comprimido): desenho dos lotes, filtros, áreas,
   * bocas de lobo e locais de votação. É pedido já na abertura do sistema (app.js), antes de o painel abrir.
   */
  precarregar() {
    if (!this._nucleo) {
      this._nucleo = pedirJSON(`${CFG.dados}levantamento-nucleo.json`, { tempo: 90000 });
      this._nucleo.catch(() => { this._nucleo = null; });
    }
    return this._nucleo;
  }

  /** Detalhes (fichas, empresas, unidades, busca): chegam em segundo plano. Resolve quando estão prontos. */
  detalhes() {
    return this._detalhes || this.carregar().then(() => this._detalhes);
  }

  async carregar() {
    if (this.dados) return this.dados;
    if (this._carregando) return this._carregando;
    this.estado.textContent = 'Carregando o levantamento…';
    this.estado.classList.add('carregando');
    const predios = pedirJSON(`${CFG.dados}predios.json`, { tempo: 60000 }).catch(() => null);
    const lotesEleitorais = pedirJSON(`${CFG.dados}eleitoral_lotes.json`, { tempo: 60000 }).catch(() => null);
    // Canteiros centrais estimados das avenidas e nomes completos das praças (scripts/canteiros_centrais.py).
    const complemento = pedirJSON(`${CFG.dados}areas_complemento.json`, { tempo: 60000 }).catch(() => null);
    this._carregando = this.precarregar().then(async (d) => {
      this.ix = Object.fromEntries(d.colunas_lote.map((c, i) => [c, i]));
      // Até os detalhes chegarem: tabelas vazias e busca só por quadra e lote.
      this.empresasDoLote = new Map(); this.googleDoLote = new Map(); this.condominioDoLote = new Map(); this.unidadesDoLote = {};
      this.semLote = [];
      d.empresas = d.empresas_ensino || { colunas: [], linhas: [] };   // o filtro de escolas usa só as de ensino
      d.lotes.forEach((l, i) => {
        l.i = i; l.emp = [];
        l.aneis = l.g.map(decodificarAnel);
        l.m = l.aneis.map((a) => a.map(([lo, la]) => [mx(lo), my(la)]));
        let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity, cx = 0, cy = 0;
        for (const [x, y] of l.m[0]) { o = Math.min(o, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); cx += x; cy += y; }
        l.ext = [o, s, e, n];
        l.centro = [cx / l.m[0].length, cy / l.m[0].length];
        l.busca = `qd ${semAcento(String(l.q))} lt ${semAcento(String(l.l))} | quadra ${semAcento(String(l.q))} lote ${semAcento(String(l.l))}`;
      });
      const extra = await complemento;
      if (extra) {
        const nomes = extra.nomes || {};
        const kNome = d.colunas_area.indexOf('Nome / identificação');
        for (const a of d.areas) {
          const novo = nomes[a.nome];
          if (!novo) continue;
          a.tambem = a.nome;
          a.nome = novo;
          if (a.v && kNome >= 0) { a.v = [...a.v]; a.v[kNome] = novo; }
        }
        d.areas.push(...(extra.areas || []));
      }
      for (const a of d.areas) a.aneis = a.g.map(decodificarAnel);
      for (const lim of d.limites) lim.aneisLL = lim.aneis.map(decodificarAnel);
      this.lotesEleitorais = (await lotesEleitorais)?.lotes || {};
      this.cor = Object.fromEntries(d.finalidades.map((f) => [f.nome, f.cor]));
      // Classificação alterada pela Associação (data/lotes_classificacao.json): troca a finalidade (e a cor) do lote.
      lerClassificacao().then((c) => this.aplicarClassificacao(c));
      // Bases dos prédios (predios.json): a torre de cada lote, nunca o terreno inteiro.
      this.basesDoLote = new Map();
      for (const p of (await predios)?.predios || []) {
        const k = `${p.b}|${p.q}|${p.l}`;
        if (!this.basesDoLote.has(k)) this.basesDoLote.set(k, []);
        this.basesDoLote.get(k).push(...[p.f, ...(p.fx || [])].map((anel) => ({ anel, alt: Math.max(p.p, 1) * 3 })));
      }
      this.dados = d;
      this._montarFiltros();
      this.redesenhar();
      this.estado.classList.remove('carregando');
      this._detalhes = this._carregarDetalhes(d);
      this._detalhes.catch((e) => aviso(`Fichas do levantamento indisponíveis: ${e.message}`, 'alerta'));
      return d;
    }).catch((e) => {
      this._carregando = null;
      this.estado.classList.remove('carregando');
      this.estado.textContent = `Não foi possível carregar o levantamento: ${e.message}`;
      throw e;
    });
    return this._carregando;
  }

  /** Junta os detalhes ao núcleo e monta o índice da busca em partes, sem travar a tela. */
  async _carregarDetalhes(d) {
    const x = await pedirJSON(`${CFG.dados}levantamento-detalhes.json`, { tempo: 180000 });
    if (x.gerado_em && d.gerado_em && x.gerado_em !== d.gerado_em) console.warn('Levantamento: detalhes de outra importação', x.gerado_em, d.gerado_em);
    for (const k of ['empresas', 'empresas_sem_lote', 'google', 'condominios', 'unidades', 'iluminacao', 'conferencia', 'conferencia_condominios']) if (x[k]) d[k] = x[k];
    Object.assign(d.eleitoral, x.eleitoral_tabelas || {});
    const ix = this.ix;
    const porLote = (tabela) => {
      const m = new Map();
      for (const r of tabela?.linhas || []) if (Number.isInteger(r.lote)) { if (!m.has(r.lote)) m.set(r.lote, []); m.get(r.lote).push(r.v); }
      return m;
    };
    this.empresasDoLote = porLote(d.empresas);
    this.googleDoLote = porLote(d.google);
    this.condominioDoLote = porLote(d.condominios);
    this.unidadesDoLote = d.unidades?.por_lote || {};
    const ixe = Object.fromEntries(d.empresas.colunas.map((c, i) => [c, i]));
    const pausa = () => new Promise((ok) => setTimeout(ok, 0));
    for (let i = 0; i < d.lotes.length; i++) {
      const l = d.lotes[i];
      l.v = x.lotes_v[i];
      const v = (c) => l.v[ix[c]];
      l.end = v('Endereço (cadastro)'); l.edif = v('Edifício / condomínio'); l.ar = v('Área do comércio (principal)');
      l.emp = String(v('Empresas (nome)') || '').split(';').map((t) => t.trim()).filter(Boolean);
      const emp = (this.empresasDoLote.get(i) || []).map((e) => [e[ixe['CNPJ']], e[ixe['Razão social']], e[ixe['Nome fantasia']], e[ixe['Telefone']], e[ixe['E-mail']]].join(' '));
      const un = (this.unidadesDoLote[i] || []).map((u) => `${u[0]} ${u[2] || ''}`).join(' ');
      l.busca = semAcento([`qd ${l.q} lt ${l.l}`, `quadra ${l.q} lote ${l.l}`, ...l.v.filter((t) => t !== null && t !== ''), emp.join(' '), un].join(' | '));
      if (i % 1500 === 1499) await pausa();
    }
    const ixs = d.empresas_sem_lote.colunas;
    this.semLote = d.empresas_sem_lote.linhas.map((r) => ({ v: r, busca: semAcento(r.filter((t) => t !== null).join(' | ')),
      nome: r[ixs.indexOf('Nome fantasia')] || r[ixs.indexOf('Razão social')], bairro: r[ixs.indexOf('Bairro')] }));
    this.detalhesProntos = true;
    if (this.campo?.value) this._buscar();
    return d;
  }

  _gravar() { memoria.gravar('bussola:levantamento', { opcoes: this.opcoes, ocultas: [...this.ocultas] }); }

  // ------------------------------------------------------------------- painel
  _montar() {
    const chave = (id, titulo, sub) => {
      const caixa = el('input', { type: 'checkbox', id: `lv-${id}`, checked: !!this.opcoes[id],
        onchange: (e) => { this.opcoes[id] = e.target.checked; this._gravar(); if (id === 'edificacoes') this._edificacoes(); else this.redesenhar(); } });
      return el('label', { class: 'linha-chave' }, el('span', {}, el('strong', {}, titulo), sub ? el('small', {}, sub) : null),
        el('span', { class: 'interruptor' }, caixa, el('span', {})));
    };
    this.estado = el('p', { class: 'nota' }, 'Lotes, áreas públicas e locais de votação do levantamento da Associação.');
    this.caixaBairros = el('div', { class: 'lv-bairros' });
    this.legenda = el('ul', { class: 'lv-legenda', 'aria-label': 'Finalidades dos lotes' });
    this.campo = el('input', { class: 'campo', type: 'search', id: 'lv-busca', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Rua, empresa, prédio, “qd 12 lt 5”…', 'aria-label': 'Buscar no levantamento',
      oninput: () => { clearTimeout(this._t); this._t = setTimeout(() => this._buscar(), 200); } });
    this.resultados = el('ul', { class: 'lv-resultados', 'aria-label': 'Resultados no levantamento' });
    this.raiz.append(
      this.estado,
      this.caixaBairros,
      chave('lotes', 'Lotes por finalidade'),
      this.legenda,
      chave('ruas', 'Ruas e avenidas', 'cinza, cada rua com extensão, início e fim'),
      chave('imoveis', 'Imóveis públicos'),
      chave('verdes', 'Praças e áreas verdes'),
      chave('bocas', 'Bocas de lobo'),
      chave('postes', 'Postes'),
      this._chaveEdificacoes = chave('edificacoes', 'Edificações em 3D nestes bairros'),
      el('h3', { class: 'subtitulo' }, 'Pedidos de manutenção'),
      this.caixaManut = el('p', { class: 'nota' }),
      el('div', { class: 'linha-botoes' },
        el('button', { class: 'botao', onclick: () => relatorioImpressao() }, 'Relatório para imprimir'),
        el('button', { class: 'botao-texto', onclick: () => relatorioCSV() }, 'Baixar planilha (CSV)')),
      el('h3', { class: 'subtitulo' }, 'Buscar no levantamento'),
      this.campo, this.resultados);
  }

  _montarFiltros() {
    const d = this.dados;
    this.caixaBairros.textContent = '';
    d.limites.forEach((lim, i) => {
      const nome = d.bairros[i] || lim.nome;
      this.caixaBairros.append(el('label', { class: 'lv-bairro' },
        el('input', { type: 'checkbox', checked: this.opcoes.bairros[i] !== false,
          onchange: (e) => { this.opcoes.bairros[i] = e.target.checked; this._gravar(); this.redesenhar(); } }),
        el('span', { class: 'lv-cor', style: `background:${CORES_LIMITE[i % 2]}` }),
        el('span', {}, el('strong', {}, nome), el('small', {}, `${fmtNum(lim.lotes)} lotes`)),
        el('button', { class: 'botao-texto', type: 'button', onclick: (e) => { e.preventDefault(); this.irParaBairro(i); } }, 'Ir')));
    });
    this._montarLegenda();
    this.estado.textContent = `${fmtNum(d.lotes.length)} lotes, ${fmtNum(d.contagem?.empresas ?? (d.empresas.linhas.length + (d.empresas_sem_lote?.linhas.length || 0)))} empresas, ` +
      `${fmtNum(d.areas.length)} áreas públicas e ${fmtNum(d.eleitoral.pontos.length)} locais de votação.`;
    this._contarPedidos();
    if (this.caixaEleitoral) this._montarEleitoral();
    if (this.opcoes.edificacoes) this._edificacoes();
  }

  /**
   * Lotes por finalidade em grupos: Residencial (com os condomínios residencial e horizontal), Comercial (com o
   * condomínio comercial), Misto (com o condomínio misto), Público, Religioso, Lote vago e Não identificado.
   */
  _montarLegenda() {
    const d = this.dados, porNome = Object.fromEntries(d.finalidades.map((f) => [f.nome, f]));
    const GRUPOS = [
      ['Residencial', ['Residencial', 'Condomínio residencial', 'Condomínio horizontal (casas)']],
      ['Comercial', ['Comercial', 'Condomínio comercial']],
      ['Misto', ['Misto', 'Condomínio misto']], ['Público', ['Institucional / Público']],
      ['Religioso', ['Religioso']], ['Lote vago', ['Lote vago']], ['Não identificado', ['Não identificado']],
    ];
    const usados = new Set(GRUPOS.flatMap(([, i]) => i));
    for (const f of d.finalidades) if (!usados.has(f.nome)) GRUPOS.push([f.nome, [f.nome]]); // finalidade nova não se perde
    const alternar = (nomes, ver) => { for (const n of nomes) (ver ? this.ocultas.delete(n) : this.ocultas.add(n)); this._gravar(); this._montarLegenda(); this.redesenhar(); };
    this.legenda.textContent = '';
    for (const [grupo, nomes] of GRUPOS) {
      const itens = nomes.map((n) => porNome[n]).filter(Boolean);
      if (!itens.length) continue;
      const vistos = itens.filter((f) => !this.ocultas.has(f.nome)).length;
      const caixa = el('input', { type: 'checkbox', checked: vistos === itens.length, onchange: (e) => alternar(itens.map((f) => f.nome), e.target.checked) });
      caixa.indeterminate = vistos > 0 && vistos < itens.length;
      const total = itens.reduce((t, f) => t + f.n, 0);
      const li = el('li', { class: 'lv-grupo-fin' }, el('label', {}, caixa,
        el('span', { class: 'lv-cor', style: `background:${itens[0].cor}` }), el('span', {}, el('strong', {}, grupo)), el('small', {}, fmtNum(total))));
      if (itens.length > 1 || itens[0].nome !== grupo) {
        li.append(el('ul', { class: 'lv-sub' }, itens.map((f) => el('li', {}, el('label', {},
          el('input', { type: 'checkbox', checked: !this.ocultas.has(f.nome), onchange: (e) => alternar([f.nome], e.target.checked) }),
          el('span', { class: 'lv-cor', style: `background:${f.cor}` }), el('span', {}, f.nome), el('small', {}, fmtNum(f.n)))))));
      }
      this.legenda.append(li);
    }
    this._legendaEscolas(alternar);
  }

  /**
   * Escolas e cursos dentro de "Lotes por finalidade": o lote (ou a área pública) da escola é pintado como as demais
   * finalidades, com um marcador pequeno e o nome em cima ("Infantil - Público - Nome"). Subitens: públicas,
   * particulares, cada nível de ensino e os cursos.
   */
  _legendaEscolas() {
    this.escolas.preparar(this);
    const f = (this.opcoes.escolasFiltro ||= { publica: true, particular: true, infantil: true, fundamental: true, medio: true, superior: true, aulas: true });
    const conta = this.escolas.contagem();
    const porNivel = (id) => this.escolas.itens.filter((i) => i.tipo !== 'aulas' && i.niveis.includes(id)).length;
    const mudar = () => { this._gravar(); this.redesenhar(); };
    const sub = (id, nome, cor, n, cor2) => el('li', {}, el('label', {},
      el('input', { type: 'checkbox', checked: f[id] !== false, onchange: (e) => { f[id] = e.target.checked; mudar(); } }),
      el('span', { class: 'lv-cores' }, el('span', { class: 'lv-cor', style: `background:${cor}` }), cor2 ? el('span', { class: 'lv-cor', style: `background:${cor2}` }) : null),
      el('span', {}, nome), el('small', {}, fmtNum(n))));
    const caixa = el('input', { type: 'checkbox', id: 'lv-escolas', checked: !!this.opcoes.escolas, onchange: (e) => { this.opcoes.escolas = e.target.checked; mudar(); } });
    this.legenda.append(el('li', { class: 'lv-grupo-fin' }, el('label', {}, caixa,
      el('span', { class: 'lv-cor', style: 'background:#2e7d32' }), el('span', {}, el('strong', {}, 'Escolas e cursos')),
      el('small', {}, fmtNum(this.escolas.itens.length))),
    el('ul', { class: 'lv-sub' },
      sub('publica', 'Públicas (verde escuro)', '#2e7d32', conta.publica),
      sub('particular', 'Particulares (verde claro)', '#8de0a0', conta.particular),
      ...NIVEIS.map((n) => sub(n.id, n.nome, n.cor, porNivel(n.id), n.corPublica)),
      sub('aulas', `Cursos (idiomas, lutas, dança, música e outros)`, AULAS.cor, conta.aulas))));
  }

  /** Liga/desliga as edificações em 3D só nos dois bairros (mesmo motor das Edificações da cidade). */
  _edificacoes() {
    if (!this.dados || !this.aoEdificacoes) return Promise.resolve();
    return Promise.all(this.dados.limites.map((lim, i) => {
      const id = ['000400000015', '000400000017'][i] || `lv-${i}`;
      return this.aoEdificacoes(id, this.dados.bairros[i] || lim.nome, !!this.opcoes.edificacoes && this.opcoes.bairros[i] !== false, lim.aneisLL);
    }));
  }

  /** Controles eleitorais montados em outra caixa (Camadas → Zonas Eleitorais). */
  async montarEleitoralEm(caixa) {
    this.caixaEleitoral = caixa;
    caixa.textContent = 'Carregando os locais de votação…';
    await this.carregar();
    this._montarEleitoral();
  }

  /** Modo eleitoral: '' (desligado), 'geral' (eleição 2026 por zona) ou 'ct' (Conselho Tutelar 2023). */
  async definirEleicao(m) {
    this.opcoes.eleicao = m;
    this._gravar();
    if (m) await this.carregar();
    if (this.caixaEleitoral && this.dados) this._montarEleitoral();
    this.redesenhar();
  }

  _montarEleitoral() {
    const d = this.dados.eleitoral, c = this.caixaEleitoral;
    c.textContent = '';
    this.opcoes.eleicao ??= '';
    this.opcoes.grupos ??= {};
    const zonas = [...new Set(d.pontos.filter((p) => p.tipo === 'geral').map((p) => p.grupo))].sort((a, b) => parseInt(a) - parseInt(b));
    const regioes = [...new Set(d.pontos.filter((p) => p.tipo === 'ct' || p.tipo === 'transferido').map((p) => p.grupo))].sort();
    const seletor = el('select', { class: 'campo', id: 'lv-eleicao', 'aria-label': 'Eleição' },
      el('option', { value: '' }, 'Locais de votação desligados'), el('option', { value: 'geral' }, 'Eleição geral 2026 — locais por zona'),
      el('option', { value: 'ct' }, 'Conselho Tutelar 2023 — locais por região'));
    seletor.value = this.opcoes.eleicao;
    const lista = el('div', { class: 'lv-grupos' });
    const montarGrupos = () => {
      lista.textContent = '';
      const m = this.opcoes.eleicao;
      if (!m) return;
      const grupos = m === 'geral' ? zonas : [...regioes, 'Sem informação no edital'];
      for (const g of grupos) {
        const chaveG = `${m}:${g}`;
        const n = m === 'geral' ? d.pontos.filter((p) => p.tipo === 'geral' && p.grupo === g).length
          : g === 'Sem informação no edital' ? d.pontos.filter((p) => p.tipo === 'sem').length
          : d.pontos.filter((p) => p.grupo === g && p.tipo === 'ct').length;
        lista.append(el('label', { class: 'lv-grupo' },
          el('input', { type: 'checkbox', checked: this.opcoes.grupos[chaveG] !== false,
            onchange: (e) => { this.opcoes.grupos[chaveG] = e.target.checked; this._gravar(); this.redesenhar(); } }),
          el('span', {}, g), el('small', {}, `${fmtNum(n)} locais`)));
      }
      if (m === 'ct') {
        lista.append(el('p', { class: 'nota' }, 'Laranja com borda amarela: colégio com votação do Conselho Tutelar. Cinza com borda branca: colégio sem votação (transferido ou sem informação), com linha tracejada até o colégio que recebeu as urnas.'));
      }
    };
    seletor.addEventListener('change', () => { this.opcoes.eleicao = seletor.value; this._gravar(); montarGrupos(); this.redesenhar(); });
    c.append(seletor, lista);
    montarGrupos();
  }

  irParaBairro(i) {
    const lim = this.dados?.limites[i];
    if (!lim) return;
    const pts = lim.aneisLL.flat();
    const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
    this.globo.voarPara({ extensao: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)], inclinacao: -60 });
  }

  /** Lote do levantamento mais próximo de um ponto (referência de início e fim das ruas). */
  _loteMaisProximo(lon, lat) {
    if (!this.dados) return null;
    const x = mx(lon), y = my(lat);
    let melhor = null, dm = Infinity;
    for (const l of this.dados.lotes) {
      if (x < l.ext[0] - 80 || x > l.ext[2] + 80 || y < l.ext[1] - 80 || y > l.ext[3] + 80) continue;
      const d = Math.hypot(l.centro[0] - x, l.centro[1] - y);
      if (d < dm) { dm = d; melhor = l; }
    }
    return melhor;
  }

  _lotesVisiveis() {
    return this.dados.lotes.filter((l) => this.opcoes.bairros[l.b] !== false && !this.ocultas.has(l.f));
  }

  // ------------------------------------------------------------------ desenho
  /** Aplica classificações gravadas (bairro|quadra|lote -> finalidade) e redesenha se algo mudou. */
  aplicarClassificacao(mapa) {
    const d = this.dados;
    if (!d?.lotes || !mapa) return;
    let mudou = false;
    for (const l of d.lotes) {
      const nova = mapa[`${d.bairros[l.b]}|${l.q}|${l.l}`];
      if (nova && this.cor?.[nova] && l.f !== nova) { l.f = nova; mudou = true; }
    }
    if (mudou && this.mostrar) this.redesenhar();
  }

  redesenhar() {
    if (!this.dados) return;
    const d = this.dados, camadas = this.globo.viewer.imageryLayers;
    // Alternância rápida: divisas, bocas de lobo e áreas são criadas uma vez (this.fixos) e só mudam de
    // visibilidade; a camada dos lotes só é refeita quando bairros, finalidades ou o fundo mudam.
    this.fonte.entities.removeAll();                         // só os nomes dos locais de votação, refeitos abaixo
    const nomeBairro = (b) => d.bairros.indexOf(b);
    const bairroVisivel = (b) => { const i = nomeBairro(b); return i < 0 || this.opcoes.bairros[i] !== false; };
    // Escolas e cursos (em "Lotes por finalidade"): o lote da escola particular ou do curso e a área pública da
    // escola pública são pintados na camada dos lotes, na cor do nível.
    const escolas = this.mostrar && this.opcoes.escolas && this.escolas.itens ? this.escolas.visiveis(this.opcoes.escolasFiltro || {}, bairroVisivel) : [];
    const sinal = this.opcoes.bairros.map((b) => (b === false ? 0 : 1)).join('');
    const assinaturaLotes = this.mostrar && (this.opcoes.lotes || escolas.length)
      ? `${sinal}|${this.globo.chaveBase === 'mapa' ? 'm' : 's'}|${this.opcoes.lotes ? [...this.ocultas].sort().join(',') : '-'}|${escolas.map((e) => `${e.i.lote?.i ?? e.i.nome}:${e.cor}`).join(',')}` : '';
    if (assinaturaLotes !== this._assinaturaLotes) {
      this._assinaturaLotes = assinaturaLotes;
      if (this.camadaLotes) { camadas.remove(this.camadaLotes, true); this.camadaLotes = null; }
      const corEscola = new Map(escolas.filter((e) => e.i.lote).map((e) => [e.i.lote.i, e.cor]));
      const base = assinaturaLotes && this.opcoes.lotes ? this._lotesVisiveis() : [];
      const lotes = base.map((l) => ({ aneis: l.m, ext: l.ext, centro: l.centro, nm: l.l, q: l.q, cor: comAlfa(corEscola.get(l.i) || this.cor[l.f] || '#9aa3ad', corEscola.has(l.i) ? 0.75 : 0.5) }));
      const vistos = new Set(base.map((l) => l.i));
      for (const e of escolas) {
        if (e.i.lote && !vistos.has(e.i.lote.i)) {          // lote da escola com "Lotes por finalidade" desligado
          const l = e.i.lote; vistos.add(l.i);
          lotes.push({ aneis: l.m, ext: l.ext, centro: l.centro, nm: l.l, q: l.q, cor: comAlfa(e.cor, 0.75) });
        } else if (e.i.area) {                                // escola pública: a área pública inteira
          const m = e.i.area.aneis.map((a) => a.map(([lo, la]) => [mx(lo), my(la)]));
          let o = Infinity, s0 = Infinity, ee = -Infinity, n = -Infinity;
          for (const [x, y] of m[0]) { o = Math.min(o, x); ee = Math.max(ee, x); s0 = Math.min(s0, y); n = Math.max(n, y); }
          lotes.push({ aneis: m, ext: [o, s0, ee, n], centro: [(o + ee) / 2, (s0 + n) / 2], nm: '', cor: comAlfa(e.cor, 0.75) });
        }
      }
      if (lotes.length) {
        let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const l of lotes) { o = Math.min(o, l.ext[0]); s = Math.min(s, l.ext[1]); e = Math.max(e, l.ext[2]); n = Math.max(n, l.ext[3]); }
        const g = (x, y) => [Cesium.Math.toDegrees(x / R), Cesium.Math.toDegrees(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2)];
        const [ow, ss] = g(o, s), [le, nn] = g(e, n);
        const ret = Cesium.Rectangle.fromDegrees(ow, ss, le, nn);
        // Número do lote: só este (o do levantamento); o desenho cadastral de baixo não escreve número dentro dos
        // bairros da Associação, para não sair dois números (ou "2,3" ao lado de "2" e "3") no mesmo lote.
        this.camadaLotes = new Cesium.ImageryLayer(new ProvedorLotes({ lotes, retangulo: ret, borda: 'rgba(255,255,255,.55)',
          rotulos: () => true, estiloRotulo: () => (this.globo.chaveBase === 'mapa' ? 'mapa' : 'sobre'),
          credito: 'Levantamento da Associação', nivelMinimo: 11 }), { rectangle: ret });
        camadas.add(this.camadaLotes);
        this.globo.organizarPilha();
      }
      const sem = !!(this.mostrar && this.opcoes.lotes);
      if (sem !== !!FILTRO_BAIRROS.semNumeroDeLote) { FILTRO_BAIRROS.semNumeroDeLote = sem; this.aoMudarNumeros?.(); }
    }

    this._montarFixos();
    for (const ent of this.fixos.entities.values) {
      const f = ent.lvFixo;
      ent.show = this.mostrar && (f.grupo === 'limite' ? this.opcoes.bairros[f.i] !== false
        : f.grupo === 'boca' ? !!this.opcoes.bocas && bairroVisivel(f.bairro)
        : (f.verde ? !!this.opcoes.verdes : !!this.opcoes.imoveis) && (f.i < 0 || this.opcoes.bairros[f.i] !== false));
    }
    // Postes em 3D (haste, bola da tensão, transformador e braço da luminária), só nos bairros visíveis.
    this.postes.mostrar(this.mostrar && !!this.opcoes.postes, bairroVisivel).catch((e) => aviso(`Postes indisponíveis: ${e.message}`, 'alerta'));

    if (this.escolas.itens) this.escolas.mostrar(this.mostrar && !!this.opcoes.escolas, this.opcoes.escolasFiltro, bairroVisivel);
    this._filtroDoMapa();
    this._desenharEleitoral();
    // Ruas do bairro: cada uma é um marcador próprio, em toda a extensão dentro do bairro (ruas.js).
    const bairrosRuas = this.mostrar && this.opcoes.ruas ? d.limites.map((lim, i) => (this.opcoes.bairros[i] === false ? null
      : { nome: d.bairros[i] || lim.nome || `Bairro ${i + 1}`, aneis: d.limites_oficiais?.[i]?.aneis.map(decodificarAnel) || lim.aneisLL })).filter(Boolean) : [];
    const chaveRuas = bairrosRuas.map((b) => b.nome).join('|');
    if (chaveRuas !== this._chaveRuas) { this._chaveRuas = chaveRuas; this.ruas.mostrar(bairrosRuas.length > 0, bairrosRuas).catch(() => {}); }
    this.globo.organizarPilha();
    this.globo.redesenhar();
    this.aoMudar();
  }

  /** Divisas dos bairros, bocas de lobo e áreas públicas: criadas uma vez só; redesenhar() só liga e desliga. */
  _montarFixos() {
    if (this._fixosProntos) return;
    const d = this.dados;
    if (!this.fixos) { this.fixos = new Cesium.CustomDataSource('levantamento-fixos'); this.globo.viewer.dataSources.add(this.fixos); }
    const add = (lvFixo, def, levantamento) => {
      const ent = this.fixos.entities.add({ show: false, ...def }); ent.lvFixo = lvFixo; if (lvFixo.ll) ent.ll = lvFixo.ll;
      if (levantamento) ent.levantamento = levantamento;
    };
    this.fixos.entities.suspendEvents();
    d.limites.forEach((lim, i) => {
      const cor = Cesium.Color.fromCssColorString(CORES_LIMITE[i % 2]);
      // Divisa única do sistema: o limite oficial do Mapa Fácil (todos os lotes do bairro ficam dentro dele), no
      // mesmo padrão das divisas de todos os bairros — preta, amarela e preta (#000000, #FFFF00, #000000).
      const oficial = d.limites_oficiais?.[i];
      const aneis = oficial ? oficial.aneis.map(decodificarAnel) : lim.aneisLL;
      for (const anel of aneis) {
        const pos = Cesium.Cartesian3.fromDegreesArray([...anel, anel[0]].flat());
        add({ grupo: 'limite', i }, { polyline: { positions: pos, clampToGround: true, width: 6, zIndex: 0, material: Cesium.Color.fromCssColorString('#000000') } });
        add({ grupo: 'limite', i }, { polyline: { positions: pos, clampToGround: true, width: 2, zIndex: 1, material: Cesium.Color.fromCssColorString('#FFFF00') } });
      }
      const pts = lim.aneisLL[0];
      const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
      add({ grupo: 'limite', i, ll: [c[0], c[1]] }, { position: noChao(c[0], c[1]), label: {
        text: d.bairros[i] || lim.nome, font: '700 17px system-ui, "Segoe UI", Roboto, sans-serif',
        fillColor: cor, outlineColor: Cesium.Color.BLACK, outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(2500, 60000) } });
    });
    const cb = d.bocas.colunas, kla = cb.indexOf('Latitude'), klo = cb.indexOf('Longitude'), kb = cb.indexOf('Bairro');
    const kc = cb.indexOf('Código para manutenção'), kn = cb.indexOf('Unidades em sequência');
    for (const b of d.bocas.linhas) {
      const codigo = b.v[kc];
      const ent = this.fixos.entities.add({ show: false, position: noChao(b.v[klo], b.v[kla]),
        billboard: { image: this._iconeBoca(b.v[kn], manutencao.tem(codigo), /alerta/.test(b.icone || '')), width: 30, height: 30,
          // Cresce ao aproximar e diminui ao afastar a câmera, como os demais marcadores do mapa.
          scaleByDistance: new Cesium.NearFarScalar(120, 1.5, 2500, 0.3),
          disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000) } });
      ent.lvFixo = { grupo: 'boca', bairro: b.v[kb], codigo, n: b.v[kn], alerta: /alerta/.test(b.icone || '') };
      ent.levantamento = { tipo: 'boca', dado: b };
      ent.ll = [b.v[klo], b.v[kla]];
    }
    for (const a of d.areas) {
      const verde = ehAreaVerde(a), i = a.bai ? d.bairros.indexOf(a.bai) : -1;
      for (const anel of a.aneis) {
        add({ grupo: 'area', verde, i }, { polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(anel.flat()),
          material: Cesium.Color.fromCssColorString(verde ? '#2e9d57' : '#5c6bc0').withAlpha(0.5), classificationType: Cesium.ClassificationType.TERRAIN } }, { tipo: 'area', dado: a });
      }
    }
    this.fixos.entities.resumeEvents();
    this._fixosProntos = true;
  }

  /**
   * Ícone da boca de lobo: grelha escura com contorno branco e o número de unidades num mostrador branco. Com pedido
   * de manutenção, contorno e mostrador ficam vermelhos (laranja: observação do levantamento).
   */
  _iconeBoca(n, pedido, alerta) {
    const chave = `${n}|${pedido ? 1 : 0}|${alerta ? 1 : 0}`;
    this._icones ||= new Map();
    if (this._icones.has(chave)) return this._icones.get(chave);
    const T = 64, c = document.createElement('canvas'); c.width = c.height = T;
    const g = c.getContext('2d');
    const borda = pedido ? '#e53935' : alerta ? '#ff9800' : '#ffffff';
    g.lineJoin = 'round';
    // grelha
    const x0 = 6, y0 = 16, w = 44, h = 38;
    g.fillStyle = '#23272c'; g.strokeStyle = '#000000'; g.lineWidth = 7;
    g.beginPath(); g.roundRect ? g.roundRect(x0, y0, w, h, 6) : g.rect(x0, y0, w, h); g.stroke();
    g.strokeStyle = borda; g.lineWidth = 4; g.stroke(); g.fill();
    g.fillStyle = '#c9cfd6';
    for (let i = 0; i < 5; i++) g.fillRect(x0 + 6 + i * 7.6, y0 + 9, 3.6, h - 15);
    g.fillRect(x0 + 4, y0 + 4, w - 8, 3);
    // mostrador com o número de unidades
    const r = 13, cx = T - r - 2, cy = r + 2;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = pedido ? '#e53935' : '#ffffff'; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = '#000000'; g.stroke();
    g.fillStyle = pedido ? '#ffffff' : '#111418';
    g.font = '800 17px system-ui, "Segoe UI", Roboto, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n || 1), cx, cy + 1);
    this._icones.set(chave, c);
    return c;
  }

  /** Depois de pedir (ou retirar) manutenção: bocas de lobo com o pedido ficam vermelhas. */
  _atualizarBocas() {
    if (!this.fixos) return;
    for (const ent of this.fixos.entities.values) {
      const f = ent.lvFixo;
      if (f?.grupo === 'boca') ent.billboard.image = this._iconeBoca(f.n, manutencao.tem(f.codigo), f.alerta);
    }
    this.globo.redesenhar();
  }

  // --------------------------------------------------------------- eleitoral
  /** Lote do colégio de cada local (data/eleitoral_lotes.json); sem lote, um quadrado de ~30 m no ponto. */
  _loteDoLocal(p) {
    const k = `${p.lon},${p.lat}`;
    if (!this._lotesLocais) this._lotesLocais = new Map();
    if (this._lotesLocais.has(k)) return this._lotesLocais.get(k);
    const l = this.lotesEleitorais?.[k];
    const aneisLL = l?.aneis || [[[p.lon - 0.00014, p.lat - 0.00014], [p.lon + 0.00014, p.lat - 0.00014], [p.lon + 0.00014, p.lat + 0.00014], [p.lon - 0.00014, p.lat + 0.00014]]];
    const m = aneisLL.map((a) => a.map(([lo, la]) => [mx(lo), my(la)]));
    let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity, cx = 0, cy = 0;
    for (const [x, y] of m[0]) { o = Math.min(o, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); cx += x; cy += y; }
    const r = { aneisLL, m, ext: [o, s, e, n], centro: [cx / m[0].length, cy / m[0].length], lote: l || null };
    this._lotesLocais.set(k, r);
    return r;
  }

  /**
   * Locais de votação como o lote inteiro do colégio: cor e borda fortes e o nome em cima.
   * Conselho Tutelar: colégio sem votação (transferido ou sem informação) em cinza com borda branca e
   * linha tracejada até o colégio que recebeu as urnas, que fica com a cor normal.
   */
  _desenharEleitoral() {
    const camadas = this.globo.viewer.imageryLayers;
    if (this.camadaEleitoral) { camadas.remove(this.camadaEleitoral, true); this.camadaEleitoral = null; }
    this._locaisVisiveis = [];
    const m = this.opcoes.eleicao;
    if (!m || !this.dados) return;
    const E = this.dados.eleitoral;
    const ve = (g) => (this.opcoes.grupos || {})[`${m}:${g}`] !== false;
    const pontos = E.pontos.filter((p) => (m === 'geral' ? p.tipo === 'geral' && ve(p.grupo)
      : (p.tipo === 'ct' || p.tipo === 'transferido') ? ve(p.grupo) : p.tipo === 'sem' && ve('Sem informação no edital')));
    const COR = { votacao: ['rgba(255,109,0,.62)', '#ffea00'], semVotacao: ['rgba(150,150,150,.72)', '#ffffff'] };
    const poligonos = [];
    for (const p of pontos) {
      if (!(p.lon > -49.6 && p.lon < -48.9 && p.lat > -17 && p.lat < -16.3)) continue; // coordenada inválida no levantamento
      const l = this._loteDoLocal(p);
      const [cor, borda] = p.tipo === 'geral' || p.tipo === 'ct' ? COR.votacao : COR.semVotacao;
      poligonos.push({ aneis: l.m, ext: l.ext, centro: l.centro, cor, borda, largura: 3.2 });
      this._locaisVisiveis.push({ p, l });
    }
    this._rotulando = this._rotularLocais();
    const linhas = [];
    if (m === 'ct') {
      for (const s of E.setas) {
        if (!ve(s.regiao)) continue;
        const de = this._loteDoLocal({ lon: s.de[0], lat: s.de[1] }), para = this._loteDoLocal({ lon: s.para[0], lat: s.para[1] });
        linhas.push({ de: de.centro, para: para.centro, cor: '#ffffff', contorno: 'rgba(0,0,0,.6)', largura: 3, tracejado: true });
      }
    }
    if (!poligonos.length) return;
    let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of poligonos) { o = Math.min(o, p.ext[0]); s = Math.min(s, p.ext[1]); e = Math.max(e, p.ext[2]); n = Math.max(n, p.ext[3]); }
    const g = (x, y) => [Cesium.Math.toDegrees(x / R), Cesium.Math.toDegrees(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2)];
    const folga = 300;
    const [ow, ss] = g(o - folga, s - folga), [le, nn] = g(e + folga, n + folga);
    const ret = Cesium.Rectangle.fromDegrees(ow, ss, le, nn);
    this.camadaEleitoral = new Cesium.ImageryLayer(new ProvedorDesenho({ poligonos, linhas, retangulo: ret,
      credito: 'Locais de votação: TSE e CMDCA (levantamento da Associação); lotes: Mapa Fácil' }), { rectangle: ret });
    camadas.add(this.camadaEleitoral);
    this.globo.organizarPilha();
  }

  /**
   * Nome de cada colégio em cima do lote. A altitude do terreno é lida uma vez e guardada: rótulo preso
   * ao chão (CLAMP_TO_GROUND) recalcula a altura a cada quadro e era o que travava o Conselho Tutelar.
   */
  async _rotularLocais() {
    const vez = (this._vezRotulos = (this._vezRotulos || 0) + 1);
    const locais = this._locaisVisiveis || [];
    this._altLocais ||= new Map();
    const graus = (c) => [Cesium.Math.toDegrees(c[0] / R), Cesium.Math.toDegrees(2 * Math.atan(Math.exp(c[1] / R)) - Math.PI / 2)];
    const faltam = locais.filter(({ l }) => !this._altLocais.has(`${this.globo.relevoAtivo}|${l.centro.join()}`));
    if (faltam.length) {
      const alts = await this.globo.altitudes(faltam.map(({ l }) => graus(l.centro))).catch(() => faltam.map(() => 0));
      faltam.forEach(({ l }, k) => this._altLocais.set(`${this.globo.relevoAtivo}|${l.centro.join()}`, Number.isFinite(alts[k]) ? alts[k] : 0));
      if (vez !== this._vezRotulos) return;
    }
    const exagero = this.globo.cena.verticalExaggeration || 1;
    for (const { p, l } of locais) {
      const [lo, la] = graus(l.centro);
      const votacao = p.tipo === 'geral' || p.tipo === 'ct';
      const ent = this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(lo, la, (this._altLocais.get(`${this.globo.relevoAtivo}|${l.centro.join()}`) + 6) * exagero),
        label: { text: p.nome.replace(/\s+-\s+[A-Z]{2}-[A-Z]{2,4}$/, ''), font: '700 12.5px system-ui, "Segoe UI", Roboto, sans-serif',
          fillColor: votacao ? Cesium.Color.WHITE : Cesium.Color.fromCssColorString('#e0e0e0'),
          outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3500) } });
      ent.levantamento = { tipo: 'ponto', dado: p };
    }
    this.globo.redesenhar();
  }

  /**
   * Com o painel Bairros aberto, o mapa (quadras, lotes e números de quadra) mostra só os bairros marcados; com o
   * painel fechado, volta a mostrar a cidade inteira.
   */
  _filtroDoMapa() {
    const d = this.dados;
    let aneis = null, ext = null;
    if (this.mostrar && d) {
      aneis = [];
      d.limites.forEach((lim, i) => {
        if (this.opcoes.bairros[i] === false) return;
        const of = d.limites_oficiais?.[i];
        const ll = of ? of.aneis.map(decodificarAnel) : lim.aneisLL;
        aneis.push(ll.map((a) => a.map(([lo, la]) => [mx(lo), my(la)])));
      });
      ext = [Infinity, Infinity, -Infinity, -Infinity];
      for (const an of aneis) for (const a of an) for (const [x, y] of a) { ext[0] = Math.min(ext[0], x); ext[1] = Math.min(ext[1], y); ext[2] = Math.max(ext[2], x); ext[3] = Math.max(ext[3], y); }
      if (!aneis.length) ext = [0, 0, 0, 0]; // nenhum bairro marcado: nada de quadras e lotes
    }
    const assinatura = JSON.stringify(ext);
    if (assinatura === this._assinaturaFiltro) return;
    this._assinaturaFiltro = assinatura;
    FILTRO_BAIRROS.aneis = aneis;
    FILTRO_BAIRROS.ext = ext;
    this.aoMudarFiltroMapa?.();
  }

  /** Clique dentro do lote de um colégio de votação. */
  _localNoPonto(x, y) {
    return (this._locaisVisiveis || []).find(({ l }) => x >= l.ext[0] && x <= l.ext[2] && y >= l.ext[1] && y <= l.ext[3] && dentro(l.m, x, y))?.p;
  }

  // ------------------------------------------------------------------- busca
  _buscar() {
    const q = semAcento(this.campo.value);
    this.resultados.textContent = '';
    if (!this.dados || q.length < 2) return;
    if (!this.detalhesProntos) {
      this.resultados.append(el('li', { class: 'nota' }, 'Carregando os dados da busca…'));
      this.detalhes().then(() => this._buscar()).catch(() => {});
      return;
    }
    const termos = q.split(/\s+/);
    const achados = this._lotesVisiveis().filter((l) => termos.every((t) => l.busca.includes(t))).slice(0, 40);
    const cod = this.campo.value.trim().toUpperCase();
    if (/^(BL|IP)-(JA|NS|EN)-\d+$/.test(cod)) {
      const t = cod.startsWith('BL') ? this.dados.bocas : this.dados.iluminacao, k = t.colunas.indexOf('Código para manutenção');
      const item = t.linhas.find((x) => x.v[k] === cod);
      if (item) {
        const lat = item.v[t.colunas.indexOf('Latitude')], lon = item.v[t.colunas.indexOf('Longitude')];
        this.resultados.append(el('li', {}, el('button', { class: 'lv-resultado', onclick: () => {
          (cod.startsWith('BL') ? this.abrirBoca(item) : this.abrirPoste(item)); this.globo.voarPara({ lon, lat, distancia: 250, inclinacao: -55 }); } },
          el('span', { class: 'lv-cor', style: 'background:#4fc3f7' }), el('span', {}, el('strong', {}, cod), el('small', {}, cod.startsWith('BL') ? 'Boca de lobo' : 'Iluminação pública')))));
      }
    }
    const semLote = this.semLote.filter((e) => termos.every((t) => e.busca.includes(t))).slice(0, 20);
    if (!achados.length && !semLote.length && !this.resultados.children.length) { this.resultados.append(el('li', { class: 'nota' }, 'Nada encontrado nos lotes visíveis nem nas empresas sem lote.')); return; }
    for (const e of semLote) {
      this.resultados.append(el('li', {}, el('button', { class: 'lv-resultado', onclick: () => this.abrirEmpresaSemLote(e) },
        el('span', { class: 'lv-cor', style: 'background:transparent;border-style:dashed' }),
        el('span', {}, el('strong', {}, e.nome || 'Empresa'), el('small', {}, `${e.bairro || ''} · empresa sem lote identificado`)))));
    }
    for (const l of achados) {
      this.resultados.append(el('li', {}, el('button', { class: 'lv-resultado', onclick: () => this.abrirLote(l, true) },
        el('span', { class: 'lv-cor', style: `background:${this.cor[l.f]}` }),
        el('span', {}, el('strong', {}, l.edif || (l.emp && l.emp[0]) || l.end || `Qd ${l.q} Lt ${l.l}`),
          el('small', {}, `${this.dados.bairros[l.b]} · Qd ${l.q} Lt ${l.l} · ${l.ar || l.f}`)))));
    }
  }

  // -------------------------------------------------------------- cliques e ficha
  /** Clique no mapa: devolve true se tratou (lote, área ou local do levantamento). */
  aoClicar(pego, ponto) {
    if (!this.dados) return false;
    if (this.postes.aoClicar(pego)) return true;
    if (this.ruas.aoClicar(pego)) return true;
    if (this.escolas.aoClicar(pego, (a) => this.abrirArea(a), (l) => this.abrirLote(l, true))) return true;
    const lv = pego?.id?.levantamento;
    if (lv) {
      if (lv.tipo === 'boca' && pego.id.billboard) {
        const b = pego.id.billboard;
        this.abrirBoca(lv.dado);
        b.scale = 1.6; b.color = Cesium.Color.WHITE.brighten(0.3, new Cesium.Color());
        this.identificar.selecionar(() => { b.scale = 1; b.color = Cesium.Color.WHITE; this.globo.redesenhar(); });
        this.globo.redesenhar();
        return true;
      }
      if (lv.tipo === 'lote') this.abrirLote(lv.dado);
      else if (lv.tipo === 'area') this.abrirArea(lv.dado);
      else if (lv.tipo === 'seta') this.abrirSeta(lv.dado);
      else if (lv.tipo === 'boca') this.abrirBoca(lv.dado);
      else this.abrirPonto(lv.dado);
      return true;
    }
    if (!ponto) return false;
    const x = mx(ponto.lon), y = my(ponto.lat);
    const local = this.opcoes.eleicao ? this._localNoPonto(x, y) : null;
    if (local) { this.abrirPonto(local); return true; }
    if (!this.mostrar || !this.opcoes.lotes) return false;
    // Lote só com a câmera a 2,5 km ou menos; acima disso o clique seleciona a quadra (até 5 km) ou o bairro.
    if (this.globo.camera.positionCartographic.height > 2500) return false;
    const l = this._lotesVisiveis().find((t) => x >= t.ext[0] && x <= t.ext[2] && y >= t.ext[1] && y <= t.ext[3] && dentro(t.m, x, y));
    if (!l) return false;
    this.abrirLote(l);
    return true;
  }

  /** Tabela com todas as colunas preenchidas de uma linha. */
  _tudo(colunas, valores, pular = [], lote = null) {
    const OCULTOS = ['Alvarás municipais', 'Local de votação mais próximo (2026)', 'Distância ao local (m)',
      'Conselho Tutelar 2023 — situação do local', 'Conselho Tutelar — onde votou'];
    const EDITAVEIS = ['Contatos do levantamento', 'Telefones do levantamento'];
    const tabela = this.identificar.tabela(colunas.map((c, k) => [c, valores[k]])
      .filter(([c, v]) => v !== null && v !== undefined && v !== '' && !pular.includes(c) && !OCULTOS.includes(c) && !(lote && EDITAVEIS.includes(c)))
      .map(([c, v]) => [c, typeof v === 'number' ? (Number.isInteger(v) ? fmtNum(v) : String(v).replace('.', ',')) : String(v)]));
    if (!lote) return tabela;
    // Contatos e telefones: caixa de texto editável por lote (guardada neste aparelho; o levantamento original fica intacto).
    const chave = `bussola:lote-edicao:${lote.ci || `${lote.b}-${lote.q}-${lote.l}`}`;
    const salvo = (() => { try { return JSON.parse(localStorage.getItem(chave) || '{}'); } catch { return {}; } })();
    const caixas = EDITAVEIS.map((c) => {
      const original = valores[colunas.indexOf(c)];
      const area = el('textarea', { class: 'campo area', rows: 3, 'aria-label': c,
        onchange: (e) => { salvo[c] = e.target.value; try { localStorage.setItem(chave, JSON.stringify(salvo)); } catch { /* sem armazenamento */ } } },
      salvo[c] ?? (original == null ? '' : String(original)));
      return el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, c), area);
    });
    return el('div', {}, tabela, ...caixas);
  }

  abrirLote(l, voar = false) {
    if (!this.detalhesProntos) { this._esperarFicha(() => this.abrirLote(l, voar)); return; }
    const d = this.dados, id = this.identificar, cl = d.colunas_lote;
    const c = l.aneis[0].reduce((a, p) => [a[0] + p[0] / l.aneis[0].length, a[1] + p[1] / l.aneis[0].length], [0, 0]);
    const ponto = { lon: c[0], lat: c[1], alt: NaN };
    id.limparDestaque();
    id.destacarLonLat(l.aneis, { fechado: true, cor: Cesium.Color.fromCssColorString(this.cor[l.f] || '#ffd54a') });
    // A mesma ficha de todos os lotes de Goiânia (fichalote.js), com o levantamento da Associação como dado adicional.
    const ci = String(l.v[cl.indexOf('Inscrição do lote (CI)')] || '').replace(/\D/g, '');
    const ce = d.empresas?.colunas || [];
    const empresas = (this.empresasDoLote.get(l.i) || []).map((e) => Object.fromEntries(ce.map((k, i) => [k, e[i]])));
    const R = 6378137, mx = (lon) => lon * (Math.PI / 180) * R, my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
    fichaLote(id, {
      lote: { attributes: { ci, nm_lot: String(l.l) }, geometry: { rings: l.aneis.map((r) => r.map(([lo, la]) => [mx(lo), my(la)])) } },
      quadra: { nm_qdr: String(l.q) }, bairro: d.bairros[l.b], ponto,
      extra: { colunas: cl, valores: l.v, empresas, quadra: l.q, lote: l.l, finalidade: l.f, endereco: l.v[cl.indexOf('Endereço (cadastro)')] },
    }).then(() => {
      const m = this._manutencao(l.v[cl.indexOf('Código para manutenção')]);
      if (m) id.corpo.insertBefore(el('div', { class: 'linha-botoes' }, m), id.corpo.querySelector('.coordenadas.fim'));
    });
    if (voar) this.globo.voarPara({ lon: c[0], lat: c[1], distancia: 350, inclinacao: -60 });
  }

  /** Empresas do lote cujos CNPJs estão na lista (texto "a; b; c" da base). */
  _empresasDaBase(l, texto) {
    const d = this.dados, ce = d.empresas.colunas, kc = ce.indexOf('CNPJ');
    const lista = new Set(String(texto || '').split(';').map((x) => x.trim()).filter(Boolean));
    return (this.empresasDoLote.get(l.i) || []).filter((e) => lista.has(e[kc]));
  }

  _listarEmpresas(titulo, empresas, aberto) {
    if (!empresas.length) return;
    const d = this.dados, ce = d.empresas.colunas;
    const s = this.identificar.secao(`${titulo} (${empresas.length})`, { aberto });
    for (const e of empresas) {
      const nome = e[ce.indexOf('Nome fantasia')] || e[ce.indexOf('Razão social')] || e[ce.indexOf('CNPJ')];
      s.append(el('details', { class: 'lv-empresa' }, el('summary', {}, nome), this._tudo(ce, e, ['Bairro', 'Quadra', 'Lote'])));
    }
  }

  /** Base independente de uma unidade do condomínio (uma inscrição de IPTU). */
  _corpoUnidade(l, u, cu) {
    const id = this.identificar;
    id.titulo(`${u[0]}`, `Quadra ${l.q} · Lote ${l.l} · ${this.dados.bairros[l.b]} · ${l.edif || l.f}`);
    id.corpo.append(this._tudo(cu, u, ['Unidade']));
    this._listarEmpresas('Empresas nesta unidade', this._empresasDaBase(l, u[cu.indexOf('CNPJs ativos')]), true);
    const m = this._manutencao(l.v[this.dados.colunas_lote.indexOf('Código para manutenção')]);
    if (m) id.corpo.append(el('div', { class: 'linha-botoes' }, m));
    id.corpo.append(el('p', { class: 'nota' }, 'Dados só desta unidade. Para ver o condomínio inteiro, escolha “ -- ” na lista.'));
  }

  /** Base geral do lote (ou do condomínio, quando há unidades). */
  _corpoGeral(l, geral, cu) {
    const d = this.dados, id = this.identificar;
    id.corpo.append(this._tudo(d.colunas_lote, l.v, ['Bairro', 'Quadra', 'Lote'], { ci: String(l.v[d.colunas_lote.indexOf('Inscrição do lote (CI)')] || ''), b: l.b, q: l.q, l: l.l }));
    const empresas = this.empresasDoLote.get(l.i) || [];
    if (geral) {
      this._listarEmpresas('Empresas do condomínio, sem unidade identificada', this._empresasDaBase(l, geral[cu.indexOf('CNPJs ativos')]), false);
      this._listarEmpresas('Todas as empresas no lote', empresas, false);
    } else this._listarEmpresas('Empresas no lote', empresas, empresas.length <= 3);
    const google = this.googleDoLote.get(l.i) || [];
    if (google.length) {
      const s = id.secao(`Google Maps (${google.length})`, { aberto: true });
      const cg = d.google.colunas;
      for (const g of google) {
        const link = g[cg.indexOf('Link')];
        s.append(el('div', { class: 'lv-google' }, this._tudo(cg, g, ['Bairro', 'Quadra', 'Lote', 'Link']),
          link ? el('a', { class: 'botao-texto', href: link, target: '_blank', rel: 'noopener' }, 'Abrir no Google Maps') : null));
      }
    }
    const cond = this.condominioDoLote.get(l.i) || [];
    for (const r of cond) id.secao('Prédio / condomínio', { aberto: false }).append(this._tudo(d.condominios.colunas, r, ['Bairro', 'Quadra', 'Lote']));
    const m = this._manutencao(l.v[d.colunas_lote.indexOf('Código para manutenção')]);
    const ed = id.acoes.editarPoligono ? el('button', { class: 'botao', onclick: () => id.acoes.editarPoligono({ aneis: l.aneis, quadra: l.q, lote: l.l,
      bairro: d.bairros[l.b], ci: String(l.v[d.colunas_lote.indexOf('Inscrição do lote (CI)')] || ''), id: String(l.v[d.colunas_lote.indexOf('ID do lote (Mapa Fácil)')] || '') }) }, 'Editar como polígono') : null;
    if (m || ed) {
      const ref = [...id.corpo.children].find((c) => c.matches('dl.atributos') || c.querySelector(':scope > dl.atributos')) || null;
      id.corpo.insertBefore(el('div', { class: 'linha-botoes' }, m, ed), ref);
    }
  }

  /** Pedido de manutenção registrado no sistema: o botão fica marcado; clicar de novo retira. */
  _manutencao(codigo, extra = {}) {
    if (!codigo) return null;
    const TIPOS = { LT: 'Lote', AP: 'Área pública', BL: 'Boca de lobo', IP: 'Iluminação', PT: 'Poste' };
    const sigla = String(codigo).split('-')[0];
    const bairro = { JA: 'Jardim América', NS: 'Nova Suíça' }[String(codigo).split('-')[1]] || '';
    return botaoManutencao({ codigo, tipo: TIPOS[sigla] || 'Outro', titulo: extra.titulo || codigo, bairro: extra.bairro || bairro,
      local: extra.local || '', lon: extra.lon ?? '', lat: extra.lat ?? '' }, { aoMudar: () => { this._contarPedidos(); if (sigla === 'BL') this._atualizarBocas(); } });
  }

  _contarPedidos() {
    if (!this.caixaManut) return;
    const n = manutencao.todos().length;
    this.caixaManut.textContent = n ? `${fmtNum(n)} pedidos registrados neste aparelho.` : 'Nenhum pedido registrado ainda.';
  }

  abrirBoca(b) {
    const id = this.identificar, c = this.dados.bocas.colunas;
    const lat = b.v[c.indexOf('Latitude')], lon = b.v[c.indexOf('Longitude')], codigo = b.v[c.indexOf('Código para manutenção')];
    const n = b.v[c.indexOf('Unidades em sequência')];
    id.limparDestaque();
    id.abrir({ titulo: `Boca de lobo ${codigo}`, subtitulo: `${n} ${n === 1 ? 'unidade' : 'unidades'} em sequência · ${b.v[c.indexOf('Bairro')]}`, ponto: { lon, lat, alt: NaN } });
    id.corpo.append(this._manutencao(codigo, { titulo: `Boca de lobo ${codigo}`, lon, lat }) || '', this._tudo(c, b.v));
  }

  abrirPoste(p) {
    if (!this.detalhesProntos) { this._esperarFicha(() => this.abrirPoste(p)); return; }
    const id = this.identificar, c = this.dados.iluminacao.colunas;
    const lat = p.v[c.indexOf('Latitude')], lon = p.v[c.indexOf('Longitude')], codigo = p.v[c.indexOf('Código para manutenção')];
    id.limparDestaque();
    id.abrir({ titulo: `Iluminação ${codigo}`, subtitulo: `${p.v[c.indexOf('Logradouro (cadastro)')] || ''} · ${p.v[c.indexOf('Bairro')]}`, ponto: { lon, lat, alt: NaN } });
    id.corpo.append(this._tudo(c, p.v), this._manutencao(codigo) || '');
  }

  abrirEmpresaSemLote(e) {
    const id = this.identificar, ce = this.dados.empresas_sem_lote.colunas;
    id.limparDestaque();
    id.abrir({ titulo: e.nome || 'Empresa', subtitulo: `${e.bairro || ''} · sem lote identificado` });
    id.corpo.append(this._tudo(ce, e.v));
  }

  /** Ficha pedida antes de os detalhes chegarem: avisa e abre assim que estiverem prontos. */
  _esperarFicha(abrir) {
    this.identificar.abrir({ titulo: 'Carregando a ficha…', subtitulo: 'Levantamento da Associação' });
    this.detalhes().then(abrir).catch((e) => aviso(`Ficha indisponível: ${e.message}`, 'alerta'));
  }

  abrirArea(a) {
    const id = this.identificar;
    const anel = a.aneis[0];
    const c = anel.reduce((s, p) => [s[0] + p[0] / anel.length, s[1] + p[1] / anel.length], [0, 0]);
    id.limparDestaque();
    id.destacarLonLat(a.aneis, { fechado: true });
    id.abrir({ titulo: a.nome, subtitulo: a.cat, ponto: { lon: c[0], lat: c[1], alt: NaN } });
    if (a.v) {
      const m = this._manutencao(a.v[this.dados.colunas_area.indexOf('Código para manutenção')]);
      if (m) id.corpo.append(el('div', { class: 'linha-botoes' }, m));
      id.corpo.append(this._tudo(this.dados.colunas_area, a.v));
    }
    else if (a.desc?.length) id.corpo.append(el('div', { class: 'lv-desc' }, a.desc.map((t) => el('p', {}, t))));
  }

  /** Linha da aba "Locais de votação" pelo nome do local. */
  _linhaLocal(nome) {
    const t = this.dados.eleitoral.locais, k = t.colunas.indexOf('Local de votação');
    const n = semAcento(nome);
    return t.linhas.find((r) => semAcento(r[k] || '') === n);
  }

  abrirPonto(p) {
    if (!this.detalhesProntos) { this._esperarFicha(() => this.abrirPonto(p)); return; }
    const id = this.identificar, E = this.dados.eleitoral;
    id.limparDestaque();
    const lote = this._loteDoLocal(p);
    if (lote.lote) id.destacarLonLat(lote.aneisLL, { fechado: true });
    const tipos = { geral: `${p.grupo} eleitoral`, ct: `Conselho Tutelar 2023 · região ${p.grupo}`,
      transferido: `Local transferido no Conselho Tutelar · região ${p.grupo}`, sem: 'Sem informação no edital do Conselho Tutelar' };
    id.abrir({ titulo: p.nome, subtitulo: tipos[p.tipo], ponto: { lon: p.lon, lat: p.lat, alt: NaN } });
    if (p.desc?.length) id.corpo.append(el('div', { class: 'lv-desc' }, p.desc.slice(1).map((t) => el('p', {}, t))));
    const linha = this._linhaLocal(p.nome);
    if (linha) id.secao('Planilha: locais de votação', { aberto: false }).append(this._tudo(E.locais.colunas, linha));
    if (p.tipo === 'ct') {
      const ct = E.conselho, k = ct.colunas.indexOf('Local de votação do CT');
      const r = ct.linhas.find((x) => semAcento(x[k] || '').slice(0, 25) === semAcento(p.nome).slice(0, 25));
      if (r) id.secao('Planilha: Conselho Tutelar', { aberto: true }).append(this._tudo(ct.colunas, r));
    }
  }

  abrirSeta(s) {
    const id = this.identificar;
    id.limparDestaque();
    id.abrir({ titulo: 'Seções transferidas', subtitulo: `Conselho Tutelar 2023 · região ${s.regiao}`, ponto: { lon: s.de[0], lat: s.de[1], alt: NaN } });
    id.corpo.append(el('div', { class: 'lv-desc' }, s.desc.map((t) => el('p', {}, t))));
  }
}
