// Postes 3D da camada Energia (1.36): em toda Goiânia, os postes e a iluminação pública do cadastro da
// Prefeitura aparecem com o mesmo desenho dos postes do Jardim América (haste, bola do topo na cor da tensão,
// braço e esfera da luminária), no lugar dos marcadores. Só indicação: sem pedido de manutenção.
//  - Poste (Mapa_Energia/4): a haste.
//  - Barramento e Potência da lâmpada (Mapa_Energia/1 e /3): o braço com a luminária (no poste mais próximo).
//  - Tensão (bola do topo): poste na rede primária = alta (laranja); só na secundária = baixa (amarelo).
// Por serem dezenas de milhares, o desenho 3D é montado para a área vista, de perto (até ~2,5 km de altura).
import { Postes, escalaMostrador } from './postes.js';
import { consultarOuServidor } from './banco.js';

const Cesium = window.Cesium;
const ALTURA_3D = 2500;    // m de câmera: até aqui, o poste em 3D
const ALTURA_MAX = 7000;   // até aqui, os postes como pontos (crescem até 5 km); acima, somem
const RAIO = 0.012;        // graus em torno do centro da vista (~1,3 km) para o 3D

/** Postes da cidade: o desenho de postes.js com dados montados a partir do cadastro da Prefeitura. */
class PostesCidade extends Postes {
  carregar() { return Promise.resolve(this.dados); }
  _corAtual(p, parte) { return parte === 'lampada' ? '#00ffff' : super._corAtual(p, parte); }
  /** A luminária cresce até 5 km (e fica assim até 7 km). */
  escalaLamp(h) { return escalaMostrador(h, { ate: 5000 }); }
  /** Ficha do poste da cidade: só o que o cadastro traz (barramento, potência e tensão); sem manutenção. */
  abrir(p) {
    const id = this.identificar;
    id.abrir({ titulo: p.numero ? `Poste ${p.numero}` : (p.iluminacao ? 'Poste com iluminação pública' : 'Poste'), subtitulo: 'Energia · Goiânia', ponto: { lon: p.lon, lat: p.lat, alt: NaN } });
    id.corpo.textContent = '';
    const linhas = [['Número do poste (cadastro)', p.numero || '—'], ['Barramento', p.barramento || '—'],
      ['Potência da lâmpada', p.potencia ? `${p.potencia} W` : (p.iluminacao ? '—' : 'Sem iluminação')],
      ['Tensão da rede', p.tensao ? `${p.tensao} tensão` : 'Não identificada']];
    if (p.tipoPoste) linhas.push(['Tipo de poste', p.tipoPoste]);
    if (p.luminaria) linhas.push(['Luminária', p.luminaria]);
    if (p.cadastro) linhas.push(['Código no cadastro', p.cadastro]);
    id.corpo.append(id.tabela(linhas));
  }
}

const dist2 = (a, b, kx) => ((a[0] - b[0]) * kx) ** 2 + (a[1] - b[1]) ** 2;

function pertoDeLinha(p, paths, tol) {
  const kx = Math.cos((p[1] * Math.PI) / 180);
  for (const linha of paths) for (let k = 1; k < linha.length; k++) {
    const [x1, y1] = linha[k - 1], [x2, y2] = linha[k];
    const ax = (x1 - p[0]) * kx, ay = y1 - p[1], bx = (x2 - p[0]) * kx, by = y2 - p[1];
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1e-18;
    const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l2));
    const qx = ax + t * vx, qy = ay + t * vy;
    if (qx * qx + qy * qy < tol * tol) return true;
  }
  return false;
}

export class Energia3D {
  constructor({ globo, identificar }) {
    this.globo = globo;
    this.postes = new PostesCidade({ globo, identificar });
    this.ativo = false; this.comPostes = false; this.comLuz = false;
    this._vez = 0;
    // De 2,5 km a 7 km: os postes como pontos (luminária ciano; sem luminária, a cor da tensão), crescendo até 5 km.
    this.pontos = globo.cena.primitives.add(new Cesium.PointPrimitiveCollection());
    globo.camera.moveEnd.addEventListener(() => this.atualizar());
  }

  /** Clique: poste em 3D ou ponto de longe abrem a mesma ficha (sem manutenção). */
  aoClicar(pego) {
    if (pego?.collection === this.pontos && pego.id?.poste) { this.postes.abrir(pego.id.poste); return true; }
    return this.postes.aoClicar(pego);
  }

  /** Liga ou desliga: postes (camada Poste) e/ou iluminação (Barramento ou Potência). */
  definir({ postes, luz }) {
    this.comPostes = !!postes; this.comLuz = !!luz;
    this.ativo = this.comPostes || this.comLuz;
    this._chave = null;
    this.atualizar();
  }

  async atualizar() {
    const vez = ++this._vez;
    const h = this.globo.camera.positionCartographic.height;
    if (!this.ativo || h > ALTURA_MAX) { this.postes.mostrar(false); this.pontos.removeAll(); this._chave = null; this.globo.redesenhar(); return; }
    const em3d = h <= ALTURA_3D;
    const c = this.globo.camera.positionCartographic;
    const lon = Cesium.Math.toDegrees(c.longitude), lat = Cesium.Math.toDegrees(c.latitude);
    const raio = em3d ? RAIO : Math.min(0.07, Math.max(RAIO, (h / 111000) * 0.9)); // a vista inteira, até ~7 km
    const passo = em3d ? RAIO / 2 : raio / 3;
    const tam = em3d ? 0 : Math.round(4 + 5 * Math.min(1, (h - ALTURA_3D) / (5000 - ALTURA_3D))); // px: cresce até 5 km
    const chave = `${em3d}:${Math.round(lon / passo)}:${Math.round(lat / passo)}:${Math.round(raio * 100)}:${tam}:${this.comPostes}:${this.comLuz}`;
    if (chave === this._chave) return;
    const env = [lon - raio, lat - raio, lon + raio, lat + raio].join(',');
    const q = (id, campos, geo = true) => consultarOuServidor('Mapa_Energia', id, { f: 'json', where: '1=1', geometry: env, geometryType: 'esriGeometryEnvelope',
      inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', returnGeometry: String(geo), outFields: campos })
      .then((r) => r.features || []).catch(() => []);
    const [postes, luz, prim, sec] = await Promise.all([
      q(4, 'OBJECTID,id,pgf_barram,pgf_label,tb_pg_desc'), this.comLuz ? q(1, 'OBJECTID,Cod_Cad,Pot_Lamp,Qtd_Lamp,Barramento,Tipo_Lumin') : [], q(7, 'OBJECTID'), q(8, 'OBJECTID'),
    ]);
    if (vez !== this._vez) return;
    const primarias = prim.map((f) => f.geometry?.paths || []).flat();
    const secundarias = sec.map((f) => f.geometry?.paths || []).flat();
    const lista = [];
    for (const f of postes) {
      if (!f.geometry || f.geometry.x == null) continue;
      const pt = [f.geometry.x, f.geometry.y];
      const tensao = pertoDeLinha(pt, primarias, 0.00006) ? 'Alta' : pertoDeLinha(pt, secundarias, 0.00006) ? 'Baixa' : '';
      const a = f.attributes;
      const limpo = (v) => String(v ?? '').trim();
      lista.push({ lon: pt[0], lat: pt[1], codigo: `CID-${a.id || a.OBJECTID}`, tensao, material: 'R',
        numero: limpo(a.pgf_label) || limpo(a.pgf_barram), barramento: limpo(a.pgf_barram), tipoPoste: limpo(a.tb_pg_desc),
        cadastro: limpo(a.id), iluminacao: false, bairro: '' });
    }
    // Iluminação: no poste mais próximo (até ~12 m); sem poste perto, vira um poste com luminária.
    for (const f of luz) {
      if (!f.geometry || f.geometry.x == null) continue;
      const pt = [f.geometry.x, f.geometry.y], kx = Math.cos((pt[1] * Math.PI) / 180);
      let melhor = null, d = 0.00011 ** 2;
      for (const p of lista) { const dd = dist2([p.lon, p.lat], pt, kx); if (dd < d) { d = dd; melhor = p; } }
      const bar = String(f.attributes.Barramento ?? '').trim();
      if (melhor) { melhor.iluminacao = true; melhor.potencia = f.attributes.Pot_Lamp; melhor.luminaria = f.attributes.Tipo_Lumin; if (!melhor.barramento) melhor.barramento = bar; if (!melhor.numero) melhor.numero = bar; }
      else lista.push({ lon: pt[0], lat: pt[1], codigo: `IP-${f.attributes.Cod_Cad || f.attributes.OBJECTID}`, tensao: '', material: 'R', iluminacao: true,
        potencia: f.attributes.Pot_Lamp, luminaria: f.attributes.Tipo_Lumin, barramento: bar, numero: bar, bairro: '' });
    }
    const mostrar = this.comPostes ? lista : lista.filter((p) => p.iluminacao);
    mostrar.forEach((p, i) => { p.i = i; });
    this._chave = chave;
    if (!em3d) {
      // longe: pontos leves (sem o 3D), do mesmo jeito para a cidade inteira vista
      this.postes.mostrar(false);
      this.pontos.removeAll();
      const COR = { Alta: Cesium.Color.fromCssColorString('#ff9800'), Baixa: Cesium.Color.fromCssColorString('#ffeb3b'), '': Cesium.Color.fromCssColorString('#bdbdbd') };
      const luz = Cesium.Color.fromCssColorString('#00ffff');
      for (const p of mostrar) this.pontos.add({ position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 780), pixelSize: p.iluminacao ? tam : Math.max(3, tam - 2),
        color: p.iluminacao ? luz : COR[p.tensao || ''], outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: { poste: p } });
      this.globo.redesenhar();
      return;
    }
    this.pontos.removeAll();
    this.postes.dados = { postes: mostrar };
    this.postes._alt = null; this.postes._rumos = null; this.postes._assinatura = null;
    await this.postes.mostrar(true);
  }
}
