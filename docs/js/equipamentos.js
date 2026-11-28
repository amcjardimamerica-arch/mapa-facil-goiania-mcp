// Equipamentos públicos na Base Cadastral (1.39), como marcadores com ícone:
//  - Grande equipamento (Mapa_PontosNotaveis/2: estádios, terminais, centros administrativos…), no centro da área;
//  - Educação municipal (Mapa_PontosNotaveis/0) e Saúde (Mapa_PontosNotaveis/1);
//  - Segurança, cultura e assistência social (Geo360: Guarda Civil Municipal, Cultura, CRAS e CREAS).
// Ficam em "Imóveis públicos (azul)". O clique abre a ficha do equipamento.
import { consultarOuServidor } from './banco.js';
import { CFG } from './config.js';
import { noChao } from './globo.js';

const Cesium = window.Cesium;
const TIPOS = {
  grande: { titulo: 'Grande equipamento', cor: '#0d47a1', letra: 'GE' },
  educacao: { titulo: 'Equipamento de educação municipal', cor: '#1565c0', letra: 'E' },
  saude: { titulo: 'Equipamento de saúde', cor: '#c62828', letra: '+' },
  social: { titulo: 'Segurança, cultura e assistência social', cor: '#6a1b9a', letra: 'S' },
};
const icones = new Map();
function icone(tipo) {
  if (icones.has(tipo)) return icones.get(tipo);
  const t = TIPOS[tipo], c = document.createElement('canvas'); c.width = c.height = 44;
  const g = c.getContext('2d');
  g.fillStyle = t.cor; g.strokeStyle = '#ffffff'; g.lineWidth = 3;
  if (tipo === 'grande') { g.beginPath(); g.roundRect ? g.roundRect(3, 3, 38, 38, 6) : g.rect(3, 3, 38, 38); g.fill(); g.stroke(); }
  else { g.beginPath(); g.arc(22, 22, 18, 0, Math.PI * 2); g.fill(); g.stroke(); }
  g.fillStyle = '#ffffff'; g.font = `800 ${t.letra.length > 1 ? 15 : 20}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(t.letra, 22, 23);
  icones.set(tipo, c);
  return c;
}
const centro = (rings) => {
  let a = 0, x = 0, y = 0;
  const r = rings[0] || [];
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; a += f; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f; }
  return a ? [x / (3 * a), y / (3 * a)] : r[0];
};

export class Equipamentos {
  constructor({ globo, identificar }) {
    Object.assign(this, { globo, identificar });
    this.fonte = new Cesium.CustomDataSource('equipamentos-base');
    globo.viewer.dataSources.add(this.fonte);
    this.op = { grande: false, educacao: false, saude: false, social: false };
    this.dados = {};
  }

  async _carregar(tipo) {
    if (this.dados[tipo]) return this.dados[tipo];
    const q = (id, geo) => consultarOuServidor('Mapa_PontosNotaveis', id, { f: 'json', where: '1=1', outFields: '*', outSR: '4326', returnGeometry: 'true' })
      .then((r) => (r.features || []).map((f) => ({ c: geo === 'area' ? centro(f.geometry?.rings || []) : [f.geometry?.x, f.geometry?.y], a: f.attributes }))
        .filter((x) => x.c && x.c[0] != null)).catch(() => []);
    let lista = [];
    if (tipo === 'grande') lista = await q(2, 'area');
    else if (tipo === 'educacao') lista = await q(0, 'ponto');
    else if (tipo === 'saude') lista = await q(1, 'ponto');
    else {
      const d = await fetch(`${CFG.dados}geo360/equipamentos.json`).then((r) => r.json()).catch(() => ({ equipamentos: [] }));
      lista = (d.equipamentos || []).map((e) => ({ c: e.c, a: { Nome: e.n, Tipo: e.t, Endereço: e.e, Bairro: e.b, CEP: e.cep } }));
    }
    this.dados[tipo] = lista;
    return lista;
  }

  async definir(op) {
    Object.assign(this.op, op);
    const vez = (this._vez = (this._vez || 0) + 1);
    const listas = await Promise.all(Object.keys(TIPOS).map(async (k) => [k, this.op[k] ? await this._carregar(k) : []]));
    if (vez !== this._vez) return;
    this.fonte.entities.suspendEvents();
    this.fonte.entities.removeAll();
    for (const [k, lista] of listas) for (const it of lista) {
      const ent = this.fonte.entities.add({ position: noChao(it.c[0], it.c[1]),
        billboard: { image: icone(k), width: k === 'grande' ? 26 : 22, height: k === 'grande' ? 26 : 22, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, k === 'grande' ? 40000 : 12000) } });
      ent.equipamento = { tipo: k, a: it.a, c: it.c };
    }
    this.fonte.entities.resumeEvents();
    this.globo.redesenhar();
  }

  aoClicar(pego) {
    const e = pego?.id?.equipamento;
    if (!e) return false;
    const a = e.a || {};
    const nome = a.Nome || a.nm || a.nome || a.NOME || a.nm_equip || a.Name || TIPOS[e.tipo].titulo;
    const id = this.identificar;
    id.abrir({ titulo: String(nome), subtitulo: `${TIPOS[e.tipo].titulo} · Goiânia`, ponto: { lon: e.c[0], lat: e.c[1], alt: NaN } });
    id.corpo.textContent = '';
    const fora = /^(OBJECTID|FID|Shape|shape|created|last_edited|GlobalID|id$)/;
    id.corpo.append(id.tabela(Object.entries(a).filter(([k, v]) => v != null && String(v).trim() !== '' && !fora.test(k)).map(([k, v]) => [k, String(v)])));
    return true;
  }
}
