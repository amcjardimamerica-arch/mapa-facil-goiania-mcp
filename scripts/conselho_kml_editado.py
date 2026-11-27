"""Divisas dos Conselhos Tutelares redesenhadas pelo titular no Google Earth (scripts/dados/kml_conselho/divisas_editadas_titular.kml).

    python scripts/conselho_kml_editado.py

Centro-Sul, Oeste, Noroeste, Norte e Leste: o traçado do arquivo. Campinas: tudo o que sobra até o limite do município.
Limpeza: recorte no limite de Goiânia; sobreposições entre vizinhos ficam com quem tem o trecho mais "por dentro";
vãos e pedaços soltos (< 0,5 km²) vão para o vizinho de maior divisa; pontas e recortes finos (< ~30 m) somem;
pontos repetidos e alinhados são retirados. Grava docs/data/conselho_regioes.geojson e conselho_divisas.json.
"""
import json
import re
import sys
from pathlib import Path

from shapely.geometry import Point, Polygon, mapping, shape
from shapely.ops import polylabel, unary_union

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "scripts"))
KM2 = 111.32 * 110.57 * 0.958
EPS = 0.00014  # ~15 m: pontas e recortes mais finos que ~30 m saem


def so_areas(g):
    if g.is_empty or g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    return unary_union([p for p in getattr(g, "geoms", []) if p.geom_type in ("Polygon", "MultiPolygon")])


def partes(g):
    return [p for p in getattr(g, "geoms", [g]) if not p.is_empty]


def ler_kml():
    s = (RAIZ / "scripts/dados/kml_conselho/divisas_editadas_titular.kml").read_text(encoding="utf-8")
    regs = {}
    for p in re.findall(r"<Placemark[^>]*>(.*?)</Placemark>", s, flags=re.S):
        n = re.search(r"<name>(.*?)</name>", p, flags=re.S).group(1).replace("Conselho Tutelar", "").strip()
        polys = []
        for pol in re.findall(r"<Polygon>(.*?)</Polygon>", p, flags=re.S):
            ext = re.search(r"<outerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", pol, flags=re.S).group(1)
            furos = re.findall(r"<innerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", pol, flags=re.S)
            c = lambda t: [tuple(map(float, x.split(",")[:2])) for x in t.split()]
            polys.append(Polygon(c(ext), [c(f) for f in furos]).buffer(0))
        regs[n] = unary_union(polys)
    return regs


def main():
    d = json.loads((RAIZ / "docs/data/conselho_regioes.geojson").read_text(encoding="utf-8"))
    ter = json.loads((RAIZ / "docs/data/territorio.geojson").read_text(encoding="utf-8"))
    limite = shape(next(f for f in ter["features"] if f["properties"].get("tipo") == "goiania")["geometry"]).buffer(0)
    kml = {k: so_areas(g.intersection(limite)) for k, g in ler_kml().items()}
    nomes = list(kml)
    # 1) sobreposições: o trecho fica com quem o tem mais por dentro
    novos = dict(kml)
    for i, a in enumerate(nomes):
        for b in nomes[i + 1:]:
            sob = so_areas(novos[a].intersection(novos[b]))
            for q in partes(sob):
                c = q.representative_point()
                dono, outro = (a, b) if kml[a].boundary.distance(c) >= kml[b].boundary.distance(c) else (b, a)
                novos[outro] = so_areas(novos[outro].difference(q))
    # 2) pontas e recortes finos: abertura e fechamento morfológicos de cada área
    for k in nomes:
        g = novos[k].buffer(-EPS, join_style=2).buffer(EPS, join_style=2)       # tira pontas
        g = g.buffer(EPS, join_style=2).buffer(-EPS, join_style=2)               # fecha recortes
        novos[k] = so_areas(g.intersection(limite))
    for i, a in enumerate(nomes):  # o fechamento pode ter invadido vizinhos: devolve
        for b in nomes[:i]:
            novos[a] = so_areas(novos[a].difference(novos[b]))
    # 3) Campinas: o restante do município; pedaços soltos e vãos finos vão para o vizinho de maior divisa
    resto = so_areas(limite.difference(unary_union(list(novos.values()))))
    ps = sorted(partes(resto), key=lambda q: -q.area)
    campinas = ps[0]
    for q in ps[1:]:
        if q.area * KM2 >= 0.5 and q.touches(campinas):
            campinas = unary_union([campinas, q]); continue
        viz = {k: novos[k].buffer(1e-6).intersection(q.buffer(1e-6)).area for k in nomes}
        viz["Campinas"] = campinas.buffer(1e-6).intersection(q.buffer(1e-6)).area
        j = max(viz, key=viz.get)
        if j == "Campinas":
            campinas = unary_union([campinas, q])
        else:
            novos[j] = so_areas(unary_union([novos[j], q]))
    novos["Campinas"] = so_areas(campinas)
    # 4) pedacinhos soltos (< 0,5 km²) de qualquer área: para o vizinho de maior divisa; buraquinhos fechados
    MIN = 0.5 / KM2
    for k in list(novos):
        ps = partes(novos[k])
        if len(ps) <= 1:
            continue
        grande = max(ps, key=lambda q: q.area)
        for q in ps:
            if q is grande or q.area >= MIN:
                continue
            j = max((x for x in novos if x != k), key=lambda x: novos[x].buffer(1e-6).intersection(q.buffer(1e-6)).area)
            novos[j] = so_areas(unary_union([novos[j], q]))
            novos[k] = so_areas(novos[k].difference(q))
    for k in list(novos):
        novos[k] = so_areas(unary_union([Polygon(q.exterior, [h for h in q.interiors if Polygon(h).area >= MIN]) for q in partes(novos[k])]))
    ordem = nomes + ["Campinas"]
    for i, k in enumerate(ordem[1:], 1):
        novos[k] = so_areas(novos[k].difference(unary_union([novos[o] for o in ordem[:i]])))
    # migalhas de recorte (< 0,001 km²) somem
    for k in ordem:
        novos[k] = so_areas(unary_union([q for q in partes(novos[k]) if q.area * KM2 >= 0.001]))

    # locais de votação
    lv = json.loads((RAIZ / "scripts/dados/levantamento.json").read_text(encoding="utf-8"))["eleitoral"]["locais"]
    C = {c: i for i, c in enumerate(lv["colunas"])}
    fora = []
    for l in lv["linhas"]:
        reg, la, lo = l[C["CT — região"]], l[C["Latitude"]], l[C["Longitude"]]
        if reg in novos and la and -17 < la < -16.3 and not novos[reg].buffer(2e-5).contains(Point(lo, la)):
            onde = [k for k, g in novos.items() if g.contains(Point(lo, la))]
            fora.append((l[C.get("Local de votação", 0)], reg, onde[0] if onde else "fora de Goiânia"))

    for f in d["features"]:
        p = f["properties"]
        if p.get("tipo", "conselho") == "conselho":
            g = novos[p["regiao"]]
            f["geometry"] = mapping(so_areas(g.simplify(0.00001, preserve_topology=True)))  # sem pontos repetidos/alinhados
            p["area_km2"] = round(g.area * KM2, 1)
            pt = polylabel(max(partes(g), key=lambda x: x.area), tolerance=0.0005)
            p["rotulo"] = [round(pt.x, 5), round(pt.y, 5)]
            p["origem"] = ("Restante do município (confinantes e limite de Goiânia)" if p["regiao"] == "Campinas"
                           else "Traçado do titular no Google Earth (27/11/2026)")
        elif p.get("tipo") == "regiao_administrativa" and p.get("conselho") in novos:
            f["geometry"] = mapping(so_areas(shape(f["geometry"]).buffer(0).intersection(novos[p["conselho"]]).simplify(0.00003, preserve_topology=True)))
    d["nota"] = ("Conselhos Tutelares de Goiânia: divisas traçadas pelo titular no Google Earth (27/11/2026); Campinas com o restante do "
                 "município até o limite. Base: Resolução CMDCA 85/2023.")
    (RAIZ / "docs/data/conselho_regioes.geojson").write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # divisas entre Conselhos (para a ficha), como no script dos KMLs
    import conselho_kml
    refs = json.loads((RAIZ / "scripts/dados/referencias_conselho.geojson").read_text(encoding="utf-8"))
    lin = [(f["properties"].get("nome") or "").strip() for f in refs["features"]]
    geos = [shape(f["geometry"]) for f in refs["features"]]
    geos = [g.boundary if g.geom_type in ("Polygon", "MultiPolygon") else g for g in geos]
    divisas = []
    for i, a in enumerate(ordem):
        for b in ordem[i + 1:]:
            dv = novos[a].boundary.intersection(novos[b].boundary.buffer(2e-5))
            if dv.length * 107000 < 200:
                continue
            z = dv.buffer(0.0004)
            ref = {}
            for n, g in zip(lin, geos):
                if n and g.intersects(z):
                    m = g.intersection(z).length * 107000
                    if m > 150:
                        ref[n] = ref.get(n, 0) + m
            divisas.append({"conselhos": [a, b], "extensao_m": round(dv.length * 107000),
                            "referencias": [{"nome": n, "m": round(m)} for n, m in sorted(ref.items(), key=lambda x: -x[1])[:15]]})
    (RAIZ / "docs/data/conselho_divisas.json").write_text(json.dumps({"divisas": divisas}, ensure_ascii=False, indent=1), encoding="utf-8")
    print({k: (round(g.area * KM2, 1), len(partes(g)), sum(len(q.interiors) for q in partes(g))) for k, g in novos.items()})
    print("cobertura", round(unary_union(list(novos.values())).area / limite.area * 100, 3), "% | sobreposição km2",
          round(sum(novos[a].intersection(novos[b]).area for i, a in enumerate(ordem) for b in ordem[i + 1:]) * KM2, 4))
    print("mudança em relação ao traçado do titular (km2):", {k: round(novos[k].symmetric_difference(kml[k]).area * KM2, 2) for k in nomes})
    print("locais fora do seu Conselho:", len(fora), fora[:8])


if __name__ == "__main__":
    main()
