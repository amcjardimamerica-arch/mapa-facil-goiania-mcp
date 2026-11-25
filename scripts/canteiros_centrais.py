"""Canteiros centrais das avenidas do Jardim América e da Nova Suíça -> docs/data/areas_complemento.json.

    python scripts/canteiros_centrais.py PASTA_DA_EXTRACAO [planilha.xlsx]

PASTA_DA_EXTRACAO é a saída de scripts/extrair_mapafacil.py (usa dados/Feature_Base/2 e /7).

O cadastro da Prefeitura não tem polígono de canteiro. Nas avenidas de pista dupla o Mapa Fácil
desenha um eixo por pista, com o mesmo nome (ex.: duas linhas "AV T 63"). O canteiro é a faixa entre
as duas pistas: a cada 4 m de um eixo procura-se o eixo paralelo de mesmo nome (5 a 40 m, ângulo
< 20°, lado a lado); a faixa fica no meio, com largura = distância entre eixos − 2 × meia pista (3,5 m), e é
interrompida nos cruzamentos. Só o que fica dentro dos dois bairros (+20 m, avenidas de divisa).

O levantamento da Associação (levantamento.json) manda: onde ele já tem canteiro, praça ou área, a
faixa estimada é recortada e fica só o restante. Também vão aqui os nomes completos conferidos no
Google (Praça C232 = Praça do Imigrante Italiano; Praça C246 = Praça José Rodrigues Naves Júnior),
aplicados por cima do levantamento sem alterá-lo (o importar_levantamento.py regrava aquele arquivo).
"""
from __future__ import annotations

import gzip
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import LineString, Polygon, shape
from shapely.ops import nearest_points, unary_union
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extrair_dados import projecao_local  # noqa: E402

RAIZ = Path(__file__).resolve().parent.parent
LEVANTAMENTO = RAIZ / "docs" / "data" / "levantamento.json"
SAIDA = RAIZ / "docs" / "data" / "areas_complemento.json"
BAIRROS = {"000400000015": "Jardim América", "000400000017": "Nova Suíça"}
SIGLA = {"Jardim América": "JA", "Nova Suíça": "NS"}
CAT = "Canteiros Centrais e Áreas Remanescentes"
MEIA_PISTA = 3.5
PASSO = 4.0

# Nomes completos conferidos no Google Maps (o código fica junto: é o nome que está na placa da rua).
NOMES = {
    "Praça C232": "Praça C232 - Praça do Imigrante Italiano",
    "Praça C246": "Praça C246 - Praça José Rodrigues Naves Júnior",
}

PEQUENAS = {"de", "da", "do", "das", "dos", "e"}


def nome_avenida(nm: str) -> str:
    """'AV T 63' -> 'Av. T63'; 'Av Ana Nunes De Morais' -> 'Av. Ana Nunes de Morais'."""
    resto = re.sub(r"^av\.?\s+", "", nm.strip(), flags=re.I)
    m = re.fullmatch(r"([A-Za-z]{1,2})\s*-?\s*(\d+[A-Za-z]?)", resto)
    if m:
        return f"Av. {m.group(1).upper()}{m.group(2).upper()}"
    pal = [p.lower() if i and p.lower() in PEQUENAS else p[:1].upper() + p[1:].lower() for i, p in enumerate(resto.split())]
    return "Av. " + " ".join(pal)


def ler(caminho: Path):
    return json.load(gzip.open(caminho, "rt", encoding="utf-8"))["features"]


def decodificar(anel: list[int]) -> list[tuple[float, float]]:
    out, x, y = [], 0, 0
    for i in range(0, len(anel), 2):
        x += anel[i]
        y += anel[i + 1]
        out.append((x / 1e6, y / 1e6))
    return out


def codificar(coords) -> list[int]:
    pts = [(round(x * 1e6), round(y * 1e6)) for x, y in coords]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    out, px, py = [], 0, 0
    for x, y in pts:
        out += [x - px, y - py]
        px, py = x, y
    return out


def direcao(linha: LineString, d: float):
    a = linha.interpolate(max(0.0, d - 2))
    b = linha.interpolate(min(linha.length, d + 2))
    return b.x - a.x, b.y - a.y


def faixas(eixos: list[LineString]) -> list[list[tuple[float, float, float]]]:
    """Pontos médios (x, y, largura) entre eixos paralelos de mesmo nome."""
    arv = STRtree(eixos)
    saida = []
    for i, g in enumerate(eixos):
        n = max(2, int(g.length / PASSO))
        atual = []
        for k in range(n + 1):
            d = g.length * k / n
            p = g.interpolate(d)
            melhor = None
            for j in arv.query(p.buffer(40)):
                if j == i:
                    continue
                h = eixos[j]
                q = nearest_points(p, h)[1]
                dist = p.distance(q)
                if 5 < dist < 40:
                    v1, v2 = direcao(g, d), direcao(h, h.project(q))
                    n1, n2 = math.hypot(*v1), math.hypot(*v2)
                    # paralelos (< 20°) e lado a lado: a ligação p→q é quase perpendicular à via (> 70°),
                    # o que descarta o trecho seguinte da mesma via (colinear, ponta com ponta)
                    lado = abs(((q.x - p.x) * v1[0] + (q.y - p.y) * v1[1]) / (dist * n1)) if n1 else 1
                    if n1 and n2 and abs((v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)) > 0.94 and lado < 0.34 \
                            and (melhor is None or dist < melhor[0]):
                        melhor = (dist, q)
            if melhor:
                dist, q = melhor
                atual.append(((p.x + q.x) / 2, (p.y + q.y) / 2, max(1.2, dist - 2 * MEIA_PISTA)))
            else:
                if len(atual) >= 2:
                    saida.append(atual)
                atual = []
        if len(atual) >= 2:
            saida.append(atual)
    return saida


def main(pasta: str, planilha: str | None = None) -> int:
    base = Path(pasta) / "dados" / "Feature_Base"
    para_m, para_g = projecao_local(-49.28, -16.71)
    bairros = {}
    for f in ler(base / "2-divisas-de-bairro.geojson.gz"):
        nome = BAIRROS.get(str(f["properties"].get("id")))
        if nome:
            bairros[nome] = para_m(shape(f["geometry"]).buffer(0))
    B = unary_union(list(bairros.values()))
    zona = B.buffer(20)

    perto = B.buffer(100)
    segs = []
    for f in ler(base / "7-segmento-de-logradouro.geojson.gz"):
        if not f["geometry"]:
            continue
        g = para_m(shape(f["geometry"]))
        if not g.intersects(perto):
            continue
        nm = (f["properties"].get("nm") or "").strip()
        tp = str(f["properties"].get("tp_log") or "").strip().upper()
        for linha in getattr(g, "geoms", [g]):
            segs.append((nm, tp, linha))
    arv_segs = STRtree([s[2] for s in segs])

    por_nome = defaultdict(list)
    for nm, tp, linha in segs:
        if tp == "AV" and nm:
            por_nome[nm].append(linha)

    # Levantamento da Associação: o que já está desenhado lá não é refeito aqui.
    lev = json.loads(LEVANTAMENTO.read_text(encoding="utf-8"))
    ja_desenhado = []
    canteiros_lev = []
    for a in lev["areas"]:
        for anel in a["g"]:
            pts = decodificar(anel)
            if len(pts) < 3:
                continue
            pol = para_m(Polygon(pts).buffer(0))
            ja_desenhado.append(pol)
            if a["cat"] == CAT and a["nome"].startswith("Canteiro"):
                canteiros_lev.append((a["nome"], pol))
    ja = unary_union(ja_desenhado).buffer(1.0)

    areas, conferencia, brutos = [], [], []
    por_bairro = defaultdict(lambda: defaultdict(list))
    for nm, eixos in sorted(por_nome.items()):
        if len(eixos) < 2:
            continue
        poligonos = []
        for pontos in faixas(eixos):
            for a, b in zip(pontos, pontos[1:]):
                if math.hypot(b[0] - a[0], b[1] - a[1]) > 2 * PASSO + 1:
                    continue
                poligonos.append(LineString([a[:2], b[:2]]).buffer((a[2] + b[2]) / 4, cap_style=2))
        if not poligonos:
            continue
        u = unary_union(poligonos)
        outras = [segs[k][2] for k in arv_segs.query(u.buffer(10)) if segs[k][0] != nm]
        if outras:
            u = u.difference(unary_union([s.buffer(MEIA_PISTA + 1.5) for s in outras]))
        u = u.intersection(zona)
        brutos.append(u)
        u = u.difference(ja).simplify(0.4)
        for p in getattr(u, "geoms", [u]):
            if p.geom_type != "Polygon" or p.area < 25:
                continue
            comprimento = p.minimum_rotated_rectangle.exterior.length / 2
            if comprimento < 20:
                continue
            c = p.representative_point()
            bairro = min(bairros, key=lambda b: bairros[b].distance(c))
            por_bairro[bairro][nm].append(Polygon(p.exterior))

    seq = defaultdict(int)
    for bairro in ("Jardim América", "Nova Suíça"):
        for nm in sorted(por_bairro[bairro], key=nome_avenida):
            partes = por_bairro[bairro][nm]
            area = sum(p.area for p in partes)
            if area < 100:  # sobra de cruzamento na divisa do bairro, não é canteiro
                continue
            comp = sum(p.minimum_rotated_rectangle.exterior.length / 2 for p in partes)
            seq[bairro] += 1
            codigo = f"AP-{SIGLA[bairro]}-CC{seq[bairro]:02d}"
            nome = f"Canteiro Central - {nome_avenida(nm)} - {bairro}"
            fonte = "Mapa Fácil — eixos das duas pistas (segmentos de logradouro); traçado estimado pela Bússola"
            complemento = (f"{len(partes)} trecho(s), cerca de {comp:,.0f} m de extensão e {area / max(comp, 1):.1f} m de largura média. "
                           "Faixa entre as pistas, interrompida nos cruzamentos; confira no local.").replace(",", ".")
            v = [bairro, CAT, nome, "CANTEIRO CENTRAL", None, "PREFEITURA MUNICIPAL DE GOIANIA", None, complemento,
                 round(area, 1), None, None, None, fonte, codigo]
            g = [codificar(para_g(p).exterior.coords) for p in sorted(partes, key=lambda p: -p.area)]
            areas.append({"nome": nome, "cat": CAT, "cor": "#7fff00", "bai": bairro, "estimado": True, "g": g, "v": v,
                          "desc": [f"{CAT} · {bairro}", nome, complemento, f"Fontes: {fonte}", f"Código para manutenção: {codigo}"]})

    # Conferência com os canteiros do levantamento: quanto do canteiro da Associação o traçado bruto cobria.
    tudo = unary_union(brutos).buffer(2) if brutos else Polygon()
    for nome, pol in canteiros_lev:
        conferencia.append([nome, round(pol.area, 1), round(100 * pol.intersection(tudo).area / pol.area)])
        print(f"  conferência {nome:60s} {conferencia[-1][2]:3d}% coberto pelo traçado")

    saida = {
        "fonte": "Bússola: canteiros centrais estimados pelos eixos de pista dupla do Mapa Fácil (Jardim América e Nova Suíça) "
                 "e nomes completos conferidos no Google Maps",
        "gerado_em": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "nomes": NOMES,
        "areas": areas,
    }
    SAIDA.write_text(json.dumps(saida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    total = sum(a["v"][8] for a in areas)
    print(f"{SAIDA.name}: {len(areas)} canteiros ({sum(len(a['g']) for a in areas)} trechos, {total:,.0f} m²); "
          f"{len(NOMES)} nomes completos; {len(canteiros_lev)} canteiros do levantamento preservados")

    if planilha:
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Canteiros centrais"
        ws.append(["Código", "Bairro", "Nome", "Trechos", "Área (m²)", "Complemento", "Fonte"])
        for a in areas:
            ws.append([a["v"][13], a["bai"], a["nome"], len(a["g"]), a["v"][8], a["v"][7], a["v"][12]])
        ws2 = wb.create_sheet("Do levantamento (mantidos)")
        ws2.append(["Canteiro do levantamento", "Área (m²)", "% coberto pelo traçado estimado"])
        for linha in conferencia:
            ws2.append(linha)
        ws3 = wb.create_sheet("Nomes completos")
        ws3.append(["No levantamento", "Passa a mostrar"])
        for k, n in NOMES.items():
            ws3.append([k, n])
        for w in wb.worksheets:
            for col in w.columns:
                w.column_dimensions[col[0].column_letter].width = min(80, max(10, *(len(str(c.value or "")) for c in col)))
        wb.save(planilha)
        print(f"planilha: {planilha}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(*sys.argv[1:3]))
