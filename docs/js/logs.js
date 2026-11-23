// Página de validação: tabela dos logs de acesso (lidos da Planilha Google pelo Apps Script).
import { CFG } from './config.js';
import { lerAcessos } from './registro.js';

const $ = (s) => document.querySelector(s);
// A seção fica fechada; abre pelo botão "Logs de acesso" do topo ou pelo endereço validacao.html#logs.
const secao = $('#logs'), botaoLogs = $('#abrir-logs');
const mostrar = (abre) => { secao.hidden = !abre; botaoLogs?.setAttribute('aria-pressed', String(abre)); if (abre) secao.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
botaoLogs?.addEventListener('click', () => mostrar(secao.hidden));
if (location.hash === '#logs') mostrar(true);
const estado = $('#logs-estado'), tabela = $('#logs-tabela'), corpo = tabela.querySelector('tbody');
const txt = (v) => (v === undefined || v === null ? '' : String(v));

function linha(a) {
  const tr = document.createElement('tr');
  const quando = new Date(a.data_hora);
  const data = Number.isNaN(+quando) ? txt(a.data_hora) : quando.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
  const gps = a.lat_gps ? `GPS ${txt(a.lat_gps)}, ${txt(a.lon_gps)} (±${txt(a.precisao_gps_m)} m)` : '';
  const mapa = a.lat_gps || a.lat_ip ? `https://www.google.com/maps/search/?api=1&query=${a.lat_gps || a.lat_ip},${a.lon_gps || a.lon_ip}` : '';
  const celulas = [
    [data],
    [txt(a.nome) || txt(a.usuario), txt(a.usuario)],
    [txt(a.evento) === 'login' ? 'Login' : 'Abertura', txt(a.pagina)],
    [[a.cidade, a.estado, a.pais].filter(Boolean).join(' · ') || '—', gps, mapa],
    [[a.tipo, a.modelo].filter(Boolean).join(' · '), [a.sistema, a.navegador].filter(Boolean).join(' · '), txt(a.tela)],
    [txt(a.ip), txt(a.provedor)],
  ];
  for (const [principal, ...extras] of celulas) {
    const td = document.createElement('td');
    td.append(document.createTextNode(principal || ''));
    for (const x of extras) {
      if (!x) continue;
      const s = document.createElement('small');
      if (/^https:/.test(x)) { const l = document.createElement('a'); l.href = x; l.target = '_blank'; l.rel = 'noopener'; l.textContent = 'ver no mapa'; s.append(l); }
      else s.textContent = x;
      td.append(s);
    }
    tr.append(td);
  }
  return tr;
}

async function ver() {
  const chave = $('#logs-chave').value.trim();
  if (!chave) { estado.textContent = 'Digite a chave de leitura dos logs.'; return; }
  estado.textContent = 'Carregando os logs…';
  try {
    const acessos = await lerAcessos(chave);
    corpo.textContent = '';
    acessos.forEach((a) => corpo.append(linha(a)));
    tabela.hidden = !acessos.length;
    estado.textContent = acessos.length ? `${acessos.length} acessos, do mais recente para o mais antigo.` : 'Nenhum acesso registrado ainda.';
    try { sessionStorage.setItem('bussola:chave-logs', chave); } catch { /* nada */ }
  } catch (e) { estado.textContent = `Não foi possível ler os logs: ${e.message}.`; tabela.hidden = true; }
}

if (!CFG.registro?.url) {
  estado.textContent = 'O registro de acessos ainda não está ligado: falta publicar o Apps Script da Planilha Google da Associação e colocar o endereço dele no sistema (CFG.registro.url).';
  $('#logs-ver').disabled = true; $('#logs-chave').disabled = true;
} else {
  $('#logs-ver').addEventListener('click', ver);
  $('#logs-chave').addEventListener('keydown', (e) => { if (e.key === 'Enter') ver(); });
  try { const c = sessionStorage.getItem('bussola:chave-logs'); if (c) { $('#logs-chave').value = c; ver(); } } catch { /* nada */ }
}
