// Localização por GPS e indicação de locais.
//
// - Acompanha a posição do aparelho (ponto azul com o círculo de precisão), com
//   a opção de o mapa seguir quem está andando.
// - Mostra onde a pessoa está: coordenadas, UTM, bairro, quadra e lote (Mapa Fácil).
// - "Indicar um local": registra um ponto (pela posição do GPS ou clicando no mapa)
//   com tipo e descrição, e gera um link que abre a Bússola exatamente nesse ponto.
import { $, el, aviso, fmtNum, fmtGraus, paraUTM, memoria, baixarArquivo, pedirJSON, mercX, mercY } from './util.js';

const Cesium = window.Cesium;

export const TIPOS = [
  { id: 'buraco', nome: 'Buraco ou asfalto', cor: '#ff8a3d' },
  { id: 'luz', nome: 'Iluminação pública', cor: '#ffd54a' },
  { id: 'lixo', nome: 'Lixo ou entulho', cor: '#b0855a' },
  { id: 'arvore', nome: 'Árvore ou poda', cor: '#5fd17a' },
  { id: 'calcada', nome: 'Calçada ou acessibilidade', cor: '#c792ea' },
  { id: 'agua', nome: 'Água, esgoto ou drenagem', cor: '#4fc3f7' },
  { id: 'seguranca', nome: 'Segurança', cor: '#ff5f6d' },
  { id: 'ponto', nome: 'Ponto de encontro ou referência', cor: '#e8eaed' },
  { id: 'outro', nome: 'Outro assunto', cor: '#9aa3ad' },
];
const tipoDe = (id) => TIPOS.find((t) => t.id === id) || TIPOS[TIPOS.length - 1];

const alfinete = (cor) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48"><path d="M18 1C9 1 2 8 2 17c0 12 16 29 16 29s16-17 16-29C34 8 27 1 18 1z" fill="${cor}" stroke="#1f2226" stroke-width="2.5"/><circle cx="18" cy="17" r="6.5" fill="#1f2226"/><path d="M18 12.5v5.3M18 20.6v.9" stroke="${cor}" stroke-width="2.6" stroke-linecap="round"/></svg>`)}`;

/** Texto curto e seguro para o link (base64url de JSON). */
export function codificarIndicacao(i) {
  const json = JSON.stringify({ la: +i.lat.toFixed(6), lo: +i.lon.toFixed(6), t: i.tipo, d: (i.descricao || '').slice(0, 280), a: i.autor || '', h: i.quando });
  return btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodificarIndicacao(texto) {
  try {
    const b = atob(texto.replace(/-/g, '+').replace(/_/g, '/'));
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))));
    if (!Number.isFinite(o.la) || !Number.isFinite(o.lo) || Math.abs(o.la) > 90 || Math.abs(o.lo) > 180) return null;
    return { lat: o.la, lon: o.lo, tipo: tipoDe(o.t).id, descricao: String(o.d || '').slice(0, 280),
      autor: String(o.a || '').slice(0, 80), quando: Number.isFinite(o.h) ? o.h : Date.now() };
  } catch { return null; }
}

const fmtQuando = (ms) => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export class Localizacao {
  constructor({ globo, identificar, camadas, territorio, raiz, botaoGps, sessao }) {
    Object.assign(this, { globo, identificar, camadas, territorio, raiz, botaoGps });
    this.sessao = sessao || { login: 'anonimo', nome: '' };
    this.chave = `bussola:indicacoes:${this.sessao.login}`;
    this.lista = memoria.ler(this.chave, []);
    this.posicao = null;       // última leitura do GPS
    this.vigia = null;         // id do watchPosition
    this.seguir = true;
    this.aguardando = false;   // esperando clique no mapa para indicar
    this.rascunho = null;      // ponto escolhido para a nova indicação
    this.recebida = null;      // indicação aberta por link
    this._ultimoVoo = 0;

    this.fonteGps = new Cesium.CustomDataSource('gps');
    this.fonteInd = new Cesium.CustomDataSource('indicacoes');
    globo.viewer.dataSources.add(this.fonteGps);
    globo.viewer.dataSources.add(this.fonteInd);
    this._montarPainel();
    this.lista.forEach((i) => this._desenhar(i));
    this._listar();
  }

  // ======================================================================= GPS
  get ativo() { return this.vigia !== null; }

  alternar() { if (this.ativo) this.parar(); else this.ligar(); }

  ligar() {
    if (!('geolocation' in navigator)) { this._estado('Este aparelho não informa a localização.', 'erro'); aviso('Este navegador não informa a localização.', 'alerta'); return; }
    if (!window.isSecureContext) { this._estado('A localização só funciona em endereço seguro (https).', 'erro'); return; }
    this._estado('Procurando o sinal de GPS…', 'buscando');
    this._primeira = true;
    this.vigia = navigator.geolocation.watchPosition((p) => this._novaPosicao(p), (e) => this._erroGps(e),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    this._sincronizarBotoes();
  }

  parar() {
    if (this.vigia !== null) navigator.geolocation.clearWatch(this.vigia);
    this.vigia = null;
    this.fonteGps.entities.removeAll();
    this.globo.redesenhar();
    this._estado(this.posicao ? `GPS desligado. Última posição às ${new Date(this.posicao.quando).toLocaleTimeString('pt-BR')}.` : 'GPS desligado.', 'parado');
    this._sincronizarBotoes();
  }

  _erroGps(e) {
    const textos = {
      1: 'O acesso à localização foi negado. Libere a localização para este site nas configurações do navegador.',
      2: 'O aparelho não conseguiu determinar a posição. Tente em local aberto.',
      3: 'O GPS demorou a responder. Continuamos tentando…',
    };
    this._estado(textos[e.code] || 'Não foi possível obter a sua localização.', e.code === 3 ? 'buscando' : 'erro');
    if (e.code === 1) { this.vigia = null; this._sincronizarBotoes(); aviso(textos[1], 'alerta', 7000); }
  }

  _novaPosicao(p) {
    const { longitude: lon, latitude: lat, accuracy, heading, speed } = p.coords;
    this.posicao = { lon, lat, precisao: accuracy, rumo: heading, velocidade: speed, quando: p.timestamp || Date.now() };
    this._desenharGps();
    const dentro = this.territorio.contem(lon, lat);
    this._estado(`GPS ativo · precisão de ${fmtNum(accuracy)} m${dentro ? '' : ' · fora de Goiânia'}`, accuracy > 60 ? 'fraco' : 'ativo');
    this._mostrarAqui();
    if (this._primeira) {
      this._primeira = false;
      if (!dentro) aviso('Você está fora de Goiânia. O mapa traz dados apenas do município.', 'alerta', 6000);
      this.globo.voarPara({ lon, lat, distancia: 650, inclinacao: -60 });
      this._ultimoVoo = Date.now();
      this._consultarEndereco(this.posicao, $('#gps-endereco', this.raiz));
    } else if (this.seguir && Date.now() - this._ultimoVoo > 3000) {
      this._ultimoVoo = Date.now();
      const altura = this.globo.camera.positionCartographic.height;
      this.globo.voarPara({ lon, lat, distancia: Math.min(Math.max(altura * 1.1, 300), 3000), inclinacao: -60, duracao: 0.9 });
    }
  }

  _desenharGps() {
    const { lon, lat, precisao } = this.posicao;
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat);
    const raio = Math.max(precisao || 0, 3);
    if (!this._entPonto) {
      this._entCirculo = this.fonteGps.entities.add({ id: 'gps:precisao', position: pos, ellipse: {
        semiMajorAxis: raio, semiMinorAxis: raio, material: Cesium.Color.fromCssColorString('#4c8dff').withAlpha(0.18),
        outline: false, classificationType: Cesium.ClassificationType.TERRAIN } });
      this._entPonto = this.fonteGps.entities.add({ id: 'gps:ponto', position: pos, point: {
        pixelSize: 16, color: Cesium.Color.fromCssColorString('#4c8dff'), outlineColor: Cesium.Color.WHITE, outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
    if (!this.fonteGps.entities.contains(this._entPonto)) { this.fonteGps.entities.add(this._entCirculo); this.fonteGps.entities.add(this._entPonto); }
    this._entPonto.position = pos;
    this._entCirculo.position = pos;
    this._entCirculo.ellipse.semiMajorAxis = raio;
    this._entCirculo.ellipse.semiMinorAxis = raio;
    this.globo.redesenhar();
  }

  // ================================================================== consulta
  /** Bairro, quadra e lote do ponto, pela base cadastral do Mapa Fácil. */
  async endereco(ponto) {
    if (!this.territorio.contem(ponto.lon, ponto.lat)) {
      const m = this.territorio.municipioEm(ponto.lon, ponto.lat);
      return { texto: m ? `${m.nome} (fora de Goiânia)` : 'Fora de Goiânia' };
    }
    const base = this.camadas.consultaBase();
    if (!base) return { texto: 'Goiânia' };
    // Consulta numa janela fixa de 200 m (0,5 m por pixel), independente da câmera,
    // para o mesmo ponto sempre devolver o mesmo lote.
    const x = mercX(ponto.lon), y = mercY(ponto.lat), meia = 100 / Math.cos((ponto.lat * Math.PI) / 180);
    const r = await pedirJSON(`${base.tema.url}/identify`, { parametros: {
      f: 'json', geometry: `${x},${y}`, geometryType: 'esriGeometryPoint', sr: '3857', layers: 'all:0,1,2', tolerance: 1,
      mapExtent: [x - meia, y - meia, x + meia, y + meia].join(','), imageDisplay: '400,400,96', returnGeometry: 'false' } });
    const res = r.results || [];
    const v = (id, campos) => { const x = res.find((y) => y.layerId === id); for (const c of campos) { const s = String(x?.attributes?.[c] ?? '').trim(); if (s && !/^(null|<null>)$/i.test(s)) return s; } return ''; };
    const bairro = v(2, ['nm', 'nm1']), quadra = v(1, ['nm_qdr']), lote = v(0, ['nm_lot']);
    const partes = [quadra && `Quadra ${quadra}`, lote && `Lote ${lote}`].filter(Boolean).join(', ');
    return { bairro, quadra, lote, texto: [bairro, partes].filter(Boolean).join(' · ') || 'Goiânia' };
  }

  async _consultarEndereco(ponto, alvo) {
    if (!alvo) return null;
    alvo.textContent = 'Consultando o Mapa Fácil…';
    alvo.classList.add('carregando');
    try {
      const e = await this.endereco(ponto);
      alvo.textContent = e.texto;
      return e;
    } catch (err) {
      alvo.textContent = `Endereço indisponível agora (${err.message}).`;
      return null;
    } finally { alvo.classList.remove('carregando'); }
  }

  // ===================================================================== painel
  _montarPainel() {
    const r = this.raiz;
    this.btnLigar = el('button', { class: 'botao', onclick: () => this.alternar() }, 'Ligar GPS');
    this.chkSeguir = el('input', { type: 'checkbox', checked: true, onchange: (e) => { this.seguir = e.target.checked; } });
    r.append(
      el('div', { class: 'gps-cartao' },
        el('div', { class: 'gps-topo' }, el('span', { id: 'gps-luz', class: 'gps-luz parado' }), el('span', { id: 'gps-estado' }, 'GPS desligado.')),
        el('div', { id: 'gps-aqui', class: 'gps-aqui', hidden: true },
          el('div', {}, el('small', {}, 'Você está em'), el('strong', { id: 'gps-endereco' }, '—')),
          el('div', {}, el('small', {}, 'Latitude, longitude'), el('span', { id: 'gps-graus' }, '—')),
          el('div', {}, el('small', {}, 'UTM 22S · SIRGAS 2000'), el('span', { id: 'gps-utm' }, '—'))),
        el('div', { class: 'linha-botoes' }, this.btnLigar,
          el('button', { class: 'botao-texto', id: 'gps-centralizar', onclick: () => this.centralizar() }, 'Centralizar')),
        el('label', { class: 'linha-chave' }, el('span', {}, el('strong', {}, 'Seguir minha posição'), el('small', {}, 'o mapa acompanha quem está andando')),
          el('span', { class: 'interruptor' }, this.chkSeguir, el('span', {})))),

      el('h3', { class: 'subtitulo' }, 'Indicar um local'),
      el('p', { class: 'nota' }, 'Registre um ponto e envie o link: quem abrir vai direto ao local indicado.'),
      el('div', { class: 'linha-botoes' },
        el('button', { class: 'botao', id: 'ind-gps', onclick: () => this.indicarAqui() }, 'Usar minha posição'),
        this.btnMapa = el('button', { class: 'botao', id: 'ind-mapa', onclick: () => this.pedirPonto() }, 'Escolher no mapa')),
      this.form = el('div', { class: 'ind-form', hidden: true }),

      this.caixaRecebida = el('div', { class: 'ind-recebida', hidden: true }),

      el('h3', { class: 'subtitulo' }, 'Minhas indicações'),
      this.ul = el('ul', { class: 'ind-lista' }),
      el('div', { class: 'linha-botoes' },
        el('button', { class: 'botao-texto', onclick: () => this.exportarCSV() }, 'Baixar planilha (CSV)'),
        el('button', { class: 'botao-texto', onclick: () => this.exportarGeoJSON() }, 'Baixar GeoJSON')),
      el('p', { class: 'nota' }, 'As indicações ficam guardadas neste aparelho, na sua conta. Use o link ou a planilha para enviá-las à Associação.'));
  }

  _estado(texto, tipo) {
    const t = $('#gps-estado', this.raiz), luz = $('#gps-luz', this.raiz);
    if (t) t.textContent = texto;
    if (luz) luz.className = `gps-luz ${tipo}`;
  }

  _sincronizarBotoes() {
    this.btnLigar.textContent = this.ativo ? 'Desligar GPS' : 'Ligar GPS';
    if (this.botaoGps) {
      this.botaoGps.setAttribute('aria-pressed', String(this.ativo));
      this.botaoGps.title = this.ativo ? 'Desligar o GPS' : 'Minha localização (GPS)';
    }
  }

  _mostrarAqui() {
    const p = this.posicao;
    $('#gps-aqui', this.raiz).hidden = false;
    $('#gps-graus', this.raiz).textContent = fmtGraus(p.lat, p.lon);
    const u = paraUTM(p.lon, p.lat);
    $('#gps-utm', this.raiz).textContent = `E ${fmtNum(u.e, 1)}  N ${fmtNum(u.n, 1)}`;
    // Atualiza o endereço quando a pessoa anda mais de 25 m.
    const ant = this._ultimoEndereco;
    const andou = !ant || Cesium.Cartesian3.distance(Cesium.Cartesian3.fromDegrees(ant.lon, ant.lat), Cesium.Cartesian3.fromDegrees(p.lon, p.lat)) > 25;
    if (andou) { this._ultimoEndereco = { lon: p.lon, lat: p.lat }; this._consultarEndereco(p, $('#gps-endereco', this.raiz)); }
  }

  centralizar() {
    if (!this.posicao) { if (!this.ativo) this.ligar(); return; }
    this.globo.voarPara({ lon: this.posicao.lon, lat: this.posicao.lat, distancia: 500, inclinacao: -60, duracao: 1 });
  }

  // ================================================================= indicação
  /** Nova indicação na posição atual: pede ao GPS uma leitura recente. */
  indicarAqui() {
    if (!('geolocation' in navigator)) { aviso('Este navegador não informa a localização. Use “Escolher no mapa”.', 'alerta'); return; }
    if (!this.ativo) this.ligar();
    aviso('Lendo a sua posição pelo GPS…');
    const usar = (pos) => this._abrirForm({ ...pos, origem: 'gps' });
    navigator.geolocation.getCurrentPosition(
      (p) => usar({ lon: p.coords.longitude, lat: p.coords.latitude, precisao: p.coords.accuracy, quando: p.timestamp || Date.now() }),
      (e) => {
        if (this.posicao && Date.now() - this.posicao.quando < 5 * 60000) usar(this.posicao);
        else this._erroGps(e);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 });
  }

  pedirPonto() {
    this.aguardando = true;
    this.globo.cena.canvas.style.cursor = 'crosshair';
    this.btnMapa.textContent = 'Clique no mapa…';
    aviso('Clique no mapa sobre o local que você quer indicar.');
  }

  cancelarPedido() {
    this.aguardando = false;
    this.globo.cena.canvas.style.cursor = '';
    this.btnMapa.textContent = 'Escolher no mapa';
  }

  /** Clique no mapa enquanto aguarda: vira o ponto da nova indicação. */
  escolher(ponto) {
    this.cancelarPedido();
    this._abrirForm({ lon: ponto.lon, lat: ponto.lat, origem: 'mapa' });
  }

  _abrirForm(ponto) {
    this.rascunho = ponto;
    this.fonteGps.entities.removeById('rascunho');
    this.fonteGps.entities.add({ id: 'rascunho', position: Cesium.Cartesian3.fromDegrees(ponto.lon, ponto.lat),
      billboard: { image: alfinete('#ffffff'), width: 30, height: 40, verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    this.globo.redesenhar();
    const selTipo = el('select', { class: 'campo', id: 'ind-tipo', 'aria-label': 'Tipo da indicação' },
      TIPOS.map((t) => el('option', { value: t.id }, t.nome)));
    const txt = el('textarea', { class: 'campo area', id: 'ind-descricao', rows: 3, maxlength: 280,
      placeholder: 'O que há neste local? Ex.: poste apagado em frente ao número 120.' });
    const endereco = el('strong', { class: 'carregando' }, 'Consultando o Mapa Fácil…');
    this.form.textContent = '';
    this.form.append(
      el('div', { class: 'ind-local' },
        el('small', {}, ponto.origem === 'gps' ? `Sua posição pelo GPS (precisão de ${fmtNum(ponto.precisao)} m)` : 'Ponto escolhido no mapa'),
        endereco, el('span', { class: 'nota' }, fmtGraus(ponto.lat, ponto.lon))),
      el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Tipo'), selTipo),
      el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Descrição'), txt),
      el('div', { class: 'linha-botoes' },
        el('button', { class: 'botao destaque', id: 'ind-salvar', onclick: () => this.salvar(selTipo.value, txt.value) }, 'Salvar indicação'),
        el('button', { class: 'botao-texto', onclick: () => this.fecharForm() }, 'Cancelar')));
    this.form.hidden = false;
    this._consultarEndereco(ponto, endereco).then((e) => { if (this.rascunho === ponto) ponto.endereco = e?.texto || ''; });
    if (ponto.origem === 'mapa') this.globo.voarPara({ lon: ponto.lon, lat: ponto.lat, distancia: Math.min(this.globo.camera.positionCartographic.height * 1.2, 1500), duracao: 0.8 });
    txt.focus({ preventScroll: true });
  }

  fecharForm() {
    this.rascunho = null;
    this.form.hidden = true;
    this.form.textContent = '';
    this.fonteGps.entities.removeById('rascunho');
    this.globo.redesenhar();
  }

  salvar(tipo, descricao) {
    const p = this.rascunho;
    if (!p) return null;
    const ind = { id: Date.now(), tipo: tipoDe(tipo).id, descricao: descricao.trim().slice(0, 280),
      lon: +p.lon.toFixed(6), lat: +p.lat.toFixed(6), precisao: p.precisao ? Math.round(p.precisao) : null,
      origem: p.origem, endereco: p.endereco || '', autor: this.sessao.nome || this.sessao.login, quando: Date.now() };
    this.lista.unshift(ind);
    this._gravar();
    this._desenhar(ind);
    this.fecharForm();
    this._listar();
    aviso('Indicação salva. Use “Enviar” para mandar o link.');
    return ind;
  }

  remover(id) {
    this.lista = this.lista.filter((i) => i.id !== id);
    this.fonteInd.entities.removeById(`ind:${id}`);
    this._gravar();
    this._listar();
    this.globo.redesenhar();
  }

  _gravar() { memoria.gravar(this.chave, this.lista); }

  _desenhar(i, { recebida = false } = {}) {
    const t = tipoDe(i.tipo);
    const id = recebida ? 'ind:recebida' : `ind:${i.id}`;
    this.fonteInd.entities.removeById(id);
    const e = this.fonteInd.entities.add({ id, position: Cesium.Cartesian3.fromDegrees(i.lon, i.lat),
      billboard: { image: alfinete(t.cor), width: recebida ? 36 : 28, height: recebida ? 48 : 38, verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: recebida ? 'Local indicado' : t.nome, font: '600 12.5px system-ui, "Segoe UI", Roboto, sans-serif',
        fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, recebida ? -56 : -46), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8000) } });
    e.indicacao = i;
    this.globo.redesenhar();
  }

  linkDe(i) {
    const base = `${location.origin}${location.pathname}`;
    return `${base}#ind=${codificarIndicacao(i)}`;
  }

  textoDe(i) {
    const t = tipoDe(i.tipo);
    return [`📍 ${t.nome}`, i.endereco, i.descricao, `Indicado por ${i.autor || '—'} em ${fmtQuando(i.quando)}`,
      `Abrir na Bússola: ${this.linkDe(i)}`, `Google Maps: https://www.google.com/maps/search/?api=1&query=${i.lat},${i.lon}`]
      .filter(Boolean).join('\n');
  }

  async enviar(i) {
    const texto = this.textoDe(i);
    if (navigator.share) {
      try { await navigator.share({ title: `Bússola: ${tipoDe(i.tipo).nome}`, text: texto }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
  }

  copiar(i) {
    (navigator.clipboard?.writeText(this.linkDe(i)) || Promise.reject()).then(
      () => aviso('Link da indicação copiado.'), () => aviso('Não foi possível copiar o link.', 'alerta'));
  }

  irPara(i) { this.globo.voarPara({ lon: i.lon, lat: i.lat, distancia: 450, inclinacao: -55 }); }

  _listar() {
    this.ul.textContent = '';
    if (!this.lista.length) {
      this.ul.append(el('li', { class: 'nota' }, 'Nenhuma indicação ainda. Use “Usar minha posição” ou “Escolher no mapa”.'));
      return;
    }
    for (const i of this.lista) {
      const t = tipoDe(i.tipo);
      this.ul.append(el('li', { class: 'ind-item' },
        el('span', { class: 'ind-cor', style: `background:${t.cor}` }),
        el('div', { class: 'ind-texto' },
          el('strong', {}, t.nome),
          i.endereco ? el('small', {}, i.endereco) : null,
          i.descricao ? el('span', {}, i.descricao) : null,
          el('small', {}, fmtQuando(i.quando))),
        el('div', { class: 'ind-acoes' },
          el('button', { class: 'botao-texto', onclick: () => this.irPara(i) }, 'Ver'),
          el('button', { class: 'botao-texto', onclick: () => this.enviar(i) }, 'Enviar'),
          el('button', { class: 'botao-texto', onclick: () => this.copiar(i) }, 'Link'),
          el('button', { class: 'botao-texto perigo', onclick: () => { if (confirm('Remover esta indicação?')) this.remover(i.id); } }, 'Remover'))));
    }
  }

  // ======================================================== indicação recebida
  /** Abre uma indicação vinda de link (#ind=…). */
  abrirRecebida(texto) {
    const i = decodificarIndicacao(texto);
    if (!i) { aviso('O link de indicação está incompleto ou danificado.', 'alerta'); return false; }
    this.recebida = i;
    this._desenhar(i, { recebida: true });
    const t = tipoDe(i.tipo);
    const endereco = el('strong', { class: 'carregando' }, 'Consultando o Mapa Fácil…');
    this.caixaRecebida.textContent = '';
    this.caixaRecebida.append(
      el('small', {}, 'Local indicado por link'),
      el('div', { class: 'ind-recebida-topo' }, el('span', { class: 'ind-cor', style: `background:${t.cor}` }), el('strong', {}, t.nome)),
      endereco,
      i.descricao ? el('p', {}, i.descricao) : null,
      el('small', {}, `Indicado por ${i.autor || '—'} em ${fmtQuando(i.quando)}`),
      el('div', { class: 'linha-botoes' },
        el('button', { class: 'botao', onclick: () => this.irPara(i) }, 'Ir ao local'),
        el('button', { class: 'botao', onclick: () => this.comoChegar(i) }, 'Como chegar'),
        el('button', { class: 'botao-texto', onclick: () => this.guardarRecebida() }, 'Guardar nas minhas')));
    this.caixaRecebida.hidden = false;
    this._consultarEndereco(i, endereco).then((e) => { if (e) i.endereco = e.texto; });
    this.irPara(i);
    return true;
  }

  guardarRecebida() {
    const i = this.recebida;
    if (!i) return;
    const nova = { ...i, id: Date.now(), origem: 'link' };
    this.lista.unshift(nova);
    this._gravar();
    this._desenhar(nova);
    this.fonteInd.entities.removeById('ind:recebida');
    this.caixaRecebida.hidden = true;
    this.recebida = null;
    this._listar();
    aviso('Indicação guardada.');
  }

  /** Rota até o local no aplicativo de mapas do aparelho, a partir do GPS. */
  comoChegar(i) {
    const origem = this.posicao ? `&origin=${this.posicao.lat},${this.posicao.lon}` : '';
    window.open(`https://www.google.com/maps/dir/?api=1${origem}&destination=${i.lat},${i.lon}`, '_blank', 'noopener');
  }

  /** Clique numa indicação no mapa: abre a ficha com as ações. */
  aoClicar(pego) {
    const i = pego?.id?.indicacao;
    if (!i) return false;
    const t = tipoDe(i.tipo);
    this.identificar.fonte.entities.removeAll();
    this.identificar.abrir({ titulo: t.nome, subtitulo: i.endereco || 'Indicação', ponto: { lon: i.lon, lat: i.lat, alt: NaN } });
    const c = this.identificar.corpo;
    if (i.descricao) c.append(el('p', {}, i.descricao));
    c.append(el('p', { class: 'nota' }, `Indicado por ${i.autor || '—'} em ${fmtQuando(i.quando)}`),
      el('div', { class: 'linha-botoes' },
        el('button', { class: 'botao', onclick: () => this.enviar(i) }, 'Enviar'),
        el('button', { class: 'botao', onclick: () => this.comoChegar(i) }, 'Como chegar'),
        el('button', { class: 'botao-texto', onclick: () => this.identificar.emPonto({ lon: i.lon, lat: i.lat, alt: NaN }) }, 'Consultar no Mapa Fácil')));
    return true;
  }

  // ================================================================ exportação
  exportarCSV() {
    if (!this.lista.length) { aviso('Ainda não há indicações para baixar.'); return; }
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const linhas = [['Data', 'Tipo', 'Descrição', 'Endereço', 'Latitude', 'Longitude', 'Precisão (m)', 'Origem', 'Autor', 'Link'].map(q).join(';'),
      ...this.lista.map((i) => [fmtQuando(i.quando), tipoDe(i.tipo).nome, i.descricao, i.endereco, String(i.lat).replace('.', ','),
        String(i.lon).replace('.', ','), i.precisao ?? '', { gps: 'GPS', mapa: 'Mapa', link: 'Link' }[i.origem] || '', i.autor, this.linkDe(i)].map(q).join(';'))];
    baixarArquivo(`indicacoes-bussola-${new Date().toISOString().slice(0, 10)}.csv`, `\ufeff${linhas.join('\r\n')}`, 'text/csv;charset=utf-8');
  }

  exportarGeoJSON() {
    if (!this.lista.length) { aviso('Ainda não há indicações para baixar.'); return; }
    const fc = { type: 'FeatureCollection', features: this.lista.map((i) => ({ type: 'Feature',
      geometry: { type: 'Point', coordinates: [i.lon, i.lat] },
      properties: { tipo: tipoDe(i.tipo).nome, descricao: i.descricao, endereco: i.endereco, autor: i.autor,
        data: new Date(i.quando).toISOString(), precisao_m: i.precisao, origem: i.origem } })) };
    baixarArquivo(`indicacoes-bussola-${new Date().toISOString().slice(0, 10)}.geojson`, JSON.stringify(fc, null, 2), 'application/geo+json');
  }
}
