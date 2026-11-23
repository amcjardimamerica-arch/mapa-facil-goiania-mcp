// Pedidos de manutenção registrados no próprio sistema (lotes, áreas públicas, bocas de lobo e postes).
// Ficam guardados neste aparelho; o relatório sai em planilha (CSV) ou em página para imprimir/salvar em PDF.
import { el, aviso, baixarArquivo } from './util.js';

const CHAVE = 'bussola:manutencao';
const hoje = () => new Date().toLocaleDateString('pt-BR');

function ler() { try { return JSON.parse(localStorage.getItem(CHAVE) || '{}'); } catch { return {}; } }
function gravar(d) { try { localStorage.setItem(CHAVE, JSON.stringify(d)); } catch { aviso('Não foi possível guardar o pedido neste aparelho.', 'alerta'); } }

export const manutencao = {
  todos: () => Object.values(ler()).sort((a, b) => (a.registrado < b.registrado ? 1 : -1)),
  tem: (codigo) => !!ler()[codigo],
  pedido: (codigo) => ler()[codigo] || null,
  /** Liga ou desliga o pedido do item. Devolve o pedido (ou null, se foi retirado). */
  alternar(item) {
    const d = ler();
    if (d[item.codigo]) { delete d[item.codigo]; gravar(d); return null; }
    d[item.codigo] = { ...item, data: hoje(), registrado: new Date().toISOString(), descricao: item.descricao || '' };
    gravar(d);
    return d[item.codigo];
  },
  atualizar(codigo, campos) {
    const d = ler();
    if (!d[codigo]) return;
    Object.assign(d[codigo], campos);
    gravar(d);
  },
};

/** Botão de pedido: fica marcado enquanto houver pedido; clicar de novo retira. A data é editável. */
export function botaoManutencao(item, { aoMudar } = {}) {
  const caixa = el('div', { class: 'manut' });
  const montar = () => {
    caixa.textContent = '';
    const p = manutencao.pedido(item.codigo);
    const botao = el('button', { class: `botao manut-botao${p ? ' ligado' : ''}`, 'aria-pressed': String(!!p),
      title: p ? 'Clique para retirar o pedido de manutenção' : 'Registrar pedido de manutenção deste item',
      onclick: () => { const r = manutencao.alternar(item); aviso(r ? `Pedido de manutenção registrado (${item.codigo}).` : `Pedido de manutenção retirado (${item.codigo}).`); montar(); aoMudar?.(r); } },
      p ? `Manutenção pedida (${item.codigo})` : `Pedir manutenção (${item.codigo})`);
    caixa.append(botao);
    if (p) {
      caixa.append(
        el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Data do pedido'),
          el('input', { class: 'campo', type: 'text', value: p.data, 'aria-label': 'Data do pedido de manutenção',
            onchange: (e) => manutencao.atualizar(item.codigo, { data: e.target.value.trim() }) })),
        el('label', { class: 'rotulo-faixa bloco' }, el('span', {}, 'Descrição do problema'),
          el('textarea', { class: 'campo area', rows: 2, 'aria-label': 'Descrição do problema', onchange: (e) => manutencao.atualizar(item.codigo, { descricao: e.target.value.trim() }) }, p.descricao || '')));
    }
  };
  montar();
  return caixa;
}

const COLUNAS = [['codigo', 'Código'], ['tipo', 'Tipo'], ['titulo', 'Item'], ['bairro', 'Bairro'], ['local', 'Local'],
  ['data', 'Data do pedido'], ['descricao', 'Descrição'], ['lat', 'Latitude'], ['lon', 'Longitude']];

export function relatorioCSV() {
  const lista = manutencao.todos();
  if (!lista.length) { aviso('Nenhum pedido de manutenção registrado.'); return; }
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [COLUNAS.map(([, t]) => q(t)).join(';'), ...lista.map((p) => COLUNAS.map(([k]) => q(k === 'lat' || k === 'lon' ? String(p[k] ?? '').replace('.', ',') : p[k])).join(';'))];
  baixarArquivo(`pedidos-manutencao-${new Date().toISOString().slice(0, 10)}.csv`, `\ufeff${linhas.join('\r\n')}`, 'text/csv;charset=utf-8');
}

export function relatorioImpressao() {
  const lista = manutencao.todos();
  if (!lista.length) { aviso('Nenhum pedido de manutenção registrado.'); return; }
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const porTipo = {};
  for (const p of lista) (porTipo[p.tipo] ||= []).push(p);
  const html = `<!DOCTYPE html><html lang="pt-BR"><meta charset="utf-8"><title>Pedidos de manutenção — Bússola</title>
<style>body{font:13px system-ui,Segoe UI,Roboto,sans-serif;margin:24px;color:#111}h1{font-size:20px}h2{font-size:15px;margin-top:22px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:5px 7px;text-align:left;vertical-align:top}th{background:#eee}</style>
<h1>Pedidos de manutenção</h1><p>A.M.C. Jardim América · gerado em ${new Date().toLocaleString('pt-BR')} · ${lista.length} pedidos</p>
${Object.entries(porTipo).map(([tipo, itens]) => `<h2>${esc(tipo)} (${itens.length})</h2><table><tr>${COLUNAS.filter(([k]) => k !== 'tipo').map(([, t]) => `<th>${t}</th>`).join('')}</tr>
${itens.map((p) => `<tr>${COLUNAS.filter(([k]) => k !== 'tipo').map(([k]) => `<td>${esc(p[k])}</td>`).join('')}</tr>`).join('')}</table>`).join('')}
<script>print()</script></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
}
