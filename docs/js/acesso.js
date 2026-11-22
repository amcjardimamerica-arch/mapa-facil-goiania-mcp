// Acesso à Bússola: conferência de usuário e senha e sessão no aparelho.
//
// As senhas nunca ficam gravadas: o arquivo acesso/usuarios.json guarda só o
// resumo PBKDF2-SHA256 (sal próprio por usuário, 310 mil iterações). A conferência
// é feita no navegador, com a Web Crypto API.

export const CHAVE_SESSAO = 'bussola:sessao';
export const ARQUIVO_USUARIOS = 'acesso/usuarios.json';
const HORAS_SESSAO = 12;
const DIAS_LEMBRAR = 30;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const deHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
export const normalizarLogin = (s) => String(s || '').trim().toLowerCase();

/** Resumo PBKDF2-SHA256 da senha, em hexadecimal. */
export async function resumoSenha(senha, salHex, iteracoes) {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: deHex(salHex), iterations: iteracoes }, chave, 256);
  return hex(bits);
}

/** Comparação em tempo constante (não revela onde os textos diferem). */
function iguais(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function carregarUsuarios(base = '') {
  const r = await fetch(`${base}${ARQUIVO_USUARIOS}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`lista de usuários indisponível (HTTP ${r.status})`);
  return (await r.json()).usuarios || [];
}

/** Confere usuário e senha. Devolve o usuário (sem o resumo) ou null. */
export async function conferir(login, senha, usuarios) {
  const alvo = usuarios.find((u) => u.login === normalizarLogin(login) && u.ativo !== false);
  // Mesmo sem usuário, calcula um resumo: o tempo de resposta não denuncia quem existe.
  const ref = alvo || { sal: '00'.repeat(16), iteracoes: 310000, resumo: '' };
  const calculado = await resumoSenha(String(senha || ''), ref.sal, ref.iteracoes);
  if (!alvo || !iguais(calculado, alvo.resumo)) return null;
  return { login: alvo.login, nome: alvo.nome, perfil: alvo.perfil || 'membro', marca: alvo.resumo.slice(0, 12) };
}

export function abrirSessao(usuario, lembrar) {
  const sessao = { ...usuario, inicio: Date.now(),
    expira: Date.now() + (lembrar ? DIAS_LEMBRAR * 864e5 : HORAS_SESSAO * 36e5), lembrar: !!lembrar };
  const texto = JSON.stringify(sessao);
  try {
    (lembrar ? localStorage : sessionStorage).setItem(CHAVE_SESSAO, texto);
    (lembrar ? sessionStorage : localStorage).removeItem(CHAVE_SESSAO);
  } catch { /* navegador sem armazenamento: a sessão vale só nesta página */ }
  return sessao;
}

export function lerSessao() {
  try {
    const s = JSON.parse(sessionStorage.getItem(CHAVE_SESSAO) || localStorage.getItem(CHAVE_SESSAO) || 'null');
    return s && s.login && s.expira > Date.now() ? s : null;
  } catch { return null; }
}

export function encerrarSessao() {
  try { sessionStorage.removeItem(CHAVE_SESSAO); localStorage.removeItem(CHAVE_SESSAO); } catch { /* nada */ }
}

/** Confirma, depois de aberto o sistema, que o usuário ainda existe e não trocou de senha. */
export async function sessaoAindaValida(sessao, base = '') {
  try {
    const u = (await carregarUsuarios(base)).find((x) => x.login === sessao.login);
    return !!u && u.ativo !== false && u.resumo.startsWith(sessao.marca);
  } catch { return true; } // sem rede, não derruba quem já entrou
}
