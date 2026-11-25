"""Regiões do Conselho Tutelar de Goiânia pela delimitação oficial -> docs/data/conselho_regioes.geojson.

    python scripts/regioes_conselho.py PASTA_DA_EXTRACAO [planilha.xlsx]

PASTA_DA_EXTRACAO é a saída de scripts/extrair_mapafacil.py (usa Mapa_Limites/6 e Feature_Base/2).

Base oficial: Resolução CMDCA n.º 85, de 14/03/2023 (gestão 2024-2028). Cada um dos 6 Conselhos Tutelares
atende duas das 12 Regiões de planejamento da Prefeitura (SEPLAM), que o Mapa Fácil publica em
Mapa_Limites/6 "Divisas de Região (12)":

    Centro-Sul = Central + Sul           Oeste    = Macambira-Cascavel + Sudoeste
    Noroeste   = Mendanha + Noroeste     Norte    = Vale do Meia Ponte + Norte
    Leste      = Leste + Sudeste         Campinas = Campinas + Oeste

As divisas das 12 regiões seguem as divisas de bairro. Ajustes, todos registrados no arquivo:
- bairros que a Resolução põe em outra região (Alphaville, Rio Verde e Forte Ville, que ela lista na Sudoeste e
  o edital de 2023 também votou no Conselho Oeste) vão para a região da Resolução;
- bairros fora das 12 regiões (loteamentos novos na borda) vão para a região que a Resolução indica
  (Jardins do Cerrado -> Oeste); sem indicação, para a do local de votação do edital de 2023 que fica dentro
  dele; sem nenhum dos dois, para a região vizinha mais próxima ("por proximidade").
Os locais de votação vêm do edital de 2023 (levantamento.json, aba "Conselho Tutelar").
"""
from __future__ import annotations

import gzip
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

from shapely.geometry import Point, mapping, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extrair_dados import projecao_local  # noqa: E402

RAIZ = Path(__file__).resolve().parent.parent
SAIDA = RAIZ / "docs" / "data" / "conselho_regioes.geojson"

CONSELHOS = {
    "Centro-Sul": {"regioes": ["Central", "Sul"], "sede": "Praça Central, Qd. 60, Lt. 06/08 (Av. Circular), Setor Pedro Ludovico",
                   "telefone": "(62) 3524-1760", "plantao": "Plantão 1 — (62) 98145-2630"},
    "Oeste": {"regioes": ["Macambira-Cascavel", "Sudoeste"], "sede": "Rua U-59 com Rua U-47, Setor União",
              "telefone": "(62) 3524-1765", "plantao": "Plantão 2 — (62) 98145-2586"},
    "Noroeste": {"regioes": ["Mendanha", "Noroeste"], "sede": "Av. do Povo, Qd. 10, Lt. 11, Jardim Curitiba I",
                 "telefone": "(62) 3595-5106", "plantao": "Plantão 2 — (62) 98145-2586"},
    "Norte": {"regioes": ["Vale do Meia Ponte", "Norte"], "sede": "Rua Serra Dourada, Jardim Diamantina",
              "telefone": "", "plantao": "Plantão 1 — (62) 98145-2630"},
    "Leste": {"regioes": ["Leste", "Sudeste"], "sede": "Av. do Ouro, Chácara 329, Jardim Novo Mundo",
              "telefone": "(62) 3524-1752", "plantao": "Plantão 1 — (62) 98145-2630"},
    "Campinas": {"regioes": ["Campinas", "Oeste"], "sede": "Rua dos Ferroviários, Qd. 23, Lt. 10, Esplanada do Anicuns",
                 "telefone": "(62) 3524-2481", "plantao": "Plantão 2 — (62) 98145-2586"},
}
REG2CT = {r: c for c, d in CONSELHOS.items() for r in d["regioes"]}

# Bairros que a Resolução 85/2023 (e o edital de 2023) põem em região diferente do desenho da SEPLAM.
AJUSTES = {
    "Lot Alphaville Residencial": "Sudoeste", "Jd Alphaville": "Sudoeste", "Res Alphaville": "Sudoeste",
    "Jd Alphavilly I": "Sudoeste", "Res Rio Verde": "Sudoeste", "Res Forteville": "Sudoeste",
    "Res Forte Ville - Extensão": "Sudoeste",
}
# Bairros fora das 12 regiões que a Resolução nomeia.
FORA_PELA_RESOLUCAO = [(re.compile(r"jardins? do cerrado", re.I), "Oeste")]

FONTE = ("Resolução CMDCA Goiânia n.º 85/2023 (circunscrições dos Conselhos Tutelares, gestão 2024-2028) sobre as "
         "12 Regiões da SEPLAM (Mapa Fácil, Mapa_Limites/6); locais de votação do edital de 2023 do CMDCA")


def regiao_nome(nm: str) -> str:
    n = nm.replace("REGIÃO ", "").strip().title()
    return n.replace(" Do ", " do ").replace("-cascavel", "-Cascavel")


def sem_acento(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def limpar(g, minimo=2e-7):
    """Tira furos e ilhas de menos de ~2.400 m² (frestas entre os desenhos de região e de bairro)."""
    from shapely.geometry import MultiPolygon, Polygon
    partes = []
    for p in getattr(g, "geoms", [g]):
        if p.geom_type != "Polygon" or p.area < minimo:
            continue
        partes.append(Polygon(p.exterior, [i for i in p.interiors if Polygon(i).area >= minimo]))
    return partes[0] if len(partes) == 1 else MultiPolygon(partes)


def ler(caminho: Path):
    return json.load(gzip.open(caminho, "rt", encoding="utf-8"))["features"]


def main(pasta: str, planilha: str | None = None) -> int:
    base = Path(pasta) / "dados"
    para_m, _ = projecao_local(-49.28, -16.71)
    reg = {regiao_nome(f["properties"]["nm_reg"]): shape(f["geometry"]).buffer(0)
           for f in ler(base / "Mapa_Limites" / "6-divisas-de-regiao-12.geojson.gz")}
    assert set(reg) == set(REG2CT), sorted(set(reg) ^ set(REG2CT))
    ter = json.loads((RAIZ / "docs/data/territorio.geojson").read_text(encoding="utf-8"))
    limite = shape(next(f for f in ter["features"] if f["properties"].get("tipo") == "goiania")["geometry"]).buffer(0)

    nomes = list(reg)
    arv = STRtree([reg[n] for n in nomes])
    reg_m = {n: para_m(g) for n, g in reg.items()}
    bairros = []
    for f in ler(base / "Feature_Base" / "2-divisas-de-bairro.geojson.gz"):
        if not f["geometry"]:
            continue
        p = f["properties"]
        g = shape(f["geometry"]).buffer(0)
        if g.is_empty:
            continue
        partes = {}
        for k in arv.query(g):
            a = g.intersection(reg[nomes[k]]).area / g.area
            if a > 0.001:
                partes[nomes[k]] = a
        bairros.append({"id": p.get("id"), "nome": (p.get("nm") or "").strip(), "pop": p.get("pop_total") or 0,
                        "g": g, "partes": partes, "fora": max(0.0, 1 - sum(partes.values())), "ajuste": ""})

    lev = json.loads((RAIZ / "scripts/dados/levantamento.json").read_text(encoding="utf-8"))
    L = lev["eleitoral"]["locais"]
    lc_ = {c: i for i, c in enumerate(L["colunas"])}
    pontos_edital = [(x[lc_["Longitude"]], x[lc_["Latitude"]], x[lc_["CT — região"]], x[lc_["Local de votação"]])
                     for x in L["linhas"] if x[lc_["CT — região"]] and x[lc_["Latitude"]] and x[lc_["Longitude"]]]

    # Ajustes: bairro inteiro para a região da Resolução; bairro fora das 12 regiões para a região indicada/próxima.
    todas = unary_union(list(reg.values()))
    extra = defaultdict(list)   # região -> polígonos acrescentados
    tirar = defaultdict(list)   # região -> polígonos retirados
    for b in bairros:
        if b["nome"] in AJUSTES:
            destino = AJUSTES[b["nome"]]
            for r in b["partes"]:
                if r != destino:
                    tirar[r].append(b["g"])
            extra[destino].append(b["g"])
            b["partes"] = {destino: 1.0}
            b["ajuste"] = "Resolução 85/2023"
        elif b["fora"] > 0.5:
            destino = next((r for rx, r in FORA_PELA_RESOLUCAO if rx.search(sem_acento(b["nome"]))), None)
            motivo = "Resolução 85/2023 (fora das 12 regiões da SEPLAM)"
            gm = para_m(b["g"])
            pelo_edital = [(nome, ct) for x, y, ct, nome in pontos_edital if b["g"].contains(Point(x, y))]
            if not destino and pelo_edital:
                nome, ct = pelo_edital[0]
                destino = min(CONSELHOS[ct]["regioes"], key=lambda r: gm.distance(reg_m[r]))
                motivo = f"edital de 2023 (local {nome} votou no Conselho {ct})"
            if not destino:
                destino = min(reg_m, key=lambda r: gm.distance(reg_m[r]))
                motivo = f"por proximidade ({round(gm.distance(reg_m[destino]))} m da Região {destino})"
            extra[destino].append(b["g"].difference(todas))
            b["partes"] = {**b["partes"], destino: b["partes"].get(destino, 0) + b["fora"]}
            b["fora"] = 0.0
            b["ajuste"] = motivo

    final = {}
    for r, g in reg.items():
        if tirar[r]:
            g = g.difference(unary_union(tirar[r]))
        if extra[r]:
            g = unary_union([g, *extra[r]])
        final[r] = limpar(g.buffer(0).intersection(limite).buffer(0))

    for b in bairros:
        b["ct"] = defaultdict(float)
        for r, a in b["partes"].items():
            b["ct"][REG2CT[r]] += a
        b["conselho"] = max(b["ct"], key=b["ct"].get) if b["ct"] else None
        b["regiao"] = max(b["partes"], key=b["partes"].get) if b["partes"] else None

    K = lev["eleitoral"]["conselho"]
    kc = {c: i for i, c in enumerate(K["colunas"])}
    locais = defaultdict(list)
    for linha in K["linhas"]:
        locais[linha[kc["Região"]]].append(linha)

    def pronto(nome: str) -> str:
        return re.sub(r"\s+", " ", nome).strip()

    feats = []
    for c, d in CONSELHOS.items():
        g = limpar(unary_union([final[r] for r in d["regioes"]])).simplify(0.00002, preserve_topology=True)
        do_ct = [b for b in bairros if b["conselho"] == c and b["ct"][c] >= 0.5 and not b["nome"].lower().startswith("gleba")]
        divididos = sorted({b["nome"] for b in bairros if 0.1 < b["ct"].get(c, 0) < 0.9 and not b["nome"].lower().startswith("gleba")})
        lc = locais.get(c, [])
        feats.append({"type": "Feature", "properties": {
            "tipo": "conselho", "regiao": c, "regioes_administrativas": d["regioes"],
            "area_km2": round(para_m(g).area / 1e6, 1),
            "populacao": round(sum(b["pop"] * b["ct"].get(c, 0) for b in bairros)),
            "bairros_n": len(do_ct), "bairros": sorted({b["nome"] for b in do_ct}), "bairros_divididos": divididos,
            "ajustes": sorted({f'{b["nome"]}: {b["ajuste"]}' for b in bairros if b["ajuste"] and b["conselho"] == c}),
            "locais": len(lc), "urnas": sum(x[kc["Urnas"]] or 0 for x in lc),
            "eleitores": sum(x[kc["Eleitores aptos"]] or 0 for x in lc),
            "locais_votacao": [pronto(x[kc["Local de votação do CT"]]) for x in lc],
            "sede": d["sede"], "telefone": d["telefone"], "plantao": d["plantao"]},
            "geometry": mapping(g)})
    for r, g in final.items():
        feats.append({"type": "Feature", "properties": {"tipo": "regiao_administrativa", "regiao": r, "conselho": REG2CT[r],
                                                        "area_km2": round(para_m(g).area / 1e6, 1)},
                      "geometry": mapping(g.simplify(0.00002, preserve_topology=True))})
    saida = {"type": "FeatureCollection", "nota": FONTE, "features": feats}
    SAIDA.write_text(json.dumps(saida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{SAIDA.name}: {SAIDA.stat().st_size // 1024} KB")
    for f in feats[:6]:
        p = f["properties"]
        print(f"  {p['regiao']:11s} {p['area_km2']:6.1f} km²  {p['populacao']:>8,} hab.  {p['bairros_n']:3d} bairros  "
              f"{p['locais']:3d} locais  {p['urnas']:4d} urnas  {p['eleitores']:>8,} eleitores")

    if planilha:
        gravar_planilha(planilha, feats, bairros, K, kc)
    return 0


def gravar_planilha(caminho, feats, bairros, K, kc):
    import openpyxl
    from openpyxl.styles import Font
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Regiões"
    ws.append(["Conselho Tutelar", "Regiões administrativas (SEPLAM)", "Área (km²)", "População (Mapa Fácil)", "Bairros",
               "Locais de votação 2023", "Urnas", "Eleitores aptos", "Sede", "Telefone", "Plantão"])
    for f in feats[:6]:
        p = f["properties"]
        ws.append([p["regiao"], " + ".join(p["regioes_administrativas"]), p["area_km2"], p["populacao"], p["bairros_n"],
                   p["locais"], p["urnas"], p["eleitores"], p["sede"], p["telefone"], p["plantao"]])
    ws2 = wb.create_sheet("Bairros")
    ws2.append(["Bairro (Mapa Fácil)", "ID", "Conselho Tutelar", "Região administrativa", "% no Conselho", "Outros Conselhos (%)",
                "População", "Ajuste"])
    for b in sorted(bairros, key=lambda b: (b["conselho"] or "~", b["nome"])):
        outros = "; ".join(f"{c} {round(a * 100)}%" for c, a in sorted(b["ct"].items()) if c != b["conselho"] and a >= 0.005)
        ws2.append([b["nome"], b["id"], b["conselho"] or "fora das regiões", b["regiao"],
                    round(b["ct"].get(b["conselho"], 0) * 100, 1) if b["conselho"] else None, outros, b["pop"], b["ajuste"]])
    ws3 = wb.create_sheet("Locais de votação 2023")
    ws3.append(K["colunas"])
    for linha in sorted(K["linhas"], key=lambda x: (x[0], x[3])):
        ws3.append(linha)
    for w in wb.worksheets:
        for cel in w[1]:
            cel.font = Font(bold=True)
        w.freeze_panes = "A2"
        for col in w.columns:
            w.column_dimensions[col[0].column_letter].width = min(70, max(10, *(len(str(c.value or "")) for c in col[:300])))
    wb.save(caminho)
    print(f"planilha: {caminho}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(*sys.argv[1:3]))
