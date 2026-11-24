// Página de validação: liberar os dados complementares (cofre) para esta conta, por 24 horas.
import { iniciarBanco, cofreDisponivel, cofreAberto, abrirCofre, fecharCofre, cofreLiberadoAte } from './banco.js';
import { el } from './util.js';

const corpo = document.querySelector('#cofre-corpo');

function montar() {
  corpo.textContent = '';
  if (!cofreDisponivel()) { corpo.append(el('p', { class: 'nota' }, 'Este banco não tem dados complementares cifrados.')); return; }
  if (cofreAberto()) {
    const ate = cofreLiberadoAte();
    corpo.append(el('p', { class: 'nota' }, `🔓 Liberados para esta conta${ate ? ` até ${ate.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}: proprietário, CPF/CNPJ e demais dados aparecem nas fichas e na busca do mapa.`),
      el('div', { class: 'linha-botoes' }, el('a', { class: 'botao', href: 'sistema.html' }, 'Voltar ao mapa'),
        el('button', { class: 'botao-texto', onclick: () => { fecharCofre(); montar(); } }, 'Bloquear agora')));
    return;
  }
  const campo = el('input', { type: 'password', class: 'campo', placeholder: 'Senha dos dados complementares', autocomplete: 'off', 'aria-label': 'Senha dos dados complementares' });
  const msg = el('p', { class: 'nota' }, '🔒 Bloqueados. A senha libera, para esta conta e por 24 horas, os dados complementares em todo o mapa.');
  const liberar = async () => {
    try { await abrirCofre(campo.value); campo.value = ''; montar(); }
    catch (e) { msg.textContent = `🔒 ${e.message}`; msg.classList.add('erro'); }
  };
  campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') liberar(); });
  corpo.append(msg, el('div', { class: 'linha-botoes' }, campo, el('button', { class: 'botao', onclick: liberar }, 'Liberar por 24 horas')));
}

corpo.append(el('p', { class: 'nota' }, 'Carregando…'));
iniciarBanco().catch(() => {}).finally(montar);
