// Bússola — inicialização e ligação da interface.
import { CFG, VERSAO } from './config.js';
import { $, $$, el, pedirJSON, debounce, aviso, baixarArquivo, fmtNum, fmtGraus, fmtDistancia, paraUTM, memoria } from './util.js';
import { Territorio } from './territorio.js';
import { Globo } from './globo.js';
import { Camadas } from './camadas.js';
import { Identificar } from './identificar.js';
import { Busca } from './busca.js';
import { Edificios } from './edificios.js';
import { Servicos } from './servicos.js';
import { registrarAcesso } from './registro.js';
import { Medir } from './medir.js';
import { Marcadores } from './marcadores.js';
import { Localizacao } from './localizacao.js';
import { Lotes } from './lotes.js';
import { Levantamento } from './levantamento.js';
import { Poligonos } from './poligonos.js';
import { encerrarSessao, sessaoAindaValida } from './acesso.js';
import { iniciarBanco } from './banco.js';

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
  return { v: p.get('v'), b: p.get('b'), t: p.get('t'), ed: p.get('ed'), n: p.get('n'), r: p.get('r'), ind: p.get('ind'), l: p.get('l'), lv: p.get('lv'), eb: p.get('eb') };
}

async function iniciar() {
  if (!Cesium) throw new Error('A biblioteca do globo (CesiumJS) não carregou. Verifique a conexão e recarregue.');
  // Guarda no aparelho o banco local e os dados (abre de imediato nas próximas vezes).
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  estadoAbertura('Abrindo o banco de dados local…');
  // Dados do Mapa Fácil guardados no próprio site: o sistema deixa de depender do servidor da Prefeitura.
  const banco = await iniciarBanco();
  estadoAbertura('Carregando o território de Goiânia…');
  const [geo, catalogo, bairros, lugares, manifesto, satelite] = await Promise.all([
    pedirJSON(`${CFG.dados}territorio.geojson`),
    pedirJSON(`${CFG.dados}camadas.json`),
    pedirJSON(`${CFG.dados}bairros.json`),
    pedirJSON(`${CFG.dados}lugares.json`),
    pedirJSON(`${CFG.dados}manifest.json`).catch(() => ({})),
    pedirJSON(`${CFG.dados}satelite.json`).catch(() => ({ versoes: [] })), // opcional: sem ele, só não há datas antigas
  ]);
  catalogo.satelite = satelite.versoes || [];
  catalogo.banco = banco;
  catalogo.bairros = bairros.bairros; // nomes de bairro no mapa desenhado
  const territorio = new Territorio(geo);
  const hash = lerHash();

  estadoAbertura('Montando o globo…');
  const globo = new Globo(territorio, catalogo);
  // Conteúdos próprios de alguns projetos do painel Camadas (os módulos são criados logo abaixo).
  const especiais = {
    eleitoral: (caixa) => levantamento.montarEleitoralEm(caixa).catch((e) => { caixa.textContent = `Locais de votação indisponíveis: ${e.message}`; }),
    eleitoralLigar: (ligado) => levantamento.definirEleicao(ligado ? (levantamento.opcoes.eleicao || 'geral') : '').catch(() => {}),
    edificacoes: (caixa) => edificios.montarEm(caixa),
  };
  const camadas = new Camadas(globo, catalogo, $('#lista-camadas'), { especiais });
  const identificar = new Identificar(globo, camadas, territorio);
  const servicos = new Servicos({ globo, identificar });
  camadas.servicos = servicos;
  const edificios = new Edificios(globo, identificar);
  const medir = new Medir(globo, $('#painel-medir'));
  const marcadores = new Marcadores(globo, identificar, medir, $('#painel-marcadores'));
  const busca = new Busca({ globo, identificar, territorio, bairros: bairros.bairros, lugares: lugares.lugares, edificios });
  identificar.acoes.marcar = (ponto, nome) => marcadores.adicionar(ponto, nome);
  const poligonos = new Poligonos(globo, identificar, $('#painel-marcadores'));
  marcadores.poligonos = poligonos;
  identificar.acoes.editarPoligono = (dados) => poligonos.doLote(dados);
  const sessao = window.bussolaSessao || { login: 'anonimo', nome: '' };
  const lotes = new Lotes({ globo, bairros: bairros.bairros, raiz: $('#painel-lotes') });
  const levantamento = new Levantamento({ globo, identificar, raiz: $('#painel-levantamento') });
  lotes.edificios = edificios;
  levantamento.aoEdificacoes = (id, nome, ligado, aneis) => edificios.definirBairro(id, nome, ligado, aneis).then(() => lotes._desenharChips());
  // Os locais de votação só aparecem com o projeto Zonas Eleitorais ligado.
  levantamento.opcoes.eleicao = '';
  const localizacao = new Localizacao({ globo, camadas, territorio, botaoGps: $('#nav-local') });
  Object.assign(app, { globo, camadas, identificar, servicos, edificios, medir, marcadores, poligonos, localizacao, lotes, levantamento, busca, territorio, catalogo, manifesto, sessao });

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
    if (painelAberto === 'levantamento') levantamento.mostrarBairros().catch((e) => aviso(`Levantamento indisponível: ${e.message}`, 'alerta'));
    if (painelAberto !== 'medir') medir.cancelar();
    if (painelAberto !== 'marcadores') marcadores.cancelarPedido();
  };
  app.abrirPainel = abrirPainel;
  $$('#trilho [data-painel]').forEach((b) => b.addEventListener('click', () => abrirPainel(b.dataset.painel)));
  $('#painel-fechar').addEventListener('click', () => abrirPainel(painelAberto));

  // --------------------------------------------------------- bases e épocas
  const creditoBase = (chave) => {
    const b = bases.find((x) => x.chave === chave);
    if (chave === 'satelite') return CFG.googleMapsApiKey ? 'Satélite: Google' : 'Satélite: Esri, Maxar';
    if (b?.tipo === 'historico') return `${b.titulo}: Esri Wayback${b.fonte ? `, ${b.fonte}` : ''}`;
    if (chave === 'mapa') return 'Mapa: Prefeitura de Goiânia, relevo Esri';
    return `${(b?.titulo || '').replace(' (cartografia municipal)', '')}: Prefeitura de Goiânia`;
  };
  const seletorData = $('#satelite-data');
  const marcarBase = () => {
    for (const b of $$('#lista-bases button, #epocas button')) b.setAttribute('aria-checked', String(b.dataset.base === globo.chaveBase));
    seletorData.value = globo.chaveBase.startsWith('sat-') ? globo.chaveBase : '';
    $('#rotulo-esq').textContent = bases.find((b) => b.chave === globo.chaveBase)?.curto || '';
    // O mapa desenhado e o Mapa Básico já trazem ruas e nomes: a camada por cima do satélite sai.
    if (globo.camadaRealce) { globo.camadaRealce.show = !['basico', 'mapa'].includes(globo.chaveBase); globo.redesenhar(); }
    servicos.definirFundo(globo.chaveBase); // nomes dos marcadores: brancos no satélite, pretos no mapa sem fotos
  };
  const trocarBase = async (chave) => {
    try { await globo.definirBase(chave); marcarBase(); atualizarLink(); }
    catch (e) { aviso(`Não foi possível carregar essa imagem: ${e.message}`, 'alerta'); }
  };
  app.trocarBase = trocarBase;
  const descricao = { satelite: 'fotografia atual', vetor: 'sem fotos: quadras, ruas e relevo', mapa: 'cartografia oficial com lotes' };
  const historicas = bases.filter((b) => b.tipo === 'historico');
  for (const b of bases.filter((x) => x.tipo !== 'historico')) {
    $('#lista-bases').append(el('button', { role: 'radio', dataset: { base: b.chave }, onclick: () => trocarBase(b.chave) },
      el('strong', {}, b.titulo.replace(' (cartografia municipal)', '')), el('small', {}, descricao[b.tipo])));
  }
  // Datas anteriores do satélite: uma opção por data de captura no centro de Goiânia.
  seletorData.append(el('option', { value: '' }, historicas.length ? 'Escolher uma data…' : 'Indisponível'),
    ...historicas.map((b) => el('option', { value: b.chave },
      `${b.titulo.replace('Satélite de ', '')}${b.fonte ? ` · ${b.fonte}` : ''}${b.resolucao ? ` · ${String(b.resolucao).replace('.', ',')} m` : ''}`)));
  seletorData.disabled = !historicas.length;
  seletorData.addEventListener('change', () => trocarBase(seletorData.value || 'satelite'));
  for (const b of bases.filter((x) => ['satelite', 'mapa'].includes(x.chave))) {
    $('#epocas').append(el('button', { role: 'radio', dataset: { base: b.chave }, title: b.titulo, onclick: () => trocarBase(b.chave) }, b.curto));
  }
  marcarBase();

  const seletor = $('#comparar');
  seletor.append(el('option', { value: '' }, 'Sem comparação'),
    ...bases.filter((b) => b.tipo !== 'historico').map((b) => el('option', { value: b.chave }, b.titulo)),
    historicas.length ? el('optgroup', { label: 'Satélite em outras datas' },
      historicas.map((b) => el('option', { value: b.chave }, b.titulo))) : null);
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

  // Opções da busca: Ruas e quadras e Lotes por bairro (com Edificações 3D por bairro).
  const opcoesBusca = $('#busca-opcoes'), botaoOpcoes = $('#busca-opcoes-botao');
  const abrirOpcoes = (abre) => { opcoesBusca.hidden = !abre; botaoOpcoes.setAttribute('aria-expanded', String(abre)); };
  botaoOpcoes.addEventListener('click', () => abrirOpcoes(opcoesBusca.hidden));
  document.addEventListener('pointerdown', (e) => { if (!opcoesBusca.hidden && !e.target.closest('#caixa-busca')) abrirOpcoes(false); });
  app.abrirOpcoesBusca = abrirOpcoes;
  $('#busca').addEventListener('input', () => abrirOpcoes(false));

  edificios.aoMudar = () => atualizarLink();
  camadas.aoMudar = () => atualizarLink();
  if (hash.t) camadas.restaurarDe(hash.t);
  lotes.aoMudar = () => atualizarLink();
  if (hash.l) lotes.restaurar(hash.l);
  levantamento.aoMudar = () => atualizarLink();
  if (hash.lv === '1') levantamento.mostrarBairros().catch(() => {});

  // ----------------------------------------------------------- navegação
  const rad = Cesium.Math.toRadians;
  $('#nav-bussola').addEventListener('click', () => globo.orbitar({ rumo: 0 }));
  $('#nav-3d').addEventListener('click', () => globo.orbitar({ inclinacao: globo.camera.pitch < rad(-80) ? rad(-45) : rad(-90) }));
  $('#nav-mais').addEventListener('click', () => globo.orbitar({ fator: 0.55 }));
  $('#nav-menos').addEventListener('click', () => globo.orbitar({ fator: 1.8 }));
  $('#nav-inclina-mais').addEventListener('click', () => globo.orbitar({ dInclinacao: rad(12) }));
  $('#nav-inclina-menos').addEventListener('click', () => globo.orbitar({ dInclinacao: rad(-12) }));
  $('#nav-inicio').addEventListener('click', () => globo.irParaInicio(1.6));
  // O pássaro da busca centraliza o mapa em Goiânia e bate a asa.
  $('#marca-passaro').addEventListener('click', (e) => {
    const b = e.currentTarget;
    b.classList.remove('voa'); void b.offsetWidth; b.classList.add('voa');
    setTimeout(() => b.classList.remove('voa'), 900);
    globo.irParaInicio(1.6);
  });
  $('#nav-foto').addEventListener('click', async () => {
    const blob = await globo.capturar();
    if (blob) baixarArquivo(`bussola-${new Date().toISOString().slice(0, 10)}.png`, blob);
  });
  $('#nav-local').addEventListener('click', () => localizacao.alternar());
  $('#btn-sair').addEventListener('click', () => {
    localizacao.parar();
    encerrarSessao();
    location.replace('index.html');
  });

  // ---------------------------------------------------- cliques e cursor
  const maos = new Cesium.ScreenSpaceEventHandler(globo.cena.canvas);
  maos.setInputAction((ev) => {
    const ponto = globo.pontoNaTela(ev.position);
    if (poligonos.desenho) { poligonos.clique(ponto); return; }
    if (medir.ativo) { medir.clique(ponto); return; }
    if (marcadores.aguardando) { if (ponto) marcadores.adicionar(ponto); return; }
    const pego = globo.cena.pick(ev.position);
    edificios.limparSelecao();
    if (pego?.id?.alca) return; // alças de edição: tratadas no arrastar
    if (poligonos.aoClicar(pego) || edificios.aoClicar(pego) || servicos.aoClicar(pego) || marcadores.aoClicar(pego) || levantamento.aoClicar(pego, ponto)) return;
    if (ponto) identificar.emPonto(ponto);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  maos.setInputAction(() => {
    if (poligonos.desenho) { poligonos.desfazer(); poligonos.concluirDesenho(); return; }
    if (medir.ativo) { medir.desfazer(); medir.concluir(); }
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  maos.setInputAction((ev) => {
    if (poligonos.aoBotaoDireito(globo.cena.pick(ev.position))) return;
    if (medir.ativo) medir.desfazer();
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  // Edição de polígonos: arrastar vértices.
  maos.setInputAction((ev) => { if (poligonos.editando) poligonos.aoPressionar(globo.cena.pick(ev.position)); }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
  maos.setInputAction(() => { poligonos.aoSoltar(); }, Cesium.ScreenSpaceEventType.LEFT_UP);

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
    if (poligonos.arrasto || poligonos.desenho) poligonos.aoMover(globo.pontoNaTela(ev.endPosition));
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
  if (bairros.bairros.length) {
    $('#lista-bairros').after(el('p', { class: 'nota' },
      'População conforme o campo da base municipal. A soma dos bairros equivale à do Censo de 2010, não à de 2022.'));
  }
  $('#sortear').addEventListener('click', () => {
    const altos = edificios.lista.slice(0, 40);
    const sorteio = [...parques.map((l) => () => irLugar(l)), ...altos.map((e) => () => edificios.irPara(e))];
    if (sorteio.length) sorteio[Math.floor(Math.random() * sorteio.length)]();
  });

  // ---------------------------------------------------------------- sobre
  $('#sobre-usuario').textContent = sessao.nome ? `Conectado como ${sessao.nome} (${sessao.login}).` : '';
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
    if (edificios.cidade) p.set('ed', '1');
    const eb = edificios.serializarBairros();
    if (eb) p.set('eb', eb);
    if (!realce.checked) p.set('n', '0');
    const l = lotes.serializar();
    if (l) p.set('l', l);
    if (levantamento.ativo) p.set('lv', '1');
    if (!globo.relevoAtivo) p.set('r', '0');
    history.replaceState(null, '', `#${p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%7C/g, '|')}`);
  }

  // -------------------------------------------------------------- teclado
  document.addEventListener('keydown', (e) => {
    if (poligonos.ocupado && (e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); poligonos.desfazer(); return; }
    if (poligonos.ocupado && e.key === 'Escape' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
      if (poligonos.desenho) poligonos.cancelarDesenho(); else poligonos.concluirEdicao();
      return;
    }
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
    else if (e.key === 'g' || e.key === 'G') localizacao.alternar();
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
  if (hash.ed === '1') await edificios.ligar(true);
  for (const id of String(hash.eb || '').split('.').filter(Boolean)) {
    const b = bairros.bairros.find((x) => x.id === id);
    if (b) edificios.definirBairro(id, b.n, true).catch(() => {});
  }
  // Usuário removido ou com senha trocada perde o acesso também nos aparelhos já conectados.
  // Abertura com sessão lembrada (sem passar pelo login): um registro por sessão do navegador.
  try {
    if (!sessionStorage.getItem('bussola:registrado')) { sessionStorage.setItem('bussola:registrado', '1'); registrarAcesso(sessao, 'abertura'); }
  } catch { /* sem armazenamento */ }
  sessaoAindaValida(sessao).then((ok) => { if (!ok) { encerrarSessao(); location.replace('index.html'); } });
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
