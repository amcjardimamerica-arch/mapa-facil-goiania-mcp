/**
 * Registro de acessos da Bússola — Google Apps Script ligado a uma Planilha Google.
 *
 * Instalação (uma vez, na conta Google da Associação):
 *  1. Crie uma Planilha Google vazia chamada "Bússola — acessos".
 *  2. Menu Extensões → Apps Script. Apague o conteúdo e cole este arquivo inteiro. Salve.
 *  3. Configurações do projeto (engrenagem) → Propriedades do script → Adicionar propriedade:
 *       CHAVE_LEITURA = uma senha longa só sua (é ela que abre os logs na página de validação).
 *  4. Implantar → Nova implantação → tipo "App da Web":
 *       Executar como: Eu      Quem pode acessar: Qualquer pessoa
 *     Autorize e copie o endereço que termina em /exec.
 *  5. Envie esse endereço no chat para ser colocado no sistema.
 */
const COLUNAS = ['data_hora', 'evento', 'usuario', 'nome', 'pagina', 'tipo', 'sistema', 'navegador', 'modelo', 'tela',
  'idioma', 'fuso', 'ip', 'provedor', 'cidade', 'estado', 'pais', 'lat_ip', 'lon_ip', 'lat_gps', 'lon_gps', 'precisao_gps_m', 'agente'];

function aba_() {
  const planilha = SpreadsheetApp.getActiveSpreadsheet();
  let aba = planilha.getSheetByName('acessos');
  if (!aba) {
    aba = planilha.insertSheet('acessos');
    aba.appendRow(COLUNAS);
    aba.setFrozenRows(1);
  }
  return aba;
}

/** Grava um acesso (chamado pelo site a cada login e a cada abertura). */
function doPost(e) {
  const r = JSON.parse(e.postData.contents || '{}');
  if (!r.usuario || !r.evento) return ContentService.createTextOutput('ignorado');
  const linha = COLUNAS.map((c) => (r[c] === undefined || r[c] === null ? '' : String(r[c]).slice(0, 500)));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { aba_().appendRow(linha); } finally { lock.releaseLock(); }
  return ContentService.createTextOutput('ok');
}

/** Lê os acessos mais recentes; exige a chave de leitura. */
function doGet(e) {
  const p = e.parameter || {};
  const saida = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  const chave = PropertiesService.getScriptProperties().getProperty('CHAVE_LEITURA');
  if (p.acao !== 'ler') return saida({ ok: true });
  if (!chave || p.chave !== chave) return saida({ erro: 'chave de leitura incorreta' });
  const valores = aba_().getDataRange().getValues();
  const cab = valores.shift();
  const limite = Math.min(Number(p.limite) || 500, 5000);
  const acessos = valores.slice(-limite).reverse().map((l) => Object.fromEntries(cab.map((c, i) => [c, l[i]])));
  return saida({ acessos });
}
