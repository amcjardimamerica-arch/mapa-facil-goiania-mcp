// Lotes por bairro: a pessoa escolhe os bairros e só os lotes deles são buscados
// no Mapa Fácil e desenhados no mapa. Nada do restante de Goiânia é carregado.
import { CFG } from './config.js';
import { el, aviso, fmtNum, semAcento } from './util.js';
import { ProvedorLotes, filaMunicipal } from './mapavetorial.js';

const Cesium = window.Cesium;
const MAX_BAIRROS = 6;
const CORES = ['rgba(255,213,74,.20)', 'rgba(138,180,248,.22)', 'rgba(129,214,147,.22)', 'rgba(255,138,128,.22)', 'rgba(199,146,234,.22)', 'rgba(79,195,247,.22)'];
const MARCAS = ['#ffd54a', '#8ab4f8', '#81d693', '#ff8a80', '#c792ea', '#4fc3f7'];

async function consultarLotes(parametros) {
  return filaMunicipal.rodar(async () => {
    const r = await fetch(`${CFG.baseCadastral}/0/query`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ f: 'json', ...parametros }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || 'erro do servidor');
    return d;
  });
}

/** Ponto dentro de polígono (anéis em coordenadas planas), regra par-ímpar. */
export function dentroDe(aneis, x, y) {
  let dentro = false;
  for (const anel of aneis) {
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const [xi, yi] = anel[i], [xj, yj] = anel[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
  }
  return dentro;
}

const extensao = (aneis) => {
  let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
  for (const a of aneis) for (const [x, y] of a) { if (x < o) o = x; if (x > l) l = x; if (y < s) s = y; if (y > n) n = y; }
  return [o, s, l, n];
};
const centroDe = (anel) => { let sx = 0, sy = 0; for (const [x, y] of anel) { sx += x; sy += y; } return [sx / anel.length, sy / anel.length]; };
const grausDe = (x, y) => [(x / 6378137) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI)];

export class Lotes {
  constructor({ globo, bairros, raiz }) {
    this.globo = globo;
    this.bairros = bairros;
    this.raiz = raiz;
    this.escolhidos = new Map(); // id -> { bairro, cor, marca, lotes, estado }
    this.camada = null;
    this.aoMudar = () => {};
    this._montar();
  }

  _montar() {
    this.campo = el('input', { class: 'campo', id: 'lotes-busca', type: 'search', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Digite o nome do bairro…', 'aria-label': 'Bairro para mostrar os lotes', role: 'combobox',
      'aria-expanded': 'false', 'aria-controls': 'lotes-sugestoes', oninput: () => this._sugerir(), onkeydown: (e) => this._tecla(e) });
    this.lista = el('ul', { id: 'lotes-sugestoes', class: 'lotes-sugestoes', role: 'listbox', hidden: true });
    this.chips = el('ul', { class: 'lotes-escolhidos', 'aria-label': 'Bairros com lotes no mapa' });
    this.estado = el('p', { class: 'nota', id: 'lotes-estado' }, 'Escolha um ou mais bairros: só os lotes deles serão carregados.');
    this.raiz.append(
      el('div', { class: 'lotes-caixa' },
        el('div', { class: 'lotes-topo' }, el('strong', {}, 'Lotes por bairro'), el('small', {}, `até ${MAX_BAIRROS} bairros por vez`)),
        el('div', { class: 'lotes-campo' }, this.campo, this.lista),
        this.chips, this.estado));
  }

  _sugerir() {
    const q = semAcento(this.campo.value);
    this.lista.textContent = '';
    this.ativo = -1;
    if (q.length < 2) { this._fecharLista(); return; }
    const achados = this.bairros.filter((b) => semAcento(b.n).includes(q) || semAcento(b.b || '').includes(q))
      .sort((a, b) => (semAcento(a.b || a.n).startsWith(q) ? 0 : 1) - (semAcento(b.b || b.n).startsWith(q) ? 0 : 1) || (b.pop || 0) - (a.pop || 0))
      .slice(0, 8);
    this.sugestoes = achados;
    if (!achados.length) { this.lista.append(el('li', { class: 'vazio' }, 'Nenhum bairro com esse nome.')); }
    achados.forEach((b, i) => this.lista.append(el('li', { role: 'option', id: `lotes-op-${i}`, 'aria-selected': 'false', class: 'item',
      onmousedown: (e) => { e.preventDefault(); this.adicionar(b.id); } },
      el('span', {}, b.n), this.escolhidos.has(b.id) ? el('small', {}, 'já no mapa') : null)));
    this.lista.hidden = false;
    this.campo.setAttribute('aria-expanded', 'true');
  }

  _fecharLista() { this.lista.hidden = true; this.campo.setAttribute('aria-expanded', 'false'); this.campo.removeAttribute('aria-activedescendant'); }

  _tecla(e) {
    const n = this.sugestoes?.length || 0;
    if (e.key === 'Escape') { this._fecharLista(); return; }
    if (!n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.ativo = (this.ativo + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      [...this.lista.children].forEach((li, i) => { li.classList.toggle('ativo', i === this.ativo); li.setAttribute('aria-selected', String(i === this.ativo)); });
      this.campo.setAttribute('aria-activedescendant', `lotes-op-${this.ativo}`);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.adicionar(this.sugestoes[Math.max(0, this.ativo)].id);
    }
  }

  /** Coloca os lotes de um bairro no mapa (busca só esse bairro no servidor). */
  async adicionar(id, { voar = true } = {}) {
    const bairro = this.bairros.find((b) => b.id === id);
    if (!bairro) return false;
    this.campo.value = '';
    this._fecharLista();
    if (this.escolhidos.has(id)) { if (voar) this.irPara(id); return true; }
    if (this.escolhidos.size >= MAX_BAIRROS) { aviso(`Mostre até ${MAX_BAIRROS} bairros por vez. Remova um para incluir outro.`, 'alerta'); return false; }
    const usadas = new Set([...this.escolhidos.values()].map((x) => x.indice));
    const indice = [...CORES.keys()].find((i) => !usadas.has(i)) ?? 0;
    const item = { bairro, indice, cor: CORES[indice], marca: MARCAS[indice], lotes: [], estado: 'carregando', total: 0 };
    this.escolhidos.set(id, item);
    this._desenharChips();
    if (voar) this.globo.voarPara({ extensao: bairro.e, inclinacao: -60 });
    try {
      await this._carregar(item);
      item.estado = 'pronto';
      if (!this.escolhidos.has(id)) return false; // removido enquanto carregava
      this._atualizarCamada();
      aviso(`${fmtNum(item.lotes.length)} lotes de ${bairro.n} no mapa.`);
    } catch (e) {
      item.estado = 'erro';
      item.erro = e.message;
      aviso(`Não foi possível carregar os lotes de ${bairro.n}: ${e.message}`, 'alerta', 6000);
    }
    this._desenharChips();
    this.aoMudar();
    return item.estado === 'pronto';
  }

  async _carregar(item) {
    const b = item.bairro;
    const r = await filaMunicipal.rodar(async () => {
      const resp = await fetch(`${CFG.baseCadastral}/2/query?${new URLSearchParams({ f: 'json', where: `id = '${b.id.replace(/'/g, '')}'`,
        outFields: 'id', returnGeometry: 'true', outSR: '3857', geometryPrecision: '1' })}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    });
    const aneis = r.features?.[0]?.geometry?.rings;
    if (!aneis) throw new Error('limite do bairro não encontrado');
    item.aneis = aneis;
    const geometria = JSON.stringify({ rings: aneis, spatialReference: { wkid: 3857 } });
    const base = { geometry: geometria, geometryType: 'esriGeometryPolygon', inSR: '3857', outSR: '3857', spatialRel: 'esriSpatialRelIntersects' };
    // Primeiro só os números dos lotes do bairro; depois as geometrias, em lotes de 600.
    const { objectIds } = await consultarLotes({ ...base, returnIdsOnly: 'true' });
    const ids = [...new Set(objectIds || [])].sort((a, b) => a - b);
    item.total = ids.length;
    item.carregados = 0;
    this._desenharChips();
    const partes = [];
    for (let k = 0; k < ids.length; k += 600) partes.push(ids.slice(k, k + 600));
    const vistos = new Set();
    await Promise.all(partes.map(async (parte) => {
      if (!this.escolhidos.has(b.id)) return; // desistiu no meio
      const d = await consultarLotes({ objectIds: parte.join(','), outSR: '3857', returnGeometry: 'true',
        outFields: 'OBJECTID,nm_lot', geometryPrecision: '1', maxAllowableOffset: '0.25' });
      for (const f of d.features || []) {
        const oid = f.attributes.OBJECTID;
        const a = f.geometry?.rings;
        if (!a?.length || vistos.has(oid)) continue;
        vistos.add(oid);
        const centro = centroDe(a[0]);
        // Só os lotes cujo centro fica dentro do bairro (os vizinhos que encostam na divisa ficam de fora).
        if (!dentroDe(aneis, centro[0], centro[1])) continue;
        const nm = String(f.attributes.nm_lot || '').trim();
        item.lotes.push({ aneis: a, ext: extensao(a), centro, nm: /^\d+[A-Z]?$/i.test(nm) ? nm : (nm && nm.length <= 6 ? nm : ''), cor: item.cor });
      }
      item.carregados += parte.length;
      this._desenharChips();
    }));
  }

  /** Edificações em 3D só dentro do bairro (mesmo motor do projeto Edificações). */
  async alternarEdificacoes(id) {
    const it = this.escolhidos.get(id);
    if (!it || !this.edificios) return;
    const ligar = !this.edificios.bairroLigado(id);
    const aneis = it.aneis ? it.aneis.map((a) => a.map(([x, y]) => grausDe(x, y))) : null;
    await this.edificios.definirBairro(id, it.bairro.n, ligar, aneis);
    this._desenharChips();
  }

  remover(id) {
    if (this.edificios?.bairroLigado(id)) this.edificios.definirBairro(id, '', false);
    if (!this.escolhidos.delete(id)) return;
    this._atualizarCamada();
    this._desenharChips();
    this.aoMudar();
  }

  limpar() {
    this.escolhidos.clear();
    this._atualizarCamada();
    this._desenharChips();
    this.aoMudar();
  }

  irPara(id) {
    const it = this.escolhidos.get(id);
    if (it) this.globo.voarPara({ extensao: it.bairro.e, inclinacao: -60 });
  }

  /** Recria a camada de lotes com o que está carregado (desenhada no navegador). */
  _atualizarCamada() {
    const camadas = this.globo.viewer.imageryLayers;
    if (this.camada) { camadas.remove(this.camada, true); this.camada = null; }
    const lotes = [...this.escolhidos.values()].filter((x) => x.estado === 'pronto' || x.lotes.length).flatMap((x) => x.lotes);
    if (lotes.length) {
      let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
      for (const lt of lotes) { o = Math.min(o, lt.ext[0]); s = Math.min(s, lt.ext[1]); l = Math.max(l, lt.ext[2]); n = Math.max(n, lt.ext[3]); }
      const [ow, ss] = grausDe(o, s), [le, nn] = grausDe(l, n);
      const ret = Cesium.Rectangle.fromDegrees(ow, ss, le, nn);
      this.camada = new Cesium.ImageryLayer(new ProvedorLotes({ lotes, retangulo: ret }), { rectangle: ret });
      camadas.add(this.camada);
      this.globo.organizarPilha();
    }
    this.globo.redesenhar();
  }

  _desenharChips() {
    this.chips.textContent = '';
    for (const [id, it] of this.escolhidos) {
      const progresso = it.estado === 'carregando'
        ? (it.total ? `carregando ${fmtNum(Math.min(it.carregados || 0, it.total))} de ${fmtNum(it.total)}…` : 'carregando…')
        : it.estado === 'erro' ? 'falhou — toque para tentar de novo' : `${fmtNum(it.lotes.length)} lotes`;
      this.chips.append(el('li', { class: `lotes-chip ${it.estado}` },
        el('span', { class: 'lotes-cor', style: `background:${it.marca}` }),
        el('button', { class: 'lotes-nome', title: 'Ir ao bairro', onclick: () => (it.estado === 'erro'
          ? (this.escolhidos.delete(id), this.adicionar(id)) : this.irPara(id)) },
          el('strong', {}, it.bairro.n), el('small', {}, progresso)),
        this.edificios ? el('button', { class: `botao-texto lotes-3d${this.edificios.bairroLigado(id) ? ' ligado' : ''}`,
          'aria-pressed': String(this.edificios.bairroLigado(id)), title: 'Edificações em 3D só neste bairro',
          onclick: () => this.alternarEdificacoes(id) }, '3D') : null,
        el('button', { class: 'botao-icone', 'aria-label': `Tirar os lotes de ${it.bairro.n}`, title: 'Tirar do mapa', onclick: () => this.remover(id) }, '×')));
    }
    const total = [...this.escolhidos.values()].reduce((s, x) => s + x.lotes.length, 0);
    this.estado.textContent = this.escolhidos.size
      ? `${fmtNum(total)} lotes no mapa. Clique em um lote para ver o cadastro.`
      : 'Escolha um ou mais bairros: só os lotes deles serão carregados.';
  }

  /** Para o link da vista: ids dos bairros escolhidos. */
  serializar() { return [...this.escolhidos.keys()].join('.'); }
  restaurar(texto) { for (const id of String(texto || '').split('.').filter(Boolean).slice(0, MAX_BAIRROS)) this.adicionar(id, { voar: false }); }
}
