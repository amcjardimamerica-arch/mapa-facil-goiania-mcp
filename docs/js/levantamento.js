// Levantamento da Associação: Jardim América e Nova Suíça.
// Lotes classificados por finalidade, limites dos bairros, áreas públicas,
// prédios em 3D e locais de votação, a partir de data/levantamento.json.
import { CFG } from './config.js';
import { el, aviso, fmtNum, pedirJSON, semAcento, memoria } from './util.js';
import { ProvedorLotes } from './mapavetorial.js';

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

const comAlfa = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export class Levantamento {
  constructor({ globo, identificar, raiz }) {
    Object.assign(this, { globo, identificar, raiz });
    this.dados = null;
    this.camadaLotes = null;
    this.fonte = new Cesium.CustomDataSource('levantamento');
    globo.viewer.dataSources.add(this.fonte);
    const salvo = memoria.ler('bussola:levantamento', {});
    this.opcoes = { limites: true, oficiais: false, lotes: true, areas: false, predios: false, bocas: false, iluminacao: false, bairros: [true, true], ...salvo.opcoes };
    this.ocultas = new Set(salvo.ocultas || []);
    this.aoMudar = () => {};
    this._montar();
  }

  get ativo() { return !!this.dados; }

  // ------------------------------------------------------------------ dados
  async carregar() {
    if (this.dados) return this.dados;
    if (this._carregando) return this._carregando;
    this.estado.textContent = 'Carregando o levantamento…';
    this.estado.classList.add('carregando');
    this._carregando = pedirJSON(`${CFG.dados}levantamento.json`, { tempo: 90000 }).then((d) => {
      const ix = Object.fromEntries(d.colunas_lote.map((c, i) => [c, i]));
      this.ix = ix;
      const porLote = (tabela) => {
        const m = new Map();
        for (const r of tabela.linhas) if (Number.isInteger(r.lote)) { if (!m.has(r.lote)) m.set(r.lote, []); m.get(r.lote).push(r.v); }
        return m;
      };
      this.empresasDoLote = porLote(d.empresas);
      this.googleDoLote = porLote(d.google);
      this.condominioDoLote = porLote(d.condominios);
      this.unidadesDoLote = d.unidades?.por_lote || {};
      const ixe = Object.fromEntries(d.empresas.colunas.map((c, i) => [c, i]));
      d.lotes.forEach((l, i) => {
        const v = (c) => l.v[ix[c]];
        l.end = v('Endereço (cadastro)'); l.edif = v('Edifício / condomínio'); l.ar = v('Área do comércio (principal)');
        l.emp = String(v('Empresas (nome)') || '').split(';').map((x) => x.trim()).filter(Boolean);
        l.i = i;
        const emp = (this.empresasDoLote.get(i) || []).map((e) => [e[ixe['CNPJ']], e[ixe['Razão social']], e[ixe['Nome fantasia']], e[ixe['Telefone']], e[ixe['E-mail']]].join(' '));
        l.extraBusca = emp.join(' ');
      });
      for (const l of d.lotes) {
        l.aneis = l.g.map(decodificarAnel);
        l.m = l.aneis.map((a) => a.map(([lo, la]) => [mx(lo), my(la)]));
        let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity, cx = 0, cy = 0;
        for (const [x, y] of l.m[0]) { o = Math.min(o, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); cx += x; cy += y; }
        l.ext = [o, s, e, n];
        l.centro = [cx / l.m[0].length, cy / l.m[0].length];
        const un = (this.unidadesDoLote[l.i] || []).map((u) => `${u[0]} ${u[2] || ''}`).join(' ');
        l.busca = semAcento([`qd ${l.q} lt ${l.l}`, `quadra ${l.q} lote ${l.l}`, ...l.v.filter((x) => x !== null && x !== ''), l.extraBusca, un].join(' | '));
      }
      for (const a of d.areas) a.aneis = a.g.map(decodificarAnel);
      for (const lim of d.limites) lim.aneisLL = lim.aneis.map(decodificarAnel);
      const ixs = d.empresas_sem_lote.colunas;
      this.semLote = d.empresas_sem_lote.linhas.map((r) => ({ v: r, busca: semAcento(r.filter((x) => x !== null).join(' | ')),
        nome: r[ixs.indexOf('Nome fantasia')] || r[ixs.indexOf('Razão social')], bairro: r[ixs.indexOf('Bairro')] }));
      this.cor = Object.fromEntries(d.finalidades.map((f) => [f.nome, f.cor]));
      this.dados = d;
      this._montarFiltros();
      this.redesenhar();
      this.estado.classList.remove('carregando');
      return d;
    }).catch((e) => {
      this._carregando = null;
      this.estado.classList.remove('carregando');
      this.estado.textContent = `Não foi possível carregar o levantamento: ${e.message}`;
      throw e;
    });
    return this._carregando;
  }

  _gravar() { memoria.gravar('bussola:levantamento', { opcoes: this.opcoes, ocultas: [...this.ocultas] }); }

  // ------------------------------------------------------------------- painel
  _montar() {
    const chave = (id, titulo, sub) => {
      const caixa = el('input', { type: 'checkbox', id: `lv-${id}`, checked: !!this.opcoes[id],
        onchange: (e) => { this.opcoes[id] = e.target.checked; this._gravar(); this.redesenhar(); } });
      return el('label', { class: 'linha-chave' }, el('span', {}, el('strong', {}, titulo), el('small', {}, sub)),
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
      chave('limites', 'Limites dos bairros', 'divisa de cada bairro no mapa'),
      chave('lotes', 'Lotes por finalidade', 'residencial, comercial, condominial…'),
      this.legenda,
      chave('oficiais', 'Limite oficial do Mapa Fácil', 'para comparar com o limite pelos lotes'),
      chave('areas', 'Áreas públicas', 'praças, áreas verdes, canteiros e equipamentos'),
      chave('bocas', 'Bocas de lobo', 'ícone com o número de unidades em sequência'),
      chave('iluminacao', 'Iluminação pública', 'lâmpada e poste em 3D (cadastro anterior ao LED)'),
      chave('predios', 'Condomínios e prédios em 3D', 'cor pelo tipo de condomínio, altura pelos pavimentos'),
      el('h3', { class: 'subtitulo' }, 'Eleitoral'),
      this.caixaEleitoral = el('div', { class: 'lv-eleitoral' }),
      el('h3', { class: 'subtitulo' }, 'Buscar no levantamento'),
      this.campo, this.resultados,
      this.caixaConferencia = el('div', {}),
      el('p', { class: 'nota' }, 'Fontes: Mapa Fácil, Receita Federal (CNPJ), Google Maps, TSE e edital do Conselho Tutelar 2023, compiladas pela Associação.'));
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
    this.legenda.textContent = '';
    for (const f of d.finalidades) {
      this.legenda.append(el('li', {}, el('label', {},
        el('input', { type: 'checkbox', checked: !this.ocultas.has(f.nome),
          onchange: (e) => { if (e.target.checked) this.ocultas.delete(f.nome); else this.ocultas.add(f.nome); this._gravar(); this.redesenhar(); } }),
        el('span', { class: 'lv-cor', style: `background:${f.cor}` }),
        el('span', {}, f.nome), el('small', {}, fmtNum(f.n)))));
    }
    this.estado.textContent = `${fmtNum(d.lotes.length)} lotes, ${fmtNum(d.empresas.linhas.length + d.empresas_sem_lote.linhas.length)} empresas, ` +
      `${fmtNum(d.areas.length)} áreas públicas e ${fmtNum(d.eleitoral.pontos.length)} locais de votação.`;
    this._montarEleitoral();
    const cf = d.conferencia;
    this.caixaConferencia.textContent = '';
    if (cf?.linhas?.length) {
      this.caixaConferencia.append(el('details', { class: 'lv-empresa' }, el('summary', {}, 'Conferência de lotes'),
        el('table', { class: 'unidades' }, el('thead', {}, el('tr', {}, cf.colunas.map((c) => el('th', {}, c)))),
          el('tbody', {}, cf.linhas.map((r) => el('tr', {}, r.map((v) => el('td', {}, v ?? '—'))))))));
    }
  }

  _montarEleitoral() {
    const d = this.dados.eleitoral, c = this.caixaEleitoral;
    c.textContent = '';
    this.opcoes.eleicao ??= '';
    this.opcoes.grupos ??= {};
    const zonas = [...new Set(d.pontos.filter((p) => p.tipo === 'geral').map((p) => p.grupo))].sort((a, b) => parseInt(a) - parseInt(b));
    const regioes = [...new Set(d.pontos.filter((p) => p.tipo === 'ct' || p.tipo === 'transferido').map((p) => p.grupo))].sort();
    const seletor = el('select', { class: 'campo', id: 'lv-eleicao', 'aria-label': 'Eleição' },
      el('option', { value: '' }, 'Desligado'), el('option', { value: 'geral' }, 'Eleição geral 2026 — locais por zona'),
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
        lista.append(el('p', { class: 'nota' }, 'Estrela laranja: local de votação do Conselho Tutelar. Cinza: local transferido, com seta para a escola que reuniu as urnas.'));
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

  _lotesVisiveis() {
    return this.dados.lotes.filter((l) => this.opcoes.bairros[l.b] !== false && !this.ocultas.has(l.f));
  }

  // ------------------------------------------------------------------ desenho
  redesenhar() {
    if (!this.dados) return;
    const d = this.dados, camadas = this.globo.viewer.imageryLayers;
    this.fonte.entities.removeAll();
    if (this.camadaLotes) { camadas.remove(this.camadaLotes, true); this.camadaLotes = null; }

    if (this.opcoes.lotes) {
      const lotes = this._lotesVisiveis().map((l) => ({ aneis: l.m, ext: l.ext, centro: l.centro, nm: l.l, cor: comAlfa(this.cor[l.f] || '#9aa3ad', 0.5) }));
      if (lotes.length) {
        let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const l of lotes) { o = Math.min(o, l.ext[0]); s = Math.min(s, l.ext[1]); e = Math.max(e, l.ext[2]); n = Math.max(n, l.ext[3]); }
        const g = (x, y) => [Cesium.Math.toDegrees(x / R), Cesium.Math.toDegrees(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2)];
        const [ow, ss] = g(o, s), [le, nn] = g(e, n);
        const ret = Cesium.Rectangle.fromDegrees(ow, ss, le, nn);
        this.camadaLotes = new Cesium.ImageryLayer(new ProvedorLotes({ lotes, retangulo: ret, borda: 'rgba(255,255,255,.55)',
          credito: 'Levantamento da Associação', nivelMinimo: 11 }), { rectangle: ret });
        camadas.add(this.camadaLotes);
        this.globo.organizarPilha();
      }
    }

    if (this.opcoes.limites) {
      d.limites.forEach((lim, i) => {
        if (this.opcoes.bairros[i] === false) return;
        const cor = Cesium.Color.fromCssColorString(CORES_LIMITE[i % 2]);
        for (const anel of lim.aneisLL) {
          const pos = Cesium.Cartesian3.fromDegreesArray([...anel, anel[0]].flat());
          this.fonte.entities.add({ polyline: { positions: pos, clampToGround: true, width: 4,
            material: new Cesium.PolylineOutlineMaterialProperty({ color: cor, outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1.5 }) } });
        }
        const pts = lim.aneisLL[0];
        const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
        this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(c[0], c[1]), label: {
          text: d.bairros[i] || lim.nome, font: '700 17px system-ui, "Segoe UI", Roboto, sans-serif',
          fillColor: cor, outlineColor: Cesium.Color.BLACK, outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(2500, 60000) } });
      });
    }

    if (this.opcoes.oficiais) {
      (d.limites_oficiais || []).forEach((lim, i) => {
        if (this.opcoes.bairros[i] === false) return;
        for (const anel of lim.aneis.map(decodificarAnel)) {
          this.fonte.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray([...anel, anel[0]].flat()), clampToGround: true,
            width: 3, material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE.withAlpha(0.9), dashLength: 14 }) } });
        }
      });
    }

    const nomeBairro = (b) => d.bairros.indexOf(b);
    const bairroVisivel = (b) => { const i = nomeBairro(b); return i < 0 || this.opcoes.bairros[i] !== false; };
    if (this.opcoes.bocas) {
      const cb = d.bocas.colunas, kla = cb.indexOf('Latitude'), klo = cb.indexOf('Longitude'), kb = cb.indexOf('Bairro');
      for (const b of d.bocas.linhas) {
        if (!bairroVisivel(b.v[kb])) continue;
        const ent = this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(b.v[klo], b.v[kla]),
          billboard: { image: `img/icones/${b.icone}`, width: 30, height: 30, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000) } });
        ent.levantamento = { tipo: 'boca', dado: b };
      }
    }
    if (this.opcoes.iluminacao) {
      const ci = d.iluminacao.colunas, kla = ci.indexOf('Latitude'), klo = ci.indexOf('Longitude'), kb = ci.indexOf('Bairro'), ka = ci.indexOf('Altura 3D estimada (m)');
      const cinza = Cesium.Color.fromCssColorString('#b0bec5');
      for (const p of d.iluminacao.linhas) {
        if (!bairroVisivel(p.v[kb])) continue;
        const alt = Number(p.v[ka]) || 8;
        const ent = this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(p.v[klo], p.v[kla], alt),
          billboard: { image: 'img/icones/lampada.png', width: 22, height: 22, heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4000) } });
        ent.levantamento = { tipo: 'poste', dado: p };
        const poste = this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(p.v[klo], p.v[kla], alt / 2),
          cylinder: { length: alt, topRadius: 0.12, bottomRadius: 0.2, material: cinza, heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1500) } });
        poste.levantamento = { tipo: 'poste', dado: p };
      }
    }

    if (this.opcoes.areas) {
      for (const a of d.areas) {
        if (a.bai && d.bairros.indexOf(a.bai) >= 0 && this.opcoes.bairros[d.bairros.indexOf(a.bai)] === false) continue;
        for (const anel of a.aneis) {
          const ent = this.fonte.entities.add({ polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(anel.flat()),
            material: Cesium.Color.fromCssColorString('#2e9d57').withAlpha(0.5), classificationType: Cesium.ClassificationType.TERRAIN } });
          ent.levantamento = { tipo: 'area', dado: a };
        }
      }
    }

    if (this.opcoes.predios) {
      for (const l of this._lotesVisiveis()) {
        if (!l.alt || !(l.pav >= 3 || /^Condomínio/.test(l.f))) continue;
        const ent = this.fonte.entities.add({ polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(l.aneis[0].flat()),
          height: 0, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          extrudedHeight: l.alt, extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          material: Cesium.Color.fromCssColorString(/^Condomínio/.test(l.f) ? this.cor[l.f] : l.f === 'Residencial' ? '#2196f3' : l.f === 'Comercial' ? '#e91e63' : '#9e9e9e').withAlpha(0.85), outline: false } });
        ent.levantamento = { tipo: 'lote', dado: l };
      }
    }

    const m = this.opcoes.eleicao;
    if (m) {
      const ve = (g) => this.opcoes.grupos[`${m}:${g}`] !== false;
      const E = d.eleitoral;
      const rotulo = (texto) => ({ text: texto, font: '600 12px system-ui, "Segoe UI", Roboto, sans-serif', fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3000) });
      const pontos = E.pontos.filter((p) => (m === 'geral' ? p.tipo === 'geral' && ve(p.grupo)
        : (p.tipo === 'ct' || p.tipo === 'transferido') ? ve(p.grupo) : p.tipo === 'sem' && ve('Sem informação no edital')));
      for (const p of pontos) {
        const estilo = { geral: ['#ff8c00', 9], ct: ['#ffd700', 13], transferido: ['#9e9e9e', 8], sem: ['#e0e0e0', 7] }[p.tipo];
        const ent = this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
          point: { pixelSize: estilo[1], color: Cesium.Color.fromCssColorString(estilo[0]), outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
            outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: rotulo(p.nome) });
        ent.levantamento = { tipo: 'ponto', dado: p };
      }
      if (m === 'ct') {
        for (const s of E.setas) {
          if (!ve(s.regiao)) continue;
          const ent = this.fonte.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray([...s.de, ...s.para]),
            clampToGround: true, width: 9, material: new Cesium.PolylineArrowMaterialProperty(Cesium.Color.fromCssColorString('#bdbdbd').withAlpha(0.95)) } });
          ent.levantamento = { tipo: 'seta', dado: s };
        }
      }
    }
    this.globo.redesenhar();
    this.aoMudar();
  }

  // ------------------------------------------------------------------- busca
  _buscar() {
    const q = semAcento(this.campo.value);
    this.resultados.textContent = '';
    if (!this.dados || q.length < 2) return;
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
    const lv = pego?.id?.levantamento;
    if (lv) {
      if (lv.tipo === 'lote') this.abrirLote(lv.dado);
      else if (lv.tipo === 'area') this.abrirArea(lv.dado);
      else if (lv.tipo === 'seta') this.abrirSeta(lv.dado);
      else if (lv.tipo === 'boca') this.abrirBoca(lv.dado);
      else if (lv.tipo === 'poste') this.abrirPoste(lv.dado);
      else this.abrirPonto(lv.dado);
      return true;
    }
    if (!ponto || !this.opcoes.lotes) return false;
    const x = mx(ponto.lon), y = my(ponto.lat);
    const l = this._lotesVisiveis().find((t) => x >= t.ext[0] && x <= t.ext[2] && y >= t.ext[1] && y <= t.ext[3] && dentro(t.m, x, y));
    if (!l) return false;
    this.abrirLote(l);
    return true;
  }

  /** Tabela com todas as colunas preenchidas de uma linha. */
  _tudo(colunas, valores, pular = []) {
    return this.identificar.tabela(colunas.map((c, k) => [c, valores[k]])
      .filter(([c, v]) => v !== null && v !== undefined && v !== '' && !pular.includes(c))
      .map(([c, v]) => [c, typeof v === 'number' ? (Number.isInteger(v) ? fmtNum(v) : String(v).replace('.', ',')) : String(v)]));
  }

  abrirLote(l, voar = false) {
    const d = this.dados, id = this.identificar;
    const c = l.aneis[0].reduce((a, p) => [a[0] + p[0] / l.aneis[0].length, a[1] + p[1] / l.aneis[0].length], [0, 0]);
    const ponto = { lon: c[0], lat: c[1], alt: NaN };
    const unidades = this.unidadesDoLote[l.i] || [];
    const cu = d.unidades?.colunas || [];
    id.fonte.entities.removeAll();
    id.destacarLonLat(l.aneis, { fechado: true });
    // Condomínio: a pessoa escolhe a base geral (" -- ") ou a de uma unidade (apartamento, sala, casa…).
    const desenhar = (k) => {
      id.abrir({ titulo: `Quadra ${l.q} · Lote ${l.l}`, subtitulo: `${d.bairros[l.b]} · ${l.f}`, ponto });
      if (unidades.length) {
        const kTipo = cu.indexOf('Tipo da unidade');
        const principais = unidades.filter((u, i) => i > 0 && !['Box', 'Escaninho'].includes(u[kTipo])).length;
        const seletor = el('select', { class: 'campo', id: 'lv-unidade', 'aria-label': 'Unidade do condomínio' },
          unidades.map((u, i) => el('option', { value: String(i) }, i === 0 ? ' -- (condomínio, base geral)' : String(u[0]))));
        seletor.value = String(k);
        seletor.addEventListener('change', () => desenhar(Number(seletor.value)));
        id.corpo.append(el('label', { class: 'rotulo-faixa bloco lv-unidade' },
          el('span', {}, /horizontal/i.test(l.f) ? 'Casa do condomínio' : 'Apartamento ou sala',
            el('small', {}, ` ${fmtNum(principais)} unidades principais, ${fmtNum(unidades.length - 1)} inscrições de IPTU`)), seletor));
      }
      if (k > 0) this._corpoUnidade(l, unidades[k], cu); else this._corpoGeral(l, unidades[0], cu);
      id.corpo.append(el('button', { class: 'botao', onclick: () => id.emPonto(ponto) }, 'Consultar este ponto no Mapa Fácil'));
    };
    desenhar(0);
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
    id.corpo.append(this._tudo(d.colunas_lote, l.v, ['Bairro', 'Quadra', 'Lote']));
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
    if (m) id.corpo.insertBefore(el('div', { class: 'linha-botoes' }, m), id.corpo.querySelector('dl.atributos'));
  }

  /** Botão que abre a página de Pedidos de Manutenção já no item (URL#CÓDIGO). */
  _manutencao(codigo) {
    if (!codigo || !this.dados.manutencao) return null;
    return el('a', { class: 'botao destaque', href: `${this.dados.manutencao}#${encodeURIComponent(codigo)}`, target: '_blank', rel: 'noopener' },
      `Pedir manutenção (${codigo})`);
  }

  abrirBoca(b) {
    const id = this.identificar, c = this.dados.bocas.colunas;
    const lat = b.v[c.indexOf('Latitude')], lon = b.v[c.indexOf('Longitude')], codigo = b.v[c.indexOf('Código para manutenção')];
    const n = b.v[c.indexOf('Unidades em sequência')];
    id.fonte.entities.removeAll();
    id.abrir({ titulo: `Boca de lobo ${codigo}`, subtitulo: `${n} ${n === 1 ? 'unidade' : 'unidades'} em sequência · ${b.v[c.indexOf('Bairro')]}`, ponto: { lon, lat, alt: NaN } });
    id.corpo.append(this._tudo(c, b.v), this._manutencao(codigo) || '');
  }

  abrirPoste(p) {
    const id = this.identificar, c = this.dados.iluminacao.colunas;
    const lat = p.v[c.indexOf('Latitude')], lon = p.v[c.indexOf('Longitude')], codigo = p.v[c.indexOf('Código para manutenção')];
    id.fonte.entities.removeAll();
    id.abrir({ titulo: `Iluminação ${codigo}`, subtitulo: `${p.v[c.indexOf('Logradouro (cadastro)')] || ''} · ${p.v[c.indexOf('Bairro')]}`, ponto: { lon, lat, alt: NaN } });
    id.corpo.append(this._tudo(c, p.v), this._manutencao(codigo) || '');
  }

  abrirEmpresaSemLote(e) {
    const id = this.identificar, ce = this.dados.empresas_sem_lote.colunas;
    id.fonte.entities.removeAll();
    id.abrir({ titulo: e.nome || 'Empresa', subtitulo: `${e.bairro || ''} · sem lote identificado` });
    id.corpo.append(this._tudo(ce, e.v));
  }

  abrirArea(a) {
    const id = this.identificar;
    const anel = a.aneis[0];
    const c = anel.reduce((s, p) => [s[0] + p[0] / anel.length, s[1] + p[1] / anel.length], [0, 0]);
    id.fonte.entities.removeAll();
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
    const id = this.identificar, E = this.dados.eleitoral;
    id.fonte.entities.removeAll();
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
    id.fonte.entities.removeAll();
    id.abrir({ titulo: 'Seções transferidas', subtitulo: `Conselho Tutelar 2023 · região ${s.regiao}`, ponto: { lon: s.de[0], lat: s.de[1], alt: NaN } });
    id.corpo.append(el('div', { class: 'lv-desc' }, s.desc.map((t) => el('p', {}, t))));
  }
}
