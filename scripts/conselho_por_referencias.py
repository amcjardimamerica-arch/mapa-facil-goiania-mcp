"""Divisas dos Conselhos Tutelares nas áreas sem bairro, por referências geográficas.

    python scripts/conselho_por_referencias.py

Parte do desenho oficial (scripts/dados/conselho_regioes_oficial.geojson: Resolução CMDCA 85/2023 sobre as 12 Regiões
da SEPLAM, que segue as divisas de bairro) e completa o município até o limite. As áreas sem bairro são recortadas
pelas referências geográficas (scripts/dados/referencias_conselho.geojson): rodovias (BR-153, GO-…), anel viário,
avenidas (como a Av. Guapó), estradas, marginais e cursos d'água (Rio Meia Ponte, córregos Cascavel e outros).
Cada pedaço recortado vai para o Conselho com quem ele faz a maior divisa, de fora para dentro; assim a nova divisa
sempre corre por uma rodovia, avenida, estrada ou rio (ou pela divisa de bairro, que já é a do desenho oficial).
Grava docs/data/conselho_regioes.geojson.
"""
import json
from pathlib import Path

from shapely.geometry import LineString, MultiLineString, Point, Polygon, mapping, shape
from shapely.ops import polylabel, polygonize, unary_union
from shapely.strtree import STRtree

RAIZ = Path(__file__).resolve().parent.parent
KM2 = 111.32 * 110.57 * 0.958


def so_areas(g):
    from shapely.geometry import MultiPolygon
    if g.is_empty or isinstance(g, (Polygon, MultiPolygon)):
        return g
    return unary_union([p for p in getattr(g, "geoms", []) if isinstance(p, (Polygon, MultiPolygon))])


def linhas(g):
    if isinstance(g, (Polygon,)) or g.geom_type == "MultiPolygon":
        return unary_union([p.boundary for p in getattr(g, "geoms", [g])])
    return g


def main():
    oficial = json.loads((RAIZ / "scripts/dados/conselho_regioes_oficial.geojson").read_text(encoding="utf-8"))
    refs = json.loads((RAIZ / "scripts/dados/referencias_conselho.geojson").read_text(encoding="utf-8"))
    ter = json.loads((RAIZ / "docs/data/territorio.geojson").read_text(encoding="utf-8"))
    limite = shape(next(f for f in ter["features"] if f["properties"].get("tipo") == "goiania")["geometry"]).buffer(0)
    cons = [f for f in oficial["features"] if f["properties"].get("tipo", "conselho") == "conselho"]
    regs = [f for f in oficial["features"] if f["properties"].get("tipo") == "regiao_administrativa"]
    geos = [so_areas(shape(f["geometry"]).buffer(0).intersection(limite)) for f in cons]
    lacuna = so_areas(limite.difference(unary_union(geos)).buffer(0))

    # Recorte da lacuna pelas referências (só o que passa por ela).
    zona = lacuna.buffer(0.0005)
    cortes = [linhas(shape(f["geometry"])) for f in refs["features"]]
    cortes = [c.intersection(zona) for c in cortes if c.intersects(zona)]
    rede = unary_union([lacuna.boundary, *[unary_union([p.boundary for p in getattr(g, "geoms", [g])]) for g in geos], *cortes])
    faces = [f for f in polygonize(rede) if f.area > 1e-9 and lacuna.contains(f.representative_point())]
    print("pedaços da área sem bairro:", len(faces))

    # De fora para dentro: cada pedaço vai para o Conselho com a maior divisa comum.
    dono = [None] * len(faces)
    atuais = list(geos)
    arvore = STRtree(faces)
    mudou = True
    while mudou:
        mudou = False
        bordas = [g.boundary for g in atuais]
        for k, f in enumerate(faces):
            if dono[k] is not None:
                continue
            fb = f.boundary.buffer(2e-6)
            comum = [fb.intersection(b).length for b in bordas]
            j = max(range(len(atuais)), key=lambda i: comum[i])
            if comum[j] > 1e-5:
                dono[k] = j
                mudou = True
        if mudou:
            atuais = [unary_union([geos[i], *[faces[k] for k in range(len(faces)) if dono[k] == i]]).buffer(0) for i in range(len(geos))]
    sobras = [k for k in range(len(faces)) if dono[k] is None]
    for k in sobras:  # pedaço isolado: Conselho mais próximo
        c = faces[k].representative_point()
        dono[k] = min(range(len(atuais)), key=lambda i: atuais[i].distance(c))
    novos = [so_areas(unary_union([geos[i], *[faces[k] for k in range(len(faces)) if dono[k] == i]]).buffer(1e-7).buffer(-1e-7).intersection(limite))
             for i in range(len(geos))]
    for i in range(1, len(novos)):
        novos[i] = so_areas(novos[i].difference(unary_union(novos[:i])))
    # frestas e pedacinhos
    sobra = so_areas(limite.difference(unary_union(novos)))
    for s in getattr(sobra, "geoms", [sobra]):
        if s.is_empty:
            continue
        j = max(range(len(novos)), key=lambda i: novos[i].buffer(1e-6).intersection(s).area)
        novos[j] = so_areas(unary_union([novos[j], s]).buffer(0))
    MIN = 0.02 / KM2
    for i in range(len(novos)):
        partes = list(getattr(novos[i], "geoms", [novos[i]]))
        for q in [q for q in partes if q.area < MIN and len(partes) > 1]:
            j = max((k for k in range(len(novos)) if k != i), key=lambda k: novos[k].buffer(1e-6).intersection(q.buffer(1e-6)).area)
            novos[j] = so_areas(unary_union([novos[j], q]).buffer(0))
        novos[i] = so_areas(unary_union([Polygon(q.exterior, [h for h in q.interiors if Polygon(h).area >= MIN])
                                         for q in getattr(novos[i], "geoms", [novos[i]]) if q.area >= MIN or len(partes) == 1]))
    for i in range(1, len(novos)):
        novos[i] = so_areas(novos[i].difference(unary_union(novos[:i])))

    # Quais referências viraram divisa (para a ficha)
    def refs_na_divisa(i):
        nomes = {}
        borda = novos[i].boundary.difference(limite.boundary.buffer(0.0003)).difference(geos[i].boundary.buffer(0.0003))
        if borda.is_empty:
            return []
        z = borda.buffer(0.0004)
        for f in refs["features"]:
            g = linhas(shape(f["geometry"]))
            if g.intersects(z):
                ext = g.intersection(z).length
                n = (f["properties"].get("nome") or "").strip()
                if n and ext > 0.003:
                    nomes[n] = nomes.get(n, 0) + ext
        return [n for n, _ in sorted(nomes.items(), key=lambda x: -x[1])][:12]

    d = oficial
    for i, f in enumerate(cons):
        g = novos[i]
        rural = (g.area - geos[i].area) * KM2
        f["geometry"] = mapping(so_areas(g.simplify(0.00003, preserve_topology=True)))
        f["properties"]["area_km2"] = round(g.area * KM2, 1)
        f["properties"]["area_sem_bairro_km2"] = round(max(0, rural), 1)
        maior = max(getattr(g, "geoms", [g]), key=lambda x: x.area)
        pt = polylabel(maior, tolerance=0.0005)
        f["properties"]["rotulo"] = [round(pt.x, 5), round(pt.y, 5)]
        f["properties"]["referencias_divisa"] = refs_na_divisa(i)
        aj = [a for a in f["properties"].get("ajustes") or [] if not str(a).startswith("Áreas do município sem bairro")]
        if rural > 0.05:
            aj.append(f"Áreas do município sem bairro ({str(round(rural, 1)).replace('.', ',')} km²) incluídas até o limite de Goiânia, "
                      "com divisas por rodovias, avenidas, estradas e cursos d'água")
        f["properties"]["ajustes"] = aj
    for f in regs:
        c = next((c for c in cons if c["properties"]["regiao"] == f["properties"].get("conselho")), None)
        g = shape(f["geometry"]).buffer(0)
        if c:
            g = so_areas(g.intersection(shape(c["geometry"]).buffer(0)))
        f["geometry"] = mapping(so_areas(g.simplify(0.00003, preserve_topology=True)))
    d["nota"] = (d["nota"].split(" Áreas sem bairro:")[0] + " Áreas sem bairro: incluídas até o limite do município, com divisas "
                 "por rodovias, avenidas, estradas e cursos d'água (scripts/conselho_por_referencias.py).")
    (RAIZ / "docs/data/conselho_regioes.geojson").write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print({f["properties"]["regiao"]: (f["properties"]["area_km2"], f["properties"]["referencias_divisa"][:5]) for f in cons})
    print("lacuna km2", round(limite.difference(unary_union(novos)).area * KM2, 3))


if __name__ == "__main__":
    main()
