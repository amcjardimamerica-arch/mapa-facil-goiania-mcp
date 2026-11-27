// Página de validação: liberar os dados complementares (cofre) para esta conta, por 24 horas.
import { iniciarBanco, cofreDisponivel, cofreAberto, abrirCofre, fecharCofre, cofreLiberadoAte } from './banco.js';
import { gravacaoDisponivel, gravacaoAberta, gravacaoAte, abrirGravacao, fecharGravacao, restaurarGravacao, trocarSenhaGravacao, gravacaoUnificada, unificarComCofre } from './gravacao.js';
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
    try {
      const senha = campo.value;
      await abrirCofre(senha);
      if (await gravacaoDisponivel()) await abrirGravacao(senha).catch(() => {}); // senha única: abre os dois
      campo.value = ''; montar(); montarGravacao();
    }
    catch (e) { msg.textContent = `🔒 ${e.message}`; msg.classList.add('erro'); }
  };
  campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') liberar(); });
  corpo.append(msg, el('div', { class: 'linha-botoes' }, campo, el('button', { class: 'botao', onclick: liberar }, 'Liberar por 24 horas')));
}

corpo.append(el('p', { class: 'nota' }, 'Carregando…'));
iniciarBanco().catch(() => {}).finally(montar);


// ------------------------------------------------------------------ banco de dados gravável (gravacao.js)

const caixaG = document.querySelector('#gravacao-corpo');
async function montarGravacao() {
  if (!caixaG) return;
  caixaG.textContent = '';
  if (!(await gravacaoDisponivel())) { caixaG.append(el('p', { class: 'nota' }, 'Banco de dados gravável não configurado.')); return; }
  const msg = el('p', { class: 'nota' });
  if (gravacaoAberta()) {
    const ate = gravacaoAte();
    msg.textContent = `🔓 Gravação liberada para esta conta${ate ? ` até ${ate.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}: pedidos de manutenção, dados dos lotes e divisas editadas são gravados no banco de dados da Associação e aparecem em todos os computadores.`;
    const atual = el('input', { type: 'password', class: 'campo', placeholder: 'Senha de gravação atual', autocomplete: 'off' });
    const nova = el('input', { type: 'password', class: 'campo', placeholder: 'Senha nova (12 caracteres ou mais)', autocomplete: 'new-password' });
    const aviso2 = el('p', { class: 'nota' });
    const trocar = async () => {
      aviso2.textContent = 'Trocando a senha…';
      try { await trocarSenhaGravacao(atual.value, nova.value); aviso2.textContent = 'Senha trocada. Em 1 a 2 minutos ela vale em todos os computadores.'; atual.value = nova.value = ''; }
      catch (e) { aviso2.textContent = `Não trocou: ${e.message}`; aviso2.classList.add('erro'); }
    };
    caixaG.append(msg, el('div', { class: 'linha-botoes' }, el('a', { class: 'botao', href: 'sistema.html' }, 'Voltar ao mapa'),
      el('button', { class: 'botao-texto', onclick: () => { fecharGravacao(); montarGravacao(); } }, 'Fechar a gravação agora')),
    el('details', {}, el('summary', {}, 'Trocar a senha de gravação (só se não for usar a do cofre)'), el('div', { class: 'linha-botoes' }, atual, nova, el('button', { class: 'botao', onclick: trocar }, 'Trocar')), aviso2));
    return;
  }
  if (!(await gravacaoUnificada())) {
    // Uma única vez: a gravação passa a usar a mesma senha do cofre.
    msg.textContent = '🔒 Gravação fechada. Para usar uma senha só (a do cofre) também na gravação, faça uma única vez: digite a senha do cofre e a senha provisória de gravação recebida na implantação.';
    const sc = el('input', { type: 'password', class: 'campo', placeholder: 'Senha do cofre', autocomplete: 'off', 'aria-label': 'Senha do cofre' });
    const sp = el('input', { type: 'password', class: 'campo', placeholder: 'Senha provisória de gravação', autocomplete: 'off', 'aria-label': 'Senha provisória de gravação' });
    const unificar = async () => {
      msg.textContent = 'Unificando as senhas…';
      try {
        await unificarComCofre(sc.value, sp.value, async (x) => { await abrirCofre(x); });
        sc.value = sp.value = '';
        msg.textContent = 'Pronto: a senha do cofre agora libera também a gravação (vale em todos os computadores em 1 a 2 minutos).';
        montar(); setTimeout(montarGravacao, 1500);
      } catch (e) { msg.textContent = `🔒 Não unificou: ${e.message}`; msg.classList.add('erro'); }
    };
    caixaG.append(msg, el('div', { class: 'linha-botoes' }, sc, sp, el('button', { class: 'botao', onclick: unificar }, 'Usar a senha do cofre também na gravação')));
    return;
  }
  msg.textContent = '🔒 Gravação fechada: a mesma senha do cofre libera, por 24 horas, salvar no banco de dados da Associação.';
  const campo = el('input', { type: 'password', class: 'campo', placeholder: 'Senha do cofre', autocomplete: 'off', 'aria-label': 'Senha do cofre (libera a gravação)' });
  const liberar = async () => { try { await abrirGravacao(campo.value); campo.value = ''; montarGravacao(); } catch (e) { msg.textContent = `🔒 ${e.message}`; msg.classList.add('erro'); } };
  campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') liberar(); });
  caixaG.append(msg, el('div', { class: 'linha-botoes' }, campo, el('button', { class: 'botao', onclick: liberar }, 'Liberar a gravação por 24 horas')));
}
restaurarGravacao().finally(montarGravacao);
