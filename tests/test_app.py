"""Testes de ponta a ponta no navegador (precisam de rede e do Chromium do Playwright).

    pip install -r requirements-dev.txt && playwright install chromium
    pytest -m navegador
"""
from __future__ import annotations

import functools
import hashlib
import http.server
import json
import os
import threading
import time

import pytest

from conftest import DOCS

pytestmark = pytest.mark.navegador
playwright_api = pytest.importorskip("playwright.sync_api")

ARGS_GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
           "--ignore-gpu-blocklist", "--enable-webgl"]


@pytest.fixture(scope="module")
def servidor():
    manipulador = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DOCS))
    manipulador.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), manipulador)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture(scope="module")
def navegador():
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    with playwright_api.sync_playwright() as pw:
        b = pw.chromium.launch(args=ARGS_GL, proxy={"server": proxy, "bypass": "127.0.0.1,localhost"} if proxy else None)
        yield b
        b.close()


# Usuário de teste: a lista real de usuários é trocada por esta em todas as páginas.
SENHA_TESTE = "senha-de-teste-123"
_SAL = "a1" * 16
USUARIOS_TESTE = {"usuarios": [{"login": "teste", "nome": "Pessoa de Teste", "perfil": "membro", "ativo": True,
                                "sal": _SAL, "iteracoes": 1000,
                                "resumo": hashlib.pbkdf2_hmac("sha256", SENHA_TESTE.encode(), bytes.fromhex(_SAL), 1000).hex()}]}
SESSAO_TESTE = {"login": "teste", "nome": "Pessoa de Teste", "perfil": "membro", "marca": USUARIOS_TESTE["usuarios"][0]["resumo"][:12],
                "inicio": 0, "expira": int((time.time() + 3600) * 1000), "lembrar": True}
GPS_JARDIM_AMERICA = {"latitude": -16.70766, "longitude": -49.28568}


def _contexto(navegador, logado=True, **extra):
    ctx = navegador.new_context(viewport={"width": 1280, "height": 800}, **extra)
    ctx.route("**/acesso/usuarios.json", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(USUARIOS_TESTE)))
    if logado:
        ctx.add_init_script(f"localStorage.setItem('bussola:sessao', JSON.stringify({json.dumps(SESSAO_TESTE)}))")
    return ctx


@pytest.fixture(scope="module")
def mapa(navegador, servidor):
    """Abre o mapa uma vez (sem relevo nem edifícios, para ser rápido em CPU), já logado e com GPS simulado."""
    ctx = _contexto(navegador, geolocation=GPS_JARDIM_AMERICA, permissions=["geolocation"])
    pagina = ctx.new_page()
    erros = []
    pagina.on("pageerror", lambda e: erros.append(str(e)))
    pagina.goto(f"{servidor}/sistema.html#ed=0&r=0")
    pagina.wait_for_function("window.bussola && (window.bussola.pronto || window.bussola.erros.length)", timeout=180_000)
    pagina.erros_de_pagina = erros
    yield pagina
    ctx.close()


def test_abre_sem_erros(mapa):
    estado = mapa.evaluate("({pronto: bussola.pronto, erros: bussola.erros})")
    assert estado["pronto"], estado
    assert estado["erros"] == [] and mapa.erros_de_pagina == []
    assert mapa.evaluate("bussola.globo.chaveBase") == "satelite"
    assert mapa.evaluate("bussola.territorio.vizinhos.length") >= 8


def test_mascara_mostra_so_goiania(mapa):
    """Dentro de Goiânia o bloco da máscara é transparente; fora, cinza opaco."""
    r = mapa.evaluate("""() => {
      const p = bussola.globo.camadaMascara.imageryProvider;
      const pixel = (lon, lat) => {
        const nivel = 14, xy = p.tilingScheme.positionToTileXY(Cesium.Cartographic.fromDegrees(lon, lat), nivel);
        const tela = p.desenhar(xy.x, xy.y, nivel);
        return Array.from(tela.getContext('2d').getImageData(128, 128, 1, 1).data);
      };
      const camadas = bussola.globo.viewer.imageryLayers;
      return { centro: pixel(-49.2648, -16.6869), aparecida: pixel(-49.2469, -16.8198), longe: pixel(-47.9, -15.8),
               topo: camadas.get(camadas.length - 1) === bussola.globo.camadaMascara };
    }""")
    assert r["centro"][3] == 0, "o centro de Goiânia deve ficar visível"
    assert r["aparecida"][3] == 255 and r["longe"][3] == 255, "fora de Goiânia deve ficar cinza"
    assert r["aparecida"][:3] != r["longe"][:3], "limítrofe e 'resto' têm tons de cinza diferentes"
    assert r["topo"], "a máscara precisa ser a camada de cima"


def test_fora_de_goiania_so_indica_o_territorio(mapa):
    mapa.evaluate("bussola.identificar.emPonto({lon: -49.2469, lat: -16.8198, alt: NaN})")
    assert mapa.text_content("#ficha-titulo") == "Aparecida de Goiânia"
    assert "apenas de Goiânia" in mapa.text_content("#ficha-corpo")
    mapa.evaluate("bussola.identificar.fechar()")


def test_busca_sem_acento(mapa):
    mapa.fill("#busca", "jardim america")
    mapa.wait_for_selector("#resultados .item")
    assert "Jardim América" in mapa.text_content("#resultados")
    mapa.fill("#busca", "avenida anhanguera")
    mapa.wait_for_function("document.querySelector('#resultados').textContent.includes('Anhangüera')", timeout=30_000)
    mapa.fill("#busca", "-16.6816, -49.2556")
    mapa.wait_for_function("document.querySelector('#resultados').textContent.includes('Coordenadas')")
    mapa.fill("#busca", "")
    mapa.keyboard.press("Escape")


def test_identificar_lote(mapa):
    mapa.evaluate("bussola.identificar.emPonto({lon: -49.27162, lat: -16.68505, alt: NaN})")
    mapa.wait_for_function("!document.querySelector('#ficha-corpo .carregando')", timeout=60_000)
    titulo, corpo = mapa.text_content("#ficha-titulo"), mapa.text_content("#ficha-corpo")
    assert "Consultando" not in titulo
    assert "Bairro" in corpo and "Oeste" in corpo and "S Oeste" not in corpo, corpo[:300]
    mapa.evaluate("bussola.identificar.fechar()")


def test_temas_e_link(mapa):
    estado = mapa.evaluate("""() => {
      bussola.camadas.ligar('Mapa_MeioAmbiente', true);
      const ativos = bussola.camadas.ativos().map((a) => a.tema.chave);
      const serie = bussola.camadas.serializar();
      bussola.camadas.ligar('Mapa_MeioAmbiente', false);
      return { ativos, serie, depois: bussola.camadas.ativos().length };
    }""")
    assert estado["ativos"] == ["Mapa_MeioAmbiente"] and estado["serie"].startswith("Mapa_MeioAmbiente:")
    assert estado["depois"] == 0


def test_medicao_e_kml(mapa):
    kml = mapa.evaluate("""() => {
      const { medir, marcadores } = bussola;
      const C = (lon, lat) => ({ lon, lat, cartesiano: Cesium.Cartesian3.fromDegrees(lon, lat) });
      medir.iniciar('distancia'); medir.clique(C(-49.26, -16.68)); medir.clique(C(-49.25, -16.68)); medir.concluir();
      medir.iniciar('area'); [[-49.26, -16.68], [-49.25, -16.68], [-49.25, -16.69], [-49.26, -16.69]].forEach((p) => medir.clique(C(...p))); medir.concluir();
      const textos = medir.medidas.map((m) => m.texto);
      const k = marcadores.kml();
      medir.limpar();
      return { textos, k };
    }""")
    assert kml["textos"][0].endswith("km") and "1,0" in kml["textos"][0]      # ~1,07 km
    assert "ha" in kml["textos"][1] or "km²" in kml["textos"][1]
    assert "<LineString>" in kml["k"] and "<Polygon>" in kml["k"] and kml["k"].startswith("<?xml")


def test_satelite_em_outras_datas(mapa):
    """As datas antigas do satélite entram como fundo e voltam ao satélite atual."""
    r = mapa.evaluate("""async () => {
      const datas = bussola.globo.basesDisponiveis().filter((b) => b.tipo === 'historico');
      if (!datas.length) return { total: 0 };
      const alvo = datas[datas.length - 1].chave;            // a mais antiga
      await bussola.trocarBase(alvo);
      const durante = { base: bussola.globo.chaveBase, seletor: document.querySelector('#satelite-data').value,
                        credito: document.querySelector('#st-creditos').textContent };
      await bussola.trocarBase('satelite');
      return { total: datas.length, alvo, durante, depois: bussola.globo.chaveBase,
               opcoes: document.querySelectorAll('#satelite-data option').length };
    }""")
    assert r["total"] >= 3
    assert r["durante"]["base"] == r["alvo"] == r["durante"]["seletor"] and r["alvo"].startswith("sat-20")
    assert "Wayback" in r["durante"]["credito"]
    assert r["depois"] == "satelite" and r["opcoes"] == r["total"] + 1


AXE = "https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js"


def _violacoes_graves(pagina):
    pagina.add_script_tag(url=AXE)
    return pagina.evaluate("""() => axe.run(document, { runOnly: { type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } })
      .then((r) => r.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
        .map((v) => `${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`))""")


def test_acessibilidade_sem_violacao_grave(mapa):
    """axe-core (WCAG 2.1 A/AA): vista inicial, painel, busca e ficha sem violações graves ou críticas."""
    assert _violacoes_graves(mapa) == []
    mapa.evaluate("bussola.abrirPainel('imagens')")
    mapa.fill("#busca", "jardim")
    mapa.wait_for_selector("#resultados .item")
    mapa.evaluate("bussola.identificar.emPonto({lon: -49.2469, lat: -16.8198, alt: NaN})")
    graves = _violacoes_graves(mapa)
    mapa.fill("#busca", "")
    mapa.keyboard.press("Escape")
    mapa.evaluate("bussola.identificar.fechar(); bussola.abrirPainel('imagens')")
    assert graves == []


def test_pagina_de_validacao(navegador, servidor):
    ctx = _contexto(navegador)
    pagina = ctx.new_page()
    pagina.goto(f"{servidor}/validacao.html")
    pagina.wait_for_function("window.validacao && window.validacao.fim", timeout=420_000)
    resumo = pagina.evaluate("({resumo: window.validacao.resumo, falhas: window.validacao.testes.filter((t) => t.estado === 'falha')})")
    ctx.close()
    assert resumo["resumo"]["total"] > 30
    assert resumo["falhas"] == [], resumo["falhas"]


# ------------------------------------------------ mapa desenhado e lotes
def test_fundos_sem_ortofotos_e_mapa_desenhado(mapa):
    r = mapa.evaluate("""async () => {
      const chaves = bussola.globo.basesDisponiveis().map((b) => b.chave);
      const barra = [...document.querySelectorAll('#epocas button')].map((b) => b.textContent);
      await bussola.trocarBase('mapa');
      const p = bussola.globo.camadaBase.imageryProvider;
      const bloco = await p.requestImage(5949, 8962, 14, undefined);
      const durante = { base: bussola.globo.chaveBase, modo: p.modo, realceVisivel: bussola.globo.camadaRealce?.show };
      await bussola.trocarBase('satelite');
      return { chaves, barra, durante, bloco: bloco ? [bloco.width, bloco.height] : null,
               realceModo: bussola.globo.camadaRealce?.imageryProvider.modo };
    }""")
    assert not any(c.startswith("orto") for c in r["chaves"]) and "mapa" in r["chaves"]
    assert r["barra"] == ["Satélite", "Mapa"]
    assert r["durante"] == {"base": "mapa", "modo": "mapa", "realceVisivel": False}
    assert r["bloco"] == [512, 512] and r["realceModo"] == "sobre"


def test_nome_de_via_legivel(mapa):
    nomes = mapa.evaluate("""async () => { const m = await import('./js/mapavetorial.js');
      return [m.nomeVia('R C 212'), m.nomeVia('AV T 63'), m.nomeVia('Pça Cívica'), m.classeVia(11), m.classeVia(40), m.classeVia(60)]; }""")
    assert nomes == ["R. C-212", "Av. T-63", "Pç. Cívica", "local", "arterial", "expressa"]


def test_lotes_so_do_bairro_escolhido(mapa):
    # Setor Sul: bairro pequeno do centro, carrega rápido.
    r = mapa.evaluate("""async () => {
      const b = bussola.lotes.bairros.find((x) => x.k === 's sul') || bussola.lotes.bairros.find((x) => /sul$/i.test(x.n));
      const ok = await bussola.lotes.adicionar(b.id, { voar: false });
      const it = bussola.lotes.escolhidos.get(b.id);
      const m = await import('./js/lotes.js');
      const foraDoBairro = it.lotes.filter((l) => !m.dentroDe(it.aneis, l.centro[0], l.centro[1])).length;
      const ids = new Set(it.lotes.map((l) => l.centro.join(',')));
      const res = { ok, nome: b.n, n: it.lotes.length, total: it.total, foraDoBairro, unicos: ids.size,
                    camada: !!bussola.lotes.camada, hash: location.hash.includes('l=' + b.id) };
      bussola.lotes.limpar();
      return { ...res, depois: !!bussola.lotes.camada };
    }""")
    assert r["ok"] and r["camada"] and not r["depois"], r
    assert 200 < r["n"] <= r["total"] and r["foraDoBairro"] == 0, r
    assert r["unicos"] >= r["n"] * 0.99, r
    assert r["hash"], r


def test_levantamento_lotes_limites_e_ficha(mapa):
    r = mapa.evaluate("""async () => {
      const lv = bussola.levantamento;
      await lv.carregar();
      const antes = { lotes: lv.dados.lotes.length, limites: lv.dados.limites.length, camada: !!lv.camadaLotes,
                      bordas: lv.fonte.entities.values.filter((e) => e.polyline).length };
      const tratou = lv.aoClicar(null, { lon: -49.2857, lat: -16.7077 });
      const titulo = document.querySelector('#ficha-titulo').textContent;
      lv.ocultas.add('Residencial'); lv.redesenhar();
      const semResid = lv._lotesVisiveis().some((l) => l.f === 'Residencial');
      lv.ocultas.delete('Residencial'); lv.opcoes.bairros[1] = false; lv.redesenhar();
      const soJA = lv._lotesVisiveis().every((l) => l.b === 0);
      lv.opcoes.bairros[1] = true; lv.campo.value = 'qd 262b lt 24'; lv._buscar();
      const achou = lv.resultados.textContent;
      lv.campo.value = ''; lv._buscar(); bussola.identificar.fechar();
      const ficha = (() => { lv.abrirLote(lv.dados.lotes.find((x) => (lv.empresasDoLote.get(x.i) || []).length)); return document.querySelector('#ficha-corpo').textContent; })();
      // Condomínio: a lista começa em " -- " (base geral) e cada unidade abre a sua própria base.
      const condo = lv.dados.lotes.find((x) => (lv.unidadesDoLote[x.i] || []).length > 6 && x.f === 'Condomínio residencial');
      lv.abrirLote(condo);
      const sel = document.querySelector('#lv-unidade');
      const unid = { opcoes: sel.options.length, primeira: sel.options[0].textContent, geral: document.querySelector('#ficha-corpo').textContent.includes('Inscrição do lote (CI)') };
      sel.value = '1'; sel.dispatchEvent(new Event('change'));
      unid.titulo = document.querySelector('#ficha-titulo').textContent;
      unid.corpo = document.querySelector('#ficha-corpo').textContent;
      unid.aindaTemLista = !!document.querySelector('#lv-unidade');
      lv.opcoes.predios = true; lv.redesenhar();
      unid.horizontais3d = lv.fonte.entities.values.filter((e) => e.polygon && e.levantamento?.dado?.f === 'Condomínio horizontal (casas)').length;
      lv.opcoes.predios = false; bussola.identificar.fechar();
      lv.opcoes.eleicao = 'ct'; lv.redesenhar();
      const ct = { setas: lv.fonte.entities.values.filter((e) => e.levantamento?.tipo === 'seta').length,
                   transf: lv.fonte.entities.values.filter((e) => e.levantamento?.dado?.tipo === 'transferido').length };
      lv.opcoes.eleicao = ''; lv.opcoes.bocas = true; lv.opcoes.iluminacao = true; lv.redesenhar();
      const infra = { bocas: lv.fonte.entities.values.filter((e) => e.levantamento?.tipo === 'boca').length,
                      postes: lv.fonte.entities.values.filter((e) => e.levantamento?.tipo === 'poste' && e.billboard).length };
      lv.abrirBoca(lv.dados.bocas.linhas[0]);
      infra.link = document.querySelector('#ficha-corpo a.botao.destaque')?.href || '';
      lv.opcoes.bocas = false; lv.opcoes.iluminacao = false; bussola.identificar.fechar(); lv.redesenhar();
      return { ...antes, tratou, titulo, semResid, soJA, achou, ficha, ct, infra, unid, hash: location.hash.includes('lv=1') };
    }""")
    assert r["lotes"] > 8000 and r["limites"] == 2 and r["camada"] and r["bordas"] >= 2, r
    assert r["tratou"] and r["titulo"].startswith("Quadra "), r
    assert not r["semResid"] and r["soJA"], r
    assert "262B" in r["achou"], r
    assert "mpresas no lote" in r["ficha"] and "Inscrição do lote (CI)" in r["ficha"], r["ficha"][:300]
    u = r["unid"]
    assert u["opcoes"] > 6 and u["primeira"].startswith(" -- ") and u["geral"], u
    assert u["titulo"].startswith(("Apartamento", "Sala", "Loja", "Casa", "Box")) and "UN-" in u["corpo"] and u["aindaTemLista"], u
    assert u["horizontais3d"] > 100, u
    assert r["ct"]["setas"] > 150 and r["ct"]["transf"] > 150, r["ct"]
    assert r["infra"]["bocas"] == 830 and r["infra"]["postes"] == 4147, r["infra"]
    assert r["infra"]["link"].startswith("https://claude.ai/artifact/") and "#BL-" in r["infra"]["link"], r["infra"]
    assert "Pedir manutenção (LT-" in r["ficha"], r["ficha"][:200]
    assert r["hash"], r


# ------------------------------------------------------------------ acesso
def test_edificios_trazem_os_predios_do_iptu(mapa):
    r = mapa.evaluate("""async () => {
      const ed = bussola.edificios;
      await ed.ligar(true);
      const k = ed.lista.find((e) => e.n === 'RES KINGDOM PARK'), j = ed.lista.find((e) => e.n === 'JARDA BY PALME');
      ed.selecionar(k.i);
      const ficha = document.querySelector('#ficha-corpo').textContent;
      const cor = (e) => ed.corDe(e).toCssHexString();
      const h = ed.lista.find((e) => e.uso === 'horizontal'), c = ed.lista.find((e) => e.uso === 'comercial'), o = { a: 0 };
      const cores = { residencial: cor(k), oficialComAptos: cor({ a: 12 }), horizontal: cor(h), comercial: cor(c), indefinido: cor(o), andarH: h.p, semRotulos: !ed.rotulos };
      bussola.identificar.fechar(); await ed.ligar(false);
      return { total: ed.lista.length, conferidos: ed.conferidos, kingdom: k.p, jarda: j.p, ficha, cores,
               repetidos: ed.lista.filter((e) => !e.lv && e.ci && ed.lista.some((x) => x.lv && x.ci === e.ci)).length };
    }""")
    assert r["conferidos"] > 600 and r["kingdom"] >= 50 and r["jarda"] >= 23, r
    assert "Inscrições de IPTU no lote" in r["ficha"] and "De onde veio" in r["ficha"], r["ficha"][:300]
    c = r["cores"]
    assert c["semRotulos"] and c["andarH"] == 1 and r["repetidos"] == 0, r
    assert c["residencial"] == "#2196f3" and c["oficialComAptos"] == "#2196f3" and c["horizontal"] == "#00bfa5" and c["comercial"] == "#e91e63" and c["indefinido"] == "#9e9e9e", c


def test_sem_login_volta_ao_portal(navegador, servidor):
    ctx = _contexto(navegador, logado=False)
    pagina = ctx.new_page()
    pagina.goto(f"{servidor}/sistema.html#ed=0")
    pagina.wait_for_url("**/index.html?volta=*")
    assert "sistema.html" in pagina.url and pagina.is_visible("#form-acesso")
    ctx.close()


def test_login_errado_e_certo(navegador, servidor):
    ctx = _contexto(navegador, logado=False)
    pagina = ctx.new_page()
    pagina.goto(f"{servidor}/index.html")
    pagina.fill("#login", "teste")
    pagina.fill("#senha", "senha-errada-000")
    pagina.click("#entrar")
    pagina.wait_for_selector("#mensagem:not([hidden])")
    assert "incorretos" in pagina.text_content("#mensagem")
    assert pagina.evaluate("sessionStorage.getItem('bussola:sessao') || localStorage.getItem('bussola:sessao')") is None
    pagina.fill("#login", "  TESTE ")
    pagina.fill("#senha", SENHA_TESTE)
    pagina.check("#lembrar")
    pagina.click("#entrar")
    pagina.wait_for_url("**/sistema.html")
    sessao = json.loads(pagina.evaluate("localStorage.getItem('bussola:sessao')"))
    assert sessao["login"] == "teste" and "resumo" not in sessao and "sal" not in sessao
    ctx.close()


def test_usuario_removido_perde_o_acesso(navegador, servidor):
    ctx = navegador.new_context()
    ctx.route("**/acesso/usuarios.json", lambda r: r.fulfill(status=200, content_type="application/json", body='{"usuarios": []}'))
    ctx.add_init_script("if (location.pathname.endsWith('sistema.html')) "
                        f"localStorage.setItem('bussola:sessao', JSON.stringify({json.dumps(SESSAO_TESTE)}))")
    pagina = ctx.new_page()
    pagina.goto(f"{servidor}/sistema.html#ed=0&r=0")
    pagina.wait_for_url("**/index.html", timeout=180_000)
    assert pagina.evaluate("localStorage.getItem('bussola:sessao')") is None
    ctx.close()


# ------------------------------------------------------- GPS e indicações
def test_gps_mostra_a_posicao(mapa):
    mapa.click("#nav-local")
    mapa.wait_for_function("bussola.localizacao.posicao !== null", timeout=30_000)
    assert mapa.get_attribute("#nav-local", "aria-pressed") == "true"
    pos = mapa.evaluate("bussola.localizacao.posicao")
    assert abs(pos["lat"] - GPS_JARDIM_AMERICA["latitude"]) < 1e-6
    mapa.evaluate("bussola.abrirPainel('local')")
    mapa.wait_for_function("!document.querySelector('#gps-endereco').classList.contains('carregando')", timeout=60_000)
    assert "Jardim Am" in mapa.text_content("#gps-endereco"), mapa.text_content("#gps-endereco")
    assert "GPS ativo" in mapa.text_content("#gps-estado")


def test_indicar_pela_posicao_e_abrir_o_link(mapa):
    mapa.evaluate("document.querySelector('[data-secao=local]').hidden && bussola.abrirPainel('local')")
    mapa.click("#ind-gps")
    mapa.wait_for_selector("#ind-tipo")
    mapa.select_option("#ind-tipo", "luz")
    mapa.fill("#ind-descricao", "Poste apagado em frente à praça")
    mapa.click("#ind-salvar")
    ind = mapa.evaluate("bussola.localizacao.lista[0]")
    assert ind["tipo"] == "luz" and ind["origem"] == "gps" and ind["autor"] == "Pessoa de Teste"
    assert "Poste apagado" in mapa.text_content(".ind-lista")
    link = mapa.evaluate("bussola.localizacao.linkDe(bussola.localizacao.lista[0])")
    assert "sistema.html#ind=" in link
    volta = mapa.evaluate("async (t) => (await import('./js/localizacao.js')).decodificarIndicacao(t)", link.split("#ind=")[1])
    assert abs(volta["lat"] - ind["lat"]) < 1e-6 and volta["descricao"] == ind["descricao"]
    # Quem recebe o link abre a Bússola direto no local indicado.
    mapa.evaluate("bussola.localizacao.caixaRecebida.hidden = true")
    mapa.goto(link.replace("#ind=", "#ed=0&r=0&ind="))
    mapa.wait_for_function("window.bussola && bussola.pronto", timeout=180_000)
    mapa.wait_for_selector(".ind-recebida", state="visible", timeout=30_000)
    assert "Iluminação pública" in mapa.text_content(".ind-recebida")
    mapa.evaluate("bussola.localizacao.parar()")
