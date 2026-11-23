// Registro de acessos: quem entrou, quando, de onde e com qual aparelho.
//
// O site é estático (GitHub Pages) e não tem onde gravar; os registros vão para uma Planilha Google
// da Associação por um Apps Script publicado como aplicativo da Web (scripts/registro-acessos.gs).
// O endereço desse aplicativo fica em CFG.registro.url. A leitura exige a chave de leitura, que não
// está no código do site: quem administra digita na página de validação.
import { CFG } from './config.js';

/** Sistema, navegador, tipo e modelo do aparelho, pelo que o navegador informa. */
export async function aparelho() {
  const ua = navigator.userAgent;
  const m = (re) => (ua.match(re) || [])[1];
  const sistema = /Android/.test(ua) ? `Android ${m(/Android ([\d.]+)/) || ''}`.trim()
    : /iPhone|iPad|iPod/.test(ua) ? `iOS ${(m(/OS ([\d_]+) like Mac/) || '').replace(/_/g, '.')}`.trim()
    : /Windows NT 10/.test(ua) ? 'Windows 10/11' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? `macOS ${(m(/Mac OS X ([\d_]+)/) || '').replace(/_/g, '.')}`.trim()
    : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Outro';
  const navegador = /Edg\//.test(ua) ? `Edge ${m(/Edg\/([\d]+)/)}` : /OPR\//.test(ua) ? `Opera ${m(/OPR\/([\d]+)/)}`
    : /SamsungBrowser/.test(ua) ? `Samsung Internet ${m(/SamsungBrowser\/([\d]+)/)}`
    : /Firefox\//.test(ua) ? `Firefox ${m(/Firefox\/([\d]+)/)}` : /Chrome\//.test(ua) ? `Chrome ${m(/Chrome\/([\d]+)/)}`
    : /Safari\//.test(ua) ? `Safari ${m(/Version\/([\d.]+)/) || ''}`.trim() : 'Outro';
  const tipo = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet'
    : /Mobi|iPhone|Android/.test(ua) ? 'Celular' : 'Computador';
  let modelo = m(/Android [\d.]+; ([^;)]+?)(?: Build|\))/) || (/iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : '');
  try {
    const d = await navigator.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion']);
    if (d?.model) modelo = d.model;
  } catch { /* nem todo navegador informa */ }
  return { tipo, sistema, navegador, modelo: modelo === 'K' ? '' : modelo,
    tela: `${screen.width}×${screen.height}`, idioma: navigator.language, fuso: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

/** Localização: aproximada pelo endereço de internet e, se o GPS já estiver liberado, a posição precisa. */
async function localizacao() {
  const saida = {};
  try {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 4000);
    const r = await (await fetch('https://ipwho.is/', { signal: ctrl.signal })).json();
    if (r.success) Object.assign(saida, { ip: r.ip, cidade: r.city, estado: r.region, pais: r.country,
      provedor: r.connection?.isp || r.connection?.org || '', lat_ip: r.latitude, lon_ip: r.longitude });
  } catch { /* sem localização aproximada */ }
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p?.state === 'granted') {
      const pos = await new Promise((ok, erro) => navigator.geolocation.getCurrentPosition(ok, erro, { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }));
      Object.assign(saida, { lat_gps: +pos.coords.latitude.toFixed(6), lon_gps: +pos.coords.longitude.toFixed(6), precisao_gps_m: Math.round(pos.coords.accuracy) });
    }
  } catch { /* GPS não liberado: fica só a aproximada */ }
  return saida;
}

/** Envia um registro de acesso (não bloqueia o uso se falhar). */
export async function registrarAcesso(sessao, evento) {
  const url = CFG.registro?.url;
  if (!url || !sessao) return false;
  const registro = { evento, data_hora: new Date().toISOString(), usuario: sessao.login, nome: sessao.nome,
    pagina: location.pathname.split('/').pop() || 'index.html', ...(await aparelho()), ...(await localizacao()), agente: navigator.userAgent };
  try {
    // text/plain evita a consulta prévia de CORS, que o Apps Script não atende.
    await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(registro), keepalive: true });
    return true;
  } catch { return false; }
}

/** Lê os registros (precisa da chave de leitura definida no Apps Script). */
export async function lerAcessos(chave, limite = 500) {
  const url = CFG.registro?.url;
  if (!url) throw new Error('registro de acessos ainda não configurado');
  const r = await fetch(`${url}?acao=ler&limite=${limite}&chave=${encodeURIComponent(chave)}`);
  const d = await r.json();
  if (d.erro) throw new Error(d.erro);
  return d.acessos || [];
}
