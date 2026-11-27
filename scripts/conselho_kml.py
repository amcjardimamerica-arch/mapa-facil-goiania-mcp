"""Regiões do Conselho Tutelar pelos traçados enviados pelo titular (KMLs "Locais de Votação CMDCA").

    python scripts/conselho_kml.py

Centro-Sul, Leste, Noroeste e Oeste: o polígono da região de cada KML (scripts/dados/kml_conselho), recortado pelo
limite de Goiânia. Norte e Campinas (sem KML): o restante do município, pelo desenho anterior; o que não era de
nenhum dos dois vai para o vizinho com quem faz a maior divisa. Grava docs/data/conselho_regioes.geojson e a lista
de divisas (docs/data/conselho_divisas.json) com as ruas, avenidas e córregos que cada divisa segue.
"""
import glob
import json
import re
from pathlib import Path

from shapely.geometry import Point, Polygon, mapping, shape
from shapely.ops import polylabel, unary_union

RAIZ = Path(__file__).resolve().parent.parent
KM2 = 111.32 * 110.57 * 0.958
NOMES = {"Centro_Sul": "Centro-Sul", "Leste": "Leste", "Noroeste": "Noroeste", "Oeste": "Oeste"}


def so_areas(g):
    if g.is_empty or g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    return unary_union([p for p in getattr(g, "geoms", []) if p.geom_type in ("Polygon", "MultiPolygon")])


def coords(t):
    return [tuple(map(float, c.split(",")[:2])) for c in t.split()]


def regioes_kml():
    regs = {}
    for f in sorted(glob.glob(str(RAIZ / "scripts/dados/kml_conselho/*.kml"))):
        chave = re.search(r"CMDCA_-_(.+)\.kml$", f).group(1)
        nome = NOMES[chave]
        s = Path(f).read_text(encoding="utf-8")
        for p in re.findall(r"<Placemark[^>]*>(.*?)</Placemark>", s, flags=re.S):
            n = (re.search(r"<name>(.*?)</name>", p, flags=re.S) or [None, ""])[1].strip()
            if "<Polygon" in p and (n.startswith("Região") or n == "Delimitação"):
                ext = coords(re.search(r"<outerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", p, flags=re.S).group(1))
                furos = [coords(x) for x in re.findall(r"<innerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", p, flags=re.S)]
                g = Polygon(ext, furos).buffer(0)
                regs[nome] = unary_union([regs[nome], g]) if nome in regs else g
    return regs


def main():
    d = json.loads((RAIZ / "docs/data/conselho_regioes.geojson").read_text(encoding="utf-8"))
    ter = json.loads((RAIZ / "docs/data/territorio.geojson").read_text(encoding="utf-8"))
    limite = shape(next(f for f in ter["features"] if f["properties"].get("tipo") == "goiania")["geometry"]).buffer(0)
    cons = [f for f in d["features"] if f["properties"].get("tipo", "conselho") == "conselho"]
    atual = {f["properties"]["regiao"]: shape(f["geometry"]).buffer(0) for f in cons}
    kml = regioes_kml()
    novos, usado = {}, None
    for nome, g in kml.items():  # os 4 do titular, recortados no município, sem sobreposição
        g = so_areas(g.intersection(limite))
        if usado is not None:
            g = so_areas(g.difference(usado))
        novos[nome] = g
        usado = g if usado is None else unary_union([usado, g])
    resto = so_areas(limite.difference(usado))
    for nome in ("Norte", "Campinas"):
        novos[nome] = so_areas(resto.intersection(atual[nome]))
    sobra = so_areas(resto.difference(unary_union([novos["Norte"], novos["Campinas"]])))
    for s in getattr(sobra, "geoms", [sobra]):
        if s.is_empty or s.area * KM2 < 1e-6:
            continue
        j = max(novos, key=lambda k: novos[k].buffer(1e-6).intersection(s.buffer(1e-6)).area)
        novos[j] = so_areas(unary_union([novos[j], s]))
    # pedacinhos e buraquinhos (< 0,05 km²) para o vizinho
    MIN = 0.05 / KM2
    for nome in list(novos):
        partes = list(getattr(novos[nome], "geoms", [novos[nome]]))
        grandes = [q for q in partes if q.area >= MIN] or [max(partes, key=lambda q: q.area)]
        for q in partes:
            if q not in grandes:
                j = max((k for k in novos if k != nome), key=lambda k: novos[k].buffer(1e-6).intersection(q.buffer(1e-6)).area)
                novos[j] = so_areas(unary_union([novos[j], q]))
        novos[nome] = so_areas(unary_union([Polygon(q.exterior, [h for h in q.interiors if Polygon(h).area >= MIN]) for q in grandes]))
    ordem = list(kml) + ["Norte", "Campinas"]
    for i, nome in enumerate(ordem[1:], 1):
        novos[nome] = so_areas(novos[nome].difference(unary_union([novos[o] for o in ordem[:i]])))

    # locais de votação de 2023 (levantamento): cada um dentro do seu Conselho?
    lv = json.loads((RAIZ / "scripts/dados/levantamento.json").read_text(encoding="utf-8"))["eleitoral"]["locais"]
    C = {c: i for i, c in enumerate(lv["colunas"])}
    fora = []
    for l in lv["linhas"]:
        reg, la, lo = l[C["CT — região"]], l[C["Latitude"]], l[C["Longitude"]]
        if reg in novos and la and -17 < la < -16.3 and not novos[reg].buffer(2e-5).contains(Point(lo, la)):
            onde = [k for k, g in novos.items() if g.contains(Point(lo, la))]
            fora.append((l[C.get("Local de votação", 0)], reg, onde[0] if onde else "fora de Goiânia"))

    for f in cons:
        g = novos[f["properties"]["regiao"]]
        f["geometry"] = mapping(so_areas(g.simplify(0.00002, preserve_topology=True)))
        f["properties"]["area_km2"] = round(g.area * KM2, 1)
        maior = max(getattr(g, "geoms", [g]), key=lambda x: x.area)
        pt = polylabel(maior, tolerance=0.0005)
        f["properties"]["rotulo"] = [round(pt.x, 5), round(pt.y, 5)]
        f["properties"]["origem"] = ("Traçado enviado pelo titular (KML Locais de Votação CMDCA)" if f["properties"]["regiao"] in kml
                                     else "Restante do município, pelo desenho anterior")
    for f in d["features"]:
        if f["properties"].get("tipo") == "regiao_administrativa":
            c = novos.get(f["properties"].get("conselho"))
            if c is not None:
                f["geometry"] = mapping(so_areas(shape(f["geometry"]).buffer(0).intersection(c).simplify(0.00003, preserve_topology=True)))
    d["nota"] = ("Conselhos Tutelares de Goiânia: Centro-Sul, Leste, Noroeste e Oeste pelos traçados enviados pelo titular (KMLs "
                 "\"Locais de Votação CMDCA\"); Norte e Campinas com o restante do município. Base: Resolução CMDCA 85/2023.")
    (RAIZ / "docs/data/conselho_regioes.geojson").write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # divisas entre Conselhos e as referências que elas seguem
    refs = json.loads((RAIZ / "scripts/dados/referencias_conselho.geojson").read_text(encoding="utf-8"))
    linhas = [(f["properties"].get("nome") or "").strip() for f in refs["features"]]
    geos = [shape(f["geometry"]) for f in refs["features"]]
    geos = [g.boundary if g.geom_type in ("Polygon", "MultiPolygon") else g for g in geos]
    divisas = []
    nomes = list(novos)
    for i, a in enumerate(nomes):
        for b in nomes[i + 1:]:
            dv = novos[a].boundary.intersection(novos[b].boundary.buffer(2e-5))
            if dv.length * 107000 < 200:
                continue
            z = dv.buffer(0.0004)
            ref = {}
            for n, g in zip(linhas, geos):
                if n and g.intersects(z):
                    m = g.intersection(z).length * 107000
                    if m > 150:
                        ref[n] = ref.get(n, 0) + m
            divisas.append({"conselhos": [a, b], "extensao_m": round(dv.length * 107000),
                            "referencias": [{"nome": n, "m": round(m)} for n, m in sorted(ref.items(), key=lambda x: -x[1])[:15]]})
    (RAIZ / "docs/data/conselho_divisas.json").write_text(json.dumps({"divisas": divisas}, ensure_ascii=False, indent=1), encoding="utf-8")
    print({k: round(g.area * KM2, 1) for k, g in novos.items()}, "| cobertura", round(unary_union(list(novos.values())).area / limite.area * 100, 2), "%")
    print("locais fora do seu Conselho:", len(fora), fora[:6])


if __name__ == "__main__":
    main()
