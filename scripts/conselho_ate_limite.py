"""Leva os 6 Conselhos Tutelares até o limite do município de Goiânia.

    python scripts/conselho_ate_limite.py

A delimitação oficial (Resolução CMDCA 85/2023 sobre as 12 Regiões da SEPLAM) cobre os bairros, mas deixa de fora
as áreas do município sem bairro (zona rural, chácaras, áreas verdes). Aqui cada ponto dessas áreas é atribuído ao
Conselho mais próximo (diagrama de Voronoi de pontos amostrados nas divisas dos Conselhos), o resultado é recortado
pelo limite do município e as frestas entre Conselhos vizinhos somem. As 12 Regiões são recortadas do mesmo jeito.
Grava de volta docs/data/conselho_regioes.geojson (roda de novo sem mudar nada: é idempotente).
"""
import json
from pathlib import Path

from shapely.geometry import MultiPoint, Point, mapping, shape
from shapely.ops import unary_union, voronoi_diagram
from shapely.strtree import STRtree

RAIZ = Path(__file__).resolve().parent.parent
ARQ = RAIZ / "docs/data/conselho_regioes.geojson"
KM2 = 111.32 * 110.57 * 0.958  # graus² -> km² perto de 16,7° S (cos da latitude)


def so_areas(g):
    """Só as partes de área (interseções podem deixar linhas e pontos soltos)."""
    from shapely.geometry import MultiPolygon, Polygon
    if g.is_empty:
        return g
    if isinstance(g, (Polygon, MultiPolygon)):
        return g
    return unary_union([p for p in getattr(g, "geoms", []) if isinstance(p, (Polygon, MultiPolygon))])


def pontos_da_divisa(g, passo=0.001):
    for p in getattr(g, "geoms", [g]):
        for anel in [p.exterior, *p.interiors]:
            n = max(4, int(anel.length / passo))
            for i in range(n):
                yield anel.interpolate(i / n, normalized=True)


def main():
    d = json.loads(ARQ.read_text(encoding="utf-8"))
    ter = json.loads((RAIZ / "docs/data/territorio.geojson").read_text(encoding="utf-8"))
    limite = shape(next(f for f in ter["features"] if f["properties"].get("tipo") == "goiania")["geometry"]).buffer(0)
    cons = [f for f in d["features"] if f["properties"].get("tipo", "conselho") == "conselho"]
    regs = [f for f in d["features"] if f["properties"].get("tipo") == "regiao_administrativa"]
    geos = [shape(f["geometry"]).buffer(0).intersection(limite) for f in cons]

    # Áreas do município fora de qualquer Conselho: vão para o Conselho mais próximo.
    lacuna = limite.difference(unary_union(geos)).buffer(0)
    pts, dono = [], []
    for i, g in enumerate(geos):
        for p in pontos_da_divisa(g):
            pts.append(p); dono.append(i)
    celulas = voronoi_diagram(MultiPoint(pts), envelope=limite.buffer(0.05))
    arvore = STRtree(pts)
    extra = [[] for _ in geos]
    for cel in celulas.geoms:
        parte = cel.intersection(lacuna)
        if parte.is_empty:
            continue
        k = arvore.query_nearest(cel.representative_point())
        k = int(k[0]) if hasattr(k, "__len__") else int(k)
        extra[dono[k]].append(parte)
    novos = []
    usado = None
    for i, g in enumerate(geos):
        a = unary_union([g, *extra[i]]).buffer(0)
        if usado is not None:
            a = a.difference(usado)          # sem sobreposição entre Conselhos
        a = a.buffer(1e-7).buffer(-1e-7).intersection(limite)  # fecha frestas finíssimas
        usado = a if usado is None else unary_union([usado, a])
        novos.append(a)
    # Sobras (frestas entre vizinhos) para o Conselho que encosta nelas.
    sobra = limite.difference(unary_union(novos))
    for s in getattr(sobra, "geoms", [sobra]):
        if s.is_empty:
            continue
        j = max(range(len(novos)), key=lambda i: novos[i].buffer(1e-6).intersection(s).area)
        novos[j] = unary_union([novos[j], s]).buffer(0)

    # Limpeza: pedacinhos soltos e buraquinhos (menos de 0,02 km²) viram parte do vizinho que mais encosta neles,
    # para não sobrar linha de divisa dentro de um Conselho.
    MIN = 0.02 / KM2
    from shapely.geometry import Polygon
    for _ in range(2):
        for i in range(len(novos)):
            novos[i] = so_areas(novos[i])
            partes = list(getattr(novos[i], "geoms", [novos[i]]))
            grandes = [q for q in partes if q.area >= MIN] or [max(partes, key=lambda q: q.area)]
            for q in partes:
                if q in grandes:
                    continue
                j = max((k for k in range(len(novos)) if k != i), key=lambda k: novos[k].buffer(1e-6).intersection(q.buffer(1e-6)).area)
                novos[j] = unary_union([novos[j], q]).buffer(0)
            fechados = []
            for q in grandes:
                furos = [h for h in q.interiors if Polygon(h).area >= MIN]
                fechados.append(Polygon(q.exterior, furos))
            novos[i] = unary_union(fechados).buffer(0)
        for i in range(len(novos)):
            novos[i] = novos[i].difference(unary_union(novos[:i])) if i else novos[i]
            novos[i] = so_areas(novos[i].buffer(1e-7).buffer(-1e-7).intersection(limite))

    for f, g, ex in zip(cons, novos, extra):
        rural = sum(x.area for x in ex) * KM2
        f["geometry"] = mapping(so_areas(g.simplify(0.00005, preserve_topology=True)))
        f["properties"]["area_km2"] = round(g.area * KM2, 1)
        f["properties"]["area_sem_bairro_km2"] = round(rural, 1)
        from shapely.ops import polylabel
        maior = max(getattr(g, "geoms", [g]), key=lambda x: x.area)
        pt = polylabel(maior, tolerance=0.0005)   # ponto mais "no meio" do Conselho, para o nome não encostar no vizinho
        f["properties"]["rotulo"] = [round(pt.x, 5), round(pt.y, 5)]
        aj = [a for a in f["properties"].get("ajustes") or [] if not str(a).startswith("Áreas do município sem bairro")]
        if rural > 0.05:
            aj.append(f"Áreas do município sem bairro ({str(round(rural, 1)).replace('.', ',')} km²) atribuídas a este Conselho por proximidade, até o limite de Goiânia")
        f["properties"]["ajustes"] = aj
    # As 12 Regiões: só para dizer em qual Região fica o ponto clicado (não são desenhadas).
    for f in regs:
        conselho = next((c for c in cons if c["properties"]["regiao"] == f["properties"].get("conselho")), None)
        g = shape(f["geometry"]).buffer(0)
        if conselho:
            g = so_areas(g.intersection(shape(conselho["geometry"]).buffer(0)))
        f["geometry"] = mapping(so_areas(g.simplify(0.00005, preserve_topology=True)))
    total = sum(g.area for g in novos) * KM2
    d["nota"] = (d["nota"].split(" Áreas sem bairro:")[0] +
                 " Áreas sem bairro: atribuídas ao Conselho mais próximo, até o limite do município (scripts/conselho_ate_limite.py).")
    ARQ.write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print({f["properties"]["regiao"]: (f["properties"]["area_km2"], f["properties"]["area_sem_bairro_km2"]) for f in cons},
          "total", round(total, 1), "limite", round(limite.area * KM2, 1),
          "lacuna", round(limite.difference(unary_union(novos)).area * KM2, 4))


if __name__ == "__main__":
    main()
