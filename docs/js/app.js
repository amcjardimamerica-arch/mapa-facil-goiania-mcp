// Bússola — inicialização e ligação da interface.
import { CFG, VERSAO } from './config.js';
import { $, $$, el, pedirJSON, debounce, aviso, baixarArquivo, fmtNum, fmtGraus, fmtDistancia, paraUTM, memoria } from './util.js';
import { Territorio } from './territorio.js';
import { Globo, noChao } from './globo.js';
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
import { iniciarBanco, cofreDisponivel, cofreAberto, cofreLiberadoAte, relatorioCompleto, zerarWorkers } from './banco.js';
import { ALTURA, faixaAltura, BASE, gravarBase } from './mapavetorial.js';
import { Quadras } from './quadras.js';
import { Drenagem } from './drenagem.js';
import { Geo360 } from './geo360.js';
import { Eleicoes } from './eleicoes.js';
import { Comparador } from './comparar.js';
import { Energia3D } from './energia3d.js';
import { Vias } from './viario.js';
import { Equipamentos } from './equipamentos.js';
import { restaurarGravacao, gravacaoAberta, gravacaoAte } from './gravacao.js';
import { sincronizarManutencao } from './manutencao.js';
import { relatorio as relatorioDesempenho, zerar as zerarDesempenho } from './desempenho.js';

const Cesium = window.Cesium;
// Botões de edição das divisas (Conselho Tutelar e Zonas Eleitorais), enquanto as divisas não forem travadas.
let botoesEdicao = () => null;
let aplicarEquipamentos = () => {};

// Vias e Mobilidade: estado das opções (guardado no aparelho) e o que cada uma liga.
const TRANSITO_GRUPOS = [
  ['Sinalização Semafórica', ['semaforos', 'direita_livre', 'estudo_cruzamentos']],
  ['Sinalização Horizontal e Dispositivos', ['faixas', 'quebra_molas', 'pare', 'rotatorias', 'retencao', 'setas', 'ciclovias', 'faixas_onibus',
    'estudo_escolas', 'estudo_saude', 'estudo_onibus']],
  ['Fiscalização Eletrônica', ['fiscalizacao', 'videomonitoramento', 'licitacao_2023']],
];
// Mesmo indicador de fontes diferentes = um botão só (1.38.2): o que importa é o ponto, não a fonte.
const TRANSITO_JUNTOS = { semaforos_novos: 'semaforos', faixas_novas: 'faixas', quebra_molas_novos: 'quebra_molas', pare_novos: 'pare',
  radares_fora_set: 'fiscalizacao', cameras_mapillary: 'videomonitoramento', bicicleta: 'ciclovias' };
// Nomes do painel. Estudos (onde ainda não há a sinalização): ícone de alerta; notícias ficam de fora.
const TRANSITO_NOMES = { semaforos: 'Cruzamentos semaforizados', direita_livre: 'Direita Livre e Esquerda Livre',
  estudo_cruzamentos: '⚠ Cruzamentos sem semáforo', faixas: 'Faixas de pedestres', quebra_molas: 'Quebra-molas e faixas elevadas',
  pare: 'PARE (parada obrigatória)', rotatorias: 'Rotatórias', retencao: 'Linhas de retenção', setas: 'Setas no pavimento',
  ciclovias: 'Ciclovias, ciclofaixas e sinalização de bicicleta', faixas_onibus: 'Faixas exclusivas de ônibus',
  estudo_escolas: '⚠ Escolas sem faixa de pedestres', estudo_saude: '⚠ Unidades de saúde sem faixa de pedestres', estudo_onibus: '⚠ Pontos de ônibus sem travessia',
  fiscalizacao: 'Radares e lombadas eletrônicas', videomonitoramento: 'Câmeras de monitoramento', licitacao_2023: 'Locais previstos para fiscalização (licitação 2023)' };
const viasEstado = () => {
  const padrao = { avenidas: true, rotas: false, paradas: false, semAsfalto: false, propostas: false,
    t: { semaforos: true, direita_livre: true, faixas: true, quebra_molas: true, fiscalizacao: true } };
  try { const d = JSON.parse(localStorage.getItem('bussola:vias') || 'null'); return d ? { ...padrao, ...d, t: { ...padrao.t, ...(d.t || {}) } } : padrao; } catch { return padrao; }
};
const viasGravar = (e) => { try { localStorage.setItem('bussola:vias', JSON.stringify(e)); } catch { /* */ } };
let viasLigado = false;
let aplicarVias = () => {};

// Módulo Trânsito (transito.js): espera ele se ligar ao globo.
const esperarTransito = async () => {
  for (let i = 0; i < 120 && !(window.BussolaTransito?.indice); i++) await new Promise((ok) => setTimeout(ok, 250));
  if (!window.BussolaTransito?.indice) throw new Error('módulo de trânsito indisponível');
  return window.BussolaTransito;
};
const app = (window.bussola = { versao: VERSAO, pronto: false, erros: [] });
// Medidas de desempenho: bussola.desempenho() no console; bussola.zerarDesempenho() recomeça a contagem.
app.desempenho = () => relatorioCompleto();
app.zerarDesempenho = () => { zerarDesempenho(); zerarWorkers(); };

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

/**
 * Garante que a versão publicada é a que está aberta: lê a versão no servidor (sem cache) e, se for mais nova
 * que a carregada, atualiza o service worker, limpa o que estiver guardado de páginas e código e recarrega uma vez.
 */
async function conferirVersaoNova() {
  try {
    const texto = await (await fetch(`js/config.js?nc=${Date.now()}`, { cache: 'no-store' })).text();
    const publicada = (texto.match(/VERSAO = '([^']+)'/) || [])[1];
    if (!publicada || publicada === VERSAO) { sessionStorage.removeItem('bussola:recarregou'); return; }
    if (sessionStorage.getItem('bussola:recarregou') === publicada) return; // já tentou: não entra em ciclo
    sessionStorage.setItem('bussola:recarregou', publicada);
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update().catch(() => {});
    for (const k of (await caches?.keys?.()) || []) if (!k.startsWith('bussola-dados')) await caches.delete(k);
    location.reload();
  } catch { /* sem rede: segue com a versão aberta */ }
}

async function iniciar() {
  if (!Cesium) throw new Error('A biblioteca do globo (CesiumJS) não carregou. Verifique a conexão e recarregue.');
  // Guarda no aparelho o banco local e os dados (abre de imediato nas próximas vezes).
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  conferirVersaoNova();
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
    pedirJSON(`${CFG.dados}satelite.json`).catch(() => ({ versoes: [] })), // datas anteriores do satélite (Esri Wayback)
  ]);
  catalogo.banco = banco;
  catalogo.satelite = satelite.versoes || [];
  catalogo.bairros = bairros.bairros; // nomes de bairro no mapa desenhado
  const territorio = new Territorio(geo);
  const hash = lerHash();

  estadoAbertura('Montando o globo…');
  const globo = new Globo(territorio, catalogo);
  // Conteúdos próprios de alguns projetos do painel Camadas (os módulos são criados logo abaixo).
  const especiais = {
    // Base Cadastral: opções do desenho cadastral da cidade inteira.
    base: (caixa) => {
      const op = (k, titulo) => el('label', { class: 'linha-chave' }, el('span', {}, el('strong', {}, titulo)),
        el('span', { class: 'interruptor' }, el('input', { type: 'checkbox', checked: !!BASE[k], onchange: (e) => { BASE[k] = e.target.checked; gravarBase(); app.refazerMapas?.(); } }), el('span', {})));
      caixa.append(op('ruas', 'Nomes das ruas'), op('quadras', 'Quadras'), op('lotes', 'Lotes'), op('divisas', 'Divisas dos bairros'),
        op('nomesBairros', 'Nomes dos bairros'),
        op('atividades', 'Cadastro de Atividade Econômica'), op('npo', 'Número Predial Oficial'));
    },
    baseLigar: (ligado) => { BASE.ligado = ligado; gravarBase(); app.refazerMapas?.(); },
    // Sistema Viário: destaque amarelo das avenidas e vias principais sobre o satélite (desligável).
    // Vias e Mobilidade: avenidas, transporte coletivo, vias sem asfalto e propostas, e a sinalização de trânsito.
    viario: async (caixa) => {
      const est = viasEstado();
      const chave = (titulo, ligado, aoMudar, sub = false) => el('label', { class: `linha-chave${sub ? ' dren-sub-linha' : ''}` },
        el('span', {}, sub ? titulo : el('strong', {}, titulo)),
        el('span', { class: 'interruptor' }, el('input', { type: 'checkbox', checked: !!ligado, onchange: (e) => aoMudar(e.target.checked) }), el('span', {})));
      const mudar = (k) => (v) => { est[k] = v; viasGravar(est); aplicarVias(); };
      const marcar = (x) => { x.setAttribute('data-tc', '1'); return x; };
      caixa.append(
        chave('Avenidas Principais', est.avenidas, mudar('avenidas')),
        chave('Transporte Coletivo', est.rotas || est.paradas, (v) => { est.rotas = est.paradas = v; viasGravar(est); aplicarVias(); caixa.querySelectorAll('[data-tc] input').forEach((x) => { x.checked = v; }); }),
        marcar(chave('Rotas de ônibus', est.rotas, mudar('rotas'), true)),
        marcar(chave('Pontos e paradas de ônibus', est.paradas, mudar('paradas'), true)),
        chave('Vias sem asfalto', est.semAsfalto, mudar('semAsfalto')),
        chave('Vias propostas (sem abertura)', est.propostas, mudar('propostas')));
      const T = await esperarTransito();
      for (const [g, itens] of TRANSITO_GRUPOS) {
        const presentes = itens.filter((k) => T.indice.camadas.some((x) => x.chave === k));
        const subs = [];
        const geral = chave(g, presentes.some((k) => est.t[k]), (v) => {
          for (const k of presentes) est.t[k] = v;
          subs.forEach((x) => { x.querySelector('input').checked = v; });
          viasGravar(est); aplicarVias();
        });
        caixa.append(geral);
        for (const k of presentes) {
          const linha = chave(TRANSITO_NOMES[k] || k, est.t[k], (v) => {
            est.t[k] = v; viasGravar(est); aplicarVias();
            geral.querySelector('input').checked = presentes.some((x) => est.t[x]);
          }, true);
          subs.push(linha); caixa.append(linha);
        }
      }
    },
    viarioLigar: (ligado) => { viasLigado = ligado; aplicarVias(); },
    // Mapas de eleição: Zonas Eleitorais (TSE) e Conselho Tutelar (regiões e locais da eleição de 2023).
    eleitoral: (caixa) => caixa.append(botoesEdicao() || ''),
    eleitoralLigar: (ligado) => { if (!ligado) eleicoes.pararEdicao(); eleicoes.definir(ligado ? 'zonas' : '').catch(() => {}); levantamento.definirEleicao(ligado ? 'geral' : '').catch(() => {}); },
    // Trânsito: um botão por camada (semáforos, faixas, quebra-molas, PARE, rotatórias, ciclovias, fiscalização…)
    conselho: (caixa) => caixa.append(botoesEdicao() || ''),
    conselhoLigar: (ligado) => { if (!ligado) eleicoes.pararEdicao(); eleicoes.definir(ligado ? 'conselho' : '').catch(() => {}); levantamento.definirEleicao(ligado ? 'ct' : '').catch(() => {}); },
    cadastro: (caixa) => {
      const op = (k, titulo, sub = false) => el('label', { class: `linha-chave${sub ? ' dren-sub-linha' : ''}` }, el('span', {}, titulo),
        el('span', { class: 'interruptor' }, el('input', { type: 'checkbox', checked: !!BASE[k], onchange: (e) => {
          BASE[k] = e.target.checked; gravarBase(); app.refazerMapas?.(); aplicarEquipamentos(); } }), el('span', {})));
      caixa.append(op('areasVerdes', 'Áreas verdes e praças (verde)'), op('imoveisPublicos', 'Imóveis públicos (azul)'),
        op('eq_grande', 'Grande equipamento', true), op('eq_educacao', 'Educação municipal', true), op('eq_saude', 'Saúde', true),
        op('eq_social', 'Segurança, cultura e assistência social', true));
      const ed = el('div', {});
      caixa.append(ed);
      edificios.montarEm(ed);
    },
    cadastroLigar: (ligado) => { BASE.cadastroLigado = ligado; gravarBase(); app.refazerMapas?.(); aplicarEquipamentos(); },
    // Drenagem Pluvial: base própria da A.M.C. (bocas de lobo, galerias, pontos de inspeção e análises).
    drenagem: (caixa) => drenagem.montarEm(caixa),
    drenagemLigar: (ligado) => { drenagem.ligar(ligado).catch(() => {}); },
    // Geo360 (atualização 2024-2025): condomínios, Planta de Valores, risco geológico e equipamentos municipais.
    geo360: (caixa) => geo360.montarEm(caixa),
    geo360Ligar: (ligado) => { geo360.ligar(ligado).catch(() => {}); },
  };
  const camadas = new Camadas(globo, catalogo, $('#lista-camadas'), { especiais });
  const identificar = new Identificar(globo, camadas, territorio);
  const eleicoes = new Eleicoes({ globo, identificar });
  const drenagem = new Drenagem({ globo, identificar });
  const geo360 = new Geo360({ globo, identificar });
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
  const levantamento = new Levantamento({ globo, identificar, raiz: $('#painel-levantamento'), sessao });
  lotes.edificios = edificios;
  levantamento.aoEdificacoes = (id, nome, ligado, aneis) => edificios.definirBairro(id, nome, ligado, aneis).then(() => lotes._desenharChips());
  // Os locais de votação só aparecem com o projeto Zonas Eleitorais ligado.
  levantamento.opcoes.eleicao = '';
  const localizacao = new Localizacao({ globo, camadas, territorio, botaoGps: $('#nav-local') });
  // Equipamentos do Geo360 (Guarda Civil, Cultura, Assistência Social) também entram na busca, pelo nome.
  geo360.lugares().then((extra) => { if (extra.length) busca.acrescentarLugares(extra); }).catch(() => {});
  Object.assign(app, { drenagem, geo360, globo, camadas, identificar, servicos, edificios, medir, marcadores, poligonos, localizacao, lotes, levantamento, eleicoes, busca, territorio, catalogo, manifesto, sessao });

  const bases = globo.basesDisponiveis();
  const baseInicial = bases.some((b) => b.chave === hash.b) ? hash.b : globo.basePadrao;
  await globo.definirBase(baseInicial);

  // -------------------------------------------------------------- painéis
  const painel = $('#painel');
  let painelAberto = null;
  const abrirPainel = (nome) => {
    painelAberto = painelAberto === nome ? null : nome;
    painel.hidden = !painelAberto;
    for (const s of $$('#painel > section')) s.hidden = s.dataset.secao !== painelAberto;
    for (const b of $$('[data-painel]')) b.setAttribute('aria-pressed', String(b.dataset.painel === painelAberto));
    if (painelAberto) $('#painel-titulo').textContent = $(`#painel > [data-secao="${painelAberto}"]`).dataset.titulo;
    if (painelAberto === 'camadas') camadas.atualizarEscala();
    if (painelAberto === 'levantamento') levantamento.mostrarBairros().catch((e) => aviso(`Levantamento indisponível: ${e.message}`, 'alerta'));
    if (painelAberto !== 'medir') medir.cancelar();
    if (painelAberto !== 'marcadores') marcadores.cancelarPedido();
  };
  app.abrirPainel = abrirPainel;
  $$('[data-painel]').forEach((b) => b.addEventListener('click', () => abrirPainel(b.dataset.painel)));
  $('#painel-fechar').addEventListener('click', () => abrirPainel(painelAberto));

  // --------------------------------------------------------- bases e épocas
  const creditoBase = (chave) => {
    const b = bases.find((x) => x.chave === chave);
    if (chave === 'satelite') return 'Satélite: Esri, Maxar, Earthstar Geographics';
    if (b?.tipo === 'historico' && b.url) return `${b.titulo}: Esri Wayback${b.fonte ? `, ${b.fonte}` : ''}`;
    if (b?.tipo === 'foto' || b?.tipo === 'historico') return `${b.titulo}: ortofoto da Prefeitura de Goiânia (banco local)`;
    if (chave === 'mapa') return 'Mapa: Prefeitura de Goiânia, relevo Copernicus DEM';
    return `${(b?.titulo || '').replace(' (cartografia municipal)', '')}: Prefeitura de Goiânia`;
  };
  const seletorData = $('#satelite-data');
  const marcarBase = () => {
    for (const b of $$('#lista-bases button, #epocas button')) b.setAttribute('aria-checked', String(b.dataset.base === globo.chaveBase));
    seletorData.value = bases.find((b) => b.chave === globo.chaveBase)?.tipo === 'historico' ? globo.chaveBase : '';
    $('#rotulo-esq').textContent = bases.find((b) => b.chave === globo.chaveBase)?.curto || '';
    // O mapa desenhado e o Mapa Básico já trazem ruas e nomes: a camada por cima do satélite sai.
    if (globo.camadaRealce) { globo.camadaRealce.show = !['basico', 'mapa'].includes(globo.chaveBase); globo.redesenhar(); }
    servicos.definirFundo(globo.chaveBase); // nomes dos marcadores: brancos no satélite, pretos no mapa sem fotos
    if (edificios.ativo) edificios._construir?.(); // número no teto com as cores do fundo
    if (levantamento.dados) levantamento.redesenhar(); // número do lote: uma vez só, conforme o fundo
  };
  const trocarBase = async (chave) => {
    try { await globo.definirBase(chave); marcarBase(); atualizarLink(); }
    catch (e) { aviso(`Não foi possível carregar essa imagem: ${e.message}`, 'alerta'); }
  };
  app.trocarBase = trocarBase;
  const descricao = { satelite: 'fotografia atual (Esri)', foto: 'ortofoto da Prefeitura', vetor: 'sem fotos: quadras, ruas e relevo', mapa: 'cartografia oficial com lotes' };
  const historicas = bases.filter((b) => b.tipo === 'historico');
  for (const b of bases.filter((x) => x.tipo !== 'historico')) {
    $('#lista-bases').append(el('button', { role: 'radio', dataset: { base: b.chave }, onclick: () => trocarBase(b.chave) },
      el('strong', {}, b.titulo.replace(' (cartografia municipal)', '')), el('small', {}, descricao[b.tipo])));
  }
  // Ortofotos anteriores da Prefeitura guardadas no banco: uma opção por ano.
  seletorData.append(el('option', { value: '' }, historicas.length ? 'Escolher uma data…' : 'Indisponível'),
    ...historicas.map((b) => el('option', { value: b.chave },
      `${b.titulo.replace('Satélite de ', '').replace('Foto aérea de ', 'Ortofoto ')}${b.fonte ? ` · ${b.fonte}` : ''}${b.resolucao ? ` · ${String(b.resolucao).replace('.', ',')} m` : ''}`)));
  seletorData.disabled = !historicas.length;
  seletorData.addEventListener('change', () => trocarBase(seletorData.value || globo.basePadrao));
  for (const b of bases.filter((x) => ['satelite', 'foto', 'mapa'].includes(x.chave))) {
    $('#epocas').append(el('button', { role: 'radio', dataset: { base: b.chave }, title: b.titulo, onclick: () => trocarBase(b.chave) }, b.curto));
  }
  marcarBase();

  const seletor = $('#comparar');
  seletor.append(el('option', { value: '' }, 'Sem comparação'),
    ...bases.filter((b) => b.tipo !== 'historico').map((b) => el('option', { value: b.chave }, b.titulo)),
    historicas.length ? el('optgroup', { label: 'Fotos aéreas de outros anos' },
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
  realce.checked = hash.n === '1'; // 1.34: mapa limpo; liga só quando escolhido
  realce.addEventListener('change', () => { globo.definirRealce(realce.checked); marcarBase(); atualizarLink(); });
  globo.definirRealce(realce.checked);

  // Quadras e lotes pela altura da câmera (5 km), número da quadra (4 km) e do lote (3 km): ao cruzar uma dessas
  // alturas, os mapas desenhados (fundo Mapa, Ruas e quadras e lotes) são refeitos para a nova faixa.
  // A altura é lida a cada quadro desenhado (barato) — o evento "camera.changed" não dispara em toda mudança de vista.
  ALTURA.camera = globo.camera.positionCartographic.height;
  let faixa = faixaAltura(ALTURA.camera);
  // Número das quadras: marcadores de tela, por cima de lotes e construções 3D (docs/js/quadras.js).
  const quadras = new Quadras({ globo });
  app.quadras = quadras;
  const novasQuadras = () => quadras.atualizar();
  novasQuadras();
  // Relevo ligado/desligado ou exagero mudado: marcadores de tela voltam a ficar em cima do chão desenhado.
  globo.aoMudarRelevo(() => {
    novasQuadras();
    for (let i = 0; i < globo.viewer.dataSources.length; i++) {
      for (const ent of globo.viewer.dataSources.get(i).entities.values) if (ent.ll) ent.position = noChao(ent.ll[0], ent.ll[1]);
    }
    globo.redesenhar();
  });
  // Refaz os mapas desenhados (fundo Mapa, Ruas e quadras, números das quadras e lotes por bairro).
  const refazerVetoriais = app.refazerMapas = () => {
    novasQuadras();
    if (globo.chaveBase === 'mapa') globo.definirBase('mapa').catch(() => {});
    // A Base Cadastral é desenhada na camada "Ruas e quadras": ligada a Base, a camada entra junto (1.35).
    const precisa = realce.checked || BASE.ligado || (BASE.cadastroLigado && (BASE.areasVerdes || BASE.imoveisPublicos));
    if (globo.camadaRealce) globo.definirRealce(false);
    if (precisa) globo.definirRealce(true);
    marcarBase();
    lotes._atualizarCamada?.();
  };
  levantamento.aoMudarFiltroMapa = refazerVetoriais;
  levantamento.aoMudarNumeros = refazerVetoriais; // número do lote sai do levantamento dentro dos bairros da Associação
  globo.cena.postRender.addEventListener(() => {
    ALTURA.camera = globo.camera.positionCartographic.height;
    const f = faixaAltura(ALTURA.camera);
    if (f === faixa) return;
    faixa = f;
    refazerVetoriais();
    if (levantamento.dados) levantamento.redesenhar();
  });
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
  // Logomarca viva (Pássaro Guia), dentro da caixa da busca: ao clicar, o pássaro salta e bate as asas e o mapa
  // centraliza o Jardim América inteiro, de cima e com o norte para cima; parado,
  // de tempos em tempos ele ajeita as penas ou pia.
  const passaro = $('#marca-passaro .amc-bird');
  const animar = (cls, ms) => { if (!passaro) return; passaro.classList.remove(cls); void passaro.getBoundingClientRect(); passaro.classList.add(cls); setTimeout(() => passaro.classList.remove(cls), ms); };
  $('#marca-passaro').addEventListener('click', (e) => {
    const b = e.currentTarget;
    b.classList.remove('voa'); void b.offsetWidth; b.classList.add('voa');
    setTimeout(() => b.classList.remove('voa'), 2200);
    animar('flap', 2080); animar('chirp', 600); // 4 batidas de asa (8 × 0,26 s)
    const ja = bairros.bairros.find((x) => x.id === '000400000015');
    if (ja?.e) globo.voarPara({ extensao: ja.e, inclinacao: -90, rumo: 0, distancia: 3800, duracao: 1.6 });
    else globo.irParaInicio(1.6);
  });
  setInterval(() => { if (document.visibilityState === 'visible') animar(Math.random() < 0.5 ? 'ruffle' : 'chirp', 1000); }, 9000);
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
  // Energia: postes 3D em toda Goiânia (no lugar dos marcadores de poste e de iluminação).
  const energia3d = new Energia3D({ globo, identificar });
  camadas.energia3d = energia3d;
  camadas.geo360 = geo360;
  // Vias e Mobilidade: desenho próprio (viario.js) + avenidas (Base) + sinalização de trânsito (transito.js).
  const equipamentos = new Equipamentos({ globo, identificar });
  BASE.cadastroLigado = false; // o projeto Cadastro Imobiliário começa desligado (mapa limpo)
  aplicarEquipamentos = () => { const on = !!BASE.cadastroLigado; return equipamentos.definir({ grande: on && !!BASE.eq_grande, educacao: on && !!BASE.eq_educacao,
    saude: on && !!BASE.eq_saude, social: on && !!BASE.eq_social }).catch(() => {}); };
  aplicarEquipamentos();
  const vias = new Vias({ globo });
  app.vias = vias;
  aplicarVias = async () => {
    const est = viasEstado(), on = viasLigado;
    if (BASE.avenidas !== (on && est.avenidas)) { BASE.avenidas = on && est.avenidas; gravarBase(); app.refazerMapas?.(); }
    vias.definir({ rotas: on && est.rotas, paradas: on && est.paradas, semAsfalto: on && est.semAsfalto, propostas: on && est.propostas });
    const T = await esperarTransito().catch(() => null);
    if (!T) return;
    for (const cam of T.indice.camadas) {
      if (TRANSITO_NOMES[cam.chave]) cam.titulo = TRANSITO_NOMES[cam.chave];
      if (cam.chave.startsWith('estudo_')) cam.icone = 'alerta';
      const k = TRANSITO_JUNTOS[cam.chave] || cam.chave;
      const quer = on && !!est.t[k] && TRANSITO_GRUPOS.some(([, l]) => l.includes(k));
      if (quer !== T.ligada(cam.chave)) await T.ligar(cam.chave, quer);
    }
  };
  esperarTransito().then((T) => { for (const cam of T.indice.camadas) { if (TRANSITO_NOMES[cam.chave]) cam.titulo = TRANSITO_NOMES[cam.chave]; if (cam.chave.startsWith('estudo_')) cam.icone = 'alerta'; } }).catch(() => {});
  app.energia3d = energia3d;
  const maos = new Cesium.ScreenSpaceEventHandler(globo.cena.canvas);
  // Ctrl + clique: o lote abre numa janela própria, ao lado das outras, para comparar (até 3).
  botoesEdicao = () => (CFG.conselhoEditavel ? el('div', { class: 'linha-botoes' },
    el('button', { class: 'botao', onclick: async (e) => {
      if (eleicoes.editando) { eleicoes.pararEdicao(); e.target.textContent = 'Editar divisas'; return; }
      await eleicoes.iniciarEdicao(); e.target.textContent = 'Parar a edição'; } }, 'Editar divisas'),
    el('button', { class: 'botao-texto', onclick: () => eleicoes.salvarEdicao() }, 'Salvar divisas')) : null);
  const comparador = new Comparador({ globo, identificar });
  app.comparador = comparador;
  maos.setInputAction((ev) => {
    const ponto = globo.pontoNaTela(ev.position);
    if (ponto) comparador.abrir(ponto).catch(() => {});
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK, Cesium.KeyboardEventModifier.CTRL);
  maos.setInputAction((ev) => {
    const ponto = globo.pontoNaTela(ev.position);
    if (poligonos.desenho) { poligonos.clique(ponto); return; }
    if (medir.ativo) { medir.clique(ponto); return; }
    if (marcadores.aguardando) { if (ponto) marcadores.adicionar(ponto); return; }
    const pego = globo.cena.pick(ev.position);
    edificios.limparSelecao();
    if (pego?.id?.alca) return; // alças de edição: tratadas no arrastar
    // Trânsito: a ficha do objeto (semáforo, faixa, radar…) na janela de informações do sistema.
    if (pego?.id?.transito && window.BussolaTransito) {
      const T = window.BussolaTransito, f = T.linhas(pego.id);
      T._destacar(pego.id);
      identificar.abrir({ titulo: f.titulo, subtitulo: 'Trânsito · Goiânia', ponto });
      identificar.corpo.textContent = '';
      identificar.corpo.append(identificar.tabela(f.linhas.filter(([, v]) => !/^https?:\/\//.test(String(v))).map(([r, v]) => [r, String(v)])));
      const links = f.linhas.filter(([, v]) => /^https?:\/\//.test(String(v)));
      if (links.length) identificar.corpo.append(el('div', { class: 'linha-botoes centro' }, ...links.map(([r, v]) => el('a', { class: 'botao-texto', href: String(v), target: '_blank', rel: 'noopener' }, r))));
      return;
    }
    if (equipamentos.aoClicar(pego) || energia3d.aoClicar(pego) || poligonos.aoClicar(pego) || edificios.aoClicar(pego) || servicos.aoClicar(pego) || marcadores.aoClicar(pego) || drenagem.aoClicar(ponto) || geo360.aoClicar(ponto) || levantamento.aoClicar(pego, ponto)) return;
    if (eleicoes.aoClicar(ponto)) return; // mapa de eleição ligado: zona ou região inteira, nunca quadra ou lote
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


  // ---------------------------------------------------------------- sobre
  // Dados complementares (cofre): senha informada aqui libera por 24 horas, para este usuário, em todo o mapa.
  // Banco de dados gravável: reabre se a liberação de 24 horas ainda vale e junta os pedidos de manutenção.
  restaurarGravacao().then((ok) => { if (!ok) return null; montarCofreSobre(); return sincronizarManutencao().then(() => levantamento.dados && levantamento.redesenhar()); }).catch(() => {});
  const montarCofreSobre = () => {
    const caixa = $('#cofre-sobre');
    caixa.textContent = '';
    if (!cofreDisponivel()) { caixa.append(el('p', { class: 'nota' }, 'Este banco não tem dados complementares cifrados.')); return; }
    const ate = cofreLiberadoAte();
    caixa.append(el('p', { class: 'nota' }, cofreAberto()
      ? `🔓 Liberados${ate ? ` até ${ate.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''} para esta conta.`
      : '🔒'));
    const ateG = gravacaoAte();
    caixa.append(el('p', { class: 'nota' }, gravacaoAberta()
      ? `💾 Gravação no banco de dados liberada${ateG ? ` até ${ateG.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}.`
      : '💾 🔒'));
  };
  montarCofreSobre();
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
    if (globo.chaveBase !== globo.basePadrao) p.set('b', globo.chaveBase);
    const t = camadas.serializar();
    if (t) p.set('t', t);
    if (edificios.cidade) p.set('ed', '1');
    const eb = edificios.serializarBairros();
    if (eb) p.set('eb', eb);
    if (realce.checked) p.set('n', '1');
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
  // Filtros da Associação: o núcleo do levantamento começa a baixar durante o voo de chegada e é montado
  // assim que o globo fica livre, para o painel abrir pronto (os detalhes das fichas vêm depois, por trás).
  levantamento.associacaoDoAcesso().then((a) => { if (a) levantamento.precarregar(); }).catch(() => {});
  estadoAbertura('Pronto. Voando até Goiânia…');
  $('#abertura').classList.add('sai');
  setTimeout(() => $('#abertura').remove(), 900);
  if (hash.v && globo.aplicarVisao(hash.v)) globo.liberarLimites();
  else { await globo.chegada(); globo.liberarLimites(); }
  app.pronto = true;
  aoParar();
  (window.requestIdleCallback || ((f) => setTimeout(f, 1200)))(() => {
    levantamento.associacaoDoAcesso().then((a) => a && levantamento.carregar()).catch(() => {});
  }, { timeout: 4000 });

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
