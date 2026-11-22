// Painel "Camadas": os temas do Mapa Fácil, na ordem e com os padrões do portal.
import { CFG } from './config.js';
import { $$, el, pedirJSON, debounce, semAcento, aviso, fmtNum } from './util.js';
import { provedorExport } from './globo.js';

export class Camadas {
  constructor(globo, catalogo, raiz) {
    this.globo = globo;
    this.temas = catalogo.temas;
    this.raiz = raiz;
    this.estado = new Map();
    this.aoMudar = () => {};
    for (const t of this.temas) {
      const folhas = t.camadas.filter((c) => !c.grupo);
      const padrao = t.somente_consulta
        ? CFG.consultaPadrao.filter((id) => folhas.some((f) => f.id === id))
        : folhas.filter((c) => c.visivel && this._paisVisiveis(t, c)).map((c) => c.id);
      this.estado.set(t.chave, {
        ativo: !!t.somente_consulta, folhas: new Set(padrao), padrao, opacidade: 1,
        camada: null, legenda: null,
      });
      t._porId = new Map(t.camadas.map((c) => [c.id, c]));
    }
    this._redesenhar = debounce((chave) => this._aplicar(chave), 350);
    this._montar();
  }

  _paisVisiveis(tema, camada) {
    // Uma camada só é desenhada por padrão se todos os grupos acima dela também forem.
    const porId = new Map(tema.camadas.map((c) => [c.id, c]));
    let pai = porId.get(camada.pai);
    while (pai) { if (!pai.visivel) return false; pai = porId.get(pai.pai); }
    return true;
  }

  _faixaEscala(tema, camada) {
    // Faixa efetiva (herda dos grupos): visível quando max <= escala <= min (0 = sem limite).
    let min = 0, max = 0, c = camada;
    while (c) {
      if (c.escala_min) min = min ? Math.min(min, c.escala_min) : c.escala_min;
      if (c.escala_max) max = Math.max(max, c.escala_max);
      c = tema._porId.get(c.pai);
    }
    return { min, max };
  }

  // ----------------------------------------------------------------- interface
  _montar() {
    const busca = el('input', { type: 'search', class: 'campo', placeholder: 'Filtrar camadas…',
      'aria-label': 'Filtrar camadas', oninput: (e) => this._filtrar(e.target.value) });
    const oficiais = el('div', { class: 'grupo-temas' });
    const extras = el('div', { class: 'grupo-temas' });
    for (const t of this.temas) (t.oficial ? oficiais : extras).append(this._montarTema(t));
    this.raiz.append(
      busca,
      el('h3', { class: 'subtitulo' }, 'Temas do portal Mapa Fácil'),
      oficiais,
      el('h3', { class: 'subtitulo' }, 'Outros temas do servidor municipal'),
      el('p', { class: 'nota' }, 'Serviços publicados no mesmo servidor, fora da lista do portal.'),
      extras,
    );
  }

  _montarTema(t) {
    const e = this.estado.get(t.chave);
    const total = t.camadas.filter((c) => !c.grupo).length;
    const liga = el('input', { type: 'checkbox', class: 'tema-liga', 'aria-label': `Ligar ${t.titulo}`,
      onchange: (ev) => this.ligar(t.chave, ev.target.checked) });
    liga.checked = e.ativo;
    liga.disabled = !!t.somente_consulta;
    const conta = el('small', { class: 'tema-conta' });
    const corpo = el('div', { class: 'tema-corpo', hidden: true });
    const titulo = el('button', { class: 'tema-titulo', 'aria-expanded': 'false', onclick: () => {
      const abre = corpo.hidden;
      if (abre && !corpo.dataset.pronto) { this._montarCorpo(t, corpo); corpo.dataset.pronto = '1'; }
      corpo.hidden = !abre;
      titulo.setAttribute('aria-expanded', String(abre));
      if (abre) this.atualizarEscala();
    } }, el('span', {}, t.titulo), conta);
    const no = el('section', { class: 'tema', dataset: { chave: t.chave, texto: semAcento(`${t.titulo} ${t.camadas.map((c) => c.nome).join(' ')}`) } },
      el('div', { class: 'tema-topo' }, el('label', { class: 'interruptor' }, liga, el('span', {})), titulo), corpo);
    e.no = no; e.liga = liga; e.conta = conta; e.total = total;
    this._atualizarConta(t.chave);
    return no;
  }

  _montarCorpo(t, corpo) {
    const e = this.estado.get(t.chave);
    if (t.somente_consulta) {
      corpo.append(el('p', { class: 'nota' },
        'Este serviço não tem desenho próprio: ele responde ao clique no mapa. Marque o que deve aparecer na ficha do local.'));
    } else {
      const faixa = el('input', { type: 'range', min: 10, max: 100, value: Math.round(e.opacidade * 100),
        'aria-label': 'Opacidade', oninput: (ev) => this.opacidade(t.chave, ev.target.value / 100) });
      const legenda = el('div', { class: 'legenda', hidden: true });
      corpo.append(el('div', { class: 'tema-ferramentas' },
        el('label', { class: 'rotulo-faixa' }, 'Opacidade', faixa),
        el('button', { class: 'botao-texto', onclick: () => this._alternarLegenda(t, legenda) }, 'Legenda'),
        el('button', { class: 'botao-texto', title: 'Voltar à seleção padrão do portal',
          onclick: () => this.restaurar(t.chave) }, 'Padrão')), legenda);
    }
    const filhosDe = (pai) => t.camadas.filter((c) => c.pai === pai);
    const montar = (pai) => {
      const itens = filhosDe(pai);
      if (!itens.length) return null;
      return el('ul', { class: 'arvore' }, itens.map((c) => {
        const caixa = el('input', { type: 'checkbox', dataset: { id: c.id, grupo: c.grupo ? '1' : '' },
          onchange: (ev) => this._marcar(t, c, ev.target.checked) });
        const f = this._faixaEscala(t, c);
        const dica = !c.grupo && (f.min || f.max)
          ? el('small', { class: 'dica-escala', title: 'Faixa de escala em que a camada é desenhada' },
            f.min ? `a partir de 1:${fmtNum(f.min)}` : `até 1:${fmtNum(f.max)}`) : null;
        return el('li', { class: c.grupo ? 'no-grupo' : 'no-folha', dataset: { min: f.min, max: f.max } },
          el('label', {}, caixa, el('span', {}, c.nome || `Camada ${c.id}`), dica), montar(c.id));
      }));
    };
    const arvore = montar(-1);
    if (arvore) corpo.append(arvore);
    this._sincronizarCaixas(t);
  }

  _folhasDe(t, camada) {
    if (!camada.grupo) return [camada.id];
    return t.camadas.filter((c) => c.pai === camada.id).flatMap((c) => this._folhasDe(t, c));
  }

  _sincronizarCaixas(t) {
    const e = this.estado.get(t.chave);
    for (const caixa of $$('.arvore input', e.no)) {
      const c = t._porId.get(+caixa.dataset.id);
      const folhas = this._folhasDe(t, c);
      const marcadas = folhas.filter((id) => e.folhas.has(id)).length;
      caixa.checked = marcadas > 0 && marcadas === folhas.length;
      caixa.indeterminate = marcadas > 0 && marcadas < folhas.length;
    }
    this._atualizarConta(t.chave);
  }

  _atualizarConta(chave) {
    const e = this.estado.get(chave);
    if (!e.conta) return;
    e.conta.textContent = e.ativo ? `${e.folhas.size}/${e.total}` : `${e.total}`;
    e.no.classList.toggle('ligado', e.ativo);
  }

  _filtrar(texto) {
    const q = semAcento(texto);
    for (const no of $$('.tema', this.raiz)) no.hidden = q && !no.dataset.texto.includes(q);
  }

  async _alternarLegenda(t, caixa) {
    caixa.hidden = !caixa.hidden;
    if (caixa.hidden) return;
    const e = this.estado.get(t.chave);
    if (!e.legenda) {
      caixa.textContent = 'Carregando legenda…';
      try { e.legenda = await pedirJSON(`${t.url}/legend`, { parametros: { f: 'json' } }); }
      catch (erro) { caixa.textContent = `Legenda indisponível (${erro.message}).`; return; }
    }
    caixa.textContent = '';
    const ativas = (e.legenda.layers || []).filter((l) => e.folhas.has(l.layerId));
    if (!ativas.length) { caixa.textContent = 'Marque ao menos uma camada para ver a legenda.'; return; }
    for (const l of ativas) {
      caixa.append(el('div', { class: 'legenda-camada' }, el('strong', {}, l.layerName),
        (l.legend || []).map((s) => el('div', { class: 'legenda-item' },
          el('img', { src: `data:${s.contentType};base64,${s.imageData}`, alt: '', width: s.width, height: s.height }),
          el('span', {}, s.label || l.layerName)))));
    }
  }

  // --------------------------------------------------------------------- ações
  _marcar(t, camada, marcado) {
    const e = this.estado.get(t.chave);
    for (const id of this._folhasDe(t, camada)) marcado ? e.folhas.add(id) : e.folhas.delete(id);
    if (!t.somente_consulta && marcado && !e.ativo) { e.ativo = true; e.liga.checked = true; }
    this._sincronizarCaixas(t);
    this._redesenhar(t.chave);
    this.aoMudar();
  }

  ligar(chave, ligado) {
    const e = this.estado.get(chave), t = this.temas.find((x) => x.chave === chave);
    if (!e || t.somente_consulta) return;
    e.ativo = ligado;
    if (ligado && !e.folhas.size) e.padrao.forEach((id) => e.folhas.add(id));
    if (ligado && !e.folhas.size) t.camadas.filter((c) => !c.grupo).forEach((c) => e.folhas.add(c.id));
    e.liga.checked = ligado;
    if (e.no.querySelector('.arvore')) this._sincronizarCaixas(t); else this._atualizarConta(chave);
    this._aplicar(chave);
    this.aoMudar();
  }

  restaurar(chave) {
    const e = this.estado.get(chave), t = this.temas.find((x) => x.chave === chave);
    e.folhas = new Set(e.padrao);
    this._sincronizarCaixas(t);
    this._redesenhar(chave);
    this.aoMudar();
  }

  opacidade(chave, valor) {
    const e = this.estado.get(chave);
    e.opacidade = valor;
    if (e.camada) { e.camada.alpha = valor; this.globo.redesenhar(); }
  }

  _aplicar(chave) {
    const e = this.estado.get(chave), t = this.temas.find((x) => x.chave === chave);
    if (t.somente_consulta) return;
    if (e.camada) { this.globo.removerTema(e.camada); e.camada = null; }
    if (e.ativo && e.folhas.size) {
      const provedor = provedorExport(t.url, {
        camadas: [...e.folhas].sort((a, b) => a - b), retangulo: this.globo.ret,
        credito: `${t.titulo}: Prefeitura de Goiânia (Mapa Fácil)`,
      });
      provedor.errorEvent.addEventListener((erro) => {
        if (erro.timesRetried === 0 && !e.avisou) {
          e.avisou = true;
          aviso(`"${t.titulo}": o servidor municipal não respondeu a parte da imagem.`, 'alerta');
        }
      });
      e.camada = this.globo.adicionarTema(provedor, e.opacidade);
    }
    this._atualizarConta(chave);
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

  // ------------------------------------------------------------------- consulta
  /** Temas com desenho ligado: [{tema, ids}] — usados pelo "identificar". */
  ativos() {
    return this.temas.filter((t) => !t.somente_consulta && this.estado.get(t.chave).ativo
      && this.estado.get(t.chave).folhas.size)
      .map((t) => ({ tema: t, ids: [...this.estado.get(t.chave).folhas] }));
  }

  /** Camadas da Base Cadastral a consultar em cada clique. */
  consultaBase() {
    const t = this.temas.find((x) => x.somente_consulta);
    return t ? { tema: t, ids: [...this.estado.get(t.chave).folhas] } : null;
  }

  // ---------------------------------------------------------------------- link
  serializar() {
    return this.temas.filter((t) => !t.somente_consulta && this.estado.get(t.chave).ativo)
      .map((t) => `${t.chave}:${[...this.estado.get(t.chave).folhas].join('.')}`).join('|');
  }

  restaurarDe(texto) {
    for (const parte of String(texto || '').split('|')) {
      const [chave, ids] = parte.split(':');
      const e = this.estado.get(chave), t = this.temas.find((x) => x.chave === chave);
      if (!e || !t || t.somente_consulta) continue;
      const validos = (ids || '').split('.').map(Number).filter((id) => t._porId.has(id) && !t._porId.get(id).grupo);
      if (validos.length) e.folhas = new Set(validos);
      this.ligar(chave, true);
    }
  }
}
