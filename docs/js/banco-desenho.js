// Desenho dos temas do painel Camadas a partir do banco local (substitui o "export" do servidor).
// Usa Cesium e canvas da página; os dados vêm do núcleo (banco-nucleo.js).
import { NaoSuportado, camposDe, compilarWhere, feicoesNaExtensao, infoCamada, metadados, mx, my } from './banco-nucleo.js';
import { cronometrar } from './desempenho.js';

const Cesium = window.Cesium;

// ------------------------------------------------------------------ desenho dos temas (substitui o "export")
const PT = 96 / 72; // pontos -> pixels

function corCss(c, alfaExtra = 1) {
  if (!c) return null;
  return `rgba(${c[0]},${c[1]},${c[2]},${((c[3] ?? 255) / 255) * alfaExtra})`;
}

const imagens = new Map();
function imagemDe(sim) {
  const chave = sim.url || sim.imageData?.slice(0, 64) + (sim.imageData?.length || 0);
  if (imagens.has(chave)) return imagens.get(chave);
  const img = new Image();
  const p = new Promise((ok) => { img.onload = () => ok(img); img.onerror = () => ok(null); });
  img.src = sim.imageData ? `data:${sim.contentType || 'image/png'};base64,${sim.imageData}` : sim.url;
  const r = { img, p };
  imagens.set(chave, r);
  return r;
}

function simboloDe(renderer, valores, campos) {
  if (!renderer) return null;
  const v = (nome) => { if (!nome) return undefined; const k = campos.findIndex((c) => c.toLowerCase() === String(nome).toLowerCase() || c.toLowerCase().endsWith(`.${String(nome).toLowerCase()}`)); return k >= 0 ? valores[k] : undefined; };
  if (renderer.type === 'simple') return renderer.symbol;
  if (renderer.type === 'uniqueValue') {
    const partes = [renderer.field1, renderer.field2, renderer.field3].filter(Boolean).map((f) => { const x = v(f); return x == null ? '<Null>' : String(x).trim(); });
    const chave = partes.join(renderer.fieldDelimiter || ',');
    if (!renderer._mapa) { renderer._mapa = new Map(); for (const u of renderer.uniqueValueInfos || []) renderer._mapa.set(String(u.value).trim(), u.symbol); }
    return renderer._mapa.get(chave) || renderer._mapa.get(partes[0]) || renderer.defaultSymbol || null;
  }
  if (renderer.type === 'classBreaks') {
    const x = +v(renderer.field);
    if (!Number.isFinite(x)) return renderer.defaultSymbol || null;
    let min = renderer.minValue ?? -Infinity;
    for (const c of renderer.classBreakInfos || []) {
      const lo = c.classMinValue ?? min;
      if (x >= lo && x <= c.classMaxValue) return c.symbol;
      min = c.classMaxValue;
    }
    return renderer.defaultSymbol || null;
  }
  return null;
}

function tracejado(estilo, largura) {
  const w = Math.max(1, largura);
  return { esriSLSDash: [4 * w, 3 * w], esriSLSDot: [w, 2 * w], esriSLSDashDot: [4 * w, 2 * w, w, 2 * w], esriSLSDashDotDot: [4 * w, 2 * w, w, 2 * w, w, 2 * w], esriSLSShortDash: [2 * w, 2 * w], esriSLSLongDash: [8 * w, 3 * w] }[estilo] || [];
}

function desenharMarcador(g, sim, px, py, alfa) {
  if (sim.type === 'esriPMS') {
    const { img } = imagemDe(sim);
    if (!img.complete || !img.naturalWidth) return;
    const w = (sim.width || 12) * PT, h = (sim.height || 12) * PT;
    g.save(); g.globalAlpha = alfa; g.translate(px + (sim.xoffset || 0) * PT, py - (sim.yoffset || 0) * PT);
    if (sim.angle) g.rotate(-sim.angle * Math.PI / 180);
    g.drawImage(img, -w / 2, -h / 2, w, h); g.restore();
    return;
  }
  if (sim.type !== 'esriSMS') return;
  const r = ((sim.size || 6) * PT) / 2;
  g.beginPath();
  switch (sim.style) {
    case 'esriSMSSquare': g.rect(px - r, py - r, 2 * r, 2 * r); break;
    case 'esriSMSDiamond': g.moveTo(px, py - r); g.lineTo(px + r, py); g.lineTo(px, py + r); g.lineTo(px - r, py); g.closePath(); break;
    case 'esriSMSTriangle': g.moveTo(px, py - r); g.lineTo(px + r, py + r); g.lineTo(px - r, py + r); g.closePath(); break;
    case 'esriSMSCross': g.moveTo(px - r, py); g.lineTo(px + r, py); g.moveTo(px, py - r); g.lineTo(px, py + r); break;
    case 'esriSMSX': g.moveTo(px - r, py - r); g.lineTo(px + r, py + r); g.moveTo(px + r, py - r); g.lineTo(px - r, py + r); break;
    default: g.arc(px, py, r, 0, 2 * Math.PI);
  }
  const linha = ['esriSMSCross', 'esriSMSX'].includes(sim.style);
  if (!linha && sim.color) { g.fillStyle = corCss(sim.color, alfa); g.fill(); }
  const o = sim.outline;
  if (linha || (o && o.color && o.width)) { g.lineWidth = Math.max(1, (o?.width || 1) * PT); g.strokeStyle = corCss(o?.color || sim.color, alfa); g.stroke(); }
}

const ESCALA_N0 = 591657527.591555 * Math.cos(16.68 * Math.PI / 180); // escala real no nível 0 em Goiânia

export class ProvedorTema {
  /** Desenha as camadas escolhidas de um tema a partir do banco local, como a imagem "export" do portal. */
  constructor({ servico, camadas, retangulo, tamanho = 512, credito }) {
    this.S = servico;
    this.ids = camadas;
    this._T = tamanho; this._ret = retangulo;
    this._grade = new Cesium.WebMercatorTilingScheme();
    this._erro = new Cesium.Event();
    this._credito = credito ? new Cesium.Credit(credito) : undefined;
    this._metas = null;
  }
  get tileWidth() { return this._T; }
  get tileHeight() { return this._T; }
  get minimumLevel() { return this._ret ? 9 : 0; }
  get maximumLevel() { return 21; }
  get tilingScheme() { return this._grade; }
  get rectangle() { return this._ret || this._grade.rectangle; }
  get tileDiscardPolicy() { return undefined; }
  get errorEvent() { return this._erro; }
  get credit() { return this._credito; }
  get proxy() { return undefined; }
  get hasAlphaChannel() { return true; }
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(true); }
  getTileCredits() { return undefined; }
  pickFeatures() { return undefined; }

  async _carregarMetas() {
    if (this._metas) return this._metas;
    const metas = await Promise.all(this.ids.map(async (id) => ({ id, info: infoCamada(this.S, id), meta: await metadados(this.S, id) })));
    // ArcGIS desenha a camada de id maior primeiro (por baixo)
    this._metas = metas.filter((m) => m.info && m.meta).sort((a, b) => b.id - a.id);
    for (const m of this._metas) for (const s of this._simbolos(m.meta.drawingInfo?.renderer)) if (s?.type === 'esriPMS' || s?.type === 'esriPFS') imagemDe(s);
    await Promise.all([...imagens.values()].map((i) => i.p));
    return this._metas;
  }

  _simbolos(r) {
    if (!r) return [];
    return [r.symbol, r.defaultSymbol, ...(r.uniqueValueInfos || []).map((u) => u.symbol), ...(r.classBreakInfos || []).map((c) => c.symbol)].filter(Boolean);
  }

  _visivel(meta, nivel) {
    const escala = ESCALA_N0 / 2 ** nivel;
    if (meta.minScale && escala > meta.minScale) return false;
    if (meta.maxScale && escala < meta.maxScale) return false;
    return true;
  }

  requestImage(x, y, nivel) {
    return this._desenhar(x, y, nivel).catch((e) => { console.warn('tema local', this.S, e); return this._tela(); });
  }

  _tela() { const c = document.createElement('canvas'); c.width = c.height = this._T; return c; }

  async _desenhar(x, y, nivel) {
    return cronometrar('desenhar-tema', () => this._desenharSemMedida(x, y, nivel));
  }

  async _desenharSemMedida(x, y, nivel) {
    const metas = await this._carregarMetas();
    const ret = this._grade.tileXYToRectangle(x, y, nivel);
    const ext = [ret.west, ret.south, ret.east, ret.north].map((r) => r * 180 / Math.PI);
    const T = this._T;
    const x0 = mx(ext[0]), x1 = mx(ext[2]), y0 = my(ext[1]), y1 = my(ext[3]);
    const kx = T / (x1 - x0), ky = T / (y1 - y0);
    const pxX = (lon) => (mx(lon) - x0) * kx, pxY = (lat) => (y1 - my(lat)) * ky;
    const folga = (ext[2] - ext[0]) * 0.06;
    const caixa = [ext[0] - folga, ext[1] - folga, ext[2] + folga, ext[3] + folga];
    const tela = this._tela();
    const g = tela.getContext('2d');
    g.lineJoin = 'round'; g.lineCap = 'round';
    const rotulos = [];
    for (const { info, meta } of metas) {
      if (!this._visivel(meta, nivel) || !info.geo) continue;
      if (info.z != null && info.zv == null && nivel < info.z - 4) continue; // camada densa: só de perto
      let feats;
      try { feats = await feicoesNaExtensao(info, caixa); }
      catch (e) { if (e instanceof NaoSuportado) continue; throw e; }
      const ren = meta.drawingInfo?.renderer;
      const alfa = 1 - (meta.drawingInfo?.transparency || 0) / 100;
      const escala = ESCALA_N0 / 2 ** nivel;
      const etiquetas = (meta.drawingInfo?.labelingInfo || []).filter((l) => l.labelExpression && (!l.minScale || escala <= l.minScale) && (!l.maxScale || escala >= l.maxScale))
        .map((l) => ({ l, filtro: (() => { try { return compilarWhere(l.where, camposDe(info)); } catch { return () => true; } })() }));
      const vistos = new Set();
      for (const f of feats) {
        if (vistos.has(f.oid)) continue;
        vistos.add(f.oid);
        const e = f.ext;
        if (!e || e[2] < caixa[0] || e[0] > caixa[2] || e[3] < caixa[1] || e[1] > caixa[3]) continue;
        const geo = f.g;
        for (const { l, filtro } of etiquetas) {
          if (!filtro(f)) continue;
          const texto = textoDoRotulo(l.labelExpression, f.valores, camposDe(info));
          if (!texto) continue;
          let px, py;
          if (geo.tipo === 'ponto') [px, py] = [pxX(geo.pts[0][0]), pxY(geo.pts[0][1])];
          else if (geo.tipo === 'linha') { const p = geo.partes[0], m = p[Math.floor(p.length / 2)]; [px, py] = [pxX(m[0]), pxY(m[1])]; }
          else { const e2 = f.ext; [px, py] = [pxX((e2[0] + e2[2]) / 2), pxY((e2[1] + e2[3]) / 2)]; }
          rotulos.push({ texto, px, py, sim: l.symbol, ponto: geo.tipo === 'ponto' });
        }
        const sim = simboloDe(ren, f.valores, camposDe(info));
        if (!sim) continue;
        if (geo.tipo === 'ponto') { for (const [lo, la] of geo.pts) desenharMarcador(g, sim, pxX(lo), pxY(la), alfa); continue; }
        g.beginPath();
        for (const p of geo.partes) {
          p.forEach(([lo, la], i) => (i ? g.lineTo(pxX(lo), pxY(la)) : g.moveTo(pxX(lo), pxY(la))));
          if (geo.tipo === 'area') g.closePath();
        }
        if (geo.tipo === 'area') {
          if (sim.type === 'esriPFS') {
            const { img } = imagemDe(sim);
            if (img.naturalWidth) { g.save(); g.globalAlpha = alfa; g.fillStyle = g.createPattern(img, 'repeat'); g.fill('evenodd'); g.restore(); }
          } else if (sim.color && sim.style !== 'esriSFSNull') {
            g.fillStyle = corCss(sim.color, alfa * (sim.style && sim.style !== 'esriSFSSolid' ? 0.45 : 1));
            g.fill('evenodd');
          }
          const o = sim.outline;
          if (o && o.color && o.width && o.style !== 'esriSLSNull') { g.setLineDash(tracejado(o.style, o.width * PT)); g.lineWidth = Math.max(0.6, o.width * PT); g.strokeStyle = corCss(o.color, alfa); g.stroke(); g.setLineDash([]); }
        } else {
          const linha = sim.type === 'esriSLS' ? sim : sim.outline || sim;
          if (linha.style === 'esriSLSNull' || !linha.color) continue;
          g.setLineDash(tracejado(linha.style, (linha.width || 1) * PT));
          g.lineWidth = Math.max(0.6, (linha.width || 1) * PT);
          g.strokeStyle = corCss(linha.color, alfa);
          g.stroke();
          g.setLineDash([]);
        }
      }
    }
    // rótulos por cima de tudo, sem sobreposição
    const caixas = [];
    for (const r of rotulos) {
      const ts = r.sim || {};
      const tam = ((ts.font?.size || 8) * PT);
      g.font = `${ts.font?.style === 'italic' ? 'italic ' : ''}${ts.font?.weight === 'bold' ? '700 ' : '500 '}${tam}px ${ts.font?.family ? `"${ts.font.family}", ` : ''}system-ui, sans-serif`;
      const w = g.measureText(r.texto).width;
      const x = r.ponto ? r.px + 4 + (ts.xoffset || 0) * PT : r.px - w / 2, y = r.ponto ? r.py - 4 - (ts.yoffset || 0) * PT : r.py + tam / 3;
      const c = [x - 2, y - tam, x + w + 2, y + 3];
      if (c[0] < 0 || c[1] < 0 || c[2] > T || c[3] > T || caixas.some((b) => c[0] < b[2] && c[2] > b[0] && c[1] < b[3] && c[3] > b[1])) continue;
      caixas.push(c);
      g.lineJoin = 'round';
      g.lineWidth = Math.max(2.5, (ts.haloSize || 1.5) * PT * 1.6);
      g.strokeStyle = ts.haloColor ? corCss(ts.haloColor) : 'rgba(255,255,255,.9)';
      g.strokeText(r.texto, x, y);
      g.fillStyle = corCss(ts.color || [0, 0, 0, 255]);
      g.fillText(r.texto, x, y);
    }
    return tela;
  }
}

/** Texto do rótulo a partir da expressão do ArcGIS ("[campo]" e concatenações simples). */
function textoDoRotulo(expr, valores, campos) {
  const v = (nome) => { const n = nome.toLowerCase(); const k = campos.findIndex((c) => c.toLowerCase() === n || c.toLowerCase().endsWith(`.${n.split('.').pop()}`)); return k >= 0 ? valores[k] : ''; };
  const t = String(expr).replace(/\[([^\]]+)\]/g, (_, c) => String(v(c) ?? '').trim())
    .replace(/\s*&\s*/g, '').replace(/"\s*"/g, ' ').replace(/^"|"$/g, '').replace(/\bvbnewline\b/gi, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 58)}…` : t;
}

