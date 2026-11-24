"""Regiões do Conselho Tutelar (eleição de 2023) aproximadas pelos locais de votação.

    python scripts/regioes_conselho.py

O edital diz a região de cada local de votação (e dos locais cujas seções foram transferidas), mas não traz o
desenho das regiões. Aqui cada ponto de Goiânia é atribuído à região do local de votação mais próximo (diagrama
de Voronoi), e as áreas são unidas por região e recortadas pelo limite do município. Resultado APROXIMADO:
serve para ver a divisão, não substitui o mapa oficial do CMDCA. Grava docs/data/conselho_regioes.geojson.
"""
import json
from pathlib import Path

from shapely.geometry import MultiPoint, Point, mapping, shape
from shapely.ops import unary_union, voronoi_diagram

RAIZ = Path(__file__).resolve().parent.parent


def main():
    lev = json.loads((RAIZ / "docs/data/levantamento.json").read_text(encoding="utf-8"))
    loc = lev["eleitoral"]["locais"]
    C = {c: i for i, c in enumerate(loc["colunas"])}
    pts = []
    for l in loc["linhas"]:
        reg, lat, lon = l[C["CT — região"]], l[C["Latitude"]], l[C["Longitude"]]
        if reg and lat and lon and -17 < lat < -16.3 and -49.6 < lon < -48.9:
            pts.append((lon, lat, reg))
    ter = json.loads((RAIZ / "docs/data/territorio.geojson").read_text(encoding="utf-8"))
    gyn = next(f for f in ter["features"] if f["properties"].get("tipo") == "goiania")
    limite = shape(gyn["geometry"]).buffer(0)
    celulas = voronoi_diagram(MultiPoint([Point(x, y) for x, y, _ in pts]), envelope=limite.buffer(0.2))
    por_regiao = {}
    for cel in celulas.geoms:
        for x, y, reg in pts:
            if cel.contains(Point(x, y)):
                por_regiao.setdefault(reg, []).append(cel)
                break
    feats = []
    for reg, cels in sorted(por_regiao.items()):
        area = unary_union(cels).intersection(limite).buffer(0)
        feats.append({"type": "Feature", "properties": {"regiao": reg, "locais": sum(1 for p in pts if p[2] == reg)},
                      "geometry": mapping(area.simplify(0.0003))})
    saida = {"type": "FeatureCollection", "nota": "Aproximação pelos locais de votação do edital de 2023 (Voronoi); não é o mapa oficial do CMDCA.",
             "features": feats}
    (RAIZ / "docs/data/conselho_regioes.geojson").write_text(json.dumps(saida, ensure_ascii=False), encoding="utf-8")
    print({f["properties"]["regiao"]: f["properties"]["locais"] for f in feats})


if __name__ == "__main__":
    main()
