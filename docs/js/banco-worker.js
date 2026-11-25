// Worker de dados (passo 4 do roteiro de desempenho): leitura, descompactação, decifragem e filtro do banco
// local fora da linha da tela. A fachada (banco.js) conversa com ele pelo Comlink.
import * as Comlink from './vendor/comlink.mjs';
import { criarNucleo, NaoSuportado, Cancelado } from './banco-nucleo.js';
import { relatorio, zerar } from './desempenho.js';

let nucleo = null;
const controles = new Map(); // id -> AbortController (passo 7)

async function executar(id, fn) {
  const ac = new AbortController();
  if (id != null) controles.set(id, ac);
  try {
    return { ok: await fn(ac.signal) };
  } catch (e) {
    if (e instanceof Cancelado || e?.name === 'AbortError') return { erro: 'cancelado', cancelado: true };
    return { erro: e?.message || String(e), naoSuportado: e instanceof NaoSuportado };
  } finally { if (id != null) controles.delete(id); }
}

const api = {
  async iniciar({ raiz, manifesto }) { nucleo = criarNucleo({ raiz, manifesto, buscar: fetch.bind(self) }); return true; },
  async definirChave(bytes) { await nucleo.definirChave(bytes ? new Uint8Array(bytes) : null); },
  async consultar(id, S, camada, p) { return executar(id, (sinal) => nucleo.consultar(S, camada, { ...p, _sinal: sinal })); },
  async identificar(id, S, p) { return executar(id, () => nucleo.identificar(S, p)); },
  async metadados(S, camada) { return executar(null, () => nucleo.metadados(S, camada)); },
  async feicoesParaDesenho(id, S, camada, ext, campos) {
    const r = await executar(id, (sinal) => nucleo.feicoesParaDesenho(S, camada, ext, campos, sinal));
    // Vetores transferidos (sem cópia); o worker não guarda estes vetores em cache.
    return r.ok ? Comlink.transfer(r, [r.ok.xy.buffer, r.ok.inicio.buffer, r.ok.partes.buffer, r.ok.caixas.buffer]) : r;
  },
  async legenda(S) { return executar(null, () => nucleo.legenda(S)); },
  cancelar(id) { controles.get(id)?.abort(); },
  limparCache() { nucleo?.limparCache(); },
  async medidas() { return relatorio(); },
  zerarMedidas() { zerar(); },
};
Comlink.expose(api);
