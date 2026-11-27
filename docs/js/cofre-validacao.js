// Página de validação: um campo só ("#") para a senha. A mesma senha libera, por 24 horas e para esta conta,
// os dados protegidos (cofre) e a gravação no banco de dados. Sem nenhuma indicação do que a senha faz.
// Senha certa: "Acesso Liberado". Senha errada: só um aviso com "!".
// 5 erros seguidos: bloqueio de 5 minutos; 5 bloqueios: conta suspensa por 24 horas (neste aparelho).
import { iniciarBanco, cofreDisponivel, cofreAberto, abrirCofre } from './banco.js';
import { gravacaoDisponivel, gravacaoAberta, abrirGravacao, restaurarGravacao, gravacaoUnificada, unificarComCofre } from './gravacao.js';
import { el } from './util.js';

const corpo = document.querySelector('#senha-corpo');
const alerta = document.querySelector('#senha-alerta');
const chaveT = () => `bussola:tentativas:${window.bussolaSessao?.login || 'anonimo'}`;
const lerT = () => { try { return JSON.parse(localStorage.getItem(chaveT()) || '{}'); } catch { return {}; } };
const gravarT = (t) => { try { localStorage.setItem(chaveT(), JSON.stringify(t)); } catch { /* */ } };
let senhaDoCofre = null, senhaProvisoria = null; // só na memória desta página, para unificar as senhas

function exclamar() {
  alerta.hidden = false;
  clearTimeout(exclamar.t);
  exclamar.t = setTimeout(() => { alerta.hidden = true; }, 1800);
}

async function tentar(senha) {
  const t = lerT(), agora = Date.now();
  if ((t.suspensoAte || 0) > agora || (t.bloqueadoAte || 0) > agora) { exclamar(); return false; }
  let ok = false;
  try { if (cofreDisponivel()) { await abrirCofre(senha); ok = true; senhaDoCofre = senha; } } catch { /* */ }
  try { if (await gravacaoDisponivel()) { await abrirGravacao(senha); ok = true; if (!(await gravacaoUnificada())) senhaProvisoria = senha; } } catch { /* */ }
  // Unificação: a gravação passa a abrir com a senha do cofre (uma vez, sem nada a fazer além de digitar as duas).
  if (senhaDoCofre && senhaProvisoria && senhaDoCofre !== senhaProvisoria && !(await gravacaoUnificada())) {
    try { await unificarComCofre(senhaDoCofre, senhaProvisoria, async (x) => { await abrirCofre(x); }); senhaProvisoria = null; } catch { /* */ }
  }
  if (ok) { gravarT({}); return true; }
  t.erros = (t.erros || 0) + 1;
  if (t.erros >= 5) {
    t.erros = 0; t.bloqueios = (t.bloqueios || 0) + 1; t.bloqueadoAte = agora + 5 * 60e3;
    if (t.bloqueios >= 5) { t.bloqueios = 0; t.suspensoAte = agora + 24 * 3600e3; }
  }
  gravarT(t);
  exclamar();
  return false;
}

function montar(liberado = false) {
  corpo.textContent = '';
  const msg = el('p', { class: 'nota' }, liberado || cofreAberto() || gravacaoAberta() ? 'Acesso Liberado' : '');
  const campo = el('input', { type: 'password', class: 'campo', autocomplete: 'off', 'aria-label': '#' });
  const enviar = async () => {
    const s = campo.value;
    campo.value = '';
    if (!s) return;
    if (await tentar(s)) {
      // A mesma senha serve de chave de leitura dos logs (um campo só na página).
      try { sessionStorage.setItem('bussola:chave-logs', s); } catch { /* */ }
      const lc = document.querySelector('#logs-chave'); if (lc) lc.value = s;
      montar(true);
    }
  };
  campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });
  corpo.append(msg, el('div', { class: 'linha-botoes' }, campo, el('button', { class: 'botao', onclick: enviar }, 'Enviar')));
}

iniciarBanco().catch(() => {}).then(() => restaurarGravacao()).finally(() => montar());
