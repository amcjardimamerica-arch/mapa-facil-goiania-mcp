// Página de validação: confere dados locais, cálculos e os serviços ao vivo.
// Cada teste devolve um texto de detalhe; lançar erro = falha; { alerta } = atenção.
import { CFG, VERSAO } from './config.js';
import { iniciarBanco } from './banco.js';
import { $, el, pedirJSON, paraUTM, deUTM, mercX, mercY, areaM2, pontoNaGeometria, baixarArquivo, fmtNum, semAcento } from './util.js';

const PRACA_CIVICA = { lon: -49.2556, lat: -16.6816 };
const dados = {};
const carregar = async (nome) => (dados[nome] ??= await pedirJSON(`${CFG.dados}${nome}`, { tempo: 60000 }));
const exigir = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Imagem do servidor municipal: uma nova tentativa quando a rede falha (o servidor oscila sob carga). */
async function imagem(url, tempo = 40000) {
  try { return await imagemUmaVez(url, tempo); }
  catch (e) {
    if (!/fetch|abort|network/i.test(String(e.message || e))) throw e;
    await new Promise((ok) => setTimeout(ok, 1500));
    return `${await imagemUmaVez(url, tempo)} (na 2ª tentativa)`;
  }
}

async function imagemUmaVez(url, tempo) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), tempo);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    exigir(r.ok, `HTTP ${r.status}`);
    const tipo = r.headers.get('content-type') || '';
    const blob = await r.blob();
    exigir(tipo.startsWith('image/'), `resposta não é imagem (${tipo || 'sem tipo'})`);
    return `${tipo}, ${fmtNum(blob.size / 1024, 1)} KB`;
  } finally { clearTimeout(t); }
}

function bboxTeste(metros = 1500) {
  const x = mercX(PRACA_CIVICA.lon), y = mercY(PRACA_CIVICA.lat);
  return [x - metros, y - metros, x + metros, y + metros].join(',');
}
const urlExport = (url, extra = '') =>
  `${url}/export?bbox=${bboxTeste()}&bboxSR=3857&imageSR=3857&size=128,128&format=png32&transparent=true&f=image${extra}`;

const grupos = [
  { titulo: 'Dados extraídos do Mapa Fácil (arquivos do projeto)', testes: [
    ['Manifesto da extração', async () => {
      const m = await carregar('manifest.json');
      exigir(m.atualizado_em, 'manifest.json sem data');
      const dias = Math.round((Date.now() - new Date(m.atualizado_em)) / 864e5);
      const txt = `extraído em ${new Date(m.atualizado_em).toLocaleString('pt-BR')} (há ${dias} dia(s)), extrator ${m.versao_extrator}`;
      return dias > 45 ? { alerta: `${txt} — rode a atualização de dados` } : txt;
    }],
    ['Território: Goiânia e limítrofes', async () => {
      const t = await carregar('territorio.geojson');
      const gyn = t.features.find((f) => f.properties.tipo === 'goiania');
      const viz = t.features.filter((f) => f.properties.tipo === 'vizinho');
      exigir(gyn, 'sem o polígono de Goiânia');
      exigir(viz.length >= 8, `apenas ${viz.length} limítrofes`);
      exigir(pontoNaGeometria(PRACA_CIVICA.lon, PRACA_CIVICA.lat, gyn.geometry), 'Praça Cívica deveria estar em Goiânia');
      exigir(!pontoNaGeometria(-49.2469, -16.8198, gyn.geometry), 'centro de Aparecida não deveria estar em Goiânia');
      const ap = viz.find((f) => pontoNaGeometria(-49.2469, -16.8198, f.geometry));
      exigir(ap && /Aparecida/.test(ap.properties.nome), 'centro de Aparecida deveria cair em Aparecida de Goiânia');
      exigir(!viz.some((f) => pontoNaGeometria(PRACA_CIVICA.lon, PRACA_CIVICA.lat, f.geometry)), 'limítrofe sobrepõe Goiânia');
      return `Goiânia ${fmtNum(gyn.properties.area_km2, 1)} km²; ${viz.length} limítrofes: ${viz.map((f) => f.properties.nome).join(', ')}`;
    }],
    ['Área de Goiânia confere com o contorno', async () => {
      const t = await carregar('territorio.geojson');
      const gyn = t.features.find((f) => f.properties.tipo === 'goiania');
      const area = areaM2(gyn.geometry.coordinates[0]) / 1e6;
      exigir(Math.abs(area - gyn.properties.area_km2) / gyn.properties.area_km2 < 0.01, `calculado ${area.toFixed(1)} km²`);
      return `${fmtNum(area, 1)} km² calculados no navegador`;
    }],
    ['Índice de bairros', async () => {
      const b = (await carregar('bairros.json')).bairros;
      exigir(b.length > 1000, `só ${b.length} bairros`);
      const ja = b.find((x) => semAcento(x.n).includes('jardim america'));
      exigir(ja, 'Jardim América não está no índice');
      return `${fmtNum(b.length)} bairros; população somada ${fmtNum(b.reduce((s, x) => s + x.pop, 0))}`;
    }],
    ['Índice de logradouros', async () => {
      const d = await carregar('logradouros.json');
      exigir(d.ruas.length > 10000, `só ${d.ruas.length} registros`);
      exigir(d.ruas.some((r) => semAcento(r[1]).includes('anhanguera')), 'Av. Anhangüera não está no índice');
      return `${fmtNum(d.ruas.length)} trechos logradouro × bairro`;
    }],
    ['Edifícios para o modelo 3D', async () => {
      const d = await carregar('edificios.json');
      const e = d.edificios;
      exigir(e.length > 3000, `só ${e.length} edifícios`);
      exigir(e.every((x) => x.f.length >= 3 && x.c.length === 2), 'edifício sem base');
      return `${fmtNum(e.length)} edifícios; mais alto: ${e[0].n} (${e[0].p} pavimentos)`;
    }],
    ['Lugares (parques, educação, saúde)', async () => {
      const l = (await carregar('lugares.json')).lugares;
      exigir(l.length > 300, `só ${l.length} lugares`);
      return [['parque', 'parques'], ['educacao', 'de educação'], ['saude', 'de saúde']]
        .map(([t, r]) => `${l.filter((x) => x.tipo === t).length} ${r}`).join(', ');
    }],
    ['Catálogo de camadas igual ao do portal', async () => {
      const c = await carregar('camadas.json');
      const of = c.temas.filter((t) => t.oficial);
      exigir(of.length >= 12, `só ${of.length} temas do portal`);
      exigir(c.bases.length >= 4 && c.hibrido, 'faltam mapas base');
      return `${of.length} temas do portal, ${c.temas.length - of.length} extras, ${fmtNum(c.temas.reduce((s, t) => s + t.camadas.length, 0))} camadas, ${c.bases.length} bases`;
    }],
  ] },
  { titulo: 'Cálculos', testes: [
    ['Coordenadas UTM (SIRGAS 2000, fuso 22S) contra os pontos oficiais', async () => {
      const r = await pedirJSON(`${CFG.ms}/Mapa_Edificios/MapServer/5/query`, { parametros: {
        where: '1=1', outFields: 'x_coord,y_coord', returnGeometry: 'true', outSR: '4326', resultRecordCount: 20, f: 'json' } });
      exigir(r.features?.length, 'sem pontos de referência');
      let pior = 0;
      for (const f of r.features) {
        const u = paraUTM(f.geometry.x, f.geometry.y);
        pior = Math.max(pior, Math.hypot(u.e - f.attributes.x_coord, u.n - f.attributes.y_coord));
        const v = deUTM(u.e, u.n);
        exigir(Math.abs(v.lon - f.geometry.x) < 1e-9 && Math.abs(v.lat - f.geometry.y) < 1e-9, 'ida e volta não confere');
      }
      // Banco local: coordenadas guardadas com 7 casas decimais (~1 cm); a margem é de 10 cm.
      exigir(pior < 0.1, `erro de ${pior.toFixed(3)} m`);
      return `${r.features.length} pontos oficiais; maior diferença ${fmtNum(pior * 1000, 2)} mm`;
    }],
  ] },
  { titulo: 'Consultas (respondidas pelo banco local)', testes: [
    ['Identificar: bairro, quadra e lote na Praça Cívica', async () => {
      const x = mercX(PRACA_CIVICA.lon), y = mercY(PRACA_CIVICA.lat);
      const r = await pedirJSON(`${CFG.baseCadastral}/identify`, { parametros: {
        f: 'json', geometry: `${x},${y}`, geometryType: 'esriGeometryPoint', sr: '3857', layers: 'all:0,1,2', tolerance: 2,
        mapExtent: [x - 500, y - 500, x + 500, y + 500].join(','), imageDisplay: '800,800,96', returnGeometry: 'false' } });
      const bairro = r.results?.find((z) => z.layerId === 2);
      exigir(bairro, 'nenhum bairro devolvido');
      return `bairro: ${bairro.attributes.nm}; ${r.results.length} feição(ões) no ponto`;
    }],
    ['Cadastro Imobiliário por inscrição', async () => {
      const r = await pedirJSON(`${CFG.baseCadastral}/3/query`, { parametros: {
        f: 'json', where: "ci = '3010590447'", outFields: 'nrinscr,nmedificio', returnGeometry: 'false' } });
      exigir(r.features?.length, 'nenhuma inscrição devolvida');
      return `${r.features.length} inscrições no lote de teste (${String(r.features[0].attributes.nmedificio).trim()})`;
    }],
    ['Geometria de logradouro (busca)', async () => {
      const d = await carregar('logradouros.json');
      const rua = d.ruas.find((r) => semAcento(r[1]) === 'av anhanguera');
      exigir(rua, 'Av. Anhangüera não está no índice');
      const r = await pedirJSON(`${CFG.baseCadastral}/10/query`, { parametros: {
        f: 'json', where: `id = '${rua[0]}'`, outFields: 'nm,nm_bai', returnGeometry: 'true', outSR: '4326', geometryPrecision: 5 } });
      exigir(r.features?.some((f) => f.geometry?.paths?.length), 'sem geometria');
      return `${r.features.length} trecho(s) de ${rua[1]}`;
    }],
    ['Geometria de bairro (busca)', async () => {
      const b = (await carregar('bairros.json')).bairros.find((x) => semAcento(x.n).includes('jardim america'));
      const r = await pedirJSON(`${CFG.baseCadastral}/2/query`, { parametros: {
        f: 'json', where: `id = '${b.id}'`, outFields: 'id', returnGeometry: 'true', outSR: '4326', geometryPrecision: 5 } });
      exigir(r.features?.[0]?.geometry?.rings?.length, 'sem geometria');
      return `${b.n}: ${r.features[0].geometry.rings[0].length} vértices`;
    }],
    ['Legenda de um tema', async () => {
      const r = await pedirJSON(`${CFG.ms}/Mapa_MeioAmbiente/MapServer/legend`, { parametros: { f: 'json' } });
      exigir(r.layers?.length, 'legenda vazia');
      return `${r.layers.length} camadas com símbolos`;
    }],
  ] },
  { titulo: 'Banco de dados local — cada tema (sem o servidor da Prefeitura)', dinamico: async () => {
    const c = await carregar('camadas.json');
    const man = await (await fetch(`banco/manifesto.json?nc=${Date.now()}`, { cache: 'no-store' })).json();
    const imagens = Array.isArray(man.imagens) ? man.imagens : Object.keys(man.imagens || {});
    // Cada tema: o serviço está no banco e a primeira camada com dados responde à consulta local.
    const itens = c.temas.filter((t) => !t.somente_consulta).map((t) => [
      `${t.titulo}${t.oficial ? '' : ' (extra)'}`,
      async () => {
        const sv = man.servicos?.[t.chave];
        exigir(sv || imagens.includes(t.chave), 'serviço fora do banco local');
        const camadas = Object.entries(sv?.camadas || {}).filter(([, c]) => !c.copia_de);
        if (!camadas.length) { exigir(imagens.includes(t.chave), 'sem camadas nem imagens no banco local'); return 'imagens guardadas no banco local'; }
        const total = camadas.reduce((n, [, c]) => n + (c.total || 0), 0);
        exigir(total > 0, 'nenhuma feição no banco local');
        // Consulta de verdade ao banco: a primeira camada com geometria, num quadrado em volta da Praça Cívica.
        const geo = camadas.find(([, c]) => c.geo && c.total);
        if (geo) {
          const r = await pedirJSON(`${t.url}/${geo[0]}/query`, { parametros: { f: 'json', where: '1=1', returnCountOnly: 'true',
            geometry: bboxTeste(3000), geometryType: 'esriGeometryEnvelope', inSR: '3857', spatialRel: 'esriSpatialRelIntersects' } });
          exigir(Number.isFinite(r?.count), 'consulta local sem resposta');
        }
        return `${camadas.length} camadas, ${fmtNum(total)} feições no banco local`;
      },
    ]);
    for (const k of imagens) itens.push([`Imagens guardadas: ${k}`, async () => {
      const info = Array.isArray(man.imagens) ? null : man.imagens[k];
      return info ? `blocos de imagem no banco local (${JSON.stringify(info).slice(0, 60)}…)` : 'blocos de imagem no banco local';
    }]);
    // O Mapa e a camada "Ruas e quadras" são desenhados aqui com os dados vetoriais da base cadastral.
    const consulta = (camada, campos) => pedirJSON(`${CFG.baseCadastral}/${camada}/query`, { parametros: { f: 'json',
      geometry: '-5484730,-1885010,-5483530,-1883810', geometryType: 'esriGeometryEnvelope', inSR: '3857', outSR: '3857',
      spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true', outFields: campos, geometryPrecision: '1', maxAllowableOffset: '1' } });
    itens.push(['Mapa desenhado: quadras (vetor)', async () => {
      const r = await consulta(1, 'nm_qdr');
      exigir(r.features?.length > 20 && r.features[0].geometry?.rings, 'poucas quadras no centro');
      return `${r.features.length} quadras num quadrado de 1,2 km`;
    }]);
    itens.push(['Mapa desenhado: ruas com hierarquia (vetor)', async () => {
      const r = await consulta(7, 'nm,in_hie');
      exigir(r.features?.length > 50 && r.features.some((f) => f.attributes.in_hie >= 31), 'sem vias arteriais no centro');
      return `${r.features.length} trechos de rua`;
    }]);
    itens.push(['Levantamento da Associação (Jardim América e Nova Suíça)', async () => {
      const d = await carregar('levantamento-nucleo.json');
      const x = await carregar('levantamento-detalhes.json');
      exigir(d.lotes?.length > 8000 && d.limites?.length === 2, 'núcleo do levantamento incompleto');
      exigir(x.lotes_v?.length === d.lotes.length && x.gerado_em === d.gerado_em, 'detalhes de outra importação ou incompletos');
      return `${d.lotes.length} lotes, ${x.empresas.linhas.length + x.empresas_sem_lote.linhas.length} empresas, ${d.areas.length} áreas públicas, ${d.eleitoral.pontos.length} locais de votação`;
    }]);
    itens.push(['Mapa desenhado: relevo sombreado (próprio)', async () => imagem(CFG.relevo.sombra.replace('{z}', 13).replace('{x}', 2973).replace('{y}', 4480))]);
    return itens;
  } },
  { titulo: 'Satélite, fotos aéreas, relevo e globo', testes: [
    ['Satélite (Esri World Imagery)', async () => imagem(CFG.satelite.url.replace('{z}', 15).replace('{y}', 17924).replace('{x}', 11900))],
    ['Satélite em outras datas (Esri Wayback)', async () => {
      const d = await carregar('satelite.json');
      exigir(d.versoes?.length >= 3, 'menos de 3 datas de captura no arquivo');
      const v = d.versoes[0];
      const txt = await imagem(v.url.replace('{z}', 15).replace('{y}', 17924).replace('{x}', 11900));
      return `${d.versoes.length} datas, de ${v.captura} a ${d.versoes.at(-1).captura}; bloco da mais antiga: ${txt}`;
    }],
    ['Fotos aéreas (ortofotos da Prefeitura no banco local)', async () => {
      const man = await (await fetch(`banco/manifesto.json?nc=${Date.now()}`, { cache: 'no-store' })).json();
      const tem = (CFG.ortofotos || []).filter((o) => man.imagens?.[o.servico]);
      if (!tem.length) return { alerta: 'nenhuma ortofoto extraída ainda: o fundo padrão é o Mapa (ver ORIENTACOES da 1.24)' };
      return tem.map((o) => `${o.ano}: ${man.imagens[o.servico].blocos} blocos, níveis ${man.imagens[o.servico].min} a ${man.imagens[o.servico].max}`).join('; ');
    }],
    ['Relevo próprio (Copernicus DEM)', async () => {
      const m = await (await fetch(`${CFG.relevo.grade}.json`)).json();
      const r = await fetch(`${CFG.relevo.grade}.bin.gz`, { method: 'HEAD' });
      exigir(r.ok && m.largura > 1000, 'grade de relevo ausente');
      return `grade ${m.largura}×${m.altura}, de ${Math.round(m.minimo)} a ${Math.round(m.maximo)} m`;
    }],
    ['Biblioteca do globo (CesiumJS no próprio site)', async () => {
      const v = await (await fetch('vendor/cesium/versao.json')).json();
      const r = await fetch('vendor/cesium/Cesium.js', { method: 'HEAD' });
      exigir(r.ok, `vendor/cesium/Cesium.js: HTTP ${r.status}`);
      return `CesiumJS ${v.versao} guardado em vendor/cesium`;
    }],
    ['WebGL neste navegador', async () => {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      exigir(gl, 'WebGL indisponível: o globo 3D não abre neste navegador');
      return gl instanceof WebGL2RenderingContext ? 'WebGL 2 disponível' : { alerta: 'apenas WebGL 1 — o globo abre, com menos recursos' };
    }],
  ] },
];

const relatorio = { versao: VERSAO, pagina: location.href, navegador: navigator.userAgent, inicio: null, fim: null, testes: [] };

async function rodar() {
  $('#grupos').textContent = '';
  $('#rodar').disabled = $('#baixar').disabled = true;
  Object.keys(dados).forEach((k) => delete dados[k]);
  relatorio.testes = [];
  relatorio.inicio = new Date().toISOString();
  const conta = { ok: 0, alerta: 0, falha: 0, total: 0 };
  const resumo = () => {
    $('#resumo').textContent = '';
    $('#resumo').append(...[[conta.ok, 'aprovados'], [conta.alerta, 'com atenção'], [conta.falha, 'falharam'], [conta.total, 'testes no total']]
      .map(([n, t]) => el('div', {}, el('strong', {}, n), el('small', {}, t))));
  };
  resumo();
  for (const g of grupos) {
    const caixa = el('section', { class: 'grupo-v' }, el('h2', {}, g.titulo));
    $('#grupos').append(caixa);
    let testes = g.testes;
    if (g.dinamico) {
      try { testes = await g.dinamico(); }
      catch (e) { testes = [[`Preparar “${g.titulo}”`, async () => { throw e; }]]; }
    }
    conta.total += testes.length;
    resumo();
    // Em pequenos lotes: rápido sem sobrecarregar o servidor municipal.
    for (let i = 0; i < testes.length; i += 3) {
      await Promise.all(testes.slice(i, i + 3).map(async ([nome, fn]) => {
        const detalhe = el('div', { class: 'detalhe' }, 'executando…');
        const tempo = el('span', { class: 'tempo' });
        const linha = el('div', { class: 'teste rodando' }, el('span', { class: 'sinal' }), el('span', { class: 'nome' }, nome), tempo, detalhe);
        caixa.append(linha);
        const t0 = performance.now();
        let estado = 'ok', texto = '';
        try {
          const r = await fn();
          if (r && r.alerta) { estado = 'alerta'; texto = r.alerta; } else texto = r || '';
        } catch (e) { estado = 'falha'; texto = e.name === 'AbortError' ? 'tempo esgotado' : (e.message || String(e)); }
        const ms = Math.round(performance.now() - t0);
        linha.className = `teste ${estado}`;
        linha.querySelector('.sinal').textContent = { ok: '✓', alerta: '!', falha: '×' }[estado];
        detalhe.textContent = texto;
        tempo.textContent = `${fmtNum(ms)} ms`;
        conta[estado]++;
        relatorio.testes.push({ grupo: g.titulo, nome, estado, detalhe: texto, ms });
        resumo();
      }));
    }
  }
  relatorio.fim = new Date().toISOString();
  relatorio.resumo = conta;
  window.validacao = relatorio;
  document.title = `${conta.falha ? '✗' : '✓'} ${conta.ok}/${conta.total} — Validação da Bússola`;
  $('#rodar').disabled = $('#baixar').disabled = false;
}

$('#rodar').addEventListener('click', rodar);
$('#baixar').addEventListener('click', () =>
  baixarArquivo(`validacao-bussola-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(relatorio, null, 2), 'application/json'));
// A validação confere o sistema como ele funciona: com o banco local respondendo no lugar do servidor.
iniciarBanco().finally(rodar);
