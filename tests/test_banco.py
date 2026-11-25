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


@pytest.mark.navegador
def test_temas_e_mapa_basico_do_banco(navegador, servidor):
    """Temas do painel Camadas desenhados dos dados locais e o Mapa Básico em blocos locais, sem o servidor municipal."""
    man = manifesto()
    if "Mapa_ModeloEspacial" not in man["servicos"]:
        pytest.skip("projetos ainda não estão no banco")
    ctx = _contexto(navegador)
    pedidos = []
    ctx.route("**/portalmapa.goiania.go.gov.br/**", lambda r: (pedidos.append(r.request.url), r.abort()))
    pg = ctx.new_page()
    pg.goto(f"{servidor}/sistema.html#ed=0&r=0")
    pg.wait_for_function("window.bussola && (window.bussola.pronto || window.bussola.erros.length)", timeout=180_000)
    r = pg.evaluate("""async () => {
      const { ProvedorTema, imagemLocal } = await import('./js/banco.js');
      const preenchidos = (tela) => { const d = tela.getContext('2d').getImageData(0, 0, tela.width, tela.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
      // nível 14 sobre o Jardim América
      const n = 2 ** 14, x = Math.floor((-49.2817 + 180) / 360 * n), s = Math.sin(-16.7047 * Math.PI / 180);
      const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
      const zona = new ProvedorTema({ servico: 'Mapa_ModeloEspacial', camadas: [1, 2, 3, 4, 5, 7, 8, 9, 10] });
      const postes = new ProvedorTema({ servico: 'Mapa_Energia', camadas: [4] });
      // Desenho direto (sem o nível do pedido): a fila descarta blocos 2+ níveis longe da câmera, e aqui a
      // câmera está na cidade inteira — o que se confere é o desenho a partir do banco, não a fila.
      const t1 = await zona._desenhar(x, y, 14, {});
      const t2 = await postes._desenhar(x * 8, y * 8, 17, {});
      const basico = imagemLocal('Mapa_Basico3');
      const url = basico ? basico.url : '';
      return { zona: preenchidos(t1), postes: preenchidos(t2), basico: !!basico, url };
    }""")
    ctx.close()
    assert r["zona"] > 1000 and r["postes"] > 50, r
    if "imagens" in man:
        assert r["basico"] and "banco/blocos/Mapa_Basico3" in r["url"], r
    assert not pedidos, pedidos[:5]


def test_dados_pessoais_so_no_cofre():
    """Campos pessoais não aparecem em claro em nenhum arquivo do banco: só nos .pess, cifrados."""
    man = manifesto()
    if "cofre" not in man:
        pytest.skip("banco montado sem cofre")
    info = man["servicos"]["Mapa_Tributario_Web"]["camadas"]["0"]
    assert "CPF_CNPJ" in info["pessoais"] and "CPF_CNPJ" not in info["campos"]
    b = info["blocos"][0]
    claro = gzip.open(BANCO / "dados" / "Mapa_Tributario_Web" / "0" / str(info["z"]) / f"{b}.json.gz", "rt", encoding="utf-8").read()
    assert "CPF_CNPJ" not in claro and "PROPRIETAR" not in claro
    cifrado = (BANCO / "dados" / "Mapa_Tributario_Web" / "0" / str(info["z"]) / f"{b}.pess").read_bytes()
    assert cifrado[12:14] != b"\x1f\x8b", "o .pess precisa estar cifrado"


@pytest.mark.navegador
def test_cofre_abre_so_com_a_senha(navegador, servidor):
    man = manifesto()
    if "cofre" not in man:
        pytest.skip("banco montado sem cofre")
    senha = os.environ.get("BUSSOLA_SENHA_COFRE", "")
    ctx = _contexto(navegador)
    ctx.route("**/portalmapa.goiania.go.gov.br/**", lambda r: r.abort())
    pg = ctx.new_page()
    pg.goto(f"{servidor}/sistema.html#ed=0&r=0")
    pg.wait_for_function("window.bussola && (window.bussola.pronto || window.bussola.erros.length)", timeout=180_000)
    r = pg.evaluate("""async (senha) => {
      const b = await import('./js/banco.js');
      let errada = false;
      try { await b.abrirCofre('senha-errada'); } catch { errada = true; }
      const T = 'https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer/Mapa_Tributario_Web/MapServer/0/query';
      const pede = async () => (await fetch(`${T}?${new URLSearchParams({ f: 'json', geometry: '-49.290591,-16.698472', geometryType: 'esriGeometryPoint', inSR: '4326', outFields: '*', returnGeometry: 'false' })}`)).json();
      const fechado = await pede();
      let aberto = null;
      if (senha) { await b.abrirCofre(senha); aberto = await pede(); b.fecharCofre(); }
      return { errada, fechado: fechado.features?.[0]?.attributes || null, aberto: aberto?.features?.[0]?.attributes || null };
    }""", senha)
    ctx.close()
    assert r["errada"] and r["fechado"] and "PROPRIETAR" not in r["fechado"], r
    if senha:
        assert r["aberto"] and r["aberto"].get("PROPRIETAR"), r
