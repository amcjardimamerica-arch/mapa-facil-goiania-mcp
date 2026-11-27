// Bússola — módulo Trânsito (sinalização sem placas verticais).
// Semáforos, Direita Livre, faixas de pedestres, quebra-molas e faixas elevadas, PARE,
// rotatórias, ciclovias, faixas de ônibus, fiscalização eletrônica da SET, licitação de 2023,
// notícias oficiais e o estudo de lacunas. Tudo local (docs/dados/transito), sem servidor externo.
//
// Uso: <script type="module" src="js/transito.js"></script> depois do script principal.
// O módulo procura o viewer do CesiumJS sozinho; se não achar, chame
//   window.BussolaTransito.iniciar(viewer)  — por exemplo, logo após criar o globo.
const VERSAO_TRANSITO = '1.0';
const BASE = new URL('../dados/transito/', import.meta.url);
const Cesium = () => window.Cesium;
import { noChao } from './globo.js';

// ------------------------------------------------------------------ ícones (desenhados, sem arquivos)
const cacheIcone = new Map();
function icone(tipo, cor) {
  const k = `${tipo}|${cor}`;
  if (cacheIcone.has(k)) return cacheIcone.get(k);
  const S = 48, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const circulo = (fill, stroke = '#000', r = 20) => { g.beginPath(); g.arc(24, 24, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); g.lineWidth = 3; g.strokeStyle = stroke; g.stroke(); };
  const texto = (t, cor2 = '#fff', tam = 22) => { g.fillStyle = cor2; g.font = `bold ${tam}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 24, 25); };
  switch (tipo) {
    case 'semaforo':
      g.fillStyle = '#111'; g.strokeStyle = cor; g.lineWidth = 3;
      g.beginPath(); g.roundRect(14, 2, 20, 44, 6); g.fill(); g.stroke();
      [['#ff1744', 10], ['#ffd600', 24], ['#00e676', 38]].forEach(([f, y]) => { g.beginPath(); g.arc(24, y, 5.5, 0, Math.PI * 2); g.fillStyle = f; g.fill(); });
      break;
    case 'seta': circulo(cor, '#004d40'); texto('↱', '#003300', 28); break;
    case 'faixa':
      g.fillStyle = '#263238'; g.fillRect(4, 4, 40, 40);
      g.fillStyle = cor; for (let x = 8; x < 44; x += 9) g.fillRect(x, 8, 5, 32);
      g.strokeStyle = '#000'; g.lineWidth = 2; g.strokeRect(4, 4, 40, 40); break;
    case 'lombada':
      g.beginPath(); g.moveTo(4, 38); g.quadraticCurveTo(24, 2, 44, 38); g.closePath();
      g.fillStyle = cor; g.fill(); g.lineWidth = 3; g.strokeStyle = '#000'; g.stroke();
      g.fillStyle = '#000'; for (let x = 12; x < 40; x += 8) { g.beginPath(); g.moveTo(x, 34); g.lineTo(x + 4, 22); g.lineTo(x + 7, 22); g.lineTo(x + 3, 34); g.fill(); }
      break;
    case 'pare': {
      g.beginPath();
      for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; g[i ? 'lineTo' : 'moveTo'](24 + 21 * Math.cos(a), 24 + 21 * Math.sin(a)); }
      g.closePath(); g.fillStyle = cor; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); texto('PARE', '#fff', 12); break;
    }
    case 'rotatoria': circulo('rgba(0,0,0,.55)', cor, 18); g.lineWidth = 6; g.strokeStyle = cor; g.beginPath(); g.arc(24, 24, 9, 0, Math.PI * 2); g.stroke(); break;
    case 'radar':
      g.fillStyle = cor; g.strokeStyle = '#000'; g.lineWidth = 3;
      g.beginPath(); g.roundRect(6, 14, 30, 20, 4); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(36, 18); g.lineTo(44, 13); g.lineTo(44, 35); g.lineTo(36, 30); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(18, 24, 5, 0, Math.PI * 2); g.fill(); break;
    case 'camera': circulo(cor, '#000'); texto('◉', '#003', 22); break;
    case 'noticia': circulo(cor, '#000'); texto('i', '#000', 26); break;
    case 'alerta':
      g.beginPath(); g.moveTo(24, 3); g.lineTo(45, 43); g.lineTo(3, 43); g.closePath();
      g.fillStyle = cor; g.fill(); g.lineWidth = 3; g.strokeStyle = '#000'; g.stroke(); texto('!', '#000', 24); break;
    case 'escola': circulo(cor, '#000'); texto('E', '#fff', 22); break;
    case 'saude': circulo('#fff', cor); g.fillStyle = cor; g.fillRect(20, 10, 8, 28); g.fillRect(10, 20, 28, 8); break;
    case 'onibus': circulo(cor, '#000'); texto('🚌', '#fff', 20); break;
    default: circulo(cor);
  }
  const url = c.toDataURL();
  cacheIcone.set(k, url);
  return url;
}

// ------------------------------------------------------------------ estilos do painel
const CSS = `
#transito-botao{position:fixed;left:12px;bottom:92px;z-index:40;background:#1b2330;color:#fff;border:1px solid #3c4a60;border-radius:8px;padding:8px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}
#transito-botao.ativo{background:#0d47a1}
#transito-painel{position:fixed;left:12px;bottom:138px;z-index:40;width:340px;max-height:70vh;overflow:auto;background:rgba(20,26,36,.96);color:#e8edf3;border:1px solid #3c4a60;border-radius:10px;padding:10px 12px;font:13px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.5)}
#transito-painel[hidden],#transito-ficha[hidden]{display:none}
#transito-painel h3{margin:4px 0 8px;font-size:15px}
#transito-painel h4{margin:12px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#9fb3c8}
#transito-painel label{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer}
#transito-painel label img{width:20px;height:20px}
#transito-painel label .linha{width:20px;height:4px;border-radius:2px}
#transito-painel label small{margin-left:auto;color:#9fb3c8}
#transito-painel input[type=search]{width:100%;box-sizing:border-box;margin:4px 0 2px;padding:6px 8px;border-radius:6px;border:1px solid #3c4a60;background:#0f141c;color:#fff}
#transito-painel .nota{color:#9fb3c8;font-size:11px;line-height:1.35}
#transito-painel a{color:#82b1ff}
#transito-ficha{position:fixed;right:12px;top:80px;z-index:41;width:360px;max-height:70vh;overflow:auto;background:rgba(20,26,36,.97);color:#e8edf3;border:1px solid #3c4a60;border-radius:10px;padding:10px 12px;font:13px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.5)}
#transito-ficha h3{margin:0 24px 6px 0;font-size:14px}
#transito-ficha table{border-collapse:collapse;width:100%}
#transito-ficha td{border-top:1px solid #2c3646;padding:4px 4px;vertical-align:top}
#transito-ficha td:first-child{color:#9fb3c8;width:38%}
#transito-ficha a{color:#82b1ff;word-break:break-all}
#transito-ficha button{position:absolute;right:8px;top:6px;background:none;border:0;color:#fff;font-size:18px;cursor:pointer}`;

// ------------------------------------------------------------------ módulo
const T = {
  viewer: null, indice: null, fontes: {}, dados: {}, filtroBairro: '', selecionada: null,
  integrado: true, // 1.31: botões no painel Camadas > Trânsito e ficha do sistema (sem botão flutuante)
  async iniciar(viewer) {
    if (this.viewer) return this;
    const C = Cesium();
    if (!C || !viewer) throw new Error('Trânsito: CesiumJS ou viewer ausente');
    this.viewer = viewer;
    this.indice = await (await fetch(new URL('indice.json', BASE))).json();
    if (!this.integrado) { this._montarInterface(); this._clique(); }
    for (const cam of this.indice.camadas) if (cam.ligada && this.ligarPadrao) await this.ligar(cam.chave, true);
    console.info(`[Trânsito ${VERSAO_TRANSITO}] ${this.indice.camadas.length} camadas disponíveis`);
    return this;
  },

  async _carregar(chave) {
    if (this.dados[chave]) return this.dados[chave];
    const d = await (await fetch(new URL(`${chave}.json`, BASE))).json();
    this.dados[chave] = d;
    return d;
  },

  async ligar(chave, ligado) {
    const C = Cesium();
    let fonte = this.fontes[chave];
    if (!fonte && ligado) {
      const d = await this._carregar(chave);
      fonte = new C.CustomDataSource(`transito-${chave}`);
      const cor = C.Color.fromCssColorString(d.cor || '#fff');
      if (d.tipo === 'ponto') {
        const img = icone(d.icone, d.cor);
        const iBairro = d.campos.indexOf('bairro');
        const ddc = d.distancia_max ? new C.DistanceDisplayCondition(0, d.distancia_max) : undefined;
        for (const it of d.itens) {
          const e = fonte.entities.add({
            position: noChao(it[0], it[1]),
            billboard: {
              image: img, scale: 0.55,
              disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: ddc,
              scaleByDistance: new C.NearFarScalar(300, 1.0, 20000, 0.45),
            },
          });
          e.transito = { chave, valores: it.slice(2), bairro: iBairro >= 0 ? String(it[2 + iBairro] || '') : '' };
        }
      } else {
        const iBairro = -1;
        for (const it of d.itens) {
          const e = fonte.entities.add({
            polyline: {
              positions: C.Cartesian3.fromDegreesArray(it.c.flat()), width: d.largura || 3,
              material: cor.withAlpha(0.9), clampToGround: true,
            },
          });
          e.transito = { chave, valores: it.p, bairro: iBairro >= 0 ? '' : '' };
        }
      }
      await this.viewer.dataSources.add(fonte);
      this.fontes[chave] = fonte;
      this._aplicarFiltro(chave);
    }
    if (fonte) fonte.show = ligado;
    this.viewer.scene.requestRender();
  },

  filtrarBairro(texto) {
    this.filtroBairro = (texto || '').trim().toLowerCase();
    Object.keys(this.fontes).forEach((k) => this._aplicarFiltro(k));
    this.viewer.scene.requestRender();
  },

  _aplicarFiltro(chave) {
    const f = this.filtroBairro, fonte = this.fontes[chave];
    if (!fonte) return;
    for (const e of fonte.entities.values) {
      const b = (e.transito.bairro || '').toLowerCase();
      e.show = !f || !e.billboard || b.includes(f);
    }
  },

  _montarInterface() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
    const bt = Object.assign(document.createElement('button'), { id: 'transito-botao', textContent: '🚦 Trânsito', title: 'Sinalização de trânsito' });
    const pn = Object.assign(document.createElement('div'), { id: 'transito-painel', hidden: true });
    const fc = Object.assign(document.createElement('div'), { id: 'transito-ficha', hidden: true });
    bt.onclick = () => { pn.hidden = !pn.hidden; bt.classList.toggle('ativo', !pn.hidden); };
    pn.innerHTML = `<h3>Sinalização de trânsito</h3>
      <input type="search" placeholder="Filtrar pontos por bairro (ex.: Jardim América)">
      <div class="nota">Sem placas verticais. Itens fora da base oficial da SET vêm de mapeamento colaborativo e notícias: conferir em campo.</div>`;
    pn.querySelector('input').oninput = (ev) => this.filtrarBairro(ev.target.value);
    const grupos = {};
    for (const cam of this.indice.camadas) {
      if (!grupos[cam.grupo]) { grupos[cam.grupo] = document.createElement('div'); grupos[cam.grupo].innerHTML = `<h4>${cam.grupo}</h4>`; pn.append(grupos[cam.grupo]); }
      const lb = document.createElement('label');
      const simbolo = cam.tipo === 'ponto' ? `<img src="${icone(cam.icone, cam.cor)}" alt="">` : `<span class="linha" style="background:${cam.cor}"></span>`;
      lb.innerHTML = `<input type="checkbox" ${cam.ligada ? 'checked' : ''}> ${simbolo} <span>${cam.titulo}</span> <small>${cam.quantidade.toLocaleString('pt-BR')}</small>`;
      lb.querySelector('input').onchange = (ev) => this.ligar(cam.chave, ev.target.checked);
      grupos[cam.grupo].append(lb);
    }
    const fontes = document.createElement('div');
    fontes.innerHTML = `<h4>Fontes (meio de pesquisa)</h4><div class="nota">${this.indice.fontes.map((f) => `• <a href="${f.url}" target="_blank" rel="noopener">${f.nome}</a>`).join('<br>')}<br><br>Dados compilados em ${this.indice.gerado_em} · módulo ${VERSAO_TRANSITO}</div>`;
    pn.append(fontes);
    document.body.append(bt, pn, fc);
    this.ficha = fc;
  },

  _clique() {
    const C = Cesium();
    const h = new C.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    h.setInputAction((mov) => {
      const p = this.viewer.scene.pick(mov.position);
      const e = p && p.id && p.id.transito ? p.id : null;
      this._destacar(e);
      if (e) this._mostrarFicha(e);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  },

  // Seleção sem marcador: só aumenta o brilho e o tamanho do próprio objeto.
  /** Linhas da ficha de um objeto de trânsito: [rótulo, valor]. */
  linhas(e) {
    const d = this.dados[e.transito.chave];
    return { titulo: d.titulo, linhas: d.campos.map((c, i) => [d.rotulos[i], e.transito.valores[i]]).filter(([, v]) => v !== '' && v != null) };
  },
  ligada(chave) { return !!this.fontes[chave]?.show; },

  _destacar(e) {
    const C = Cesium(), ant = this.selecionada;
    if (ant) {
      if (ant.billboard) { ant.billboard.scale = 0.55; ant.billboard.color = C.Color.WHITE; }
      if (ant.polyline) ant.polyline.width = this.dados[ant.transito.chave].largura || 3;
    }
    this.selecionada = e;
    if (e) {
      if (e.billboard) { e.billboard.scale = 0.9; e.billboard.color = new C.Color(1.35, 1.35, 1.35, 1); }
      if (e.polyline) e.polyline.width = (this.dados[e.transito.chave].largura || 3) * 2.2;
    } else if (this.ficha) this.ficha.hidden = true;
    this.viewer.scene.requestRender();
  },

  _mostrarFicha(e) {
    const d = this.dados[e.transito.chave];
    const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
    const valor = (v) => {
      const s = String(v ?? '');
      if (!s) return '';
      if (s.includes(' | ') && s.includes('http')) return s.split(' | ').map((p) => { const i = p.indexOf(': http'); return i > 0 ? `<a href="${esc(p.slice(i + 2))}" target="_blank" rel="noopener">${esc(p.slice(0, i))}</a>` : esc(p); }).join('<br>');
      if (/^https?:\/\//.test(s)) return s.split(' ').map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join('<br>');
      return esc(s);
    };
    const linhas = d.campos.map((c, i) => [d.rotulos[i], e.transito.valores[i]]).filter(([, v]) => v !== '' && v != null)
      .map(([r, v]) => `<tr><td>${esc(r)}</td><td>${valor(v)}</td></tr>`).join('');
    this.ficha.innerHTML = `<button title="Fechar">×</button><h3>${esc(d.titulo)}</h3><table>${linhas}</table>`;
    this.ficha.querySelector('button').onclick = () => this._destacar(null);
    this.ficha.hidden = false;
  },
};
window.BussolaTransito = T;

// Descoberta automática do viewer (nomes usados pela Bússola e pelo Goiânia Earth).
(function procurar(tentativas = 0) {
  const cands = [window.bussola?.globo?.viewer, window.goianiaEarth?.globo?.viewer, window.app?.globo?.viewer, window.globo?.viewer, window.viewer];
  const v = cands.find((x) => x && x.scene && x.dataSources);
  if (v) { T.iniciar(v).catch((e) => console.error('[Trânsito]', e)); return; }
  if (tentativas < 120) setTimeout(() => procurar(tentativas + 1), 500);
  else console.warn('[Trânsito] viewer não encontrado: chame window.BussolaTransito.iniciar(viewer)');
})();
