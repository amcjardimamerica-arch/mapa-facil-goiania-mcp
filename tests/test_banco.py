"""Banco local (docs/banco/): os dados do Mapa Fácil guardados no site e o sistema funcionando sem o servidor da Prefeitura."""
from __future__ import annotations

import csv
import gzip
import json
import os

import pytest

from conftest import DOCS
from test_app import navegador, servidor, _contexto  # noqa: F401  (fixtures do navegador)

BANCO = DOCS / "banco"
pytestmark = pytest.mark.skipif(not (BANCO / "manifesto.json").exists(), reason="banco local não montado")


def manifesto():
    return json.loads((BANCO / "manifesto.json").read_text(encoding="utf-8"))


def test_base_cadastral_completa():
    """As camadas da Base Cadastral estão no banco com a mesma quantidade de feições do servidor."""
    c = manifesto()["servicos"]["Feature_Base"]["camadas"]
    assert c["0"]["total"] == 399522 and c["0"]["z"] == 15 and "ci" in c["0"]["indices"]
    assert c["1"]["total"] == 25755 and c["2"]["total"] == 1209 and c["7"]["total"] == 69288
    assert c["3"]["agrupado"] == "ci" and c["3"]["total"] > 780000, "cadastro imobiliário (unidades de IPTU)"
    for k in ("4", "5", "6", "8", "9", "10"):
        assert c[k]["total"] > 0, k


def test_metadados_e_legendas():
    for s in manifesto()["servicos"]:
        pasta = BANCO / "servicos" / s
        assert (pasta / "MapServer.json").exists(), s
    assert json.loads((BANCO / "servicos" / "Feature_Base" / "0.json").read_text(encoding="utf-8"))["name"] == "Divisas de Lote"


def test_conferencia_sem_perdas():
    arq = BANCO / "conferencia.csv"
    assert arq.exists()
    for l in csv.DictReader(arq.open(encoding="utf-8")):
        if l["esperado"].isdigit() and int(l["esperado"]) > 0 and l["falhas"] in ("", "0"):  # pendências ficam registradas em falhas
            assert abs(int(l["baixado"]) - int(l["esperado"])) <= max(5, 0.005 * int(l["esperado"])), l


def test_bloco_de_lotes_decodifica():
    info = manifesto()["servicos"]["Feature_Base"]["camadas"]["0"]
    b = info["blocos"][len(info["blocos"]) // 2]
    d = json.load(gzip.open(BANCO / "dados" / "Feature_Base" / "0" / "15" / f"{b}.json.gz", "rt", encoding="utf-8"))
    assert d["c"] == info["campos"] and d["g"] == "area" and d["f"]
    oid, valores, enc = d["f"][0]
    x = y = 0
    for i in range(0, len(enc[0]), 2):
        x += enc[0][i]; y += enc[0][i + 1]
        assert -49.6 < x / 1e6 < -48.9 and -17.0 < y / 1e6 < -16.3


@pytest.mark.navegador
def test_sistema_funciona_sem_o_servidor_da_prefeitura(navegador, servidor):
    """Com o servidor municipal bloqueado: ficha do lote, cadastro imobiliário, busca por inscrição e lotes de perto."""
    ctx = _contexto(navegador)
    pedidos = []
    ctx.route("**/portalmapa.goiania.go.gov.br/**", lambda r: (pedidos.append(r.request.url), r.abort()))
    pg = ctx.new_page()
    pg.goto(f"{servidor}/sistema.html#ed=0&r=0")
    pg.wait_for_function("window.bussola && (window.bussola.pronto || window.bussola.erros.length)", timeout=180_000)
    r = pg.evaluate("""async () => {
      const B = 'https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer/Feature_Base/MapServer';
      const pede = async (u, p) => (await fetch(`${u}?${new URLSearchParams({ f: 'json', ...p })}`)).json();
      const ci = await pede(`${B}/0/query`, { where: "ci = '3061190239'", outFields: 'id,ci,nm_lot', returnGeometry: 'true', outSR: '4326' });
      const anel = ci.features[0].geometry.rings[0];
      const lon = anel.reduce((s, p) => s + p[0], 0) / anel.length, lat = anel.reduce((s, p) => s + p[1], 0) / anel.length;
      const cad = await pede(`${B}/3/query`, { where: "ci = '3061190239'", outFields: 'nrinscr,ci,nmedificio', returnGeometry: 'false', orderByFields: 'nrinscr' });
      const bairro = await pede(`${B}/2/query`, { where: "id = '000400000015'", outFields: 'id,nm', returnGeometry: 'true', outSR: '3857' });
      const x = lon * Math.PI / 180 * 6378137, y = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 6378137;
      const ident = await pede(`${B}/identify`, { geometry: `${x},${y}`, geometryType: 'esriGeometryPoint', sr: '3857', layers: 'all:0,1,2',
        tolerance: 1, mapExtent: `${x - 100},${y - 100},${x + 100},${y + 100}`, imageDisplay: '400,400,96', returnGeometry: 'true' });
      const env = await pede(`${B}/0/query`, { geometry: `${x - 150},${y - 150},${x + 150},${y + 150}`, geometryType: 'esriGeometryEnvelope',
        inSR: '3857', outSR: '3857', where: '1=1', outFields: 'nm_lot', returnGeometry: 'true', geometryPrecision: '1' });
      return { ci: ci.features.length, cad: cad.features.length, edificio: cad.features[0]?.attributes.nmedificio,
               bairro: bairro.features[0]?.attributes.nm, aneis: bairro.features[0]?.geometry.rings.length,
               ident: ident.results.map((r) => r.layerId), loteIdent: ident.results.find((r) => r.layerId === 0)?.attributes.ci,
               env: env.features.length };
    }""")
    ctx.close()
    assert r["ci"] == 1 and r["cad"] == 3, r  # Quadra 514, lote 1: 3 inscrições
    assert r["bairro"] and r["aneis"] >= 1, r
    assert r["ident"][:1] == [0] and set(r["ident"]) >= {0, 1, 2} and r["loteIdent"] == "3061190239", r
    assert r["env"] > 20, r
    assert not pedidos, f"o sistema pediu ao servidor da Prefeitura: {pedidos[:5]}"
