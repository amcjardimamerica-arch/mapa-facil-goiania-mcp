// Vias e Mobilidade (1.37): desenho próprio, sem as escalas nem os rótulos do Mapa Fácil.
//  - Rotas de ônibus: vias com in_onibus = 1 (Mapa_RedeViaria/8).
//  - Pontos e paradas de ônibus: Mapa_Acessibilidade/41.
//  - Vias sem asfalto: in_pavim = 'TER' (terra), em vermelho piscando.
//  - Vias propostas: Mapa_RedeViaria/16 — ruas ainda não abertas (sem sequer rua de terra), tracejadas.
// As linhas da cidade são montadas para a área vista (até ~9 km de altura); as vias propostas, de uma vez.
import { consultarOuServidor } from './banco.js';
import { noChao } from './globo.js';

const Cesium = window.Cesium;
const ALTURA_MAX = 9000;
const RAIO = 0.04;

let iconeParada = null;
function paradaIcone() {
  if (iconeParada) return iconeParada;
  const c = document.createElement('canvas'); c.width = c.height = 40;
  const g = c.getContext('2d');
  g.fillStyle = '#1565c0'; g.strokeStyle = '#ffffff'; g.lineWidth = 3;
  g.beginPath(); g.roundRect ? g.roundRect(4, 4, 32, 32, 7) : g.rect(4, 4, 32, 32); g.fill(); g.stroke();
  g.fillStyle = '#ffffff'; g.fillRect(11, 11, 18, 14); g.fillStyle = '#1565c0'; g.fillRect(13, 13, 14, 6);
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(14, 28, 2.6, 0, 7); g.arc(26, 28, 2.6, 0, 7); g.fill();
  iconeParada = c;
  return c;
}

export class Vias {
  constructor({ globo }) {
    this.globo = globo;
    this.fonte = new Cesium.CustomDataSource('vias-mobilidade');
    globo.viewer.dataSources.add(this.fonte);
    this.op = { rotas: false, paradas: false, semAsfalto: false, propostas: false };
    this._vez = 0;
    globo.camera.moveEnd.addEventListener(() => this.atualizar());
    // vermelho piscando (vias sem asfalto)
    this._pisca = new Cesium.CallbackProperty(() => Cesium.Color.fromCssColorString('#ff1744').withAlpha(0.35 + 0.65 * Math.abs(Math.sin(Date.now() / 450))), false);
  }

  definir(op) {
    Object.assign(this.op, op);
    this._chave = null;
    this.atualizar();
  }

  async atualizar() {
    const vez = ++this._vez, op = this.op;
    const algum = op.rotas || op.paradas || op.semAsfalto || op.propostas;
    const h = this.globo.camera.positionCartographic.height;
    if (!algum) { this.fonte.entities.removeAll(); this._chave = null; this.globo.redesenhar(); return; }
    const c = this.globo.camera.positionCartographic;
    const lon = Cesium.Math.toDegrees(c.longitude), lat = Cesium.Math.toDegrees(c.latitude);
    const perto = h <= ALTURA_MAX;
    const chave = `${perto ? `${Math.round(lon / (RAIO / 2))}:${Math.round(lat / (RAIO / 2))}` : 'longe'}:${JSON.stringify(op)}`;
    if (chave === this._chave) return;
    const env = [lon - RAIO, lat - RAIO, lon + RAIO, lat + RAIO].join(',');
    const q = (S, id, onde, campos, comArea = true) => consultarOuServidor(S, id, { f: 'json', where: onde, outFields: campos, outSR: '4326', returnGeometry: 'true',
      ...(comArea ? { geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' } : {}) })
      .then((r) => r.features || []).catch(() => []);
    const [vias, paradas, propostas] = await Promise.all([
      perto && (op.rotas || op.semAsfalto) ? q('Mapa_RedeViaria', 8, '1=1', 'in_onibus,in_pavim,nm') : [],
      perto && op.paradas ? q('Mapa_Acessibilidade', 41, '1=1', 'Name') : [],
      op.propostas ? (this._propostas ||= q('Mapa_RedeViaria', 16, '1=1', 'id,nm_log', false)) : [],
    ]);
    if (vez !== this._vez) return;
    this.fonte.entities.suspendEvents();
    this.fonte.entities.removeAll();
    const linha = (paths, props) => { for (const p of paths || []) if (p.length > 1) this.fonte.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(p.flat()), clampToGround: true, ...props } }); };
    for (const f of vias) {
      const a = f.attributes;
      if (op.semAsfalto && a.in_pavim === 'TER') linha(f.geometry?.paths, { width: 5, material: new Cesium.ColorMaterialProperty(this._pisca), zIndex: 3 });
      else if (op.rotas && Number(a.in_onibus) === 1) linha(f.geometry?.paths, { width: 3.5, material: Cesium.Color.fromCssColorString('#7c4dff'), zIndex: 2 });
    }
    for (const f of propostas) linha(f.geometry?.paths, { width: 3, zIndex: 1,
      material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString('#ff9800'), dashLength: 14 }) });
    for (const f of paradas) {
      if (f.geometry?.x == null) continue;
      const ent = this.fonte.entities.add({ position: noChao(f.geometry.x, f.geometry.y),
        billboard: { image: paradaIcone(), width: 20, height: 20, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, ALTURA_MAX) } });
      ent.parada = { nome: f.attributes.Name };
    }
    this.fonte.entities.resumeEvents();
    this._chave = chave;
    this.globo.redesenhar();
    if (op.semAsfalto && !this._animando) { // mantém a tela redesenhando para o piscar
      this._animando = setInterval(() => { if (this.op.semAsfalto) this.globo.redesenhar(); else { clearInterval(this._animando); this._animando = null; } }, 120);
    }
  }
}
