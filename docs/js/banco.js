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

const Cesium = window.Cesium;

export { NaoSuportado, consultar, identificar, temServico, bancoAtivo, estatisticas, ProvedorTema, buscarPessoas, vinculosDaPessoa, esquecerPessoas };

// ------------------------------------------------------------------ cofre (chave guardada por 24 h)
export const cofreDisponivel = () => !!estado.manifesto?.cofre;
export const cofreAberto = () => !!estado.chave;
const chaveGuardada = () => `bussola:cofre:${window.bussolaSessao?.login || 'anonimo'}`;

/** Abre o cofre com a senha e libera por 24 horas para este usuário, neste aparelho (só a chave derivada é guardada). */
export async function abrirCofre(senha) {
  const chave = await derivarChave(senha);
  await definirChave(chave);
  try { localStorage.setItem(chaveGuardada(), JSON.stringify({ k: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', chave)))), ate: Date.now() + 24 * 3600e3 })); } catch { /* sem armazenamento */ }
  return true;
}

export function fecharCofre() {
  definirChave(null);
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
  if (op === 'query' && id != null) return consultar(S, +id, p);
  if (op === 'identify' && id == null) return identificar(S, p);
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
