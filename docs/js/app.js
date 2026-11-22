// Bússola — inicialização e ligação da interface.
import { CFG, VERSAO } from './config.js';
import { $, $$, el, pedirJSON, debounce, aviso, baixarArquivo, fmtNum, fmtGraus, fmtDistancia, paraUTM, memoria } from './util.js';
import { Territorio } from './territorio.js';
import { Globo } from './globo.js';
import { Camadas } from './camadas.js';
import { Identificar } from './identificar.js';
import { Busca } from './busca.js';
import { Edificios } from './edificios.js';
import { Medir } from './medir.js';
import { Marcadores } from './marcadores.js';

const Cesium = window.Cesium;
const app = (window.bussola = { versao: VERSAO, pronto: false, erros: [] });

const estadoAbertura = (texto, erro = false) => {
  const no = $('#abertura-estado');
  no.textContent = texto;
  no.classList.toggle('erro', erro);
  if (erro) $('#abertura .barra').hidden = true;
};

function lerHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { v: p.get('v'), b: p.get('b'), t: p.get('t'), ed: p.get('ed'), n: p.get('n'), r: p.get('r') };
}

async function iniciar() {
  if (!Cesium) throw new Error('A biblioteca do globo (CesiumJS) não carregou. Verifique a conexão e recarregue.');
  estadoAbertura('Carregando o território de Goiânia…');
  const [geo, catalogo, bairros, lugares, manifesto] = await Promise.all([
    pedirJSON(`${CFG.dados}territorio.geojson`),
    pedirJSON(`${CFG.dados}camadas.json`),
    pedirJSON(`${CFG.dados}bairros.json`),
    pedirJSON(`${CFG.dados}lugares.json`),
    pedirJSON(`${CFG.dados}manifest.json`).catch(() => ({})),
  ]);
  const territorio = new Territorio(geo);
  const hash = lerHash();

  estadoAbertura('Montando o globo…');
  const globo = new Globo(territorio, catalogo);
  const camadas = new Camadas(globo, catalogo, $('#lista-camadas'));
  const identificar = new Identificar(globo, camadas, territorio);
  const edificios = new Edificios(globo, identificar, $('[data-secao="edificios"]'));
  const medir = new Medir(globo, $('#painel-medir'));
  const marcadores = new Marcadores(globo, identificar, medir, $('#painel-marcadores'));
  const busca = new Busca({ globo, identificar, territorio, bairros: bairros.bairros, lugares: lugares.lugares, edificios });
  identificar.acoes.marcar = (ponto, nome) => marcadores.adicionar(ponto, nome);
  Object.assign(app, { globo, camadas, identificar, edificios, medir, marcadores, busca, territorio, catalogo, manifesto });

  const bases = globo.basesDisponiveis();
  const baseInicial = bases.some((b) => b.chave === hash.b) ? hash.b : 'satelite';
  await globo.definirBase(baseInicial);

  // -------------------------------------------------------------- painéis
  const painel = $('#painel');
  let painelAberto = null;
  const abrirPainel = (nome) => {
    painelAberto = painelAberto === nome ? null : nome;
    painel.hidden = !painelAberto;
    for (const s of $$('#painel > section')) s.hidden = s.dataset.secao !== painelAberto;
    for (const b of $$('#trilho [data-painel]')) b.setAttribute('aria-pressed', String(b.dataset.painel === painelAberto));
    if (painelAberto) $('#painel-titulo').textContent = $(`#painel > [data-secao="${painelAberto}"]`).dataset.titulo;
    if (painelAberto === 'camadas') camadas.atualizarEscala();
    if (painelAberto === 'edificios') edificios.carregar().catch((e) => aviso(`Cadastro de edifícios indisponível: ${e.message}`, 'alerta'));
    if (painelAberto !== 'medir') medir.cancelar();
    if (painelAberto !== 'marcadores') marcadores.cancelarPedido();
  };
  app.abrirPainel = abrirPainel;
  $$('#trilho [data-painel]').forEach((b) => b.addEventListener('click', () => abrirPainel(b.dataset.painel)));
  $('#painel-fechar').addEventListener('click', () => abrirPainel(painelAberto));

  // --------------------------------------------------------- bases e épocas
  const creditoBase = (chave) => (chave === 'satelite'
    ? (CFG.googleMapsApiKey ? 'Satélite: Google' : 'Satélite: Esri, Maxar')
    : `${(bases.find((b) => b.chave === chave)?.titulo || '').replace(' (cartografia municipal)', '')}: Prefeitura de Goiânia`);
  const marcarBase = () => {
    for (const b of $$('#lista-bases button, #epocas button')) b.setAttribute('aria-checked', String(b.dataset.base === globo.chaveBase));
    $('#st-creditos').textContent = `Dados: Prefeitura de Goiânia (Mapa Fácil) · ${creditoBase(globo.chaveBase)} · CesiumJS`;
    $('#rotulo-esq').textContent = bases.find((b) => b.chave === globo.chaveBase)?.curto || '';
    // Sobre o próprio Mapa Básico os nomes realçados (brancos) ficariam ilegíveis.
    if (globo.camadaRealce) { globo.camadaRealce.show = globo.chaveBase !== 'basico'; globo.redesenhar(); }
  };
  const trocarBase = async (chave) => {
    try { await globo.definirBase(chave); marcarBase(); atualizarLink(); }
    catch (e) { aviso(`Não foi possível carregar essa imagem: ${e.message}`, 'alerta'); }
  };
  app.trocarBase = trocarBase;
  const descricao = { satelite: 'mosaico mundial recente', orto: 'voo da Prefeitura', mapa: 'ruas, quadras e lotes' };
  for (const b of bases) {
    $('#lista-bases').append(el('button', { role: 'radio', dataset: { base: b.chave }, onclick: () => trocarBase(b.chave) },
      el('strong', {}, b.titulo.replace(' (cartografia municipal)', '')), el('small', {}, descricao[b.tipo])));
  }
  for (const b of [...bases.filter((x) => x.tipo === 'orto'), bases[0]]) {
    $('#epocas').append(el('button', { role: 'radio', dataset: { base: b.chave }, title: b.titulo, onclick: () => trocarBase(b.chave) }, b.curto));
  }
  marcarBase();

  const seletor = $('#comparar');
  seletor.append(el('option', { value: '' }, 'Sem comparação'), ...bases.map((b) => el('option', { value: b.chave }, b.titulo)));
  const divisor = $('#divisor');
  const moverDivisor = (fracao) => {
    const f = Math.min(0.95, Math.max(0.05, fracao));
    const area = $('#globo').getBoundingClientRect();
    divisor.style.left = `${area.left + area.width * f}px`;
    globo.definirDivisor(f);
  };
  seletor.addEventListener('change', async () => {
    try {
      await globo.definirComparacao(seletor.value || null);
      divisor.hidden = !seletor.value;
      $('#rotulo-dir').textContent = bases.find((b) => b.chave === seletor.value)?.curto || '';
      if (seletor.value) moverDivisor(0.5);
    } catch (e) { aviso(`Comparação indisponível: ${e.message}`, 'alerta'); }
  });
  const pega = $('#divisor .pega');
  pega.addEventListener('pointerdown', (ev) => {
    pega.setPointerCapture(ev.pointerId);
    const area = $('#globo').getBoundingClientRect();
    const mover = (e) => moverDivisor((e.clientX - area.left) / area.width);
    pega.addEventListener('pointermove', mover);
    pega.addEventListener('pointerup', () => pega.removeEventListener('pointermove', mover), { once: true });
  });
  pega.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    moverDivisor(globo.cena.splitPosition + (e.key === 'ArrowLeft' ? -0.03 : 0.03));
  });
  window.addEventListener('resize', () => { if (!divisor.hidden) moverDivisor(globo.cena.splitPosition); });

  // ------------------------------------------- nomes, relevo, máscara, 3D
  const realce = $('#realce-liga');
  realce.checked = hash.n !== '0';
  realce.addEventListener('change', () => { globo.definirRealce(realce.checked); marcarBase(); atualizarLink(); });
  globo.definirRealce(realce.checked);
  marcarBase();

  const relevo = $('#relevo-liga');
  const ligarRelevo = async (ligado) => {
    try { await globo.definirRelevo(ligado); }
    catch { aviso('O serviço de relevo não respondeu; o globo segue sem altitude.', 'alerta'); }
    relevo.checked = globo.relevoAtivo;
  };
  relevo.addEventListener('change', () => { ligarRelevo(relevo.checked).then(atualizarLink); });
  $('#exagero').addEventListener('input', (e) => {
    $('#exagero-valor').textContent = `${String(e.target.value).replace('.', ',')}×`;
    globo.definirExagero(+e.target.value);
  });
  $('#mascara').addEventListener('input', (e) => {
    $('#mascara-valor').textContent = `${e.target.value}%`;
    globo.camadaMascara.alpha = e.target.value / 100;
    globo.redesenhar();
  });

  const ediLiga = $('#edi-liga');
  ediLiga.addEventListener('change', () => edificios.ligar(ediLiga.checked));
  edificios.aoMudar = () => atualizarLink();
  camadas.aoMudar = () => atualizarLink();
  if (hash.t) camadas.restaurarDe(hash.t);

  // ----------------------------------------------------------- navegação
  const rad = Cesium.Math.toRadians;
  $('#nav-bussola').addEventListener('click', () => globo.orbitar({ rumo: 0 }));
  $('#nav-3d').addEventListener('click', () => globo.orbitar({ inclinacao: globo.camera.pitch < rad(-80) ? rad(-45) : rad(-90) }));
  $('#nav-mais').addEventListener('click', () => globo.orbitar({ fator: 0.55 }));
  $('#nav-menos').addEventListener('click', () => globo.orbitar({ fator: 1.8 }));
  $('#nav-inclina-mais').addEventListener('click', () => globo.orbitar({ dInclinacao: rad(12) }));
  $('#nav-inclina-menos').addEventListener('click', () => globo.orbitar({ dInclinacao: rad(-12) }));
  $('#nav-inicio').addEventListener('click', () => globo.irParaInicio(1.6));
  $('#nav-foto').addEventListener('click', async () => {
    const blob = await globo.capturar();
    if (blob) baixarArquivo(`bussola-${new Date().toISOString().slice(0, 10)}.png`, blob);
  });
  $('#nav-local').addEventListener('click', () => {
    if (!navigator.geolocation) { aviso('Este navegador não informa a localização.', 'alerta'); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      const { longitude: lon, latitude: lat } = pos.coords;
      if (!territorio.contem(lon, lat)) { aviso('Você está fora de Goiânia; o mapa cobre apenas o município.', 'alerta'); return; }
      globo.voarPara({ lon, lat, distancia: 900 });
      identificar.fonte.entities.removeAll();
      identificar.alfinete(lon, lat, Cesium.Color.DODGERBLUE);
    }, () => aviso('Não foi possível obter a sua localização.', 'alerta'), { enableHighAccuracy: true, timeout: 10000 });
  });

  // ---------------------------------------------------- cliques e cursor
  const maos = new Cesium.ScreenSpaceEventHandler(globo.cena.canvas);
  maos.setInputAction((ev) => {
    const ponto = globo.pontoNaTela(ev.position);
    if (medir.ativo) { medir.clique(ponto); return; }
    if (marcadores.aguardando) { if (ponto) marcadores.adicionar(ponto); return; }
    const pego = globo.cena.pick(ev.position);
    edificios.limparSelecao();
    if (edificios.aoClicar(pego) || marcadores.aoClicar(pego)) return;
    if (ponto) identificar.emPonto(ponto);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  maos.setInputAction(() => { if (medir.ativo) { medir.desfazer(); medir.concluir(); } }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  maos.setInputAction(() => { if (medir.ativo) medir.desfazer(); }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

  let quadro = 0, ultimaPos = null;
  const st = { coord: $('#st-coord'), utm: $('#st-utm'), alt: $('#st-alt'), olho: $('#st-olho'), escala: $('#st-escala') };
  const atualizarCursor = () => {
    quadro = 0;
    const p = ultimaPos && globo.pontoNaTela(ultimaPos);
    if (!p) { st.coord.textContent = '—'; return; }
    if (medir.ativo) medir.mover(p);
    const u = paraUTM(p.lon, p.lat);
    st.coord.textContent = fmtGraus(p.lat, p.lon);
    st.utm.textContent = `UTM 22S  E ${fmtNum(u.e)}  N ${fmtNum(u.n)}`;
    st.alt.textContent = globo.relevoAtivo ? `Terreno ${fmtNum(p.alt / (globo.cena.verticalExaggeration || 1))} m` : 'Relevo desligado';
  };
  maos.setInputAction((ev) => {
    ultimaPos = ev.endPosition;
    if (!quadro) quadro = requestAnimationFrame(atualizarCursor);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  const agulha = $('#agulha');
  globo.cena.postRender.addEventListener(() => {
    agulha.setAttribute('transform', `rotate(${-Cesium.Math.toDegrees(globo.camera.heading)} 20 20)`);
  });
  const aoParar = debounce(() => {
    st.olho.textContent = `Câmera a ${fmtDistancia(globo.camera.positionCartographic.height)}`;
    const escala = globo.escala();
    st.escala.textContent = escala ? `Escala ~1:${fmtNum(Math.round(escala / (escala > 5000 ? 500 : 50)) * (escala > 5000 ? 500 : 50))}` : '';
    $('#nav-3d').textContent = globo.camera.pitch < rad(-80) ? '3D' : '2D';
    if (painelAberto === 'camadas') camadas.atualizarEscala();
    atualizarLink();
  }, 200);
  globo.camera.moveEnd.addEventListener(aoParar);

  // ------------------------------------------------------------- explorar
  const parques = lugares.lugares.filter((l) => l.tipo === 'parque');
  const irLugar = (l) => busca.escolher({ tipo: 'lugar', n: l.n, dado: l });
  for (const l of parques) $('#lista-parques').append(el('li', {}, el('button', { onclick: () => irLugar(l) }, el('span', {}, l.n))));
  for (const b of bairros.bairros.slice(0, 12)) {
    $('#lista-bairros').append(el('li', {}, el('button', { onclick: () => busca.escolher({ tipo: 'bairro', n: b.n, dado: b }) },
      el('span', {}, b.n), el('small', {}, `${fmtNum(b.pop)} hab.`))));
  }
  $('#sortear').addEventListener('click', () => {
    const altos = edificios.lista.slice(0, 40);
    const sorteio = [...parques.map((l) => () => irLugar(l)), ...altos.map((e) => () => edificios.irPara(e))];
    if (sorteio.length) sorteio[Math.floor(Math.random() * sorteio.length)]();
  });

  // ---------------------------------------------------------------- sobre
  const etapas = manifesto.etapas || {};
  const data = manifesto.atualizado_em ? new Date(manifesto.atualizado_em).toLocaleDateString('pt-BR') : '—';
  $('#sobre-dados').append(...[
    ['Dados extraídos em', data],
    ['Área de Goiânia', `${fmtNum(territorio.goiania.area_km2, 1)} km² (base municipal)`],
    ['Municípios limítrofes', territorio.vizinhos.map((v) => v.nome).join(', ')],
    ['Temas do portal', fmtNum(etapas.camadas?.temas_portal ?? catalogo.temas.filter((t) => t.oficial).length)],
    ['Camadas disponíveis', fmtNum(catalogo.temas.reduce((s, t) => s + t.camadas.filter((c) => !c.grupo).length, 0))],
    ['Bairros no índice', fmtNum(bairros.bairros.length)],
    ['Versão', VERSAO],
  ].flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

  // ----------------------------------------------------------------- link
  function atualizarLink() {
    if (!app.pronto) return;
    const p = new URLSearchParams();
    p.set('v', globo.visao());
    if (globo.chaveBase !== 'satelite') p.set('b', globo.chaveBase);
    const t = camadas.serializar();
    if (t) p.set('t', t);
    if (!edificios.ativo) p.set('ed', '0');
    if (!realce.checked) p.set('n', '0');
    if (!globo.relevoAtivo) p.set('r', '0');
    history.replaceState(null, '', `#${p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%7C/g, '|')}`);
  }
  $('#btn-compartilhar').addEventListener('click', () => {
    atualizarLink();
    (navigator.clipboard?.writeText(location.href) || Promise.reject()).then(
      () => aviso('Link desta vista copiado.'),
      () => aviso('Copie o endereço da barra do navegador para compartilhar esta vista.'));
  });

  // -------------------------------------------------------------- teclado
  document.addEventListener('keydown', (e) => {
    const digitando = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      if (medir.ativo) medir.cancelar(); else if (marcadores.aguardando) marcadores.cancelarPedido(); else identificar.fechar();
      return;
    }
    if (digitando || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); $('#busca').focus(); }
    else if (e.key === 'n' || e.key === 'N') globo.orbitar({ rumo: 0 });
    else if (e.key === 'u' || e.key === 'U') $('#nav-3d').click();
    else if (e.key === 'r' || e.key === 'R') globo.irParaInicio(1.6);
    else if (e.key === '+' || e.key === '=') globo.orbitar({ fator: 0.55 });
    else if (e.key === '-') globo.orbitar({ fator: 1.8 });
    else if (e.key === 'Enter' && medir.ativo) medir.concluir();
  });

  // ------------------------------------------------------------- abertura
  estadoAbertura('Pronto. Voando até Goiânia…');
  $('#abertura').classList.add('sai');
  setTimeout(() => $('#abertura').remove(), 900);
  if (hash.v && globo.aplicarVisao(hash.v)) globo.liberarLimites();
  else { await globo.irParaInicio(3.4); globo.liberarLimites(); }
  app.pronto = true;
  aoParar();

  // Relevo e edifícios entram depois do primeiro quadro, para o globo abrir rápido.
  if (hash.r !== '0') await ligarRelevo(true);
  if (hash.ed !== '0') await edificios.ligar(true);
  if (!memoria.ler('bussola:visto', false)) {
    aviso('Clique em qualquer ponto de Goiânia para ver lote, quadra, bairro e cadastro.', 'info', 7000);
    memoria.gravar('bussola:visto', true);
  }
}

window.addEventListener('error', (e) => app.erros.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => app.erros.push(String(e.reason?.message || e.reason)));

iniciar().catch((e) => {
  console.error(e);
  app.erros.push(String(e.message || e));
  estadoAbertura(`Não foi possível abrir o mapa: ${e.message || e}`, true);
});
