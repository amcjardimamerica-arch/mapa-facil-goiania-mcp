// Número das quadras (marcador preto de cantos arredondados, número amarelo #FFFF00).
//
// Fica em marcadores de tela, por cima de tudo: nem os lotes nem as construções em 3D o cobrem. O marcador fica
// no centro exato de cada quadra (centroide da área); o número de lote que ficaria embaixo dele é deslocado um
// pouco para o lado no desenho do mapa (mapavetorial.js). Quadra que é praça leva o nome da praça (logradouro
// "Pça" que a contorna); "ÁREA" só fica onde os dados não trazem nenhuma referência de praça.
import { CFG } from './config.js';
import { ALTURA, LIMITE_ALTURA, passaFiltro, BASE, centroDoAnel, pxMarcadorQuadra } from './mapavetorial.js';

const Cesium = window.Cesium;
const R = 6378137;
const lonDe = (x) => (x / R) * (180 / Math.PI);
const latDe = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
const AREA = /^(AREA|ÁREA|PRAC|PCA|PRACA|PRAÇA)$/i;

async function consulta(camada, envMerc, extra) {
  const corpo = new URLSearchParams({ f: 'json', where: '1=1', geometry: envMerc.join(','), geometryType: 'esriGeometryEnvelope', inSR: '3857',
    outSR: '3857', spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true', geometryPrecision: '1', ...extra });
  const r = await fetch(`${CFG.baseCadastral}/${camada}/query`, { method: 'POST', body: corpo, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.features || [];
}

function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}
function dentro(anel, x, y) {
  let d = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}
const centro = (anel) => { let x = 0, y = 0; for (const [a, b] of anel) { x += a; y += b; } return [x / anel.length, y / anel.length]; };

export class Quadras {
  constructor({ globo }) {
    this.globo = globo;
    this.marcadores = globo.cena.primitives.add(new Cesium.BillboardCollection({ scene: globo.cena }));
    this.imagens = new Map();
    this._vez = 0;
    globo.camera.moveEnd.addEventListener(() => this.atualizar());
  }

  _imagem(texto, px) {
    const chave = `${texto}|${px}`;
    if (!this.imagens.has(chave)) {
      const esc = 2, tela = document.createElement('canvas'), g = tela.getContext('2d');
      const fonte = `800 ${px * esc}px system-ui, "Segoe UI", Roboto, sans-serif`;
      g.font = fonte;
      const w = Math.ceil(g.measureText(texto).width + px * 1.0 * esc), h = Math.ceil(px * 1.5 * esc);
      tela.width = w + 2; tela.height = h + 2;
      g.font = fonte; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.beginPath();
      if (g.roundRect) g.roundRect(1, 1, w, h, h * 0.35); else g.rect(1, 1, w, h);
      g.fillStyle = '#000000'; g.fill();
      g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,255,0,.6)'; g.stroke();
      g.fillStyle = '#FFFF00'; g.fillText(texto, w / 2 + 1, h / 2 + 1 + px * 0.06 * esc);
      this.imagens.set(chave, { tela, w: tela.width / esc, h: tela.height / esc });
    }
    return this.imagens.get(chave);
  }

  limpar() { this.marcadores.removeAll(); this.globo.redesenhar(); }

  /** Refaz os marcadores da área vista (chamado ao parar a câmera e quando a seleção de bairros muda). */
  async atualizar() {
    const vez = ++this._vez;
    const h = ALTURA.camera;
    if (!(h <= LIMITE_ALTURA.numeroQuadra) || !BASE.ligado || !BASE.quadras) { this.limpar(); return; }
    const vista = this.globo.camera.computeViewRectangle(this.globo.cena.globe.ellipsoid);
    if (!vista) { this.limpar(); return; }
    const merc = (lon, lat) => [lon * (Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R];
    const [o, s] = merc(Cesium.Math.toDegrees(vista.west), Cesium.Math.toDegrees(vista.south));
    const [l, n] = merc(Cesium.Math.toDegrees(vista.east), Cesium.Math.toDegrees(vista.north));
    const env = [o, s, l, n];
    const comLotes = h <= LIMITE_ALTURA.numeroLote;
    let quadras, lotes = [], pracas = [];
    try {
      [quadras, lotes, pracas] = await Promise.all([
        consulta(1, env, { outFields: 'nm_qdr' }),
        [],
        consulta(7, [o - 80, s - 80, l + 80, n + 80], { outFields: 'tp_log,nm', where: "tp_log = 'Pça'" }).catch(() => []),
      ]);
    } catch { return; }
    if (vez !== this._vez) return;
    // Centros dos lotes (onde ficam os números) por quadra, numa grade simples.
    const T = 60, grade = new Map(), k = (x, y) => `${Math.floor(x / T)},${Math.floor(y / T)}`;
    const centrosLote = [];
    for (const f of lotes) {
      const a = f.geometry?.rings?.[0];
      if (!a) continue;
      const c = centro(a);
      centrosLote.push({ c, anel: a });
      const key = k(c[0], c[1]);
      if (!grade.has(key)) grade.set(key, []);
      grade.get(key).push(c);
    }
    const perto = (x, y) => {
      let m = Infinity;
      const gx = Math.floor(x / T), gy = Math.floor(y / T);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const c of grade.get(`${gx + dx},${gy + dy}`) || []) m = Math.min(m, Math.hypot(c[0] - x, c[1] - y));
      return m;
    };
    const px = pxMarcadorQuadra(h);
    this.marcadores.removeAll();
    for (const f of quadras) {
      const anel = f.geometry?.rings?.[0];
      let nm = String(f.attributes.nm_qdr || '').trim();
      if (!anel || !nm || !passaFiltro(f)) continue;
      const [cx, cy] = centroDoAnel(anel); // centro exato da quadra
      // Praça: nome do logradouro "Pça" que contorna a quadra.
      if (AREA.test(nm)) {
        let melhor = null;
        for (const p of pracas) for (const linha of p.geometry?.paths || []) for (let i = 1; i < linha.length; i++) {
          const d = distSeg(cx, cy, ...linha[i - 1], ...linha[i]);
          if (!melhor || d < melhor.d) melhor = { d, nome: p.attributes.nm };
        }
        let raio = 0; for (const [a, b] of anel) raio = Math.max(raio, Math.hypot(a - cx, b - cy));
        nm = melhor && melhor.d <= raio + 25 ? String(melhor.nome).replace(/^Pça\b/i, 'Pça.') : 'ÁREA';
      }
      const img = this._imagem(nm, px);
      this.marcadores.add({ position: Cesium.Cartesian3.fromDegrees(lonDe(cx), latDe(cy)), image: img.tela, width: img.w, height: img.h,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, LIMITE_ALTURA.numeroQuadra * 2.5) });
    }
    this.globo.redesenhar();
  }
}
