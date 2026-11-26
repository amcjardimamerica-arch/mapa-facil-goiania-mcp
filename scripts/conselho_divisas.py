"""Divisas dos Conselhos Tutelares por referências reais (1.25.1; regras da 1.26.0 no fim deste texto).

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

1.26.0 (pedido da A.M.C.):
  - Rio Meia Ponte e demais cursos d'água só valem como divisa onde não há bairro: dentro da área dos bairros a divisa
    segue a divisa dos bairros que passam em cima do rio (com as curvas dessas divisas);
  - nenhum Conselho tem pedaço solto nem área dentro de outro (enclave): pedaço sem local de votação vai para o
    Conselho que o cerca;
  - relatório das referências de cada divisa (ruas, avenidas, rodovias, rios e divisas de bairro) em
    docs/data/conselho_divisas.json, para a ficha.
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
    area_bairros = unary_union([Polygon(r).buffer(0) for b in bairros for r in (b["rings"] or []) if len(r) >= 4])
    vias = unary_union([borda(shape(f["geometry"])) for f in refs["features"] if f["properties"].get("tipo") != "hidrografia"])
    # Cursos d'água (Rio Meia Ponte inclusive) só fora da área dos bairros: dentro dela vale a divisa dos bairros.
    agua = unary_union([borda(shape(f["geometry"])) for f in refs["features"] if f["properties"].get("tipo") == "hidrografia"])
    agua = agua.difference(area_bairros.buffer(0.0002))
    barreiras = unary_union([vias, agua]).intersection(limite.buffer(0.0005))
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
    # Limpeza (1.26.0): nenhum buraco e nenhum pedaço solto. Buraco (área de outro Conselho cercada) e pedaço solto
    # sem local de votação vão para o Conselho que os cerca (o de maior divisa comum).
    tem_local = lambda geom: any(geom.buffer(1e-6).contains(pt) for pt, _ in locais)
    for rodada in range(4):
        mudou = 0
        for i in range(len(novos)):
            partes = list(getattr(novos[i], "geoms", [novos[i]]))
            maior = max(partes, key=lambda q: q.area)
            for q in partes:
                if q is maior or tem_local(q):
                    continue
                viz = [k for k in range(len(novos)) if k != i]
                j = max(viz, key=lambda k: novos[k].buffer(2e-5).intersection(q.exterior.buffer(2e-5)).area)
                novos[j] = so_areas(unary_union([novos[j], q])); mudou += 1
            restantes = [q for q in partes if q is maior or tem_local(q)]
            novos[i] = so_areas(unary_union([Polygon(q.exterior) for q in restantes]))  # sem buracos
        # o que era buraco de um passou a ser dele: tira dos demais
        for i in range(len(novos)):
            for k in range(len(novos)):
                if k != i and novos[i].intersects(novos[k]) and novos[i].intersection(novos[k]).area > 1e-12:
                    # quem tem local de votação no trecho disputado fica com ele; senão, o que o cerca
                    disputa = novos[i].intersection(novos[k])
                    if tem_local(so_areas(disputa)) and any(novos[k].buffer(1e-6).contains(pt) and disputa.buffer(1e-6).contains(pt) for pt, reg in locais if reg == nomes[k]):
                        novos[i] = so_areas(novos[i].difference(novos[k]))
                    else:
                        novos[k] = so_areas(novos[k].difference(novos[i]))
        print("limpeza", rodada, "pedaços soltos passados:", mudou, flush=True)
        if not mudou:
            break
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
    for pt, reg in locais:
        if reg in nomes and not novos[nomes.index(reg)].buffer(1e-6).contains(pt):
            print("  fora:", reg, pt.x, pt.y)
    relatorio_divisas(novos, nomes, refs, bairros, limite)
    (RAIZ / "docs/data/conselho_regioes.geojson").write_text(json.dumps(atual, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def relatorio_divisas(novos, nomes, refs, bairros, limite):
    """Para cada par de Conselhos vizinhos: extensão da divisa e as referências que ela segue (ruas e avenidas pelo
    nome, rodovias, cursos d'água e divisas de bairro), em docs/data/conselho_divisas.json."""
    import gzip, glob
    M = 111320 * 0.958
    linhas_rua = []
    base = RAIZ / "docs/banco/dados/Feature_Base/7"
    vistos = set()
    for a in glob.glob(str(base / "*" / "*.json.gz")):
        if "/indice-" in a:
            continue
        d = json.load(gzip.open(a)); kn = d["c"].index("nm")
        for item in d["f"]:
            if item[0] in vistos or len(item) < 3:
                continue
            vistos.add(item[0])
            for p in item[2] or []:
                x = y = 0; pts = []
                for i in range(0, len(p) - 1, 2):
                    x += p[i]; y += p[i + 1]; pts.append((x / 1e6, y / 1e6))
                if len(pts) >= 2:
                    from shapely.geometry import LineString
                    linhas_rua.append((str(item[1][kn] or "").strip(), LineString(pts)))
    arv = STRtree([g for _, g in linhas_rua])
    agua = [(f["properties"].get("nome") or "Curso d'água").strip() or "Curso d'água" for f in refs["features"]]
    agua_g = [borda(shape(f["geometry"])) for f in refs["features"]]
    arv_ref = STRtree(agua_g)
    bairro_g = [(b["nm"], unary_union([Polygon(r).buffer(0) for r in (b["rings"] or []) if len(r) >= 4])) for b in bairros]
    arv_b = STRtree([g for _, g in bairro_g])
    saida = []
    for i in range(len(novos)):
        for k in range(i + 1, len(novos)):
            comum = novos[i].buffer(1e-6).intersection(novos[k].buffer(1e-6))
            if comum.is_empty:
                continue
            linha = novos[i].boundary.intersection(novos[k].buffer(2e-5))
            total = linha.length * M
            if total < 50:
                continue
            faixa = linha.buffer(0.00012)  # ~13 m
            refs_par = {}
            for j in arv.query(faixa):
                nm, g = linhas_rua[j]
                ext = g.intersection(faixa).length * M
                if nm and ext > 40:
                    refs_par[nm] = refs_par.get(nm, 0) + ext
            for j in arv_ref.query(faixa):
                ext = agua_g[j].intersection(faixa).length * M
                if ext > 60:
                    refs_par[agua[j]] = refs_par.get(agua[j], 0) + ext
            lados = set()
            for j in arv_b.query(faixa):
                nm, g = bairro_g[j]
                if g.boundary.intersection(faixa).length * M > 60:
                    lados.add(nm)
            saida.append({"conselhos": [nomes[i], nomes[k]], "extensao_m": round(total),
                          "referencias": [{"nome": n, "m": round(m)} for n, m in sorted(refs_par.items(), key=lambda x: -x[1]) if m >= 80][:40],
                          "bairros_na_divisa": sorted(lados)})
            print(nomes[i], "x", nomes[k], round(total / 1000, 1), "km:", ", ".join(n for n, _ in sorted(refs_par.items(), key=lambda x: -x[1])[:8]))
    (RAIZ / "docs/data/conselho_divisas.json").write_text(json.dumps({"divisas": saida}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
