// Portal de acesso: confere usuário e senha e abre a Bússola.
import { carregarUsuarios, conferir, abrirSessao, lerSessao, encerrarSessao } from './acesso.js';
import { registrarAcesso } from './registro.js';

const $ = (s) => document.querySelector(s);
const form = $('#form-acesso');
const msg = $('#mensagem');
const botao = $('#entrar');

// Para onde voltar depois de entrar (só páginas internas deste site).
const pedido = new URLSearchParams(location.search).get('volta') || '';
const destino = /^(sistema|validacao)\.html(#.*)?$/.test(pedido) ? pedido : 'sistema.html';

const mostrarErro = (texto) => { msg.textContent = texto; msg.hidden = !texto; };

const sessao = lerSessao();
if (sessao) {
  form.hidden = true;
  $('#ja-conectado').hidden = false;
  $('#saudacao').textContent = `Olá, ${sessao.nome.split(' ')[0]}`;
  $('#abrir-sistema').href = destino;
}
$('#sair').addEventListener('click', () => {
  encerrarSessao();
  $('#ja-conectado').hidden = true;
  form.hidden = false;
  $('#login').focus();
});

$('#mostrar-senha').addEventListener('click', (e) => {
  const campo = $('#senha');
  const ver = campo.type === 'password';
  campo.type = ver ? 'text' : 'password';
  e.currentTarget.textContent = ver ? 'Ocultar' : 'Mostrar';
  e.currentTarget.setAttribute('aria-pressed', String(ver));
  e.currentTarget.setAttribute('aria-label', ver ? 'Ocultar senha' : 'Mostrar senha');
});

// Depois de 5 erros seguidos, uma pausa curta que cresce a cada novo erro.
let erros = 0;
let liberaEm = 0;
let saindo = false;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const login = $('#login').value.trim();
  const senha = $('#senha').value;
  if (!login || !senha) { mostrarErro('Preencha o usuário e a senha.'); (login ? $('#senha') : $('#login')).focus(); return; }
  const espera = Math.ceil((liberaEm - Date.now()) / 1000);
  if (espera > 0) { mostrarErro(`Muitas tentativas. Aguarde ${espera} segundos e tente de novo.`); return; }

  botao.disabled = true;
  botao.textContent = 'Conferindo…';
  mostrarErro('');
  try {
    const usuario = await conferir(login, senha, await carregarUsuarios());
    if (!usuario) {
      erros += 1;
      if (erros >= 5) liberaEm = Date.now() + Math.min(300, 15 * 2 ** (erros - 5)) * 1000;
      mostrarErro('Usuário ou senha incorretos. Confira e tente de novo.');
      $('#senha').select();
      return;
    }
    const sessaoNova = abrirSessao(usuario, $('#lembrar').checked);
    // Registra o login (no máximo 3 s de espera; se falhar, entra assim mesmo).
    await Promise.race([registrarAcesso(sessaoNova, 'login'), new Promise((ok) => setTimeout(ok, 3000))]);
    try { sessionStorage.setItem('bussola:registrado', '1'); } catch { /* nada */ }
    saindo = true;
    botao.textContent = 'Abrindo a Bússola…';
    location.replace(destino);
  } catch (err) {
    mostrarErro(`Não foi possível conferir o acesso agora (${err.message}). Verifique a conexão e tente de novo.`);
  } finally {
    if (!saindo) { botao.disabled = false; botao.textContent = 'Entrar'; }
  }
});

if (!sessao && !matchMedia('(pointer: coarse)').matches) $('#login').focus();
