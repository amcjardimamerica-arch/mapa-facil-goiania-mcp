"""Testes de ponta a ponta no navegador (precisam de rede e do Chromium do Playwright).

    pip install -r requirements-dev.txt && playwright install chromium
    pytest -m navegador
"""
from __future__ import annotations

import functools
import http.server
import os
import threading

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


@pytest.fixture(scope="module")
def mapa(navegador, servidor):
    """Abre o mapa uma vez (sem relevo nem edifícios, para ser rápido em CPU)."""
    pagina = navegador.new_page(viewport={"width": 1280, "height": 800})
    erros = []
    pagina.on("pageerror", lambda e: erros.append(str(e)))
    pagina.goto(f"{servidor}/index.html#ed=0&r=0")
    pagina.wait_for_function("window.bussola && (window.bussola.pronto || window.bussola.erros.length)", timeout=180_000)
    pagina.erros_de_pagina = erros
    yield pagina
    pagina.close()


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
    assert "Bairro" in corpo and "S Oeste" in corpo, corpo[:300]
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


def test_pagina_de_validacao(navegador, servidor):
    pagina = navegador.new_page()
    pagina.goto(f"{servidor}/validacao.html")
    pagina.wait_for_function("window.validacao && window.validacao.fim", timeout=420_000)
    resumo = pagina.evaluate("({resumo: window.validacao.resumo, falhas: window.validacao.testes.filter((t) => t.estado === 'falha')})")
    pagina.close()
    assert resumo["resumo"]["total"] > 30
    assert resumo["falhas"] == [], resumo["falhas"]
