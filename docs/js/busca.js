// Busca estilo Earth: bairros, logradouros, edifícios, parques, escolas, saúde,
// inscrição cadastral e coordenadas. Os índices são locais (extraídos do Mapa
// Fácil), por isso a busca ignora acentos e maiúsculas e responde na hora; a
// geometria do item escolhido é pedida ao servidor municipal.
import { CFG } from './config.js';
import { cofreAberto, buscarPessoas, vinculosDaPessoa, consultarOuServidor, identificarOuServidor, servicoDe } from './banco.js';
import { $, el, pedirJSON, semAcento, debounce, deUTM, extensaoDe, fmtNum, aviso, nomeBairro } from './util.js';
import { nomeVia } from './mapavetorial.js';

const chave = (s) => semAcento(s).replace(/[-–.]/g, ' ').replace(/\s+/g, ' ').trim();
const TROCAS = [[/^(rua)\s+/, 'r '], [/^(avenida|av)\s+/, 'av '], [/^(alameda)\s+/, 'al '],
  [/^(praca)\s+/, 'pca '], [/^(travessa)\s+/, 'tr '], [/^(rodovia)\s+/, 'rdv '], [/^(viela)\s+/, 'vel ']];

// Tipos de bairro abreviados na base municipal (só os de leitura inequívoca).
const TIPOS_BAIRRO = { S: 'Setor', Bro: 'Bairro', Jd: 'Jardim', Vl: 'Vila', Res: 'Residencial', Prq: 'Parque',
  Cj: 'Conjunto', Ch: 'Chácara', Lot: 'Loteamento', Con: 'Condomínio', Sit: 'Sítio', Faz: 'Fazenda',
  Vlg: 'Village', Dis: 'Distrito', Glb: 'Gleba' };

function pontuar(k, q, palavras) {
  if (k === q) return 0;
  if (k.startsWith(q)) return 1;
  if (k.includes(` ${q}`)) return 2;
  if (k.includes(q)) return 3;
  return palavras.every((p) => k.includes(p)) ? 4 : -1;
}

/** Melhores itens para a consulta; cada item tem `k` (chave) e, opcionalmente, `ks` (chaves alternativas). */
function melhores(itens, q, limite, desempate = () => 0) {
  const palavras = q.split(' ').filter(Boolean);
  const achados = [];
  for (const it of itens) {
    let p = pontuar(it.k, q, palavras);
    for (const k of it.ks || []) {
      const alt = pontuar(k, q, palavras);
      if (alt >= 0 && (p < 0 || alt < p)) p = alt;
    }
    if (p >= 0) achados.push([p, it]);
  }
  achados.sort((a, b) => a[0] - b[0] || desempate(a[1], b[1]) || a[1].k.length - b[1].k.length);
  return achados.slice(0, limite).map((a) => a[1]);
}

export class Busca {
  constructor({ globo, identificar, territorio, bairros, lugares, edificios }) {
    Object.assign(this, { globo, identificar, territorio });
    // "S Bueno" também é achado por "setor bueno" e por "bueno".
    this.bairros = bairros.map((b) => ({ ...b, k: chave(b.n), tipo: TIPOS_BAIRRO[b.t] || 'Bairro',
      ks: [chave(`${TIPOS_BAIRRO[b.t] || ''} ${b.b}`), chave(b.b), chave(b.o || '')] }));
    this.lugares = lugares.map((l) => ({ ...l, k: chave(l.n) }));
    // Parques, lagos, bosques e shoppings pelo nome (scripts/lugares_complemento.py), chegam depois da abertura.
    pedirJSON(`${CFG.dados}lugares_complemento.json`).then((d) => {
      const ja = new Set(this.lugares.map((l) => l.k));
      for (const l of d.lugares || []) { const k = chave(l.n); if (!ja.has(k)) { ja.add(k); this.lugares.push({ ...l, k }); } }
    }).catch(() => {});
    this.edificios = edificios; // módulo Edificios (lista pode chegar depois)
    this.ruas = null;
    this.campo = $('#busca');
    this.lista = $('#resultados');
    this.itens = [];
    this.ativo = -1;
    this.campo.addEventListener('input', debounce(() => this.procurar(), 180));
    // O navegador às vezes preenche a busca com o login salvo ("admin"): começa sempre em branco.
    const limpar = () => { if (document.activeElement !== this.campo) { this.campo.value = ''; this._fechar?.(); } };
    limpar(); setTimeout(limpar, 400); setTimeout(limpar, 1500); window.addEventListener('pageshow', limpar);
    this.campo.addEventListener('focus', () => { this._carregarRuas(); if (this.campo.value) this.procurar(); });
    this.campo.addEventListener('keydown', (e) => this._tecla(e));
    $('#busca-limpar').addEventListener('click', () => { this.campo.value = ''; this._fechar(); this.campo.focus(); });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#caixa-busca')) this._fechar(); });
  }

  async _carregarRuas() {
    if (this.ruas || this._carregando) return;
    this._carregando = true;
    try {
      const d = await pedirJSON(`${CFG.dados}logradouros.json`);
      this.ruas = d.ruas.map(([id, n, b]) => ({ id, n, b: d.bairros[b] || '', k: chave(n) }));
      if (this.campo.value.trim().length >= 2) this.procurar();
    } catch (e) { console.warn('Índice de logradouros indisponível:', e); this._carregando = false; }
  }

  _coordenadas(texto) {
    const nums = (texto.replace(/(\d),(\d)/g, '$1.$2').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length !== 2) return null;
    const [a, b] = nums;
    const grau = (lat, lon) => (lat > -18 && lat < -15.5 && lon > -50.5 && lon < -48 ? { lat, lon } : null);
    const g = grau(a, b) || grau(b, a);
    if (g) return { ...g, rotulo: `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`, sub: 'Coordenadas geográficas' };
    const utm = (e, n) => (e > 580000 && e < 800000 && n > 8050000 && n < 8290000 ? deUTM(e, n) : null);
    const u = utm(a, b) || utm(b, a);
    if (u) return { ...u, rotulo: `E ${fmtNum(Math.min(a, b))}  N ${fmtNum(Math.max(a, b))}`, sub: 'Coordenadas UTM 22S (SIRGAS 2000)' };
    return null;
  }

  procurar() {
    const bruto = this.campo.value.trim();
    $('#busca-limpar').hidden = !bruto;
    if (bruto.length < 2) { this._fechar(); return; }
    // O índice de ruas carrega no foco da caixa; texto que chega sem foco (colado, link) também o carrega.
    if (!this.ruas) this._carregarRuas();
    let q = chave(bruto);
    const grupos = [];
    const coord = this._coordenadas(bruto);
    if (coord) grupos.push(['Coordenadas', [{ tipo: 'coord', n: coord.rotulo, sub: coord.sub, ...coord }]]);
    const digitos = bruto.replace(/\D/g, '');
    if (!coord && digitos.length >= 8 && /^[\d.\s-]+$/.test(bruto)) {
      grupos.push(['Cadastro', [{ tipo: 'ci', n: `Inscrição ${digitos}`, sub: 'Localizar o lote pela inscrição cadastral', ci: digitos.slice(0, 10) }]]);
    }
    const b = melhores(this.bairros, q, 5, (x, y) => y.pop - x.pop);
    if (b.length) grupos.push(['Bairros', b.map((x) => ({ tipo: 'bairro', n: x.n,
      sub: x.pop ? `${x.tipo} · ${fmtNum(x.pop)} habitantes` : x.tipo, dado: x }))]);
    let qRua = q;
    for (const [re, por] of TROCAS) qRua = qRua.replace(re, por);
    if (this.ruas) {
      const r = melhores(this.ruas, qRua, 6);
      // Nome da rua como no mapa ("AV T 9" → "Av. T-9").
      if (r.length) grupos.push(['Logradouros', r.map((x) => ({ tipo: 'rua', n: nomeVia(x.n) || x.n, sub: nomeBairro(x.b), dado: x }))]);
    }
    const eds = this.edificios?.lista || [];
    if (eds.length) {
      const e = melhores(eds, q, 4, (x, y) => y.p - x.p);
      if (e.length) grupos.push(['Edifícios', e.map((x) => ({ tipo: 'edificio', n: x.n, sub: `${x.p} pavimentos`, dado: x }))]);
    }
    const l = melhores(this.lugares, q, 5);
    if (l.length) grupos.push(['Lugares', l.map((x) => ({ tipo: 'lugar', n: x.n, sub: x.r, dado: x }))]);
    this._mostrar(grupos, bruto);
    // Dados complementares liberados: também procura pessoas pelo nome ou pelo CPF/CNPJ.
    if (cofreAberto() && bruto.length >= 4) this._pessoas(bruto, grupos);
  }

  async _pessoas(bruto, grupos) {
    const vez = (this._vezPessoas = (this._vezPessoas || 0) + 1);
    const aguarde = [['Pessoas (dados complementares)', [{ tipo: 'nada', n: 'Procurando nos dados complementares…', sub: 'a primeira busca prepara o índice e leva alguns segundos' }]]];
    this._mostrar([...aguarde, ...grupos], bruto);
    let ps = [];
    try { ps = await buscarPessoas(bruto); } catch (e) { console.warn('busca de pessoas', e); }
    if (vez !== this._vezPessoas || this.campo.value.trim() !== bruto) return;
    const docF = (d) => (d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
      : d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : d);
    const g = ps.length ? [['Pessoas (dados complementares)', ps.map((p) => ({ tipo: 'pessoa', n: p.nome || docF(p.doc),
      sub: `${p.doc ? `${docF(p.doc)} · ` : ''}${p.vinculos.length} vínculo(s)`, dado: p }))]] : [];
    this._mostrar([...g, ...grupos], bruto);
  }

  _ir_nada() {}

  /** Pessoa: os lotes e locais vinculados piscam no mapa e a ficha lista cada vínculo. */
  async _ir_pessoa(it) {
    const p = it.dado;
    const vs = await vinculosDaPessoa(p.vinculos);
    const id = this.identificar;
    id.abrir({ titulo: p.nome || 'Pessoa', subtitulo: `${p.doc || ''} · ${vs.length} vínculo(s) nos dados complementares` });
    const aneis = vs.flatMap((v) => v.aneis);
    if (aneis.length) {
      id.piscar(aneis);
      let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
      for (const a of aneis) for (const [x, y] of a) { o = Math.min(o, x); l = Math.max(l, x); s = Math.min(s, y); n = Math.max(n, y); }
      this.globo.voarPara({ extensao: [o, s, l, n], inclinacao: -70 });
    }
    for (const v of vs) {
      const a = v.atributos;
      id.secao(`${v.rotulo}${a.INSCRICAO || a.nrinscr ? ` — ${a.INSCRICAO || a.nrinscr}` : ''}`, { aberto: vs.length <= 3 })
        .append(id.tabela(Object.entries(a).filter(([, x]) => x !== null && x !== '' && x !== undefined).map(([k, x]) => [k, String(x)])));
    }
    if (!vs.length) id.corpo.append(el('p', { class: 'nota' }, 'Os vínculos desta pessoa não têm desenho no mapa.'));
  }

  _mostrar(grupos, bruto) {
    this.lista.textContent = '';
    this.itens = [];
    this.ativo = -1;
    for (const [titulo, itens] of grupos) {
      this.lista.append(el('li', { class: 'grupo', role: 'presentation' }, titulo));
      for (const it of itens) {
        const no = el('li', { role: 'option', id: `resultado-${this.itens.length}`, 'aria-selected': 'false',
          class: `item tipo-${it.tipo}`, onclick: () => this.escolher(it) },
          el('span', { class: 'nome' }, it.n), el('span', { class: 'sub' }, it.sub || ''));
        this.lista.append(no);
        this.itens.push({ it, no });
      }
    }
    if (!this.itens.length) {
      this.lista.append(el('li', { class: 'vazio' }, this.ruas ? `Nada encontrado para “${bruto}”.` : 'Procurando…'));
    }
    this.lista.hidden = false;
    this.campo.setAttribute('aria-expanded', 'true');
  }

  _fechar() {
    this.lista.hidden = true;
    this.campo.setAttribute('aria-expanded', 'false');
    this.campo.removeAttribute('aria-activedescendant');
  }

  _tecla(e) {
    if (e.key === 'Escape') { this._fechar(); this.campo.blur(); return; }
    if (this.lista.hidden || !this.itens.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.ativo = (this.ativo + (e.key === 'ArrowDown' ? 1 : -1) + this.itens.length) % this.itens.length;
      this.itens.forEach(({ no }, i) => {
        no.classList.toggle('ativo', i === this.ativo);
        no.setAttribute('aria-selected', String(i === this.ativo));
      });
      this.campo.setAttribute('aria-activedescendant', `resultado-${this.ativo}`);
      this.itens[this.ativo].no.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.escolher(this.itens[Math.max(0, this.ativo)].it);
    }
  }

  async escolher(it) {
    this._fechar();
    this.campo.value = it.n;
    this.campo.blur();
    try {
      await this[`_ir_${it.tipo}`](it);
    } catch (e) {
      console.warn(e);
      aviso(`Não foi possível localizar “${it.n}” (${e.message}).`, 'alerta');
    }
  }

  _foraDeGoiania(lon, lat) {
    if (this.territorio.contem(lon, lat)) return false;
    aviso('Esse ponto fica fora de Goiânia.', 'alerta');
    return true;
  }

  async _ir_coord(it) {
    if (this._foraDeGoiania(it.lon, it.lat)) return;
    await this.globo.voarPara({ lon: it.lon, lat: it.lat, distancia: 700 });
    this.identificar.emPonto({ lon: it.lon, lat: it.lat, alt: NaN });
  }

  async _ir_bairro({ dado: b }) {
    const voo = this.globo.voarPara({ extensao: b.e, inclinacao: -60 });
    const id = this.identificar;
    id.limparDestaque();
    id.abrir({ titulo: b.n, subtitulo: 'Bairro · Goiânia', ponto: { lon: b.c[0], lat: b.c[1], alt: NaN } });
    id.corpo.append(id.tabela([
      ['População', b.pop ? `${fmtNum(b.pop)} habitantes (base municipal, ordem de grandeza do Censo 2010)` : 'não informada'],
      ['Condomínio horizontal', b.cond ? 'Sim' : 'Não'],
    ]));
    const r = await consultarOuServidor('Feature_Base', 2, {
      f: 'json', where: `id = '${b.id}'`, outFields: 'id', returnGeometry: 'true', outSR: '4326', geometryPrecision: 6 });
    const aneis = r.features?.[0]?.geometry?.rings;
    if (aneis) id.destacarLonLat(aneis, { fechado: true });
    await voo;
  }

  async _ir_rua({ dado: r }) {
    const resp = await consultarOuServidor('Feature_Base', 10, {
      f: 'json', where: `id = '${r.id}'`, outFields: 'nm,nm_bai', returnGeometry: 'true', outSR: '4326', geometryPrecision: 6 });
    const todas = resp.features || [];
    const doBairro = todas.filter((f) => (f.attributes.nm_bai || '').trim() === r.b);
    const linhas = (doBairro.length ? doBairro : todas).flatMap((f) => f.geometry?.paths || []);
    if (!linhas.length) throw new Error('sem geometria no servidor');
    const id = this.identificar;
    id.destacarLonLat(linhas);
    const ext = extensaoDe(linhas.flat());
    id.abrir({ titulo: nomeVia(r.n) || r.n, subtitulo: `${nomeBairro(r.b)} · Goiânia`, ponto: { lon: (ext[0] + ext[2]) / 2, lat: (ext[1] + ext[3]) / 2, alt: NaN } });
    id.corpo.append(el('p', { class: 'nota' }, 'Trecho do logradouro neste bairro, conforme a base “Logradouro por Bairro”. Clique em um lote para ver o cadastro.'));
    await this.globo.voarPara({ extensao: ext, inclinacao: -60 });
  }

  async _ir_edificio({ dado: e }) {
    await this.edificios.irPara(e);
  }

  async _ir_lugar({ dado: l }) {
    const id = this.identificar;
    id.limparDestaque();
    id.abrir({ titulo: l.n, subtitulo: `${l.r} · Goiânia`, ponto: { lon: l.c[0], lat: l.c[1], alt: NaN } });
    if (l.d) id.corpo.append(el('p', { class: 'nota' }, l.d));
    id.alfinete(l.c[0], l.c[1]);
    await this.globo.voarPara(l.e ? { extensao: l.e } : { lon: l.c[0], lat: l.c[1], distancia: 600 });
  }

  async _ir_ci(it) {
    const r = await consultarOuServidor('Feature_Base', 0, {
      f: 'json', where: `ci = '${it.ci}'`, outFields: 'id,ci', returnGeometry: 'true', outSR: '4326', geometryPrecision: 6 });
    const anel = r.features?.[0]?.geometry?.rings?.[0];
    if (!anel) throw new Error('inscrição não encontrada na base de lotes');
    const ext = extensaoDe(anel);
    const lon = anel.reduce((s, p) => s + p[0], 0) / anel.length, lat = anel.reduce((s, p) => s + p[1], 0) / anel.length;
    await this.globo.voarPara({ extensao: ext, distancia: 450 });
    this.identificar.emPonto({ lon, lat, alt: NaN });
  }
}
