"""Confere os arquivos de docs/data (sem rede): é o contrato entre o extrator e o mapa."""
from __future__ import annotations

import json
import math

from shapely.geometry import Point, Polygon, shape

from conftest import DADOS, ler

KM2_POR_GRAU2 = (111.32 ** 2) * math.cos(math.radians(16.69))
VIZINHOS_COM_DIVISA = {"Abadia de Goiás", "Aparecida de Goiânia", "Goianira", "Goianápolis", "Nerópolis",
                       "Santo Antônio de Goiás", "Senador Canedo", "Trindade"}


def test_arquivos_existem():
    for nome in ("territorio.geojson", "bairros.json", "edificios.json", "lugares.json",
                 "logradouros.json", "camadas.json", "satelite.json", "manifest.json"):
        assert (DADOS / nome).stat().st_size > 500, nome


def test_goiania(territorio, goiania):
    assert goiania.is_valid and goiania.geom_type == "Polygon"
    area = goiania.area * KM2_POR_GRAU2
    assert 700 < area < 780, f"área de Goiânia fora do esperado: {area:.1f} km²"
    props = territorio["features"][0]["properties"]
    assert abs(props["area_km2"] - area) / area < 0.01
    o, s, l, n = territorio["bbox"]
    assert goiania.bounds == (o, s, l, n) or all(
        abs(a - b) < 1e-4 for a, b in zip(goiania.bounds, (o, s, l, n)))
    assert goiania.contains(Point(-49.2556, -16.6816)), "Praça Cívica deve estar em Goiânia"


def test_limitrofes(territorio, goiania):
    vizinhos = [f for f in territorio["features"] if f["properties"]["tipo"] == "vizinho"]
    nomes = {f["properties"]["nome"] for f in vizinhos}
    assert VIZINHOS_COM_DIVISA <= nomes, f"faltam limítrofes: {VIZINHOS_COM_DIVISA - nomes}"
    assert "Goiânia" not in nomes and len(nomes) == len(vizinhos)
    for f in vizinhos:
        p, g = f["properties"], shape(f["geometry"])
        assert g.is_valid, p["nome"]
        # a máscara não pode invadir Goiânia nem deixar fresta visível na divisa
        assert g.intersection(goiania).area * KM2_POR_GRAU2 < 0.02, f"{p['nome']} sobrepõe Goiânia"
        assert g.distance(goiania) * 111_320 < 50, f"{p['nome']} não encosta em Goiânia"
        assert g.contains(Point(p["rotulo"])), f"rótulo de {p['nome']} fora do território"
        assert p["contato"] in ("divisa", "vertice")
        assert (p["divisa_km"] > 0.1) == (p["contato"] == "divisa")
        if p["nome"] in VIZINHOS_COM_DIVISA:
            assert p["contato"] == "divisa" and p["divisa_km"] > 5


def test_bairros(territorio):
    bairros = ler("bairros.json")["bairros"]
    assert len(bairros) > 1000
    o, s, l, n = territorio["bbox"]
    for b in bairros:
        assert b["n"] and b["k"] and b["id"]
        assert o - 0.02 <= b["c"][0] <= l + 0.02 and s - 0.02 <= b["c"][1] <= n + 0.02, b["n"]
        assert b["e"][0] <= b["c"][0] <= b["e"][2] and b["e"][1] <= b["c"][1] <= b["e"][3], b["n"]
    assert [b["pop"] for b in bairros[:50]] == sorted((b["pop"] for b in bairros[:50]), reverse=True)
    assert any(b["k"].endswith("jardim america") for b in bairros)
    assert 1_000_000 < sum(b["pop"] for b in bairros) < 2_000_000


def test_edificios(territorio, goiania):
    d = ler("edificios.json")
    eds = d["edificios"]
    assert len(eds) > 3000 and d["metros_por_pavimento"] > 0
    assert [e["p"] for e in eds] == sorted((e["p"] for e in eds), reverse=True)
    assert len({e["id"] for e in eds}) == len(eds), "edifício repetido"
    fora = 0
    for e in eds:
        assert isinstance(e["p"], int) and 0 <= e["p"] <= 80, e["n"]
        base = Polygon(e["f"])
        assert base.is_valid and len(e["f"]) >= 3, e["n"]
        area_m2 = base.area * KM2_POR_GRAU2 * 1e6
        assert 30 < area_m2 < 6000, f"{e['n']}: base de {area_m2:.0f} m²"
        fora += not goiania.buffer(0.001).contains(Point(e["c"]))
    assert fora == 0, f"{fora} edifícios fora de Goiânia"


def test_logradouros():
    d = ler("logradouros.json")
    assert len(d["ruas"]) > 10_000 and len(d["bairros"]) > 50
    for ident, nome, idx in d["ruas"]:
        assert ident and nome and 0 <= idx < len(d["bairros"])
    assert any("Anhangüera" in r[1] for r in d["ruas"])


def test_lugares(goiania):
    lugares = ler("lugares.json")["lugares"]
    tipos = {x["tipo"] for x in lugares}
    assert {"parque", "educacao", "saude"} <= tipos and len(lugares) > 300
    perto = goiania.buffer(0.01)
    for x in lugares:
        assert x["n"] and perto.contains(Point(x["c"])), x["n"]


def test_camadas():
    c = ler("camadas.json")
    temas = c["temas"]
    oficiais = [t for t in temas if t["oficial"]]
    assert len(oficiais) >= 12, "o portal tinha 15 temas na extração de referência"
    assert len({t["chave"] for t in temas}) == len(temas)
    consulta = [t for t in temas if t["somente_consulta"]]
    assert len(consulta) == 1 and consulta[0]["chave"] == "Feature_Base"
    assert {0, 1, 2} <= {x["id"] for x in consulta[0]["camadas"]}
    for t in temas:
        assert t["url"].startswith("https://") and t["url"].endswith("/MapServer"), t["chave"]
        ids = [x["id"] for x in t["camadas"]]
        assert ids and len(set(ids)) == len(ids), t["chave"]
        for x in t["camadas"]:
            assert x["pai"] == -1 or x["pai"] in ids, f"{t['chave']}: pai inexistente"
    chaves = {b["chave"] for b in c["bases"]}
    assert {"orto2006", "orto2011", "orto2016", "basico"} <= chaves
    assert all(9 <= b["nivel_minimo"] <= 13 for b in c["bases"])
    assert c["hibrido"]["url"].endswith("Mapa_Basico3/MapServer")
    assert len(c["catalogo_servidor"]) >= 40


def test_satelite_historico():
    d = ler("satelite.json")
    versoes = d["versoes"]
    assert len(versoes) >= 3, "poucas datas de captura"
    datas = [v["captura"] for v in versoes]
    assert datas == sorted(datas) and len(set(datas)) == len(datas), "datas fora de ordem ou repetidas"
    for v in versoes:
        assert v["url"].startswith("https://wayback.maptiles.arcgis.com/") and v["url"].endswith("/{z}/{y}/{x}")
        assert 17 <= v["nivel_maximo"] <= 19 and v["versao"] > 0
        assert "2010-01-01" < v["captura"] <= v["publicada"], "a captura não pode ser posterior à publicação"


def test_manifesto():
    m = ler("manifest.json")
    assert m["atualizado_em"].endswith("Z") and m["versao_extrator"]
    assert set(m["etapas"]) >= {"territorio", "bairros", "edificios", "lugares", "logradouros", "camadas", "satelite"}
    assert len(m["etapas"]["territorio"]["vizinhos"]) >= 8


def test_usuarios_sem_senha_em_texto():
    """O arquivo de acesso guarda só resumos PBKDF2; nunca a senha."""
    import json
    from conftest import DOCS
    dados = json.loads((DOCS / "acesso" / "usuarios.json").read_text(encoding="utf-8"))
    assert dados["usuarios"], "precisa haver ao menos um usuário"
    for u in dados["usuarios"]:
        assert set(u) <= {"login", "nome", "perfil", "ativo", "sal", "iteracoes", "resumo"}, u.keys()
        assert u["login"] == u["login"].strip().lower()
        assert len(u["sal"]) == 32 and len(u["resumo"]) == 64 and u["iteracoes"] >= 310_000
    assert any(u.get("perfil") == "admin" for u in dados["usuarios"])


def test_script_de_usuarios(tmp_path, monkeypatch):
    import usuarios
    monkeypatch.setattr(usuarios, "ARQUIVO", tmp_path / "u.json")
    usuarios.main(["adicionar", "Maria.S", "Maria Souza", "--senha", "uma-senha-boa"])
    import json
    u = json.loads((tmp_path / "u.json").read_text())["usuarios"][0]
    assert u["login"] == "maria.s" and u["resumo"] == usuarios.resumo("uma-senha-boa", u["sal"])
    usuarios.main(["desativar", "maria.s"])
    assert json.loads((tmp_path / "u.json").read_text())["usuarios"][0]["ativo"] is False
    assert "-" in usuarios.gerar_senha() and len(usuarios.gerar_senha()) == 14


def test_levantamento_da_associacao():
    """Levantamento do Jardim América e do Nova Suíça: todas as abas e camadas do KML."""
    d = ler("levantamento.json")
    assert d["bairros"] == ["Jardim América", "Nova Suíça"]
    assert len(d["limites"]) == 2 and all(lim["aneis"] and len(lim["aneis"][0]) > 50 for lim in d["limites"])
    assert len(d["lotes"]) > 8000 and all(l["g"] and len(l["g"][0]) >= 6 for l in d["lotes"])
    assert all(len(l["v"]) == len(d["colunas_lote"]) for l in d["lotes"])
    assert {"Contatos do levantamento", "Telefones do levantamento", "ID do lote (Mapa Fácil)"} <= set(d["colunas_lote"])
    assert sum(f["n"] for f in d["finalidades"]) == len(d["lotes"])
    assert len(d["empresas"]["linhas"]) > 13000 and {"Telefone", "E-mail", "CNPJ"} <= set(d["empresas"]["colunas"])
    assert sum(1 for e in d["empresas"]["linhas"] if e["lote"] is not None) > 13000
    assert len(d["empresas_sem_lote"]["linhas"]) > 3000 and len(d["google"]["linhas"]) > 200
    assert len(d["condominios"]["linhas"]) > 500 and len(d["areas"]) > 100
    e = d["eleitoral"]
    tipos = {p["tipo"] for p in e["pontos"]}
    assert tipos == {"geral", "ct", "transferido", "sem"} and len(e["setas"]) > 150
    assert len({p["grupo"] for p in e["pontos"] if p["tipo"] == "geral"}) >= 9
    assert len(e["locais"]["linhas"]) > 300 and len(e["conselho"]["linhas"]) > 100


def test_condominios_e_unidades():
    """Condomínio = mais de 5 inscrições de IPTU (ou outro indício); cada unidade tem a sua base e " -- " é a geral."""
    d = ler("levantamento.json")
    tipos = {"Condomínio horizontal (casas)", "Condomínio residencial", "Condomínio comercial", "Condomínio misto"}
    cores = {f["nome"]: f["cor"] for f in d["finalidades"]}
    assert tipos <= set(cores) and len({cores[t] for t in tipos}) == 4, "cada tipo de condomínio tem a sua cor"
    assert "Condominial" not in cores
    u = d["unidades"]
    assert u["colunas"][:3] == ["Unidade", "Tipo da unidade", "Inscrição de IPTU da unidade"]
    condominios = [i for i, l in enumerate(d["lotes"]) if l["f"] in tipos]
    assert len(condominios) > 500 and set(u["por_lote"]) == {str(i) for i in condominios}
    for i in condominios:
        linhas = u["por_lote"][str(i)]
        assert linhas[0][0] == " -- " and linhas[0][1] == "Condomínio (geral)", d["lotes"][i]["v"][:4]
        assert all(str(x[-1]).startswith("UN-") for x in linhas[1:]) and str(linhas[0][-1]).startswith("LT-")
        assert d["lotes"][i]["g"], "todo condomínio tem polígono"
    horizontais = [i for i in condominios if d["lotes"][i]["f"] == "Condomínio horizontal (casas)"]
    casas = sum(1 for i in horizontais for x in u["por_lote"][str(i)][1:] if x[1] == "Casa")
    assert casas > 300
    k = d["colunas_lote"].index("Unidades no cadastro")
    assert all(l["f"] in tipos for l in d["lotes"] if (l["v"][k] or 0) > 5), "mais de 5 inscrições é sempre condomínio"


def test_nomes_de_bairro_sem_tipo():
    b = {x["id"]: x for x in ler("bairros.json")["bairros"]}
    assert b["000400000015"]["n"] == "Jardim América" and b["000400000017"]["n"].startswith("Nova Sui")
    nomes = [x["n"] for x in b.values()]
    assert not any(n.split()[0] in ("Bro", "S", "Cj", "Cjr", "Jd", "Vl", "Res", "Prq") for n in nomes if n)
    import extrair_dados as ex
    assert ex.nome_bairro("S", "Bueno", "S Bueno") == "Bueno" and ex.nome_bairro("Jd", "Goiás", "Jd Goiás") == "Jardim Goiás"
    assert ex.nome_bairro("Bro", "da Vitória", "Bro da Vitória") == "Bairro da Vitória"


def test_infraestrutura_e_manutencao():
    d = ler("levantamento.json")
    assert d["manutencao"].startswith("https://claude.ai/artifact/")
    assert [l["lotes"] for l in d["limites"]] == [8029, 984] and len(d["limites_oficiais"]) == 2
    bl, ip = d["bocas"], d["iluminacao"]
    kb = bl["colunas"].index("Unidades em sequência")
    assert len(bl["linhas"]) == 830 and sum(b["v"][kb] for b in bl["linhas"]) == 1580
    assert all((DADOS.parent / "img" / "icones" / b["icone"]).exists() for b in bl["linhas"])
    assert len(ip["linhas"]) == 4147 and (DADOS.parent / "img" / "icones" / "lampada.png").exists()
    k = d["colunas_lote"].index("Código para manutenção")
    assert all(str(l["v"][k]).startswith("LT-") for l in d["lotes"])
