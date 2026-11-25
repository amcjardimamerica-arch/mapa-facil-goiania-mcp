// Banco local (fachada): os dados do Mapa Fácil extraídos para o próprio site (docs/banco/).
// Responde no lugar do servidor da Prefeitura às mesmas perguntas que o sistema fazia a ele (query, identify,
// legenda e metadados). Divisão (passo 3 do roteiro de desempenho):
//   banco-nucleo.js  — dados: leitura, descompactação, cofre, filtros e respostas (sem window/document/Cesium);
//   banco-desenho.js — desenho dos temas do painel Camadas (Cesium/canvas);
//   banco.js         — esta fachada: interceptador de fetch, chave do cofre guardada, imagens locais.
import { CFG } from './config.js';
import {
  estado, NaoSuportado, lerArquivo, metadados, consultar, identificar, temServico, bancoAtivo, estatisticas,
  derivarChave, definirChave, b64, buscarPessoas, vinculosDaPessoa, esquecerPessoas,
} from './banco-nucleo.js';
import { ProvedorTema } from './banco-desenho.js';
import * as Comlink from './vendor/comlink.mjs';
import { relatorio } from './desempenho.js';

const Cesium = window.Cesium;

export { NaoSuportado, consultar, identificar, temServico, bancoAtivo, estatisticas, ProvedorTema, buscarPessoas, vinculosDaPessoa, esquecerPessoas };

// ------------------------------------------------------------------ workers de dados (passo 4)
// Consultas e identificações vão para workers (fora da linha da tela). O mesmo bloco vai sempre ao mesmo worker,
// para aproveitar o cache dele; fila com prioridade (clique 0, visível 1, vizinhança 2), até 3 tarefas por worker.
const pool = { workers: [], fila: [[], [], []], emCurso: [], seq: 0 };
const PRIORIDADE = { clique: 0, visivel: 1, vizinhanca: 2 };
const hash = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

async function iniciarWorkers() {
  if (!CFG.bancoWorker || typeof Worker === 'undefined') return;
  const N = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1, (navigator.deviceMemory || 4) <= 2 ? 2 : 4));
  try {
    const ws = Array.from({ length: N }, () => Comlink.wrap(new Worker(new URL('./banco-worker.js', import.meta.url), { type: 'module' })));
    await Promise.all(ws.map((w) => w.iniciar({ raiz: estado.raiz, manifesto: estado.manifesto })));
    pool.workers = ws;
    pool.emCurso = ws.map(() => 0);
  } catch (e) {
    console.warn('Workers do banco indisponíveis; usando a linha principal:', e);
    pool.workers = [];
  }
}

function chaveRota(S, camada, p) {
  if (p?.where && p.where !== '1=1') return `${S}/${camada}/${p.where}`;
  const g = String(p?.geometry || '').split(/[,{}":xyminax]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  return `${S}/${camada}/${g.length ? `${Math.round(g[0] / 2000)}:${Math.round(g[1] / 2000)}` : ''}`;
}

function despachar() {
  for (let pr = 0; pr < 3; pr++) {
    const fila = pool.fila[pr];
    for (let i = 0; i < fila.length;) {
      const t = fila[i];
      if (pool.emCurso[t.w] >= 3) { i++; continue; }
      fila.splice(i, 1);
      pool.emCurso[t.w]++;
      t.executar(pool.workers[t.w]).then(t.ok, t.falha).finally(() => { pool.emCurso[t.w]--; despachar(); });
    }
  }
}

function noWorker(rota, prioridade, executar) {
  const w = hash(rota) % pool.workers.length;
  return new Promise((ok, falha) => { pool.fila[PRIORIDADE[prioridade] ?? 1].push({ w, executar, ok, falha }); despachar(); })
    .then((r) => {
      if (r && 'ok' in r) return r.ok;
      if (r?.naoSuportado) throw new NaoSuportado(r.erro);
      throw new Error(r?.erro || 'erro no worker do banco');
    });
}

/** Consulta no worker (ou direto, sem workers). */
export function consultarLocal(S, camada, p, prioridade = 'visivel') {
  if (!pool.workers.length) return consultar(S, camada, p);
  const id = ++pool.seq;
  return noWorker(chaveRota(S, camada, p), prioridade, (w) => w.consultar(id, S, camada, p));
}
export function identificarLocal(S, p, prioridade = 'clique') {
  if (!pool.workers.length) return identificar(S, p);
  const id = ++pool.seq;
  return noWorker(`${S}/identify/${String(p?.geometry || '').slice(0, 14)}`, prioridade, (w) => w.identificar(id, S, p));
}

async function chaveParaWorkers(chave) {
  if (!pool.workers.length) return;
  const bruta = chave ? await crypto.subtle.exportKey('raw', chave) : null;
  await Promise.all(pool.workers.map(async (w) => { await w.definirChave(bruta ? bruta.slice(0) : null); if (!chave) await w.limparCache(); }));
}

export function zerarWorkers() { for (const w of pool.workers) w.zerarMedidas().catch(() => {}); }

/** Medidas da linha principal somadas às dos workers (relatório de desempenho). */
export async function relatorioCompleto() {
  const base = relatorio();
  const dos = await Promise.all(pool.workers.map((w) => w.medidas().catch(() => null)));
  base.workers = dos.filter(Boolean).map((r) => ({ etapas: r.etapas, contadores: r.contadores }));
  for (const r of base.workers) for (const [k, v] of Object.entries(r.contadores)) base.contadores[k] = (base.contadores[k] || 0) + v;
  return base;
}

// ------------------------------------------------------------------ cofre (chave guardada por 24 h)
export const cofreDisponivel = () => !!estado.manifesto?.cofre;
export const cofreAberto = () => !!estado.chave;
const chaveGuardada = () => `bussola:cofre:${window.bussolaSessao?.login || 'anonimo'}`;

/** Abre o cofre com a senha e libera por 24 horas para este usuário, neste aparelho (só a chave derivada é guardada). */
export async function abrirCofre(senha) {
  const chave = await derivarChave(senha);
  await definirChave(chave);
  await chaveParaWorkers(chave);
  try { localStorage.setItem(chaveGuardada(), JSON.stringify({ k: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', chave)))), ate: Date.now() + 24 * 3600e3 })); } catch { /* sem armazenamento */ }
  return true;
}

export function fecharCofre() {
  definirChave(null);
  chaveParaWorkers(null).catch(() => {});
  try { localStorage.removeItem(chaveGuardada()); sessionStorage.removeItem('bussola:cofre'); } catch { /* */ }
}

/** Até quando os dados complementares estão liberados para este usuário (ou null). */
export function cofreLiberadoAte() {
  try { const g = JSON.parse(localStorage.getItem(chaveGuardada()) || 'null'); return g && g.ate > Date.now() ? new Date(g.ate) : null; } catch { return null; }
}
/** Campos pessoais (do cofre) de uma camada, para mostrar com cadeado quando o cofre está fechado. */
export const camposPessoais = (S, id) => estado.manifesto?.servicos?.[S]?.camadas?.[String(id)]?.pessoais || [];

async function restaurarCofre() {
  try {
    const g = JSON.parse(localStorage.getItem(chaveGuardada()) || 'null');
    if (g && g.ate > Date.now() && estado.manifesto?.cofre) await definirChave(b64(g.k));
    else if (g) localStorage.removeItem(chaveGuardada()); // venceram as 24 horas
  } catch { estado.chave = null; }
}

let iniciando = null;
/** Uma única inicialização por página (vários módulos podem pedir). */
export function iniciarBanco() {
  if (!iniciando) iniciando = iniciarBancoUmaVez();
  return iniciando;
}

async function iniciarBancoUmaVez() {
  try {
    estado.fetchOriginal = window.fetch.bind(window);
    // Raiz absoluta: dentro de um worker, endereço relativo resolveria contra a pasta js/.
    estado.raiz = new URL('banco/', document.baseURI).href;
    const r = await estado.fetchOriginal(`${estado.raiz}manifesto.json`, { cache: 'no-cache' });
    if (!r.ok) return null;
    estado.manifesto = await r.json();
    await restaurarCofre();
    await iniciarWorkers();
    if (estado.chave) await chaveParaWorkers(estado.chave);
    instalarInterceptador();
    return estado.manifesto;
  } catch (e) {
    console.warn('Banco local indisponível:', e);
    return null;
  }
}
/** Blocos de imagem guardados no site (serviços que só existem como imagem, ex.: Mapa Básico). */
export function imagemLocal(S) {
  const b = estado.manifesto?.imagens?.[S];
  if (!b) return null;
  const p = new Cesium.UrlTemplateImageryProvider({
    url: `${estado.raiz}blocos/${S}/{z}/{x}/{y}.${b.formato || 'png'}`, minimumLevel: b.min, maximumLevel: b.max,
    rectangle: Cesium.Rectangle.fromDegrees(...b.extensao), credit: `${S}: Prefeitura de Goiânia (Mapa Fácil) · banco local`,
    enablePickFeatures: false, tileDiscardPolicy: new Cesium.NeverTileDiscardPolicy(),
  });
  // Só existem blocos que tocam Goiânia: os do retângulo que ficam fora dela faltam de propósito.
  p.errorEvent.addEventListener((erro) => { if (erro) erro.retry = false; });
  return p;
}

// ------------------------------------------------------------------ interceptador de fetch
function parametrosDe(url, init) {
  const p = Object.fromEntries(new URL(url).searchParams);
  const corpo = init?.body;
  if (corpo) {
    const extra = corpo instanceof URLSearchParams ? corpo : typeof corpo === 'string' ? new URLSearchParams(corpo) : corpo instanceof FormData ? corpo : null;
    if (extra) for (const [k, v] of extra.entries()) p[k] = v;
  }
  return p;
}

async function responderLocal(url, init) {
  const base = `${CFG.ms}/`;
  const resto = url.split('?')[0].slice(base.length);
  const m = resto.match(/^([^/]+)\/MapServer(?:\/(\d+))?(?:\/(query|identify|legend))?\/?$/);
  if (!m) throw new NaoSuportado(resto);
  const [, S, id, op] = m;
  if (!temServico(S)) throw new NaoSuportado(`${S} fora do banco`);
  const p = parametrosDe(url, init);
  if (op === 'query' && id != null) return consultarLocal(S, +id, p);
  if (op === 'identify' && id == null) return identificarLocal(S, p);
  if (op === 'legend' && id == null) { const l = await lerArquivo(`servicos/${S}/legend.json`); if (l) return l; }
  if (!op && id != null) { const l = await metadados(S, id); if (l) return l; }
  if (!op && id == null) { const l = await lerArquivo(`servicos/${S}/MapServer.json`); if (l) return l; }
  throw new NaoSuportado(resto);
}

function instalarInterceptador() {
  const original = estado.fetchOriginal;
  window.fetch = async (entrada, init) => {
    const url = typeof entrada === 'string' ? entrada : entrada?.url;
    if (url && url.startsWith(`${CFG.ms}/`) && (!init?.method || ['GET', 'POST'].includes(String(init.method).toUpperCase()))) {
      try {
        const d = await responderLocal(url, init);
        estado.local++;
        return new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        if (!(e instanceof NaoSuportado)) console.warn('Banco local:', e);
        else console.info(`Banco local sem resposta (${e.message}): ${url.split('?')[0]}`);
        const servico = url.slice(`${CFG.ms}/`.length).split('/')[0];
        if (CFG.bancoSoLocal || (CFG.servicosSoLocais || []).includes(servico)) return new Response(JSON.stringify({ error: { code: 400, message: `Consulta fora do banco local: ${e.message}` } }), { status: 200 });
        estado.servidor++;
      }
    }
    return original(entrada, init);
  };
}
