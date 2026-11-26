// Ruas do painel Associação: cada rua do bairro é um marcador próprio, em toda a extensão dela dentro do bairro.
// Os trechos (Base Cadastral, camada 7 — segmentos de logradouro) são juntados pelo nome; o clique destaca a rua
// inteira e abre a ficha (nome, bairro, extensão e quantidade de trechos).
import { consultarOuServidor } from './banco.js';
import { el, fmtNum } from './util.js';

const Cesium = window.Cesium;
const CORES = ['#ff9800', '#e91e63', '#00bcd4', '#8bc34a', '#9c27b0', '#ffc107', '#3f51b5', '#009688', '#f44336', '#cddc39'];

function dentro(aneis, x, y) {
  let d = false;
  for (const a of aneis) for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    if ((a[i][1] > y) !== (a[j][1] > y) && x < ((a[j][0] - a[i][0]) * (y - a[i][1])) / (a[j][1] - a[i][1]) + a[i][0]) d = !d;
  }
  return d;
}
const metros = (a, b) => {
  const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540);
};

export class Ruas {
  constructor({ globo, identificar }) {
    Object.assign(this, { globo, identificar });
    this.fonte = new Cesium.CustomDataSource('ruas-associacao');
    globo.viewer.dataSources.add(this.fonte);
    this.porBairro = new Map(); // nome do bairro -> [{ nome, trechos: [[lon,lat]...][], metros }]
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
        if (!ruas.has(nome)) ruas.set(nome, { nome, trechos: [], metros: 0 });
        const r = ruas.get(nome);
        r.trechos.push(dentroDo);
        for (let i = 1; i < dentroDo.length; i++) r.metros += metros(dentroDo[i - 1], dentroDo[i]);
      }
    }
    const lista = [...ruas.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));
    this.porBairro.set(bairro, lista);
    return lista;
  }

  /** Mostra (ou tira) as ruas dos bairros visíveis: [{ nome, aneis }]. */
  async mostrar(ligado, bairros = []) {
    const vez = (this._vez = (this._vez || 0) + 1);
    this.fonte.entities.removeAll();
    if (!ligado) { this.globo.redesenhar(); return; }
    let k = 0;
    for (const b of bairros) {
      const lista = await this._ruasDo(b.nome, b.aneis).catch(() => []);
      if (vez !== this._vez) return;
      for (const r of lista) {
        const cor = Cesium.Color.fromCssColorString(CORES[k++ % CORES.length]);
        for (const t of r.trechos) {
          this.fonte.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(t.flat()), clampToGround: true, width: 5,
            material: cor.withAlpha(0.75) }, ruaAssociacao: { ...r, bairro: b.nome, cor } });
        }
      }
    }
    this.globo.redesenhar();
  }

  aoClicar(pego) {
    const r = pego?.id?.ruaAssociacao;
    if (!r) return false;
    const id = this.identificar;
    id.limparDestaque();
    id.abrir({ titulo: r.nome, subtitulo: `Rua · ${r.bairro}` });
    id.destacarLonLat(r.trechos, { fechado: false, cor: Cesium.Color.YELLOW, preencher: false });
    id.corpo.append(id.tabela([['Bairro', r.bairro], ['Extensão no bairro', `${fmtNum(Math.round(r.metros))} m`], ['Trechos', String(r.trechos.length)]]));
    return true;
  }
}
