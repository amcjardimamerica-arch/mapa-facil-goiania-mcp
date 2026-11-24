// GPS da Bússola: o botão de mira (canto inferior direito) liga a posição do aparelho; o mapa segue
// a pessoa o tempo todo e um cartão mostra onde ela está. Clicar de novo desliga.
//
// Precisão: pede leitura de alta precisão sem cache, descarta leituras muito piores que a última
// boa (comuns quando o aparelho alterna entre GPS, Wi-Fi e rede) e suaviza pequenas oscilações.
import { el, aviso, fmtNum, fmtGraus, paraUTM, pedirJSON, mercX, mercY } from './util.js';

const Cesium = window.Cesium;

export class Localizacao {
  constructor({ globo, camadas, territorio, botaoGps }) {
    Object.assign(this, { globo, camadas, territorio, botaoGps });
    this.posicao = null;   // leitura aceita (já filtrada)
    this.vigia = null;     // id do watchPosition
    this._ultimoVoo = 0;
    this.fonteGps = new Cesium.CustomDataSource('gps');
    globo.viewer.dataSources.add(this.fonteGps);
    this._montarCartao();
  }

  get ativo() { return this.vigia !== null; }

  alternar() { if (this.ativo) this.parar(); else this.ligar(); }

  ligar() {
    if (!('geolocation' in navigator)) { aviso('Este navegador não informa a localização.', 'alerta'); return; }
    if (!window.isSecureContext) { aviso('A localização só funciona em endereço seguro (https).', 'alerta'); return; }
    this.posicao = null;
    this._primeira = true;
    this.cartao.hidden = false;
    this._estado('Procurando o sinal de GPS…', 'buscando');
    this.vigia = navigator.geolocation.watchPosition((p) => this._leitura(p), (e) => this._erro(e),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    this._sincronizar();
  }

  parar() {
    if (this.vigia !== null) navigator.geolocation.clearWatch(this.vigia);
    this.vigia = null;
    this.posicao = null;
    this._entPonto = this._entCirculo = null;
    this.fonteGps.entities.removeAll();
    this.cartao.hidden = true;
    this.globo.redesenhar();
    this._sincronizar();
  }

  _sincronizar() {
    if (!this.botaoGps) return;
    this.botaoGps.setAttribute('aria-pressed', String(this.ativo));
    this.botaoGps.title = this.ativo ? 'Desligar o GPS' : 'Minha localização (GPS)';
  }

  _erro(e) {
    const textos = {
      1: 'O acesso à localização foi negado. Libere a localização para este site nas configurações do navegador.',
      2: 'O aparelho não conseguiu determinar a posição. Tente em local aberto.',
      3: 'O GPS demorou a responder. Continuamos tentando…',
    };
    this._estado(textos[e.code] || 'Não foi possível obter a sua localização.', e.code === 3 ? 'buscando' : 'erro');
    if (e.code === 1) { aviso(textos[1], 'alerta', 7000); this.parar(); }
  }

  /** Filtra e suaviza cada leitura do aparelho. */
  _leitura(p) {
    const { longitude: lon, latitude: lat, accuracy } = p.coords;
    const agora = p.timestamp || Date.now();
    const ant = this.posicao;
    // Leitura muito pior que a anterior recente (salto de antena/Wi-Fi): descarta.
    if (ant && accuracy > Math.max(ant.precisao * 2.5, 50) && agora - ant.quando < 15000) return;
    let pos = { lon, lat, precisao: accuracy, quando: agora };
    // Parado no lugar, com precisões parecidas: média ponderada pela precisão tira o "tremido".
    if (ant && agora - ant.quando < 10000) {
      const d = Cesium.Cartesian3.distance(Cesium.Cartesian3.fromDegrees(ant.lon, ant.lat), Cesium.Cartesian3.fromDegrees(lon, lat));
      if (d < Math.max(accuracy, ant.precisao)) {
        const wa = 1 / (ant.precisao ** 2), wn = 1 / (accuracy ** 2);
        pos = { lon: (ant.lon * wa + lon * wn) / (wa + wn), lat: (ant.lat * wa + lat * wn) / (wa + wn),
          precisao: Math.min(accuracy, Math.sqrt(1 / (wa + wn)) * 1.4), quando: agora };
      }
    }
    this.posicao = pos;
    this._desenhar();
    const dentro = this.territorio.contem(pos.lon, pos.lat);
    this._estado(`GPS ativo · precisão de ${fmtNum(pos.precisao)} m${dentro ? '' : ' · fora de Goiânia'}`, pos.precisao > 40 ? 'fraco' : 'ativo');
    this._mostrar();
    // O mapa segue a pessoa sempre (sem botão de centralizar).
    if (this._primeira) {
      this._primeira = false;
      if (!dentro) aviso('Você está fora de Goiânia. O mapa traz dados apenas do município.', 'alerta', 6000);
      this.globo.voarPara({ lon: pos.lon, lat: pos.lat, distancia: 450, inclinacao: -60 });
      this._ultimoVoo = Date.now();
    } else if (Date.now() - this._ultimoVoo > 2000) {
      this._ultimoVoo = Date.now();
      const altura = this.globo.camera.positionCartographic.height;
      this.globo.voarPara({ lon: pos.lon, lat: pos.lat, distancia: Math.min(Math.max(altura * 1.05, 200), 3000), inclinacao: -60, duracao: 0.8 });
    }
  }

  _desenhar() {
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
    this._entPonto.position = pos;
    this._entCirculo.position = pos;
    this._entCirculo.ellipse.semiMajorAxis = raio;
    this._entCirculo.ellipse.semiMinorAxis = raio;
    this.globo.redesenhar();
  }

  // -------------------------------------------------------------------- cartão
  _montarCartao() {
    this.cartao = el('div', { id: 'gps-cartao', class: 'gps-cartao', role: 'status', 'aria-live': 'polite', hidden: true },
      el('div', { class: 'gps-topo' }, el('span', { id: 'gps-luz', class: 'gps-luz parado' }), el('span', { id: 'gps-estado' }, 'GPS desligado.')),
      el('div', { id: 'gps-aqui', class: 'gps-aqui', hidden: true },
        el('div', {}, el('small', {}, 'Você está em'), el('strong', { id: 'gps-endereco' }, '—')),
        el('div', {}, el('small', {}, 'Latitude, longitude'), el('span', { id: 'gps-graus' }, '—')),
        el('div', {}, el('small', {}, 'UTM 22S · SIRGAS 2000'), el('span', { id: 'gps-utm' }, '—'))));
    document.body.append(this.cartao);
  }

  _estado(texto, tipo) {
    this.cartao.querySelector('#gps-estado').textContent = texto;
    this.cartao.querySelector('#gps-luz').className = `gps-luz ${tipo}`;
  }

  _mostrar() {
    const p = this.posicao, c = this.cartao;
    c.querySelector('#gps-aqui').hidden = false;
    c.querySelector('#gps-graus').textContent = fmtGraus(p.lat, p.lon);
    const u = paraUTM(p.lon, p.lat);
    c.querySelector('#gps-utm').textContent = `E ${fmtNum(u.e, 1)}  N ${fmtNum(u.n, 1)}`;
    // Endereço de novo só quando a pessoa anda mais de 25 m.
    const ant = this._ultimoEndereco;
    const andou = !ant || Cesium.Cartesian3.distance(Cesium.Cartesian3.fromDegrees(ant.lon, ant.lat), Cesium.Cartesian3.fromDegrees(p.lon, p.lat)) > 25;
    if (andou) { this._ultimoEndereco = { lon: p.lon, lat: p.lat }; this._consultarEndereco(p); }
  }

  async _consultarEndereco(ponto) {
    const alvo = this.cartao.querySelector('#gps-endereco');
    alvo.textContent = 'Consultando…';
    alvo.classList.add('carregando');
    try { alvo.textContent = (await this.endereco(ponto)).texto; }
    catch (err) { alvo.textContent = `Endereço indisponível agora (${err.message}).`; }
    finally { alvo.classList.remove('carregando'); }
  }

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
  }}
