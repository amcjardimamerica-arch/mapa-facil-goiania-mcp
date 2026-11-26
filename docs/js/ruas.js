// Ruas e avenidas do painel Associação (opção "Ruas e avenidas"): cada rua do bairro é um marcador próprio, em cinza,
// em toda a extensão dela dentro do bairro, com o nome em cima. Onde uma rua encontra outra, as duas linhas param um
// pouco antes do cruzamento — fica um espaço entre uma rua e outra, sem linhas emendadas nem nomes sobrepostos.
// Os trechos (Base Cadastral, camada 7 — segmentos de logradouro) são juntados pelo nome; o clique destaca a rua
// inteira e abre a ficha: extensão, onde começa e onde termina (quadra e lote de referência e a rua do cruzamento).
import { consultarOuServidor } from './banco.js';
import { el, fmtNum } from './util.js';
import { noChao } from './globo.js';
import { nomeVia } from './mapavetorial.js';

const Cesium = window.Cesium;
const CINZA = '#9aa0a8';
const CORTE_M = 9;   // espaço deixado de cada lado de um cruzamento com outra rua
const JUNTA_M = 4;   // pontas a menos de 4 m são o mesmo cruzamento

function dentro(aneis, x, y) {
  let d = false;
  for (const a of aneis) for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    if ((a[i][1] > y) !== (a[j][1] > y) && x < ((a[j][0] - a[i][0]) * (y - a[i][1])) / (a[j][1] - a[i][1]) + a[i][0]) d = !d;
  }
  return d;
}
export const metros = (a, b) => {
  const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540);
};

/** Tira `m` metros do começo (ou do fim) de uma linha. */
function aparar(linha, m, doFim) {
  const pts = doFim ? [...linha].reverse() : [...linha];
  let falta = m;
  while (pts.length >= 2) {
    const d = metros(pts[0], pts[1]);
    if (d > falta) {
      const t = falta / d;
      pts[0] = [pts[0][0] + (pts[1][0] - pts[0][0]) * t, pts[0][1] + (pts[1][1] - pts[0][1]) * t];
      break;
    }
    falta -= d; pts.shift();
  }
  return doFim ? pts.reverse() : pts;
}

/** Ponto do meio de uma linha (pela distância). */
function meio(linha) {
  let total = 0;
  for (let i = 1; i < linha.length; i++) total += metros(linha[i - 1], linha[i]);
  let alvo = total / 2;
  for (let i = 1; i < linha.length; i++) {
    const d = metros(linha[i - 1], linha[i]);
    if (alvo <= d) { const t = d ? alvo / d : 0; return [linha[i - 1][0] + (linha[i][0] - linha[i - 1][0]) * t, linha[i - 1][1] + (linha[i][1] - linha[i - 1][1]) * t]; }
    alvo -= d;
  }
  return linha[0];
}

export class Ruas {
  constructor({ globo, identificar }) {
    Object.assign(this, { globo, identificar });
    this.fonte = new Cesium.CustomDataSource('ruas-associacao');
    globo.viewer.dataSources.add(this.fonte);
    this.porBairro = new Map(); // nome do bairro -> [{ nome, trechos: [[lon,lat]...][], metros, inicio, fim }]
    this.loteMaisProximo = null; // (lon, lat) -> lote do levantamento mais próximo (levantamento.js)
  }

  async _ruasDo(bairro, aneis) {
    if (this.porBairro.has(bairro)) return this.porBairro.get(bairro);
    let o = Infinity, s = Infinity, l = -Infinity, n = -Infinity;
    for (const a of aneis) for (const [x, y] of a) { o = Math.min(o, x); l = Math.max(l, x); s = Math.min(s, y); n = Math.max(n, y); }
    const d = await consultarOuServidor('Feature_Base', 7, { geometry: `${o},${s},${l},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'nm,tp_log,nm_log', outSR: '4326', returnGeometry: 'true', where: '1=1' }, { prioridade: 'clique' });
    const ruas = new Map();
    for (const f of d.features || []) {
      const nome = String(f.attributes.nm || `${f.attributes.tp_log || ''} ${f.attributes.nm_log || ''}`).trim();
      if (!nome) continue;
      for (const p of f.geometry?.paths || []) {
        // só a parte do trecho dentro do bairro
        const dentroDo = p.filter(([x, y]) => dentro(aneis, x, y));
        if (dentroDo.length < 2) continue;
        if (!ruas.has(nome)) ruas.set(nome, { nome, rotulo: nomeVia(nome), trechos: [], metros: 0 });
        const r = ruas.get(nome);
        r.trechos.push(dentroDo);
        for (let i = 1; i < dentroDo.length; i++) r.metros += metros(dentroDo[i - 1], dentroDo[i]);
      }
    }
    const lista = [...ruas.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
    // Pontas de cada trecho: as que encostam em trecho de outra rua são cruzamentos (ali a linha é aparada).
    const pontas = [];
    for (const r of lista) r.trechos.forEach((t, k) => { pontas.push({ r, k, p: t[0], fim: false }, { r, k, p: t[t.length - 1], fim: true }); });
    const grade = new Map(), chave = (p) => `${Math.round(p[0] * 2000)}:${Math.round(p[1] * 2000)}`; // ~55 m
    for (const pt of pontas) { const c = chave(pt.p); if (!grade.has(c)) grade.set(c, []); grade.get(c).push(pt); }
    const vizinhas = (pt) => {
      const [gx, gy] = chave(pt.p).split(':').map(Number), out = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const o2 of grade.get(`${gx + dx}:${gy + dy}`) || []) {
        if (o2 !== pt && metros(o2.p, pt.p) <= JUNTA_M) out.push(o2);
      }
      return out;
    };
    for (const r of lista) {
      r.desenho = r.trechos.map((t) => [...t]);
      r.cruzamentos = [];
    }
    for (const pt of pontas) {
      const outras = vizinhas(pt).filter((o2) => o2.r !== pt.r);
      const mesma = vizinhas(pt).some((o2) => o2.r === pt.r);
      pt.cruza = [...new Set(outras.map((o2) => o2.r.rotulo))];
      pt.continua = mesma;
      if (outras.length) {
        const t = pt.r.desenho[pt.k];
        if (t.length >= 2) pt.r.desenho[pt.k] = aparar(t, CORTE_M, pt.fim);
      }
    }
    // Início e fim da rua no bairro: as duas pontas sem continuação mais distantes entre si.
    for (const r of lista) {
      const soltas = pontas.filter((pt) => pt.r === r && !pt.continua);
      const cand = soltas.length >= 2 ? soltas : pontas.filter((pt) => pt.r === r);
      let a = cand[0], b = cand[cand.length - 1], maior = -1;
      for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
        const dd = metros(cand[i].p, cand[j].p);
        if (dd > maior) { maior = dd; a = cand[i]; b = cand[j]; }
      }
      // Começa no lado oeste (ou norte, se a rua for mais norte-sul).
      const ns = Math.abs(a.p[1] - b.p[1]) * 110540 > Math.abs(a.p[0] - b.p[0]) * 106000;
      if (ns ? a.p[1] < b.p[1] : a.p[0] > b.p[0]) [a, b] = [b, a];
      r.inicio = a; r.fim = b;
      let longo = r.trechos[0], m0 = 0;
      for (const t of r.trechos) { let mm = 0; for (let i = 1; i < t.length; i++) mm += metros(t[i - 1], t[i]); if (mm > m0) { m0 = mm; longo = t; } }
      r.meio = meio(longo);
    }
    this.porBairro.set(bairro, lista);
    return lista;
  }

  /** Mostra (ou tira) as ruas dos bairros visíveis: [{ nome, aneis }]. */
  async mostrar(ligado, bairros = []) {
    const vez = (this._vez = (this._vez || 0) + 1);
    this.fonte.entities.removeAll();
    if (!ligado) { this.globo.redesenhar(); return; }
    const cinza = Cesium.Color.fromCssColorString(CINZA);
    for (const b of bairros) {
      const lista = await this._ruasDo(b.nome, b.aneis).catch(() => []);
      if (vez !== this._vez) return;
      this.fonte.entities.suspendEvents();
      for (const r of lista) {
        const dado = { ...r, bairro: b.nome };
        for (const t of r.desenho) {
          if (t.length < 2) continue;
          this.fonte.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(t.flat()), clampToGround: true, width: 5,
            material: cinza.withAlpha(0.95) }, ruaAssociacao: dado });
        }
        const ent = this.fonte.entities.add({ position: noChao(r.meio[0], r.meio[1]), label: { text: r.rotulo,
          font: '600 11.5px system-ui, "Segoe UI", Roboto, sans-serif', fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString('#3a3f45'), outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('#5f656d').withAlpha(0.85), backgroundPadding: new Cesium.Cartesian2(5, 2),
          disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2500) }, ruaAssociacao: dado });
        ent.ll = r.meio;
      }
      this.fonte.entities.resumeEvents();
    }
    this.globo.redesenhar();
  }

  /** "Quadra 12, lote 5 (cruzamento com R. C-130)" para uma ponta da rua. */
  _ponta(pt) {
    if (!pt) return '—';
    const l = this.loteMaisProximo?.(pt.p[0], pt.p[1]);
    const ref = l ? `Quadra ${l.q}, lote ${l.l}` : `${pt.p[1].toFixed(5)}, ${pt.p[0].toFixed(5)}`;
    return `${ref} — ${pt.cruza?.length ? `cruzamento com ${pt.cruza.join(' e ')}` : 'divisa do bairro'}`;
  }

  aoClicar(pego) {
    const r = pego?.id?.ruaAssociacao;
    if (!r) return false;
    const id = this.identificar;
    id.limparDestaque();
    id.abrir({ titulo: r.rotulo || r.nome, subtitulo: `Rua · ${r.bairro}` });
    id.destacarLonLat(r.trechos, { fechado: false, cor: Cesium.Color.YELLOW, preencher: false });
    id.corpo.append(id.tabela([['Bairro', r.bairro], ['Extensão no bairro', `${fmtNum(Math.round(r.metros))} m`],
      ['Início', this._ponta(r.inicio)], ['Fim', this._ponta(r.fim)], ['Trechos (entre cruzamentos)', String(r.trechos.length)]]),
    el('p', { class: 'nota' }, 'Início e fim pela rua dentro do bairro, com a quadra e o lote mais próximos de cada ponta.'));
    return true;
  }
}
