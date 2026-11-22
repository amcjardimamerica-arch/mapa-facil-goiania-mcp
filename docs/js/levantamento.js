// Levantamento da Associação: Jardim América e Setor Nova Suíça.
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
    this.opcoes = { limites: true, lotes: true, areas: false, predios: false, locais: false, bairros: [true, true], ...salvo.opcoes };
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
      for (const l of d.lotes) {
        l.aneis = l.g.map(decodificarAnel);
        l.m = l.aneis.map((a) => a.map(([lo, la]) => [mx(lo), my(la)]));
        let o = Infinity, s = Infinity, e = -Infinity, n = -Infinity, cx = 0, cy = 0;
        for (const [x, y] of l.m[0]) { o = Math.min(o, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); cx += x; cy += y; }
        l.ext = [o, s, e, n];
        l.centro = [cx / l.m[0].length, cy / l.m[0].length];
        l.busca = semAcento([`qd ${l.q} lt ${l.l}`, `quadra ${l.q} lote ${l.l}`, l.end, l.edif, l.ci, l.f, l.st, l.ar, l.cat, l.gm, ...(l.emp || [])].filter(Boolean).join(' | '));
      }
      for (const a of d.areas) a.aneis = a.g.map(decodificarAnel);
      for (const lim of d.limites) lim.aneisLL = lim.aneis.map(decodificarAnel);
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
      chave('areas', 'Áreas públicas', 'praças, áreas verdes, canteiros e equipamentos'),
      chave('predios', 'Prédios em 3D', 'altura pelos pavimentos (3 ou mais)'),
      chave('locais', 'Locais de votação', 'eleição de 2026 e Conselho Tutelar'),
      el('h3', { class: 'subtitulo' }, 'Buscar no levantamento'),
      this.campo, this.resultados,
      el('p', { class: 'nota' }, 'Fontes: Mapa Fácil, Receita Federal (CNPJ), Google Maps, TSE e edital do Conselho Tutelar 2023, compiladas pela Associação. Contatos e telefones não são publicados.'));
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
    this.estado.textContent = `${fmtNum(d.lotes.length)} lotes, ${fmtNum(d.areas.length)} áreas públicas e ${fmtNum(d.locais.length)} locais de votação.`;
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
        if (!(l.pav >= 3) || !l.alt) continue;
        const ent = this.fonte.entities.add({ polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(l.aneis[0].flat()),
          height: 0, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          extrudedHeight: l.alt, extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          material: Cesium.Color.fromCssColorString(this.cor[l.f] || '#9aa3ad').withAlpha(0.85), outline: false } });
        ent.levantamento = { tipo: 'lote', dado: l };
      }
    }

    if (this.opcoes.locais) {
      for (const v of d.locais) {
        const ct = /Local de votação do Conselho/i.test(v.ct);
        const ent = this.fonte.entities.add({ position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat),
          point: { pixelSize: ct ? 11 : 8, color: Cesium.Color.fromCssColorString(ct ? '#ff8a3d' : '#ffffff'),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8), outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: { text: v.nome, font: '600 12px system-ui, "Segoe UI", Roboto, sans-serif', fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -16), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2500) } });
        ent.levantamento = { tipo: 'local', dado: v };
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
    if (!achados.length) { this.resultados.append(el('li', { class: 'nota' }, 'Nada encontrado nos lotes visíveis.')); return; }
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
      else this.abrirLocal(lv.dado);
      return true;
    }
    if (!ponto || !this.opcoes.lotes) return false;
    const x = mx(ponto.lon), y = my(ponto.lat);
    const l = this._lotesVisiveis().find((t) => x >= t.ext[0] && x <= t.ext[2] && y >= t.ext[1] && y <= t.ext[3] && dentro(t.m, x, y));
    if (!l) return false;
    this.abrirLote(l);
    return true;
  }

  _local(i) { return Number.isInteger(i) ? this.dados.locais[i] : null; }

  abrirLote(l, voar = false) {
    const d = this.dados, id = this.identificar;
    const c = l.aneis[0].reduce((a, p) => [a[0] + p[0] / l.aneis[0].length, a[1] + p[1] / l.aneis[0].length], [0, 0]);
    id.fonte.entities.removeAll();
    id.destacarLonLat(l.aneis, { fechado: true });
    id.abrir({ titulo: `Quadra ${l.q} · Lote ${l.l}`, subtitulo: `${d.bairros[l.b]} · ${l.f}`, ponto: { lon: c[0], lat: c[1], alt: NaN } });
    const vot = this._local(l.vot), ctv = typeof l.ctv === 'number' ? this._local(l.ctv)?.nome : l.ctv;
    const linhas = [
      ['Finalidade', [l.f, l.st].filter(Boolean).join(' — ')],
      ['Endereço', l.end], ['Prédio / condomínio', l.edif], ['Inscrição (CI)', l.ci],
      ['Área do comércio', l.ar], ['Outras áreas', l.aa && l.aa !== l.ar ? l.aa : ''],
      ['CNPJs ativos', l.cnpj ? fmtNum(l.cnpj) : ''], ['Alvarás municipais', l.alv ? fmtNum(l.alv) : ''],
      ['Unidades', l.un ? `${fmtNum(l.un)} (${fmtNum(l.ur || 0)} residenciais, ${fmtNum(l.unr || 0)} não residenciais)` : ''],
      ['Pavimentos', l.pav ? `${fmtNum(l.pav)}${l.alt ? ` (≈ ${fmtNum(l.alt)} m)` : ''}` : ''],
      ['Área do terreno', l.at ? `${fmtNum(l.at, l.at % 1 ? 1 : 0)} m²` : ''], ['Área edificada', l.ae ? `${fmtNum(l.ae)} m²` : ''],
      ['No levantamento', l.cat], ['Google Maps', l.gm && l.gm !== '0' ? l.gm : ''], ['Área pública', l.ap],
    ].filter(([, v]) => v);
    id.corpo.append(id.tabela(linhas));
    if (l.emp?.length) {
      const s = id.secao(`Empresas no lote (${l.emp.length})`, { aberto: l.emp.length <= 4 });
      s.append(el('ul', { class: 'lv-empresas' }, l.emp.map((n) => el('li', {}, n))));
    }
    if (vot || l.ctr) {
      id.secao('Eleitoral', { aberto: false }).append(id.tabela([
        ['Local de votação mais próximo', vot ? `${vot.nome} (${vot.z}ª zona, local ${vot.n})` : ''],
        ['Distância', l.dist ? `${fmtNum(l.dist)} m` : ''],
        ['Conselho Tutelar 2023', [l.ctr && `região ${l.ctr}`, l.cts].filter(Boolean).join(' · ')],
        ['Onde votou no CT', ctv || ''],
      ].filter(([, v]) => v)));
    }
    id.corpo.append(el('button', { class: 'botao', onclick: () => id.emPonto({ lon: c[0], lat: c[1], alt: NaN }) }, 'Consultar este ponto no Mapa Fácil'));
    if (voar) this.globo.voarPara({ lon: c[0], lat: c[1], distancia: 350, inclinacao: -60 });
  }

  abrirArea(a) {
    const id = this.identificar;
    const anel = a.aneis[0];
    const c = anel.reduce((s, p) => [s[0] + p[0] / anel.length, s[1] + p[1] / anel.length], [0, 0]);
    id.fonte.entities.removeAll();
    id.destacarLonLat(a.aneis, { fechado: true });
    id.abrir({ titulo: a.nome, subtitulo: [a.cat, a.bai].filter(Boolean).join(' · '), ponto: { lon: c[0], lat: c[1], alt: NaN } });
    id.corpo.append(id.tabela([['Destinação', a.dest], ['Uso', a.uso], ['Proprietário', a.prop],
      ['Área', a.area ? `${fmtNum(a.area, 0)} m²` : ''], ['Fontes', a.fontes]].filter(([, v]) => v)));
  }

  abrirLocal(v) {
    const id = this.identificar;
    id.fonte.entities.removeAll();
    id.abrir({ titulo: v.nome, subtitulo: `${v.z}ª zona eleitoral · local ${v.n}`, ponto: { lon: v.lon, lat: v.lat, alt: NaN } });
    id.corpo.append(id.tabela([['Endereço', [v.end, v.bai].filter(Boolean).join(' — ')],
      ['Seções', v.sec ? fmtNum(v.sec) : ''], ['Eleitores', v.ele ? fmtNum(v.ele) : ''], ['Em uso em 2026', v.uso ? 'Sim' : 'Não'],
      ['Conselho Tutelar 2023', [v.ct, v.ctr && `região ${v.ctr}`].filter(Boolean).join(' · ')]].filter(([, x]) => x)));
  }
}
