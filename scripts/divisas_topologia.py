"""Divisas com pontos compartilhados (topologia) para o editor de divisas do sistema.

    python scripts/divisas_topologia.py

Cada divisa entre duas áreas vizinhas passa a ter EXATAMENTE os mesmos vértices nas duas (encaixe de até ~2,5 m), para
que, no editor, arrastar um ponto mova a divisa das duas áreas juntas, sem abrir vão nem sobrepor. Vale para os
Conselhos Tutelares (docs/data/conselho_regioes.geojson) e para as Zonas Eleitorais (docs/data/zonas_eleitorais.geojson,
gerado a partir do banco local na primeira vez).
"""
import json
import sys
from pathlib import Path

from shapely import set_precision
from shapely.geometry import mapping, shape
from shapely.ops import snap, unary_union

RAIZ = Path(__file__).resolve().parent.parent
TOL = 0.000025  # ~2,5 m


def encaixar(geos):
    nomes = list(geos)
    g = {k: set_precision(v.buffer(0), 1e-7) for k, v in geos.items()}
    # cada área encaixa nos vértices das vizinhas já tratadas (a ordem garante vértices idênticos nos dois lados)
    for i, a in enumerate(nomes):
        for b in nomes[:i]:
            if g[a].distance(g[b]) < TOL * 4:
                g[a] = snap(g[a], g[b], TOL)
        g[a] = set_precision(g[a].buffer(0), 1e-7)
    for i, a in enumerate(nomes):  # sem sobreposição depois do encaixe
        for b in nomes[:i]:
            if g[a].intersects(g[b]) and g[a].intersection(g[b]).area > 0:
                g[a] = set_precision(g[a].difference(g[b]), 1e-7)
    return g


def main():
    d = json.loads((RAIZ / "docs/data/conselho_regioes.geojson").read_text(encoding="utf-8"))
    cons = [f for f in d["features"] if f["properties"].get("tipo", "conselho") == "conselho"]
    g = encaixar({f["properties"]["regiao"]: shape(f["geometry"]) for f in cons})
    for f in cons:
        f["geometry"] = mapping(g[f["properties"]["regiao"]])
    (RAIZ / "docs/data/conselho_regioes.geojson").write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    zarq = RAIZ / "docs/data/zonas_eleitorais.geojson"
    if zarq.exists():
        z = json.loads(zarq.read_text(encoding="utf-8"))
    else:  # primeira vez: das zonas extraídas do banco local (Mapa_Limites/10)
        bruto = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/zonas.json").read_text(encoding="utf-8"))
        from shapely.geometry import Polygon
        feats = []
        for f in bruto:
            rings = f["rings"]
            ext = [r for r in rings if not Polygon(r).exterior.is_ccw]
            inn = [r for r in rings if Polygon(r).exterior.is_ccw]
            polys = [Polygon(e, [h for h in inn if Polygon(e).contains(Polygon(h).representative_point())]) for e in ext] or [Polygon(r) for r in rings]
            a = f["a"]
            feats.append({"type": "Feature", "properties": {"id": a.get("id"), "nm_zoe": a.get("nm_zoe"), "nm": a.get("nm")}, "geometry": mapping(unary_union(polys))})
        z = {"type": "FeatureCollection", "nota": "Zonas eleitorais de Goiânia (TSE, Mapa Fácil), com divisas editáveis no sistema.", "features": feats}
    gz = encaixar({str(i): shape(f["geometry"]) for i, f in enumerate(z["features"])})
    for i, f in enumerate(z["features"]):
        f["geometry"] = mapping(gz[str(i)])
    zarq.write_text(json.dumps(z, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # conferência: vértices compartilhados
    for nome, gg in (("Conselhos", g), ("Zonas", gz)):
        vs = {}
        for k, v in gg.items():
            for p in getattr(v, "geoms", [v]):
                for c in p.exterior.coords:
                    vs.setdefault((round(c[0], 7), round(c[1], 7)), set()).add(k)
        compart = sum(1 for s in vs.values() if len(s) > 1)
        sob = sum(gg[a].intersection(gg[b]).area for i, a in enumerate(gg) for b in list(gg)[i + 1:]) * 11800
        print(nome, "vértices", len(vs), "compartilhados", compart, "| sobreposição km2", round(sob, 4))


if __name__ == "__main__":
    main()
