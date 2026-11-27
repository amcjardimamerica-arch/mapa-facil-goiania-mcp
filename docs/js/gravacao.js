// Banco de dados gravável da Bússola (1.29).
//
// O site (GitHub Pages) só entrega arquivos; para gravar, o sistema usa o próprio GitHub como banco: um
// repositório PRIVADO (Bussola-dados) guarda, em arquivos JSON, os pedidos de manutenção e os dados cadastrais
// que a Associação escreve em cada lote. Cada gravação é um registro (commit) com data, hora e usuário — nada se
// perde e tudo pode ser desfeito.
//
// Segurança, no mesmo molde do cofre: a chave de acesso ao GitHub fica em acesso/gravacao.json CIFRADA
// (AES-256-GCM; chave derivada da senha por PBKDF2-SHA256, 600 mil iterações). Só quem digita a senha de
// gravação consegue abri-la, no próprio navegador; a senha não é guardada. A liberação vale 24 horas por conta.
const API = 'https://api.github.com';
const estado = { cfg: null, token: null, shas: new Map(), ouvintes: new Set() };
const b64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
const paraB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const textoB64 = (t) => paraB64(new TextEncoder().encode(t));
const deB64Texto = (t) => new TextDecoder().decode(b64(t.replace(/\s/g, '')));
const chaveLocal = () => `bussola:gravacao:${window.bussolaSessao?.login || 'anonimo'}`;
const usuario = () => window.bussolaSessao?.login || 'anonimo';

async function config() {
  if (!estado.cfg) estado.cfg = await (await fetch(new URL('acesso/gravacao.json', document.baseURI), { cache: 'no-cache' })).json();
  return estado.cfg;
}

async function derivar(senha, sal, iteracoes) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteracoes }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function decifrar(chave, cfg) {
  const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(cfg.iv) }, chave, b64(cfg.cifra));
  const d = JSON.parse(new TextDecoder().decode(claro));
  if (d.teste !== 'bussola-gravacao' || !d.token) throw new Error('arquivo de gravação inválido');
  return d.token;
}

export const gravacaoDisponivel = async () => { try { return !!(await config()).cifra; } catch { return false; } };
export const gravacaoAberta = () => !!estado.token;
export function gravacaoAte() {
  try { const g = JSON.parse(localStorage.getItem(chaveLocal()) || 'null'); return g && g.ate > Date.now() ? new Date(g.ate) : null; } catch { return null; }
}
export function aoMudarGravacao(fn) { estado.ouvintes.add(fn); }
const avisar = () => { for (const fn of estado.ouvintes) { try { fn(gravacaoAberta()); } catch { /* ouvinte */ } } };

/** Abre a gravação com a senha (vale 24 horas para esta conta, neste aparelho). */
export async function abrirGravacao(senha) {
  const cfg = await config();
  let chave;
  try { chave = await derivar(senha, b64(cfg.sal), cfg.iteracoes); estado.token = await decifrar(chave, cfg); }
  catch { estado.token = null; throw new Error('senha de gravação incorreta'); }
  try { localStorage.setItem(chaveLocal(), JSON.stringify({ k: paraB64(new Uint8Array(await crypto.subtle.exportKey('raw', chave))), ate: Date.now() + 24 * 3600e3 })); } catch { /* sem armazenamento */ }
  avisar();
  return true;
}

export function fecharGravacao() {
  estado.token = null; estado.shas.clear();
  try { localStorage.removeItem(chaveLocal()); } catch { /* */ }
  avisar();
}

/** Reabre sozinha se a liberação de 24 horas ainda vale. */
export async function restaurarGravacao() {
  try {
    const g = JSON.parse(localStorage.getItem(chaveLocal()) || 'null');
    if (!g) return false;
    if (g.ate <= Date.now()) { localStorage.removeItem(chaveLocal()); return false; }
    const chave = await crypto.subtle.importKey('raw', b64(g.k), 'AES-GCM', true, ['encrypt', 'decrypt']);
    estado.token = await decifrar(chave, await config());
    avisar();
    return true;
  } catch { estado.token = null; return false; }
}

async function gh(metodo, caminho, corpo) {
  if (!estado.token) throw new Error('gravação fechada: informe a senha de gravação na página de validação');
  const r = await fetch(`${API}${caminho}`, { method: metodo, cache: 'no-store',
    headers: { Authorization: `Bearer ${estado.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: corpo ? JSON.stringify(corpo) : undefined });
  if (r.status === 404) return null;
  if (!r.ok) { const e = new Error(`GitHub respondeu ${r.status}`); e.status = r.status; throw e; }
  return r.status === 204 ? {} : r.json();
}

/** Lê um arquivo JSON do banco (repositório de dados). null se ainda não existe. */
export async function lerDado(caminho, { repo } = {}) {
  const cfg = await config();
  const d = await gh('GET', `/repos/${repo || cfg.repo_dados}/contents/${caminho}`);
  if (!d) { estado.shas.delete(`${repo || ''}:${caminho}`); return null; }
  estado.shas.set(`${repo || ''}:${caminho}`, d.sha);
  return JSON.parse(deB64Texto(d.content));
}

/**
 * Grava um arquivo JSON no banco. `mesclar(atual)` recebe o que está gravado agora (ou null) e devolve o novo
 * conteúdo — assim duas pessoas gravando ao mesmo tempo não apagam o trabalho uma da outra (em conflito, lê de
 * novo e refaz, até 3 vezes).
 */
export async function gravarDado(caminho, mesclar, mensagem, { repo, texto = false } = {}) {
  const cfg = await config();
  const alvo = repo || cfg.repo_dados, k = `${repo || ''}:${caminho}`;
  for (let tentativa = 1; ; tentativa++) {
    const atual = await gh('GET', `/repos/${alvo}/contents/${caminho}`);
    const antes = atual && !texto ? JSON.parse(deB64Texto(atual.content)) : null;
    const novo = typeof mesclar === 'function' ? mesclar(antes) : mesclar;
    const conteudo = texto ? String(novo) : `${JSON.stringify(novo, null, 1)}\n`;
    try {
      const r = await gh('PUT', `/repos/${alvo}/contents/${caminho}`, { message: `${mensagem} (${usuario()})`, content: textoB64(conteudo), sha: atual?.sha });
      estado.shas.set(k, r?.content?.sha);
      return novo;
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && tentativa < 3) continue; // alguém gravou no meio: refaz
      throw e;
    }
  }
}

/** Troca a senha de gravação: cifra a mesma chave de acesso com a senha nova e grava no site. */
export async function trocarSenhaGravacao(senhaAtual, senhaNova) {
  if (String(senhaNova).length < 12) throw new Error('a senha nova precisa de pelo menos 12 caracteres');
  await abrirGravacao(senhaAtual);
  const cfg = await config();
  const sal = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const chave = await derivar(senhaNova, sal, cfg.iteracoes);
  const cifra = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chave, new TextEncoder().encode(JSON.stringify({ token: estado.token, teste: 'bussola-gravacao' }))));
  const novo = { ...cfg, sal: paraB64(sal), iv: paraB64(iv), cifra: paraB64(cifra) };
  await gravarDado('docs/acesso/gravacao.json', () => novo, 'Senha de gravação trocada', { repo: cfg.repo_site });
  estado.cfg = novo;
  await abrirGravacao(senhaNova);
  return true;
}

export const quemGrava = usuario;
export const repoDoSite = async () => (await config()).repo_site;
