// Ficha do lote (1.28): a mesma para todos os lotes de Goiânia — clique comum e painel Associação.
//
// Ordem pedida pelo titular:
//   1. título "Rua, nº · Quadra · Lote" e, abaixo, "Bairro · Goiânia · CEP";
//   2. botões Copiar (endereço completo) e Street View;
//   3. caixa de texto do lote (moradores, comerciantes, contatos) — com o cofre aberto, editável;
//   4. tipo do imóvel e edição do lote;
//   5. proprietário (cofre) — com o cofre aberto, nome, documentos e telefone editáveis;
//   6. "Cadastro imobiliário e dados complementares" — lote, quadra, bairro, cadastro e levantamento num só
//      quadro (o cadastro imobiliário é a fonte principal; as demais só completam o que ele não traz);
//   7. no fim, latitude, longitude e altitude do terreno.
// O que a pessoa escreve ou corrige fica guardado neste aparelho (por inscrição do lote) — o site é estático.
import { el, fmtNum, fmtGraus, aviso, nomeBairro } from './util.js';
import { cofreDisponivel, cofreAberto, consultarOuServidor } from './banco.js';

export const TIPOS_IMOVEL = ['Imóvel residencial', 'Imóvel comercial', 'Misto (residencial e comercial)', 'Igreja', 'Imóvel público',
  'Praça', 'Escola', 'Condomínio', 'Lote vago', 'Abandonado', 'Em obra', 'Outro'];

const t = (v) => String(v ?? '').trim();
const vazio = (v) => v === null || v === undefined || t(v) === '';
const cep = (c) => { const d = t(c).replace(/\D/g, ''); return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : t(c); };
const guardado = (chave, padrao) => { try { const v = localStorage.getItem(chave); return v === null ? padrao : JSON.parse(v); } catch { return padrao; } };
const guardar = (chave, valor) => { try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* sem armazenamento */ } };
const simNao = (v) => (t(v) === '' ? '' : ['1', 'S', 'SIM', 'TRUE'].includes(t(v).toUpperCase()) ? 'Sim' : 'Não');

function dentro(aneis, x, y) {
  let d = false;
  for (const a of aneis) for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    if ((a[i][1] > y) !== (a[j][1] > y) && x < ((a[j][0] - a[i][0]) * (y - a[i][1])) / (a[j][1] - a[i][1]) + a[i][0]) d = !d;
  }
  return d;
}

/**
 * Abre a ficha do lote.
 * lote: { attributes (camada Divisas de Lote: ci, nm_lot, in_cart, in_vist, in_cond, nm_cond, id), geometry (Web Mercator) }
 * quadra: atributos da quadra (nm_qdr) ou null; bairro: nome; ponto: { lon, lat, alt };
 * extra: dados da Associação para este lote { colunas, valores, empresas: [{...}] } (só nos bairros com levantamento).
 */
export async function fichaLote(ident, { lote, quadra, bairro, ponto, extra = null, aoEditarPoligono = null }) {
  const n = ++ident.pedido;
  const a = lote?.attributes || {};
  const ci = t(a.ci);
  const nq = t(quadra?.nm_qdr || extra?.quadra), nl = t(a.nm_lot || extra?.lote);
  const nb = nomeBairro(t(bairro)) || '';
  ident.caixa.hidden = false;
  const titulo0 = [nq && `Quadra ${nq}`, nl && `Lote ${nl}`].filter(Boolean).join(' · ') || 'Lote em Goiânia';
  ident.titulo(titulo0, [nb, 'Goiânia'].filter(Boolean).join(' · '));
  ident.corpo.textContent = '';
  const carregando = el('p', { class: 'nota carregando' }, 'Reunindo os dados do lote…');
  ident.corpo.append(carregando);

  // --- dados: cadastro imobiliário (principal), tributário (rua, nº, CEP; proprietário com o cofre) e atividades
  const cons = (S, c, p) => consultarOuServidor(S, c, { f: 'json', returnGeometry: 'false', ...p }).then((r) => r.features || []).catch(() => []);
  const ext = lote?.geometry?.rings ? lote.geometry.rings.flat().reduce((e, [x, y]) => [Math.min(e[0], x), Math.min(e[1], y), Math.max(e[2], x), Math.max(e[3], y)], [Infinity, Infinity, -Infinity, -Infinity]) : null;
  const [unidades, tributario, atividades, loteBase] = await Promise.all([
    /^\d{6,}$/.test(ci) ? cons('Feature_Base', 3, { where: `ci = '${ci}'`, orderByFields: 'nrinscr',
      outFields: 'nrinscr,tplogradou,nmlogradou,nrimovel,incompl,nrquadra,nrlote,nmbairro,areaterr,areaedif,areattedif,nrpaviment,nmedificio,vlvenal,nrfrenter,uso' }) : [],
    // Cadastro tributário: unidades do lote (pela inscrição do lote, dentro da área do lote)
    ext || ponto ? cons('Mapa_Tributario_Web', 0, {
      geometry: ext ? [ext[0] - 15, ext[1] - 15, ext[2] + 15, ext[3] + 15].join(',') : `${ponto.lon - 0.0003},${ponto.lat - 0.0003},${ponto.lon + 0.0003},${ponto.lat + 0.0003}`,
      geometryType: 'esriGeometryEnvelope', inSR: ext ? '3857' : '4326', spatialRel: 'esriSpatialRelIntersects', outFields: '*',
      where: /^\d{6,}$/.test(ci) ? `INSC_LOTES = '${ci}'` : '1=1' }) : [],
    ext ? cons('Feature_Base', 9, { geometry: ext.join(','), geometryType: 'esriGeometryEnvelope', inSR: '3857', outSR: '3857', returnGeometry: 'true',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'NM_SOCIAL,NM_FANT,NM_ATIV1,NM_LOG,END_COMP,NR_INSCR' }) : [],
    // Lote aberto pela Associação: cartório, vistoria e condomínio vêm da camada de lotes da Base Cadastral
    !('in_cart' in a) && /^\d{6,}$/.test(ci) ? cons('Feature_Base', 0, { where: `ci = '${ci}'`, outFields: 'id,in_cart,in_vist,in_cond,nm_cond' }) : [],
  ]);
  if (loteBase[0]) Object.assign(a, { ...loteBase[0].attributes, ...a });
  if (n !== ident.pedido) return;
  carregando.remove();
  const us = unidades.map((f) => f.attributes);
  const trib = tributario.map((f) => f.attributes);
  const ativ = atividades.filter((f) => !lote?.geometry?.rings || (f.geometry && dentro(lote.geometry.rings, f.geometry.x, f.geometry.y))).map((f) => f.attributes);
  const u0 = us[0] || {}, t0 = trib[0] || {};

  // --- endereço: rua e número do cadastro imobiliário; CEP do cadastro tributário
  const ruaCad = (t(u0.nmlogradou).toUpperCase().startsWith(`${t(u0.tplogradou).toUpperCase()} `) ? t(u0.nmlogradou)
    : [t(u0.tplogradou), t(u0.nmlogradou)].filter(Boolean).join(' '));
  const ruaTrib = t(t0.LOGRADOURO).replace(/\s+N\.\s*.*$/i, '').replace(/\s+QD\..*$/i, '');
  const rua = ruaCad || ruaTrib || t(extra?.endereco);
  const numero = t(u0.nrimovel) || t(t0.NUMR_CORRE);
  const ruaNum = [rua.replace(/\s+/g, ' '), numero && numero !== '0' ? numero : ''].filter(Boolean).join(', ');
  const CEP = cep(t0.CEP);
  ident.titulo([ruaNum, nq && `Quadra ${nq}`, nl && `Lote ${nl}`].filter(Boolean).join(' · ') || titulo0,
    [nb || nomeBairro(t(u0.nmbairro)), 'Goiânia', CEP && `CEP ${CEP}`].filter(Boolean).join(' · '));
  const enderecoCompleto = [ruaNum, nq && `Quadra ${nq}`, nl && `Lote ${nl}`, nb, 'Goiânia - GO', CEP && `CEP ${CEP}`].filter(Boolean).join(', ');

  // 2. Copiar e Street View
  ident.corpo.append(el('div', { class: 'linha-botoes acoes-lote' },
    el('button', { class: 'botao-texto', onclick: () => navigator.clipboard?.writeText(enderecoCompleto)
      .then(() => aviso('Endereço copiado.'), () => aviso('Não foi possível copiar.', 'alerta')) }, 'Copiar'),
    ponto ? el('a', { class: 'botao-texto', target: '_blank', rel: 'noopener',
      href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ponto.lat},${ponto.lon}` }, 'Street View') : null));

  const chaveLote = ci || `${nb}-${nq}-${nl}`;
  const liberado = !cofreDisponivel() || cofreAberto();
  const fechado = (texto) => el('p', { class: 'nota cadeado' }, `🔒 ${texto} Libere os dados complementares na página de validação (senha do cofre).`);

  // 3. Caixa de texto do lote: moradores, inquilinos, comerciantes e contatos
  const s3 = ident.secao('Moradores, comerciantes e contatos', { aberto: true });
  if (!liberado) s3.append(fechado('Dados protegidos.'));
  else {
    const linhas = [];
    const col = (nome) => (extra?.colunas ? extra.valores[extra.colunas.indexOf(nome)] : null);
    for (const nome of ['Nomes no levantamento', 'Contatos do levantamento', 'Telefones do levantamento', 'Empresas (nome)']) {
      if (!vazio(col(nome))) linhas.push(`${nome.replace(' do levantamento', '').replace(' no levantamento', '')}: ${t(col(nome))}`);
    }
    for (const e of extra?.empresas || []) {
      linhas.push(['Empresa', e['Nome fantasia'] || e['Razão social'], e['Razão social'] && e['Nome fantasia'] ? `(${e['Razão social']})` : '',
        e.CNPJ && `CNPJ ${e.CNPJ}`, e.Telefone && `tel. ${e.Telefone}`, e['E-mail']].filter(Boolean).join(' · '));
    }
    for (const x of ativ) {
      linhas.push(['Atividade econômica', t(x.NM_FANT) || t(x.NM_SOCIAL), t(x.NM_FANT) && t(x.NM_SOCIAL) ? `(${t(x.NM_SOCIAL)})` : '', t(x.NM_ATIV1), t(x.END_COMP)].filter(Boolean).join(' · '));
    }
    const chave = `bussola:lote-texto:${chaveLote}`;
    const area = el('textarea', { class: 'campo area caixa-lote', rows: Math.max(5, Math.min(14, linhas.length + 3)), 'aria-label': 'Moradores, comerciantes e contatos do lote',
      placeholder: 'Morador, inquilino ou ocupante, comerciante, telefones, e-mails, observações…' }, guardado(chave, null) ?? [...new Set(linhas)].join('\n'));
    area.addEventListener('change', () => { guardar(chave, area.value); aviso('Dados do lote guardados neste aparelho.'); });
    s3.append(area, el('p', { class: 'nota' }, 'Use para quem ocupa o imóvel e não é o proprietário (inquilino, morador, comércio). Fica guardado neste aparelho.'));
  }

  // 4. Tipo do imóvel e edição do lote
  const s4 = ident.secao('Tipo do imóvel e edição do lote', { aberto: true });
  const chaveTipo = `bussola:lote-tipo:${chaveLote}`;
  const tipoAtual = guardado(chaveTipo, '');
  const sel = el('select', { class: 'campo', 'aria-label': 'Tipo do imóvel', onchange: (e) => { guardar(chaveTipo, e.target.value); aviso('Tipo do imóvel guardado neste aparelho.'); } },
    el('option', { value: '' }, '— escolha o tipo do imóvel —'), ...TIPOS_IMOVEL.map((x) => el('option', { value: x, selected: x === tipoAtual }, x)));
  s4.append(el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Tipo do imóvel'), sel));
  if (aoEditarPoligono) s4.append(el('button', { class: 'botao destaque', onclick: aoEditarPoligono }, 'Editar como polígono'));

  // 5. Proprietário (cadastro tributário, no cofre)
  const s5 = ident.secao('Proprietário', { aberto: true });
  if (!cofreDisponivel()) s5.append(el('p', { class: 'nota' }, 'Este banco não tem os dados do proprietário.'));
  else if (!cofreAberto()) s5.append(fechado('Nome, CPF/CNPJ, RG e telefone do proprietário estão cifrados.'));
  else if (!trib.length) s5.append(el('p', { class: 'nota' }, 'Sem registro no cadastro tributário para este ponto.'));
  else {
    const chaveP = `bussola:lote-prop:${chaveLote}`;
    const ajustes = guardado(chaveP, {});
    const campos = [['PROPRIETAR', 'Nome do proprietário'], ['CPF_CNPJ', 'CPF/CNPJ'], ['RG', 'RG'], ['TELEFONE', 'Telefone'], ['DT_NASCIME', 'Data de nascimento'], ['ESTADO_CIV', 'Estado civil']];
    trib.slice(0, 20).forEach((p, i) => {
      const bloco = el('div', { class: 'proprietario' }, trib.length > 1 ? el('h4', { class: 'subtitulo' }, `Inscrição ${t(p.INSCRICAO) || i + 1}${t(p.COMPLEMENT) ? ` · ${t(p.COMPLEMENT)}` : ''}`) : null);
      for (const [c, rotulo] of campos) {
        const k = `${i}:${c}`;
        const inp = el('input', { class: 'campo', value: ajustes[k] ?? t(p[c]), 'aria-label': rotulo,
          onchange: (e) => { ajustes[k] = e.target.value; guardar(chaveP, ajustes); aviso('Dados do proprietário guardados neste aparelho.'); } });
        bloco.append(el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, rotulo), inp));
      }
      s5.append(bloco);
    });
  }

  // 6. Cadastro imobiliário e dados complementares (lote, quadra, bairro, cadastro e levantamento unificados)
  const s6 = ident.secao('Cadastro imobiliário e dados complementares', { aberto: true });
  const linhas = [];
  const por = new Set();
  const add = (rotulo, valor) => { if (vazio(valor) || por.has(rotulo)) return; por.add(rotulo); linhas.push([rotulo, String(valor)]); };
  add('Inscrição cadastral (CI)', ci);
  add('Endereço', ruaNum);
  add('Quadra', nq || t(u0.nrquadra));
  add('Lote', nl || t(u0.nrlote));
  add('Bairro', nb || nomeBairro(t(u0.nmbairro)));
  add('CEP', CEP);
  add('Edifício / condomínio', t(u0.nmedificio) || t(a.nm_cond));
  add('Cartório', t(a.in_cart));
  add('Vistoriado', simNao(a.in_vist));
  add('Condomínio horizontal', simNao(a.in_cond));
  add('Inscrições no lote', us.length ? fmtNum(us.length) : '');
  add('Área do terreno', u0.areaterr ? `${fmtNum(u0.areaterr, 2)} m²` : '');
  add('Área total edificada', u0.areattedif ? `${fmtNum(u0.areattedif, 2)} m²` : '');
  add('Pavimentos', u0.nrpaviment || '');
  add('Testada (frente)', u0.nrfrenter ? `${fmtNum(u0.nrfrenter, 2)} m` : '');
  add('Loteamento', [t(t0.LOTEAMENTO), t(t0.QD_LOTEAME) && `Qd. ${t(t0.QD_LOTEAME)}`, t(t0.LT_LOTEAME) && `Lt. ${t(t0.LT_LOTEAME)}`].filter(Boolean).join(' · '));
  // Levantamento da Associação: só o que o cadastro não traz (contatos ficam na caixa de texto, acima)
  if (extra?.colunas) {
    const fora = new Set(['Bairro', 'Quadra', 'Lote', 'Inscrição do lote (CI)', 'Endereço (cadastro)', 'Nomes no levantamento', 'Contatos do levantamento',
      'Telefones do levantamento', 'Empresas (nome)', 'Alvarás municipais', 'Local de votação mais próximo (2026)', 'Distância ao local (m)',
      'Conselho Tutelar 2023 — situação do local', 'Conselho Tutelar — onde votou', 'ID do lote (Mapa Fácil)', 'Código para manutenção',
      'Unidades no cadastro', 'Pavimentos', 'Edifício / condomínio', 'Área do terreno (m²)', 'Área edificada total (m²)']);
    extra.colunas.forEach((c, k) => { if (!fora.has(c)) add(c, typeof extra.valores[k] === 'number' ? fmtNum(extra.valores[k]) : extra.valores[k]); });
  }
  s6.append(ident.tabela(linhas));
  if (us.length) {
    s6.append(el('h4', { class: 'subtitulo' }, `Inscrições (${us.length})`), ...us.slice(0, 200).map((u) => el('dl', { class: 'atributos unidade-vertical' },
      el('dt', {}, 'Inscrição'), el('dd', {}, t(u.nrinscr)),
      el('dt', {}, 'Complemento'), el('dd', {}, t(u.incompl) || '—'),
      el('dt', {}, 'Área edificada'), el('dd', {}, u.areaedif ? `${fmtNum(u.areaedif, 2)} m²` : '—'),
      el('dt', {}, 'Valor venal'), el('dd', {}, u.vlvenal ? `R$ ${fmtNum(u.vlvenal, 2)}` : '—'))));
  }
  if (a.id) ident._anexos(t(a.id), s6);

  // 7. No fim: latitude, longitude e altitude do terreno
  if (ponto) {
    const exagero = ident.globo.cena.verticalExaggeration || 1;
    const alt = ident.globo.relevoAtivo && Number.isFinite(ponto.alt) ? `${fmtNum(ponto.alt / exagero)} m` : '—';
    ident.corpo.append(el('div', { class: 'coordenadas fim' },
      el('div', {}, el('small', {}, 'Latitude, longitude'), el('span', {}, fmtGraus(ponto.lat, ponto.lon))),
      el('div', {}, el('small', {}, 'Altitude do terreno'), el('span', {}, alt))));
  }
}
