// Medidas de desempenho da Bússola (passo 1 do roteiro de desempenho).
// bussola.desempenho() no console devolve, por etapa, quantas vezes rodou, a média, o p95 e o máximo (ms),
// além de contadores (bytes baixados, pedidos, acertos de cache) e as tarefas longas do navegador.
const medidas = new Map(); // etapa -> { n, total, max, amostras[] }
export const contadores = { bytes: 0, pedidos: 0, cacheMemoria: 0, cacheDisco: 0, cancelados: 0 };
const longas = [];
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) longas.push(e.duration); }).observe({ type: 'longtask', buffered: true });
} catch { /* Safari não tem "longtask" */ }

export function medir(etapa, ms) {
  let m = medidas.get(etapa);
  if (!m) medidas.set(etapa, (m = { n: 0, total: 0, max: 0, amostras: [] }));
  m.n++; m.total += ms; m.max = Math.max(m.max, ms);
  m.amostras.push(ms);
  if (m.amostras.length > 200) m.amostras.shift();
}

export async function cronometrar(etapa, fn) {
  const t = performance.now();
  try { return await fn(); } finally { medir(etapa, performance.now() - t); }
}

/** Versão síncrona (para funções que não são assíncronas). */
export function cronometrarSinc(etapa, fn) {
  const t = performance.now();
  try { return fn(); } finally { medir(etapa, performance.now() - t); }
}

const p95 = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
const r = (x) => Math.round(x * 10) / 10;

export function relatorio() {
  const etapas = {};
  for (const [k, m] of medidas) etapas[k] = { n: m.n, media: r(m.total / m.n), p95: r(p95(m.amostras)), max: r(m.max) };
  return {
    etapas, contadores: { ...contadores },
    tarefasLongas: { n: longas.length, max: r(Math.max(0, ...longas)), acimaDe50: longas.filter((x) => x > 50).length },
    memoria: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  };
}

export function zerar() {
  medidas.clear(); longas.length = 0;
  for (const k of Object.keys(contadores)) contadores[k] = 0;
}
