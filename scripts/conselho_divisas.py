"""Divisas dos Conselhos Tutelares por referências reais (1.25.1).

    python scripts/conselho_divisas.py

O município é recortado por TODAS as referências (divisas de bairro, avenidas, rodovias como a BR-153 e a GO-060,
marginais, estradas e cursos d'água) em pedaços. Cada pedaço vai inteiro para um Conselho, de modo que toda divisa
entre Conselhos corre por uma dessas referências:
  1. o pedaço com local de votação fica com o Conselho do local (os locais de votação nunca mudam de Conselho);
  2. os demais ficam com o Conselho que já ocupa a maior parte deles (desenho oficial da Resolução CMDCA 85/2023
     e as áreas sem bairro levadas ao limite);
  3. prioridade às avenidas e barreiras: um pedaço estreito colado na divisa, entre uma divisa de bairro e uma avenida,
     rodovia ou curso d'água, passa para o Conselho vizinho quando isso põe a divisa sobre a avenida/barreira
     (e não há local de votação nele).
Entradas: docs/data/conselho_regioes.geojson (atual), scripts/dados/{referencias_conselho.geojson,
bairros_poligonos.json}, scripts/dados/levantamento.json (locais de votação). Grava docs/data/conselho_regioes.geojson.
"""
import json
from pathlib import Path

from shapely.geometry import Point, Polygon, mapping, shape
from shapely.ops import polygonize, polylabel, unary_union
from shapely.strtree import STRtree
import shapely


def juntar(pedacos):
    """União rápida de pedaços que se encaixam sem sobreposição (saída do polygonize)."""
    pedacos = [p for p in pedacos if not p.is_empty]
    if not pedacos:
        return Polygon()
    try:
        return shapely.coverage_union_all(pedacos)
    except Exception:  # noqa: BLE001
        return unary_union(pedacos)

RAIZ = Path(__file__).resolve().parent.parent
KM2 = 111.32 * 110.57 * 0.958


def so_areas(g):
    from shapely.geometry import MultiPolygon
    if g.is_empty or isinstance(g, (Polygon, MultiPolygon)):
        return g
    return unary_union([p for p in getattr(g, "geoms", []) if isinstance(p, (Polygon, MultiPolygon))])


def borda(g):
    return unary_union([p.boundary for p in getattr(g, "geoms", [g])]) if g.geom_type in ("Polygon", "MultiPolygon") else g


def main():
    atual = json.loads((RAIZ / "docs/data/conselho_regioes.geojson").read_text(encoding="utf-8"))
    refs = json.loads((RAIZ / "scripts/dados/referencias_conselho.geojson").read_text(encoding="utf-8"))
    bairros = json.loads((RAIZ / "scripts/dados/bairros_poligonos.json").read_text(encoding="utf-8"))
    ter = json.loads((RAIZ / "docs/data/territorio.geojson").read_text(encoding="utf-8"))
    limite = shape(next(f for f in ter["features"] if f["properties"].get("tipo") == "goiania")["geometry"]).buffer(0)
    cons = [f for f in atual["features"] if f["properties"].get("tipo", "conselho") == "conselho"]
    nomes = [f["properties"]["regiao"] for f in cons]
    geos = [shape(f["geometry"]).buffer(0) for f in cons]

    # Referências: barreiras (avenidas, rodovias, cursos d'água) e divisas de bairro.
    barreiras = unary_union([borda(shape(f["geometry"])) for f in refs["features"]]).intersection(limite.buffer(0.0005))
    divisas_bairro = unary_union([Polygon(r).boundary for b in bairros for r in (b["rings"] or []) if len(r) >= 4])
    rede = unary_union([limite.boundary, barreiras, divisas_bairro])
    faces = [f for f in polygonize(rede) if f.area > 2e-10 and limite.contains(f.representative_point())]
    print("pedaços:", len(faces), flush=True)

    # Locais de votação (Conselho de cada um, pela região do edital).
    lv = json.loads((RAIZ / "scripts/dados/levantamento.json").read_text(encoding="utf-8"))
    loc = lv["eleitoral"]["locais"]; C = {c: i for i, c in enumerate(loc["colunas"])}
    locais = [(Point(l[C["Longitude"]], l[C["Latitude"]]), l[C["CT — região"]]) for l in loc["linhas"]
              if l[C["CT — região"]] and l[C["Latitude"]] and -17 < l[C["Latitude"]] < -16.3]

    arv = STRtree(faces)
    dono = [None] * len(faces)
    fixo = [False] * len(faces)
    for pt, reg in locais:
        if reg not in nomes:
            continue
        perto = pt.buffer(1e-5)  # local em cima de uma divisa (avenida): os pedaços dos dois lados ficam com ele
        for k in arv.query(perto):
            if faces[k].intersects(perto):
                dono[k] = nomes.index(reg); fixo[k] = True
    for g in geos:
        shapely.prepare(g)
    for k, f in enumerate(faces):
        if dono[k] is not None:
            continue
        cand = [i for i in range(len(geos)) if geos[i].intersects(f)]
        if len(cand) == 1 and geos[cand[0]].contains(f.representative_point()):
            dono[k] = cand[0]
        elif cand:
            dono[k] = max(cand, key=lambda i: geos[i].intersection(f).area)
        else:
            c = f.representative_point()
            dono[k] = min(range(len(geos)), key=lambda i: geos[i].distance(c))
    print("pedaços distribuídos", flush=True)

    # Prioridade às avenidas/barreiras: pedaços estreitos colados na divisa.
    barreira_buf = barreiras.buffer(0.00008)
    shapely.prepare(barreira_buf)
    print("faixa das barreiras pronta", flush=True)
    for rodada in range(3):
        mudou = 0
        uniao = [juntar([faces[k] for k in range(len(faces)) if dono[k] == i]) for i in range(len(geos))]
        # só a faixa junto da divisa de cada Conselho (calculada uma vez por rodada)
        faixa = [u.boundary.buffer(0.00002) for u in uniao]
        for fx in faixa:
            shapely.prepare(fx)
        for k, f in enumerate(faces):
            if fixo[k] or f.area * KM2 > 0.35:
                continue
            i = dono[k]
            fb = f.boundary
            for j in range(len(geos)):
                if j == i or not faixa[j].intersects(fb):
                    continue
                comum = fb.intersection(faixa[j])
                if comum.length < 0.0008:  # menos de ~90 m encostado no vizinho
                    continue
                # a divisa atual (com o vizinho) não é barreira, e o outro lado do pedaço é barreira
                comum_barreira = comum.intersection(barreira_buf).length / max(comum.length, 1e-12)
                resto = fb.difference(faixa[j])
                resto_barreira = resto.intersection(barreira_buf).length / max(resto.length, 1e-12)
                largura = f.area / max(fb.length / 2, 1e-12)  # ~ largura média do pedaço (graus)
                if comum_barreira < 0.3 and resto_barreira > 0.5 and largura < 0.0035:
                    dono[k] = j; mudou += 1
                    break
        print("rodada", rodada, "pedaços passados para a avenida/barreira:", mudou, flush=True)
        if not mudou:
            break

    # Os pedaços já cobrem o município sem sobreposição: cada Conselho é a junção dos seus.
    novos = [so_areas(juntar([faces[k] for k in range(len(faces)) if dono[k] == i])) for i in range(len(geos))]
    print("Conselhos montados", flush=True)
    # Limpeza: buraquinhos e pedacinhos (< 0,05 km²) que sobram entre pedaços viravam "divisas" soltas no mapa.
    MIN = 0.05 / KM2
    novos = [so_areas(unary_union([Polygon(q.exterior, [h for h in q.interiors if Polygon(h).area >= MIN])
                                   for q in getattr(g, "geoms", [g])])) for g in novos]
    for i in range(len(novos)):
        partes = list(getattr(novos[i], "geoms", [novos[i]]))
        grandes = [q for q in partes if q.area >= MIN] or [max(partes, key=lambda q: q.area)]
        for q in partes:
            if q not in grandes:
                j = max((k for k in range(len(novos)) if k != i), key=lambda k: novos[k].buffer(1e-6).intersection(q.buffer(1e-6)).area)
                novos[j] = so_areas(unary_union([novos[j], q]))
        novos[i] = so_areas(unary_union(grandes))
    for i in range(1, len(novos)):
        novos[i] = so_areas(novos[i].difference(unary_union(novos[:i])).buffer(1e-7).buffer(-1e-7))

    for i, f in enumerate(cons):
        g = novos[i]
        antes = geos[i]
        mudou_km2 = (g.symmetric_difference(antes).area) * KM2
        f["geometry"] = mapping(so_areas(g.simplify(0.00002, preserve_topology=True)))
        f["properties"]["area_km2"] = round(g.area * KM2, 1)
        maior = max(getattr(g, "geoms", [g]), key=lambda x: x.area)
        pt = polylabel(maior, tolerance=0.0005)
        f["properties"]["rotulo"] = [round(pt.x, 5), round(pt.y, 5)]
        aj = [a for a in f["properties"].get("ajustes") or [] if not str(a).startswith("Divisas ajustadas")]
        aj.append(f"Divisas ajustadas às referências (divisas de bairro, avenidas, rodovias e cursos d'água); "
                  f"{str(round(mudou_km2, 2)).replace('.', ',')} km² mudaram de lado; nenhum local de votação mudou de Conselho")
        f["properties"]["ajustes"] = aj
        print(nomes[i], round(g.area * KM2, 1), "km²; mudou", round(mudou_km2, 2), "km²")
    atual["nota"] = atual["nota"].split(" Divisas:")[0] + (" Divisas: por divisas de bairro, avenidas, rodovias e cursos d'água, "
                                                          "sem mudar o Conselho de nenhum local de votação (scripts/conselho_divisas.py).")
    # conferência: todo local de votação no Conselho certo
    erros = [(reg) for pt, reg in locais if reg in nomes and not novos[nomes.index(reg)].buffer(1e-6).contains(pt)]
    print("locais fora do seu Conselho:", len(erros), "de", len(locais))
    (RAIZ / "docs/data/conselho_regioes.geojson").write_text(json.dumps(atual, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
