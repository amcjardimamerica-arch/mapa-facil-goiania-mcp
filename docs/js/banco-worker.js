// Worker de dados (passo 4 do roteiro de desempenho): leitura, descompactação, decifragem e filtro do banco
// local fora da linha da tela. A fachada (banco.js) conversa com ele pelo Comlink.
import * as Comlink from './vendor/comlink.mjs';
import { criarNucleo, NaoSuportado } from './banco-nucleo.js';
import { relatorio, zerar } from './desempenho.js';

let nucleo = null;
const cancelados = new Set();

async function executar(id, fn) {
  try {
    if (id != null && cancelados.has(id)) return { erro: 'cancelado', cancelado: true };
    return { ok: await fn() };
  } catch (e) {
    return { erro: e?.message || String(e), naoSuportado: e instanceof NaoSuportado };
  } finally { if (id != null) cancelados.delete(id); }
}

const api = {
  async iniciar({ raiz, manifesto }) { nucleo = criarNucleo({ raiz, manifesto, buscar: fetch.bind(self) }); return true; },
  async definirChave(bytes) { await nucleo.definirChave(bytes ? new Uint8Array(bytes) : null); },
  async consultar(id, S, camada, p) { return executar(id, () => nucleo.consultar(S, camada, p)); },
  async identificar(id, S, p) { return executar(id, () => nucleo.identificar(S, p)); },
  async metadados(S, camada) { return executar(null, () => nucleo.metadados(S, camada)); },
  cancelar(id) { cancelados.add(id); },
  limparCache() { nucleo?.limparCache(); },
  async medidas() { return relatorio(); },
  zerarMedidas() { zerar(); },
};
Comlink.expose(api);
