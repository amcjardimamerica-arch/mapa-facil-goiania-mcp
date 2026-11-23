"""Base (projeção no chão) de cada prédio conferido pelo IPTU, para a camada Edifícios 3D.

    python scripts/bases_predios.py                 # usa scripts/dados/pegadas_satelite.json
    python scripts/bases_predios.py --baixar        # rebaixa as pegadas da imagem de satélite

O levantamento (predios.json) traz um registro por lote. Erguer o lote inteiro deixa o prédio
"ocupando todo o terreno" e põe torre em cima de estacionamento de lote agregado. Aqui a base de
cada prédio passa a ser:

1. Prédio que o Mapa Fácil já tinha (tema Edifício em altura): o mesmo desenho de antes
   (``edificios.json``), uma base por torre.
2. Prédio novo: a pegada da construção vista na imagem de satélite (Microsoft Global ML
   Building Footprints, extraído de imagens Bing/Maxar), recortada pelo lote.
   * prédio alto: só a maior construção do lote é a torre; o resto do terreno (estacionamento,
     garagem em lote agregado, área de lazer) não sobe;
   * se a pegada cobre quase o lote todo (embasamento + torre vistos como um bloco), a torre
     é estimada pela regra do Mapa Fácil, centrada na pegada;
   * casas de condomínio horizontal e prédios baixos: cada construção com a sua forma, 1 andar
     (horizontal) ou os andares do prédio.
3. Sem pegada na imagem: torre esquemática pela mesma regra do Mapa Fácil.

O polígono do lote fica guardado em ``lote``; ``f`` é a base da torre e ``fx`` as demais
construções do mesmo registro.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import sys
import urllib.request
from pathlib import Path

import shapely
from shapely import affinity
from shapely.geometry import Point, Polygon, shape
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extrair_dados import _base_do_edificio, maior_poligono, projecao_local  # noqa: E402

RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / "docs" / "data"
PEGADAS = Path(__file__).resolve().parent / "dados" / "pegadas_satelite.json"
FONTE_PEGADAS = ("Microsoft Global ML Building Footprints (imagens de satélite Bing/Maxar), "
                 "https://github.com/microsoft/GlobalMLBuildingFootprints, licença ODbL")
# quadkey nível 9 que cobre o Jardim América e o Nova Suíça
INDICE = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
QUADKEY = "210133001"
CAIXA = (-49.300, -16.730, -49.245, -16.685)

BASE_MF = "Mapa Fácil (mesmo desenho de antes)"
BASE_SAT = "Estimada pela imagem de satélite (pegada da construção)"
BASE_SAT_TORRE = "Estimada pela imagem de satélite (torre dentro da pegada)"
BASE_ESQ = "Esquemática (regra do Mapa Fácil, sem pegada na imagem)"


def baixar_pegadas() -> None:
    linhas = urllib.request.urlopen(INDICE, timeout=120).read().decode().splitlines()
    urls = [l.split(",")[2] for l in linhas if f",{QUADKEY}," in l and l.startswith("Brazil")]
    o, s, l, n = CAIXA
    saida = []
    for url in urls:
        bruto = urllib.request.urlopen(url, timeout=600).read()
        for linha in gzip.open(io.BytesIO(bruto), "rt"):
            f = json.loads(linha)
            x, y = f["geometry"]["coordinates"][0][0][:2]
            if o < x < l and s < y < n:
                anel = [[round(a, 7), round(b, 7)] for a, b, *_ in f["geometry"]["coordinates"][0]]
                saida.append(anel)
    PEGADAS.parent.mkdir(parents=True, exist_ok=True)
    PEGADAS.write_text(json.dumps({"fonte": FONTE_PEGADAS, "quadkey": QUADKEY, "caixa": CAIXA,
                                   "pegadas": saida}, separators=(",", ":")), encoding="utf-8")
    print(f"{len(saida)} pegadas -> {PEGADAS}")


def torre_quadrada(Lm):
    """Torre quadrada alinhada ao lote, como a regra do Mapa Fácil para condomínios e lotes grandes."""
    mrr = Lm.minimum_rotated_rectangle
    xs, ys = mrr.exterior.coords.xy
    lado = max(16.0, min(30.0, 0.5 * math.sqrt(Lm.area)))
    ang = math.degrees(math.atan2(ys[1] - ys[0], xs[1] - xs[0]))
    centro = Lm.representative_point()
    quad = affinity.rotate(centro.buffer(lado / 2, cap_style=3), ang, origin=centro)
    base = maior_poligono(quad.intersection(Lm.buffer(-1.5)))
    return base if base is not None and base.area >= 40 else quad


def anel_de(g) -> list:
    g = g.simplify(0.0000035, preserve_topology=True)
    return [[round(x, 6), round(y, 6)] for x, y in list(g.exterior.coords)[:-1]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baixar", action="store_true", help="rebaixa as pegadas da imagem de satélite")
    gerar(ap.parse_args().baixar)


def gerar(baixar: bool = False) -> None:
    if baixar or not PEGADAS.exists():
        baixar_pegadas()

    doc = json.loads((DADOS / "predios.json").read_text(encoding="utf-8"))
    edis = json.loads((DADOS / "edificios.json").read_text(encoding="utf-8"))["edificios"]
    peg = [Polygon(a) for a in json.loads(PEGADAS.read_text(encoding="utf-8"))["pegadas"]]
    peg = [p if p.is_valid else p.buffer(0) for p in peg]
    arvore = STRtree(peg)

    # Volta ao registro por lote (rodadas anteriores deste script geram várias entradas por lote).
    lotes, vistos = [], set()
    for p in doc["predios"]:
        chave = (p["b"], p["q"], p["l"])
        if chave in vistos:
            continue
        vistos.add(chave)
        p["f"] = p.get("lote") or p["f"]
        for k in ("lote", "fx", "mf", "base_3d", "torre"):
            p.pop(k, None)
        lotes.append(p)

    c0 = Point(-49.272, -16.705)
    para_m, para_g = projecao_local(c0.x, c0.y)

    # Edifícios do Mapa Fácil de cada lote: primeiro pela inscrição, depois pelo ponto dentro do lote.
    poli = [Polygon(p["f"]) for p in lotes]
    dono: dict[int, int] = {}
    por_ci = {}
    for j, p in enumerate(lotes):
        if p["ci"]:
            por_ci.setdefault(p["ci"], j)
    for i, e in enumerate(edis):
        if e.get("ci") in por_ci:
            dono[i] = por_ci[e["ci"]]
    for i, e in enumerate(edis):
        if i in dono:
            continue
        pt = Point(e["c"])
        for j, L in enumerate(poli):
            if L.contains(pt):
                dono[i] = j
                break
    do_lote: dict[int, list] = {}
    for i, j in dono.items():
        do_lote.setdefault(j, []).append(edis[i])

    saida, cont = [], {BASE_MF: 0, BASE_SAT: 0, BASE_SAT_TORRE: 0, BASE_ESQ: 0}
    for j, p in enumerate(lotes):
        L = poli[j] if poli[j].is_valid else poli[j].buffer(0)
        Lm = para_m(L)
        horizontal = p["uso"] == "horizontal"
        base = {**p, "lote": p["f"]}
        mf = sorted(do_lote.get(j, []), key=lambda e: -e["p"])
        if mf:
            for k, e in enumerate(mf):
                andares = 1 if horizontal else (max(e["p"], p["andares"]) if len(mf) == 1 else (e["p"] or p["andares"]))
                nome = p["n"] if len(mf) == 1 else (e["n"] if e["n"] != "Edifício sem nome" else f"{p['n']} — torre {k + 1}")
                saida.append({**base, "n": nome, "p": andares, "f": e["f"], "c": e["c"], "mf": e["id"],
                              "torre": k + 1 if len(mf) > 1 else None, "base_3d": BASE_MF})
                cont[BASE_MF] += 1
            continue

        # Construções vistas na imagem de satélite dentro do lote (recortadas por ele)
        partes = []
        for g in arvore.query(L):
            pg = peg[g]
            corte = pg.intersection(L)
            if corte.is_empty:
                continue
            gm = maior_poligono(para_m(corte))
            if gm is None or gm.area < 20 or corte.area < 0.4 * pg.area:
                continue
            partes.append(gm)
        partes.sort(key=lambda g: -g.area)
        baixo = horizontal or p["p"] <= 3
        if partes and baixo:
            aneis = [anel_de(para_g(g)) for g in partes]
            cen = para_g(partes[0]).centroid
            saida.append({**base, "f": aneis[0], "fx": aneis[1:] or None, "c": [round(cen.x, 6), round(cen.y, 6)],
                          "base_3d": BASE_SAT})
            cont[BASE_SAT] += 1
            continue
        if partes and partes[0].area >= 60:
            torre, rotulo = partes[0], BASE_SAT
            if torre.area > 0.75 * Lm.area and torre.area > 700:
                # embasamento e torre vistos como um bloco só: torre pela regra do Mapa Fácil dentro da pegada
                est = _base_do_edificio(torre, torre.representative_point(), 1 if torre.area > 3000 else 2, 0)
                est = maior_poligono(est.intersection(torre)) if est is not None else None
                if est is not None and est.area >= 60:
                    torre, rotulo = est, BASE_SAT_TORRE
        elif baixo:
            # prédio baixo sem pegada na imagem: lote recuado (mesma regra do Mapa Fácil)
            torre = _base_do_edificio(Lm, Lm.representative_point(), 1, 0)
            torre = maior_poligono(torre.buffer(-1.2, join_style=2).buffer(1.2, join_style=2)) or torre
            rotulo = BASE_ESQ
        else:
            # torre sem pegada na imagem (prédio mais novo que a imagem): torre quadrada da regra do Mapa Fácil
            torre, rotulo = torre_quadrada(Lm), BASE_ESQ
        g = para_g(torre)
        cen = g.centroid
        saida.append({**base, "f": anel_de(g), "c": [round(cen.x, 6), round(cen.y, 6)], "base_3d": rotulo})
        cont[rotulo] += 1

    for e in saida:
        for k in [k for k, v in e.items() if v is None and k in ("fx", "torre")]:
            e.pop(k)
    saida.sort(key=lambda e: -e["p"])
    doc["predios"] = saida
    doc["substitui"] = sorted({e["mf"] for e in saida if e.get("mf") is not None})
    doc["fonte_bases"] = FONTE_PEGADAS
    doc["nota"] = ("Base: prédios que o Mapa Fácil já tinha mantêm o desenho anterior; prédios novos têm a base "
                   "estimada pela pegada da construção na imagem de satélite, recortada pelo lote (só a torre sobe; "
                   "estacionamento e demais construções do lote agregado não); sem pegada, torre esquemática pela regra "
                   "do Mapa Fácil. Altura = andares × 3 m; vale o maior número de andares entre as fontes. "
                   "Polígono do lote em 'lote'.")
    (DADOS / "predios.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(lotes)} lotes -> {len(saida)} prédios/torres: " + "; ".join(f"{k}: {v}" for k, v in cont.items()))


if __name__ == "__main__":
    main()
