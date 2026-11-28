// Painel "Camadas": os serviços do Mapa Fácil reorganizados em projetos temáticos.
//
// Cada projeto (grupo) reúne camadas de um ou mais serviços do servidor municipal;
// um serviço pode aparecer em mais de um projeto (ex.: Limites → Zonas Eleitorais e
// Limites Administrativos). O desenho continua sendo um por serviço: as camadas de
// todos os projetos ligados que usam o serviço são pedidas juntas.
import { BASE } from './mapavetorial.js';
import { CFG } from './config.js';
import { $$, el, pedirJSON, debounce, semAcento, aviso, fmtNum } from './util.js';
import { provedorExport } from './globo.js';
import { temServico, ProvedorTema, imagemLocal } from './banco.js';
import { idsDaFicha } from './mapavetorial.js';

/** Organização dos projetos. `ids` lista camadas (folhas ou grupos) do serviço; sem `ids`, entra o serviço todo. */
export const ORGANIZACAO = [
  { chave: 'base', titulo: 'Base Cadastral', especial: 'base', fontes: [{ tema: 'Feature_Base' }] },
  // Drenagem Pluvial: base própria da A.M.C. (drenagem.js), ligada à parte, sem desligar os mapas de eleição.
  { chave: 'drenagem', titulo: 'Drenagem Pluvial', especial: 'drenagem', proprio: true, independente: true, semConta: true, fontes: [{ tema: 'Mapa_Sanemanento', ids: [] }] },
  // Geo360 (atualização 2024-2025): dados públicos do portal da Prefeitura que não vinham do Mapa Fácil (geo360.js).
  // Mapas de eleição: desenho próprio (eleicoes.js), um de cada vez.
  { chave: 'eleitoral', titulo: 'Zonas Eleitorais', especial: 'eleitoral', proprio: true, fontes: [{ tema: 'Mapa_Limites', ids: [10] }] },
  { chave: 'conselho', titulo: 'Conselho Tutelar', especial: 'conselho', proprio: true, fontes: [{ tema: 'Mapa_Limites', ids: [10] }] },
  { chave: 'energia', titulo: 'Energia', semFerramentas: true, fontes: [{ tema: 'Mapa_Energia', ids: [1, 3, 4, 5, 6, 7, 8] }] }, // 1.36: sem "Tipo de Lâmpada"
  { chave: 'saneamento', titulo: 'Saneamento', semFerramentas: true, fontes: [{ tema: 'Mapa_Sanemanento' }] },
  // Vias e Mobilidade (1.37): avenidas, transporte coletivo, vias sem asfalto e propostas (viario.js) e o Trânsito
  // (transito.js) num só projeto, com desenho próprio (sem as escalas nem os rótulos do Mapa Fácil).
  { chave: 'viario', titulo: 'Vias e Mobilidade', especial: 'viario', proprio: true, independente: true, fontes: [{ tema: 'Mapa_RedeViaria', ids: [16] }] },
  // Cadastro Imobiliário (1.41): áreas verdes e imóveis públicos (com os equipamentos), edificações em 3D, Planta de
  // Valores, Patrimônio Histórico, Regularização Fundiária, Documentação de Bairros e Uso do Solo, num título só.
  { chave: 'edificacoes', titulo: 'Cadastro Imobiliário', especial: 'cadastro', semFerramentas: true, fontes: [
    { tema: 'Mapa_Edificios', ids: [7] },
    { tema: 'Mapa_Limites', ids: [3], sub: 'Circunscrição Cartorária (Registro de Imóveis)' },
    { tema: 'Mapa_PatrimonioHistorico', sub: 'Patrimônio Histórico' },
    { tema: 'Mapa_PontosNotaveis', ids: [3], sub: 'Patrimônio Histórico' },
    { tema: 'Mapa_OcupacaoIlegal', sub: 'Regularização Fundiária' },
    { tema: 'Mapa_Documentacao', sub: 'Documentação de Bairros' },
    { tema: 'Mapa_UsoDoSoloNew', sub: 'Uso do Solo' },
    { tema: 'Mapa_Simplifica_Goiania_UsoDoSolo', sub: 'Uso do Solo' },
  ] },
  { chave: 'meio', titulo: 'Meio Ambiente', fontes: [{ tema: 'Mapa_MeioAmbiente' }, { tema: 'Mapa_PUAMA', sub: 'PUAMA' }] },
  { chave: 'telecom', titulo: 'Telecomunicação', fontes: [{ tema: 'Mapa_TelecomunicacaoNew' }] },
  { chave: 'comurg', titulo: 'COMURG', fontes: [{ tema: 'Mapa_COMURG' }] },
  { chave: 'zonas', titulo: 'Zonas Municipais', fontes: [{ tema: 'Mapa_PontosNotaveis', ids: [4] }] },
  // Regulação e Arrecadação (1.39): legislação, Modelo Espacial, documentação de bairros, tributário e fiscalização.
  { chave: 'legislacao', titulo: 'Regulação e Arrecadação', semFerramentas: true, fontes: [
    { tema: 'Mapa_Legislacao', sub: 'Legislação Municipal' },
    { tema: 'Mapa_ModeloEspacial', sub: 'Modelo Espacial (LC 171/2007)' },
    { tema: 'Mapa_Tributario_Web', sub: 'Tributário' },
    { tema: 'Mapa_Fiscalizacao', sub: 'Fiscalização' },
  ] },
  { chave: 'limites', titulo: 'Limites Administrativos', fontes: [{ tema: 'Mapa_Limites', ids: [0, 4, 5, 6, 7] }] },
  // Acessibilidade e Serviços (1.42): incorpora Serviços Públicos (Guarda Civil, Cultura, CRAS e CREAS, do recadastramento)
  // e deixa de repetir o que já está em outro marcador: endereços duplicados (43-46: educação, saúde, shopping e escolas
  // SIEG) e as plataformas e linhas de ônibus (41-42), que ficam em Vias e Mobilidade → Transporte Coletivo.
  { chave: 'servicos', titulo: 'Acessibilidade e Serviços', marcadores: true, especial: 'geo360', fontes: [{ tema: 'Mapa_Acessibilidade',
    ids: [1, 2, 3, 5, 6, 7, 8, 9, 11, 13, 14, 15, 16, 17, 18, 19, 22, 23, 24, 25, 28, 29, 30, 33, 35, 36, 37, 40] }] },
];

export class Camadas {
  /**
   * especiais: { eleitoral(caixa, grupo), edificacoes(caixa, grupo) } montam conteúdo próprio no topo do projeto;
   * servicos: módulo de marcadores (Acessibilidade e Serviços).
   */
  constructor(globo, catalogo, raiz, { especiais = {}, servicos = null } = {}) {
    this.globo = globo;
    this.temas = catalogo.temas;
    this.raiz = raiz;
    this.especiais = especiais;
    this.servicos = servicos;
    this.aoMudar = () => {};
    this.porTema = new Map(); // chave do serviço -> { tema, camada (Cesium), opacidade, legenda, avisou }
    for (const t of this.temas) {
      t._porId = new Map(t.camadas.map((c) => [c.id, c]));
      this.porTema.set(t.chave, { tema: t, camada: null, opacidade: 1, legenda: null });
    }
    this.grupos = this._organizar();
    this._redesenhar = debounce((chave) => this._aplicar(chave), 350);
    this._montar();
  }

  // ------------------------------------------------------------ organização
  _folhasSob(t, id) {
    const c = t._porId.get(id);
    if (!c) return [];
    if (!c.grupo) return [id];
    return t.camadas.filter((x) => x.pai === id).flatMap((x) => this._folhasSob(t, x.id));
  }

  _paisVisiveis(t, c) {
    let pai = t._porId.get(c.pai);
    while (pai) { if (!pai.visivel) return false; pai = t._porId.get(pai.pai); }
    return true;
  }

  _organizar() {
    const usados = new Set();
    const grupos = [];
    const montar = (def) => {
      const fontes = [];
      for (const f of def.fontes) {
        const t = this.temas.find((x) => x.chave === f.tema);
        if (!t) continue;
        usados.add(t.chave);
        const folhas = new Set(f.ids ? f.ids.flatMap((id) => this._folhasSob(t, id)) : t.camadas.filter((c) => !c.grupo).map((c) => c.id));
        // Camadas exibidas: as folhas permitidas e os grupos acima delas.
        const nos = new Set(folhas);
        for (const id of folhas) { let c = t._porId.get(t._porId.get(id).pai); while (c) { nos.add(c.id); c = t._porId.get(c.pai); } }
        const padrao = t.somente_consulta
          ? CFG.consultaPadrao.filter((id) => folhas.has(id))
          : [...folhas].filter((id) => { const c = t._porId.get(id); return c.visivel && this._paisVisiveis(t, c); });
        // Energia: ao ligar o projeto, já vêm os postes e a iluminação pública (desenho 3D, energia3d.js).
        if (t.chave === 'Mapa_Energia') for (const id of [1, 4]) if (folhas.has(id) && !padrao.includes(id)) padrao.push(id);
        fontes.push({ tema: t, sub: f.sub || '', folhas, nos, padrao, sel: new Set(padrao) });
      }
      if (!fontes.length) return;
      const consulta = fontes.every((f) => f.tema.somente_consulta);
      // Base Cadastral: o interruptor segue o desenho (BASE.ligado), que começa desligado — mapa limpo ao abrir.
      grupos.push({ ...def, fontes, consulta, ligado: def.chave === 'base' ? !!BASE.ligado : consulta, opacidade: 1 });
    };
    ORGANIZACAO.forEach(montar);
    // Serviços que a organização não cita (o catálogo pode crescer): cada um vira um projeto próprio.
    for (const t of this.temas) if (!usados.has(t.chave)) montar({ chave: t.chave, titulo: t.titulo, fontes: [{ tema: t.chave }] });
    return grupos;
  }

  grupo(chave) { return this.grupos.find((g) => g.chave === chave); }

  // ------------------------------------------------------------- interface
  _montar() {
    const busca = el('input', { type: 'search', class: 'campo', placeholder: 'Filtrar camadas…',
      'aria-label': 'Filtrar camadas', oninput: (e) => this._filtrar(e.target.value) });
    const lista = el('div', { class: 'grupo-temas' });
    for (const g of this.grupos) lista.append(this._montarGrupo(g));
    this.raiz.append(busca, el('h3', { class: 'subtitulo' }, 'Projetos'), lista);
  }

  _total(g) { return g.fontes.reduce((s, f) => s + f.folhas.size, 0); }

  _montarGrupo(g) {
    const liga = el('input', { type: 'checkbox', class: 'tema-liga', 'aria-label': `Ligar ${g.titulo}`,
      onchange: (ev) => this.ligar(g.chave, ev.target.checked) });
    liga.checked = g.ligado;
    liga.disabled = g.consulta && g.chave !== 'base'; // a Base Cadastral liga e desliga o desenho cadastral da cidade
    const conta = el('small', { class: 'tema-conta' });
    const corpo = el('div', { class: 'tema-corpo', hidden: true });
    const titulo = el('button', { class: 'tema-titulo', 'aria-expanded': 'false', onclick: () => {
      const abre = corpo.hidden;
      if (abre && !corpo.dataset.pronto) { this._montarCorpo(g, corpo); corpo.dataset.pronto = '1'; }
      corpo.hidden = !abre;
      titulo.setAttribute('aria-expanded', String(abre));
      if (abre) this.atualizarEscala();
    } }, el('span', {}, g.titulo), conta);
    const texto = semAcento(`${g.titulo} ${g.fontes.map((f) => `${f.sub} ${f.tema.titulo} ${f.tema.camadas.filter((c) => f.nos.has(c.id)).map((c) => c.nome).join(' ')}`).join(' ')}`);
    const no = el('section', { class: 'tema', dataset: { chave: g.chave, texto } },
      el('div', { class: 'tema-topo' }, el('label', { class: 'interruptor' }, liga, el('span', {})), titulo), corpo);
    Object.assign(g, { no, liga, conta, corpo });
    this._atualizarConta(g);
    return no;
  }

  _montarCorpo(g, corpo) {
    if (g.especial && this.especiais[g.especial]) {
      const caixa = el('div', { class: 'tema-especial' });
      corpo.append(caixa);
      this.especiais[g.especial](caixa, g);
    }
    if (g.consulta && g.chave === 'base') {
      // opções montadas pelo especial "base" (app.js)
    } else if (g.consulta) {
      corpo.append(el('p', { class: 'nota' }, 'Ficha do local (clique no mapa): marque o que deve aparecer.'));
    } else if (g.proprio) {
      // desenho próprio: sem opacidade nem legenda do servidor
    } else {
      const faixa = el('input', { type: 'range', min: 10, max: 100, value: Math.round(g.opacidade * 100),
        'aria-label': 'Opacidade', oninput: (ev) => this.opacidade(g.chave, ev.target.value / 100) });
      const legenda = el('div', { class: 'legenda', hidden: true });
      corpo.append(el('div', { class: 'tema-ferramentas' },
        el('label', { class: 'rotulo-faixa' }, 'Opacidade', faixa),
        // Energia e Saneamento: sem "Legenda" e "Padrão" (1.38.2)
        g.semFerramentas ? null : el('button', { class: 'botao-texto', onclick: () => this._alternarLegenda(g, legenda) }, 'Legenda'),
        g.semFerramentas ? null : el('button', { class: 'botao-texto', title: 'Voltar à seleção padrão do portal', onclick: () => this.restaurar(g.chave) }, 'Padrão')), legenda);
      if (g.marcadores) corpo.append(el('p', { class: 'nota' }, 'Os pontos aparecem como marcadores com ícone por tipo; clique em um marcador para ver os dados.'));
    }
    // Base Cadastral: as camadas são controladas pelas opções do próprio projeto (sem lista repetida).
    for (const f of (g.proprio || g.chave === 'base' ? [] : g.fontes)) {
      const filhosDe = (pai) => f.tema.camadas.filter((c) => c.pai === pai && f.nos.has(c.id));
      const montar = (pai) => {
        // pasta com uma camada só, de mesmo nome (ex.: Planta de Valores): uma marcação só
        const itens = filhosDe(pai).map((c) => {
          const f1 = c.grupo ? filhosDe(c.id) : [];
          return f1.length === 1 && String(f1[0].nome || '').trim() === String(c.nome || '').trim() ? f1[0] : c;
        });
        if (!itens.length) return null;
        return el('ul', { class: 'arvore' }, itens.map((c) => {
          const caixa = el('input', { type: 'checkbox', dataset: { tema: f.tema.chave, id: c.id },
            onchange: (ev) => this._marcar(g, f, c, ev.target.checked) });
          const faixa = this._faixaEscala(f.tema, c);
          const dica = !c.grupo && (faixa.min || faixa.max)
            ? el('small', { class: 'dica-escala', title: 'Faixa de escala em que a camada é desenhada' },
              faixa.min ? `a partir de 1:${fmtNum(faixa.min)}` : `até 1:${fmtNum(faixa.max)}`) : null;
          return el('li', { class: c.grupo ? 'no-grupo' : 'no-folha', dataset: { min: faixa.min, max: faixa.max } },
            el('label', {}, caixa, el('span', {}, c.nome || `Camada ${c.id}`), dica), montar(c.id));
        }));
      };
      const arvore = montar(-1);
      if (!arvore) continue;
      if (f.sub) {
        // fontes com o mesmo título ficam juntas na mesma subpasta
        let caixaSub = [...corpo.querySelectorAll(':scope > details.compartimento')].find((d) => d.dataset.sub === f.sub);
        if (!caixaSub) { caixaSub = el('details', { class: 'compartimento', open: true, dataset: { sub: f.sub } }, el('summary', {}, f.sub)); corpo.append(caixaSub); }
        caixaSub.append(arvore);
      } else corpo.append(arvore);
    }
    this._sincronizarCaixas(g);
  }

  _faixaEscala(t, camada) {
    let min = 0, max = 0, c = camada;
    while (c) {
      if (c.escala_min) min = min ? Math.min(min, c.escala_min) : c.escala_min;
      if (c.escala_max) max = Math.max(max, c.escala_max);
      c = t._porId.get(c.pai);
    }
    return { min, max };
  }

  _sincronizarCaixas(g) {
    for (const caixa of $$('.arvore input', g.corpo)) {
      const f = g.fontes.find((x) => x.tema.chave === caixa.dataset.tema);
      const folhas = this._folhasSob(f.tema, +caixa.dataset.id).filter((id) => f.folhas.has(id));
      const marcadas = folhas.filter((id) => f.sel.has(id)).length;
      caixa.checked = marcadas > 0 && marcadas === folhas.length;
      caixa.indeterminate = marcadas > 0 && marcadas < folhas.length;
    }
    this._atualizarConta(g);
  }

  _atualizarConta(g) {
    if (!g.conta) return;
    if (g.semConta) { g.conta.textContent = ''; g.no.classList.toggle('ligado', !!g.ligado); return; }
    const sel = g.fontes.reduce((s, f) => s + f.sel.size, 0);
    g.conta.textContent = g.ligado && !g.consulta ? `${sel}/${this._total(g)}` : `${this._total(g)}`;
    g.no.classList.toggle('ligado', g.ligado && !g.consulta);
  }

  _filtrar(texto) {
    const q = semAcento(texto);
    for (const no of $$('.tema', this.raiz)) no.hidden = q && !no.dataset.texto.includes(q);
  }

  async _alternarLegenda(g, caixa) {
    caixa.hidden = !caixa.hidden;
    if (caixa.hidden) return;
    caixa.textContent = 'Carregando legenda…';
    const partes = [];
    for (const f of g.fontes) {
      const e = this.porTema.get(f.tema.chave);
      if (!e.legenda) {
        try { e.legenda = await pedirJSON(`${f.tema.url}/legend`, { parametros: { f: 'json' } }); }
        catch (erro) { partes.push(el('p', { class: 'nota' }, `${f.sub || f.tema.titulo}: legenda indisponível (${erro.message}).`)); continue; }
      }
      for (const l of (e.legenda.layers || []).filter((x) => f.sel.has(x.layerId))) {
        partes.push(el('div', { class: 'legenda-camada' }, el('strong', {}, l.layerName),
          (l.legend || []).map((s) => el('div', { class: 'legenda-item' },
            el('img', { src: `data:${s.contentType};base64,${s.imageData}`, alt: '', width: s.width, height: s.height }),
            el('span', {}, s.label || ((l.legend || []).length > 1 ? l.layerName : '')))))); // símbolo único: o nome já está no título
      }
    }
    caixa.textContent = '';
    if (!partes.length) caixa.textContent = 'Marque ao menos uma camada para ver a legenda.';
    else caixa.append(...partes);
  }

  // ----------------------------------------------------------------- ações
  _marcar(g, f, camada, marcado) {
    for (const id of this._folhasSob(f.tema, camada.id)) if (f.folhas.has(id)) marcado ? f.sel.add(id) : f.sel.delete(id);
    if (!g.consulta && marcado && !g.ligado) { g.ligado = true; g.liga.checked = true; this._aoLigar(g, true); }
    this._sincronizarCaixas(g);
    this._aplicarGrupo(g, true);
    this.aoMudar();
  }

  ligar(chave, ligado) {
    const g = this.grupo(chave);
    if (!g) return;
    if (g.chave === 'base') { g.ligado = ligado; g.liga.checked = ligado; this._aoLigar(g, ligado); this.aoMudar(); return; }
    if (g.consulta) return;
    // Zonas Eleitorais e Conselho Tutelar: um mapa de eleição de cada vez.
    if (ligado && g.proprio && !g.independente) for (const o of this.grupos) if (o !== g && o.proprio && !o.independente && o.ligado) { o.ligado = false; o.liga.checked = false; this._aoLigar(o, false); }
    g.ligado = ligado;
    if (ligado && g.fontes.every((f) => !f.sel.size)) {
      for (const f of g.fontes) { f.padrao.forEach((id) => f.sel.add(id)); if (!f.sel.size) f.folhas.forEach((id) => f.sel.add(id)); }
    }
    g.liga.checked = ligado;
    if (g.corpo.dataset.pronto) this._sincronizarCaixas(g); else this._atualizarConta(g);
    this._aoLigar(g, ligado);
    this._aplicarGrupo(g, false);
    this.aoMudar();
  }

  /** Avisa os conteúdos especiais (Zonas Eleitorais, Edificações) que o projeto foi ligado ou desligado. */
  _aoLigar(g, ligado) { this.especiais[`${g.especial}Ligar`]?.(ligado, g); }

  restaurar(chave) {
    const g = this.grupo(chave);
    for (const f of g.fontes) f.sel = new Set(f.padrao);
    this._sincronizarCaixas(g);
    this._aplicarGrupo(g, true);
    this.aoMudar();
  }

  opacidade(chave, valor) {
    const g = this.grupo(chave);
    g.opacidade = valor;
    for (const f of g.fontes) {
      const e = this.porTema.get(f.tema.chave);
      e.opacidade = valor;
      if (e.camada) e.camada.alpha = valor;
    }
    this.globo.redesenhar();
  }

  _aplicarGrupo(g, adiar) {
    for (const f of g.fontes) (adiar ? this._redesenhar : this._aplicar.bind(this))(f.tema.chave);
    if (g.marcadores) this._aplicarMarcadores(g);
  }

  /** Camadas de um serviço que vão no desenho: as marcadas em todos os projetos ligados (menos as de marcador). */
  _desenhadas(chave) {
    const ids = new Set();
    for (const g of this.grupos) {
      if (!g.ligado || g.consulta || g.proprio) continue;
      for (const f of g.fontes) {
        if (f.tema.chave !== chave) continue;
        for (const id of f.sel) {
          if (chave === 'Mapa_Energia' && id <= 4) continue; // postes e iluminação: desenho 3D (energia3d.js)
          if ((chave === 'Mapa_Edificios' && id === 7) || (chave === 'Mapa_MeioAmbiente' && id === 14)) continue; // versão 2016-2025 (geo360.js)
          if (!(g.marcadores && this.servicos?.ehMarcador(chave, id))) ids.add(id);
        }
      }
    }
    return ids;
  }

  async _aplicarMarcadores(g) {
    if (!this.servicos) return;
    for (const f of g.fontes) {
      let ids = g.ligado ? [...f.sel] : [];
      // Energia: postes e iluminação pública no desenho 3D dos postes do Jardim América (energia3d.js), no lugar dos marcadores.
      if (f.tema.chave === 'Mapa_Energia' && this.energia3d) {
        this.energia3d.definir({ postes: ids.includes(4), luz: ids.includes(1) || ids.includes(3) });
        ids = ids.filter((id) => ![1, 2, 3, 4].includes(id));
      }
      await this.servicos.definir(f.tema, ids);
      this._redesenhar(f.tema.chave); // as que não são pontos (ex.: linhas de ônibus) seguem como imagem
    }
  }

  _aplicar(chave) {
    const e = this.porTema.get(chave), t = e.tema;
    if ((chave === 'Mapa_Edificios' || chave === 'Mapa_MeioAmbiente') && this.geo360) {
      const sel = (k, tema, id) => { const g = this.grupos.find((x) => x.chave === k); const f = g?.fontes.find((y) => y.tema.chave === tema); return !!(g?.ligado && f?.sel.has(id)); };
      this.geo360.definirExterno({ planta: sel('edificacoes', 'Mapa_Edificios', 7), risco: sel('meio', 'Mapa_MeioAmbiente', 14) });
    }
    if (chave === 'Mapa_Energia' && this.energia3d) {
      const g = this.grupos.find((x) => x.chave === 'energia');
      const sel = g?.ligado ? [...(g.fontes[0]?.sel || [])] : [];
      this.energia3d.definir({ postes: sel.includes(4), luz: sel.includes(1) || sel.includes(3) });
    }
    if (t.somente_consulta) return;
    if (e.camada) { this.globo.removerTema(e.camada); e.camada = null; }
    const ids = this._desenhadas(chave);
    if (ids.size) {
      const lista = [...ids].sort((a, b) => a - b);
      const credito = `${t.titulo}: Prefeitura de Goiânia (Mapa Fácil)`;
      // Banco local: o tema é desenhado dos dados guardados no site; sem eles, a imagem vem do servidor municipal.
      const provedor = temServico(t.chave)
        ? new ProvedorTema({ servico: t.chave, camadas: lista, retangulo: this.globo.ret, credito: `${credito} · banco local` })
        : imagemLocal(t.chave) || provedorExport(t.url, { camadas: lista, retangulo: this.globo.ret, credito });
      provedor.errorEvent.addEventListener((erro) => {
        if (!erro.cancelado && erro.timesRetried < 2) erro.retry = true; // falha passageira: tenta de novo
        if (erro.cancelado) return; // bloco cancelado: pedido de novo, não é falha
        if (erro.timesRetried >= 2 && !e.avisou) {
          e.avisou = true;
          aviso(`"${t.titulo}": parte da imagem não carregou. Aproxime ou afaste o mapa para tentar de novo.`, 'alerta');
        }
      });
      e.camada = this.globo.adicionarTema(provedor, e.opacidade);
    }
  }

  /** Esmaece as camadas que não são desenhadas na escala atual. */
  atualizarEscala() {
    const escala = this.globo.escala();
    if (!escala) return;
    for (const li of $$('.no-folha', this.raiz)) {
      const min = +li.dataset.min, max = +li.dataset.max;
      li.classList.toggle('fora-escala', (min > 0 && escala > min) || (max > 0 && escala < max));
    }
  }

  // -------------------------------------------------------------- consulta
  /** Serviços com desenho ligado: [{tema, ids}] — usados pelo "identificar". */
  ativos() {
    return this.temas.filter((t) => !t.somente_consulta).map((t) => ({ tema: t, ids: [...this._desenhadas(t.chave)] }))
      .filter((a) => a.ids.length);
  }

  /** Camadas da Base Cadastral a consultar em cada clique. */
  consultaBase() {
    for (const g of this.grupos) for (const f of g.fontes) if (f.tema.somente_consulta) return { tema: f.tema, ids: idsDaFicha() };
    return null;
  }

  // ------------------------------------------------------------------ link
  serializar() {
    return this.grupos.filter((g) => g.ligado && !g.consulta)
      .map((g) => `${g.chave}:${g.fontes.map((f) => `${f.tema.chave}=${[...f.sel].join('.')}`).join(';')}`).join('|');
  }

  restaurarDe(texto) {
    for (const parte of String(texto || '').split('|').filter(Boolean)) {
      const [chave, resto = ''] = parte.split(':');
      if (resto.includes('=')) {
        const g = this.grupo(chave);
        if (!g || g.consulta) continue;
        for (const pedaco of resto.split(';')) {
          const [tema, ids = ''] = pedaco.split('=');
          const f = g.fontes.find((x) => x.tema.chave === tema);
          if (f) f.sel = new Set(ids.split('.').map(Number).filter((id) => f.folhas.has(id)));
        }
        this.ligar(chave, true);
      } else {
        // Link antigo (serviço:camadas): liga os projetos que contêm essas camadas.
        const ids = resto.split('.').map(Number);
        for (const g of this.grupos) {
          const f = g.fontes.find((x) => x.tema.chave === chave);
          if (!f || g.consulta) continue;
          const validos = ids.filter((id) => f.folhas.has(id));
          if (!validos.length) continue;
          f.sel = new Set(validos);
          this.ligar(g.chave, true);
        }
      }
    }
  }
}
