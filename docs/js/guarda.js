// Guarda das páginas internas: sem sessão válida, volta para o portal de acesso.
// Script clássico, carregado no <head> antes de tudo, para a página nem começar.
(function () {
  var s = null;
  try { s = JSON.parse(sessionStorage.getItem('bussola:sessao') || localStorage.getItem('bussola:sessao') || 'null'); } catch (e) { s = null; }
  if (!s || !s.login || !(s.expira > Date.now())) {
    var volta = location.pathname.split('/').pop() + location.hash;
    location.replace('index.html?volta=' + encodeURIComponent(volta));
    document.documentElement.style.display = 'none';
  } else {
    window.bussolaSessao = s;
  }
})();
