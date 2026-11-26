"""Drenagem Pluvial da A.M.C. Jardim América — base própria de pesquisa (Bússola 1.27.0).

    python scripts/drenagem_pluvial.py

Fonte de pesquisa: o cadastro da microdrenagem do Plano Diretor de Drenagem Urbana de Goiânia (PDDU-GYN, UFG, Seinfra
e Prefeitura), publicado em mapa aberto (instantâneo em scripts/dados/drenagem_pddu.json.gz). Ele é usado como
levantamento de partida; a base gravada aqui é nova, feita pela A.M.C. a partir dele e cruzada com:
  - o levantamento de campo da A.M.C. (bocas de lobo do Jardim América e da Nova Suíça);
  - a Base Cadastral do banco local (logradouros, bairros, lotes e quadras);
  - o relevo Copernicus DEM do site (altitude, sentido do escoamento, pontos baixos);
  - a hidrografia do banco local (corpo d'água de cada lançamento).

O que é novo (não existe no cadastro de partida):
  - atributos limpos e padronizados (tipo da boca, unidades, estado, acesso do poço de visita);
  - endereço de cada item: logradouro, bairro, quadra e lote de referência e altitude;
  - boca ligada (ou não) à galeria, poço de visita mais próximo, distância à rua;
  - conferência com o levantamento da A.M.C.: confirmada em campo, só no PDDU, só no levantamento (bocas novas);
  - sentido do escoamento de cada trecho de galeria pelo relevo e capacidade estimada a seção plena (Manning);
  - análises: trechos de rua sem boca de lobo e pontos baixos de rua sem boca de lobo (risco de alagamento);
  - números por bairro e por bacia para a ficha do bairro.
Grava docs/data/drenagem/*.json e acrescenta a drenagem em docs/data/bairros_resumo.json.
"""
from __future__ import annotations

import glob
import gzip
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

RAIZ = Path(__file__).resolve().parents[1]
BANCO = RAIZ / "docs" / "banco" / "dados"
SAIDA = RAIZ / "docs" / "data" / "drenagem"
LAT0 = -16.68
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110540
m = lambda lon, lat: (lon * KX, lat * KY)  # metros aproximados (Goiânia é pequena o bastante)


def camada(servico, cid):
    base = BANCO / servico / str(cid)
    arqs = [base / "todos.json.gz"] if (base / "todos.json.gz").exists() else [
        Path(a) for a in glob.glob(str(base / "*" / "*.json.gz")) if "/indice-" not in a]
    cols, f = None, {}
    for a in arqs:
        d = json.load(gzip.open(a))
        cols = d["c"]
        for it in d["f"]:
            if it[0] not in f:
                f[it[0]] = (it[1], it[2] if len(it) > 2 else None)
    return cols or [], f


def aneis(g):
    out = []
    for a in g or []:
        x = y = 0
        pts = []
        for i in range(0, len(a) - 1, 2):
            x += a[i]; y += a[i + 1]
            pts.append((x / 1e6, y / 1e6))
        if len(pts) >= 2:
            out.append(pts)
    return out


def sa(t):
    t = str(t or "").replace("Ã£", "ã").replace("N:o", "Não").replace("Nio", "Não").replace("�", "ã")
    return "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn").upper().strip()


def nome_via(nm):
    s = re.sub(r"\s+", " ", str(nm or "")).strip()
    mm = re.match(r"^(R|AV|Av|AL|Al|PÇA|Pça|RDV|VIA|Via|TR|TRV|Trv|VL|ETR|Est|VD|ACS)\s+(.*)$", s)
    if not mm:
        return s
    tipos = {"R": "R.", "AV": "Av.", "Av": "Av.", "AL": "Al.", "Al": "Al.", "PÇA": "Pç.", "Pça": "Pç.", "RDV": "Rod.", "VIA": "Via", "Via": "Via",
             "TR": "Tv.", "TRV": "Tv.", "Trv": "Tv.", "VL": "Vl.", "ETR": "Estr.", "Est": "Estr.", "VD": "Vd.", "ACS": "Ac."}
    resto = re.sub(r"^([A-Z]{1,3}) (\d+[A-Z]?)$", r"\1-\2", mm.group(2))
    return f"{tipos.get(mm.group(1), mm.group(1))} {resto}"


def relevo():
    meta = json.loads((RAIZ / "docs/relevo/goiania.json").read_text())
    dif = np.frombuffer(gzip.open(RAIZ / "docs/relevo/goiania.bin.gz").read(), dtype=np.int16).reshape(meta["altura"], meta["largura"])
    alt = np.cumsum(dif.astype(np.float64), axis=1) * meta["escala"]
    L, A = meta["largura"], meta["altura"]

    def h(lon, lat):
        cx = min(L - 1.001, max(0, (lon - meta["oeste"]) / meta["passo"] - 0.5))
        cy = min(A - 1.001, max(0, (meta["norte"] - lat) / meta["passo"] - 0.5))
        x0, y0 = int(cx), int(cy); fx, fy = cx - x0, cy - y0
        return float((alt[y0, x0] * (1 - fx) + alt[y0, x0 + 1] * fx) * (1 - fy) + (alt[y0 + 1, x0] * (1 - fx) + alt[y0 + 1, x0 + 1] * fx) * fy)
    return h


def main():
    SAIDA.mkdir(parents=True, exist_ok=True)
    bruto = json.load(gzip.open(RAIZ / "scripts/dados/drenagem_pddu.json.gz", "rt", encoding="utf-8"))
    h = relevo()

    # ---------------------------------------------------------------- referências do banco local
    cb, fb = camada("Feature_Base", 2)
    kbn, kbid = cb.index("nm"), cb.index("id")
    bairros = []
    for v, g in fb.values():
        ps = [Polygon(r).buffer(0) for r in aneis(g) if len(r) >= 4]
        if ps:
            bairros.append((v[kbid], re.sub(r"\s+", " ", str(v[kbn] or "")).strip(), unary_union(ps)))
    nomes = {b["id"]: b["n"] for b in json.loads((RAIZ / "docs/data/bairros.json").read_text(encoding="utf-8"))["bairros"]}
    bairros = [(i, nomes.get(i, n), g) for i, n, g in bairros]
    arv_b = shapely.STRtree([b[2] for b in bairros])

    def bairro_em(lon, lat):
        r = arv_b.query(Point(lon, lat), predicate="within")
        return bairros[r[0]] if len(r) else None

    cr, fr = camada("Feature_Base", 7)
    kn, kh, kp = cr.index("nm"), cr.index("in_hie"), cr.index("in_pavim")
    ruas = []
    for v, g in fr.values():
        for pts in aneis(g):
            ruas.append((nome_via(v[kn]), v[kh] or 0, v[kp], LineString([m(*p) for p in pts]), pts))
    arv_r = shapely.STRtree([r[3] for r in ruas])

    cl, fl = camada("Feature_Base", 0)
    kq, klt = cl.index("id_qdr"), cl.index("nm_lot")
    cq, fq = camada("Feature_Base", 1)
    qd_nome = {v[cq.index("id")]: str(v[cq.index("nm_qdr")] or "").strip() for v, _ in fq.values()}
    lotes_c, lotes_ref = [], []
    for v, g in fl.values():
        a = aneis(g)
        if not a:
            continue
        xs = [p[0] for p in a[0]]; ys = [p[1] for p in a[0]]
        lotes_c.append(m(sum(xs) / len(xs), sum(ys) / len(ys)))
        lotes_ref.append((qd_nome.get(v[kq], ""), str(v[klt] or "").strip()))
    from scipy.spatial import cKDTree
    arv_l = cKDTree(np.array(lotes_c))

    ch, fh = camada("Mapa_MeioAmbiente", 8)
    khn = ch.index("nm") if "nm" in ch else None
    agua = []
    for v, g in fh.values():
        nome = str(v[khn] or "").strip() if khn is not None else ""
        for pts in aneis(g):
            agua.append((nome, LineString([m(*p) for p in pts])))
    arv_a = shapely.STRtree([a[1] for a in agua])

    def rua_perto(x, y):
        i = arv_r.nearest(Point(x, y))
        r = ruas[i]
        return r, r[3].distance(Point(x, y))

    def lote_perto(x, y):
        d, i = arv_l.query([x, y])
        q, l = lotes_ref[i]
        return q, l, d

    # ---------------------------------------------------------------- rede (galerias)
    # Pontas de boca de lobo: o ramal que sai de uma boca escoa a partir dela (o relevo de 30 m não resolve trechos curtos).
    _ixb = {n: i for i, n in enumerate(bruto["pontos"]["BL"]["colunas"])}
    _bl = [m((r[_ixb["felt:bbox"]][0] + r[_ixb["felt:bbox"]][2]) / 2, (r[_ixb["felt:bbox"]][1] + r[_ixb["felt:bbox"]][3]) / 2) for r in bruto["pontos"]["BL"]["linhas"]]
    from scipy.spatial import cKDTree as _T
    arv_bl0 = _T(np.array(_bl))
    dutos = []
    for o in bruto["dutos"]:
        c = o["c"]; p = o["p"]
        if len(c) < 2:
            continue
        za, zb = h(*c[0]), h(*c[-1])
        ba_, bb_ = arv_bl0.query(m(*c[0]))[0] <= 4, arv_bl0.query(m(*c[-1]))[0] <= 4
        if ba_ != bb_:                    # ramal de boca de lobo: escoa da boca para a galeria
            if bb_: c = c[::-1]; za, zb = zb, za
        elif za < zb:                     # demais trechos: do ponto mais alto para o mais baixo (relevo)
            c = c[::-1]; za, zb = zb, za
        diam = p.get("Diametr") or 0
        comp = sum(math.dist(m(*c[i - 1]), m(*c[i])) for i in range(1, len(c)))
        decl = max(0.5, float(p.get("Decliv_Ter") or 0)) / 100  # declividade do terreno (%) como aproximação do tubo
        mat = str(p.get("Material") or "").strip() or "Não informado"
        nman = 0.013 if sa(mat).startswith("CONCRETO") else 0.015
        area = math.pi * diam ** 2 / 4
        cap = (1 / nman) * area * (diam / 4) ** (2 / 3) * math.sqrt(decl) if diam else None
        dutos.append({"c": c, "d": diam, "mat": mat, "comp": round(comp, 1), "decl": round(decl * 100, 2), "cap": round(cap, 3) if cap else None,
                      "bacia": p.get("Bacia") or "", "queda": round(za - zb, 1)})
    linhas_rede = shapely.STRtree([LineString([m(*q) for q in d["c"]]) for d in dutos])
    print("galerias:", len(dutos), round(sum(d["comp"] for d in dutos) / 1000, 1), "km")

    # ---------------------------------------------------------------- pontos de inspeção
    P = bruto["pontos"]
    def tab(k):
        c = P[k]["colunas"]; ix = {n: i for i, n in enumerate(c)}
        return ix, P[k]["linhas"]
    ixp, pvs = tab("PV")
    pv_xy, pv_out = [], []
    for r in pvs:
        bb = r[ixp["felt:bbox"]]; lon, lat = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        est = sa(r[ixp["Est_Cons"]])
        acesso = "Tampa lacrada" if "LACRAD" in est else "Tampa sob o asfalto" if "PAV" in est else "Acessível" if est == "BOM" else "Sem informação"
        pv_xy.append(m(lon, lat))
        pv_out.append([lon, lat, acesso, r[ixp["Nome"]] or "", 1 if r[ixp["Croqui"]] else 0])
    arv_pv = cKDTree(np.array(pv_xy))

    ixe, elans = tab("ELAN")
    el_out = []
    for r in elans:
        bb = r[ixe["felt:bbox"]]; lon, lat = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        corpo = str(r[ixe["CorpHidr"]] or "").strip()
        if not corpo or sa(corpo) in ("EL", "E.L."):
            x, y = m(lon, lat)
            i = arv_a.nearest(Point(x, y))
            corpo = (agua[i][0] or "curso d'água sem nome") if agua[i][1].distance(Point(x, y)) < 150 else "não chega a curso d'água"
        el_out.append([lon, lat, corpo.replace("C. ", "Córrego ").replace("R. ", "Rio ").title(), r[ixe["Nome"]] or ""])

    # ---------------------------------------------------------------- bocas de lobo
    ixb, bls = tab("BL")
    lv = json.loads((RAIZ / "docs/data/levantamento-nucleo.json").read_text(encoding="utf-8"))
    cbo = lv["bocas"]["colunas"]; kb = {n: i for i, n in enumerate(cbo)}
    amc = [(b["v"][kb["Longitude"]], b["v"][kb["Latitude"]], b["v"][kb["Unidades em sequência"]], b["v"][kb["Código para manutenção"]]) for b in lv["bocas"]["linhas"]]
    amc_xy = np.array([m(a[0], a[1]) for a in amc])
    arv_amc = cKDTree(amc_xy)
    area_amc = unary_union([Polygon([q for q in aneis(l["aneis"])[0]]).buffer(0) for l in lv["limites_oficiais"]]) if lv.get("limites_oficiais") else None
    if area_amc is not None:
        area_amc_m = shapely.transform(area_amc, lambda c: np.column_stack([c[:, 0] * KX, c[:, 1] * KY]))

    bocas, usadas_amc = [], set()
    for r in bls:
        bb = r[ixb["felt:bbox"]]; lon, lat = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        est = sa(r[ixb["Est_Cons"]])
        implantada = not ("IMPLANT" in est or est == "N")
        grel, comb = sa(r[ixb["Grelha"]]) in ("SIM",), sa(r[ixb["Combin"]]) in ("SIM",)
        tipo = "Combinada" if comb else "Grelha" if grel else "Simples (guia)"
        estado = "Não implantada" if not implantada else "Ruim" if est == "RUIM" else "Bom" if est == "BOM" else "Sem informação"
        bocas.append({"lon": lon, "lat": lat, "un": max(1, int(r[ixb["Qtd"]] or 1)), "tipo": tipo, "estado": estado, "bacia": r[ixb["Nome"]] or "",
                      "origem": "PDDU"})
    # conferência com o levantamento da A.M.C. (até 12 m)
    for b in bocas:
        x, y = m(b["lon"], b["lat"])
        d, i = arv_amc.query([x, y])
        if d <= 12 and b["estado"] != "Não implantada":
            b["origem"] = "PDDU + A.M.C."; b["amc"] = amc[i][3]; usadas_amc.add(i)
        elif area_amc is not None and area_amc_m.contains(Point(x, y)) and b["estado"] != "Não implantada":
            b["origem"] = "PDDU (não achada no levantamento da A.M.C.)"
    for i, a in enumerate(amc):
        if i not in usadas_amc:
            bocas.append({"lon": a[0], "lat": a[1], "un": a[2] or 1, "tipo": "Simples (guia)", "estado": "Bom", "bacia": "", "origem": "Só no levantamento da A.M.C.", "amc": a[3]})
    pts_bocas = []
    for k, b in enumerate(bocas):
        x, y = m(b["lon"], b["lat"])
        rua, drua = rua_perto(x, y)
        q, l, dl = lote_perto(x, y)
        dpv, _ = arv_pv.query([x, y])
        dg = linhas_rede.geometries[linhas_rede.nearest(Point(x, y))].distance(Point(x, y))
        ba = bairro_em(b["lon"], b["lat"])
        b.update({"rua": rua[0], "drua": round(drua, 1), "q": q, "l": l, "bairro": ba[1] if ba else "", "bid": ba[0] if ba else "",
                  "alt": round(h(b["lon"], b["lat"]), 1), "dpv": round(float(dpv), 1), "ligada": dg <= 15, "dgal": round(dg, 1)})
        pts_bocas.append((x, y))
    existentes = [b for b in bocas if b["estado"] != "Não implantada"]
    arv_bl = cKDTree(np.array([m(b["lon"], b["lat"]) for b in existentes]))
    print("bocas:", len(bocas), "existentes:", len(existentes), Counter(b["origem"] for b in bocas))

    # ---------------------------------------------------------------- análises
    # Área coberta pelo cadastro: quadrados de 250 m com boca de lobo ou galeria (fora dela o cadastro não chegou, e a
    # falta de boca não quer dizer que ela não exista).
    coberto = set()
    for b in existentes:
        x, y = m(b["lon"], b["lat"]); coberto.add((int(x // 250), int(y // 250)))
    for d in dutos:
        for q in d["c"]:
            x, y = m(*q); coberto.add((int(x // 250), int(y // 250)))
    cob = lambda x, y: (int(x // 250), int(y // 250)) in coberto
    # 1) trechos de rua (dentro de bairro, pavimentados) a mais de 80 m de qualquer boca de lobo existente
    sem_boca = []
    for nome, hie, pav, lm, pts in ruas:
        if lm.length < 40 or pav not in ("ASF",):
            continue
        amostras = [lm.interpolate(t, normalized=True) for t in (0.1, 0.5, 0.9)]
        ds = [arv_bl.query([p.x, p.y])[0] for p in amostras]
        if min(ds) > 80 and cob(lm.interpolate(0.5, normalized=True).x, lm.interpolate(0.5, normalized=True).y):
            mid = pts[len(pts) // 2]
            if bairro_em(*mid):
                sem_boca.append({"c": [[round(a, 6), round(b, 6)] for a, b in pts], "rua": nome, "m": round(lm.length), "dist": round(min(ds))})
    # 2) pontos baixos: cruzamentos mais baixos que todas as ruas que chegam neles, sem boca de lobo a até 30 m
    pontas = defaultdict(list)
    for nome, hie, pav, lm, pts in ruas:
        for a, b in ((pts[0], pts[-1]), (pts[-1], pts[0])):
            pontas[(round(a[0] * 2e4), round(a[1] * 2e4))].append((a, b, nome, pav))
    baixos = []
    for k, lst in pontas.items():
        if len(lst) < 2:
            continue
        a = lst[0][0]; za = h(*a)
        if all(h(*o[1]) - za > 0.8 for o in lst) and any(o[3] == "ASF" for o in lst):
            x, y = m(*a)
            d, _ = arv_bl.query([x, y])
            if d > 30 and cob(x, y) and bairro_em(*a):
                baixos.append([round(a[0], 6), round(a[1], 6), round(float(d)), " × ".join(sorted({o[2] for o in lst}))[:120], round(min(h(*o[1]) - za for o in lst), 1)])
    print("trechos sem boca:", len(sem_boca), round(sum(s["m"] for s in sem_boca) / 1000, 1), "km; pontos baixos sem boca:", len(baixos))

    # ---------------------------------------------------------------- saída
    COL_B = ["lon", "lat", "unidades", "tipo", "estado", "origem", "logradouro", "bairro", "quadra", "lote", "altitude_m", "dist_rua_m",
             "dist_poço_visita_m", "ligada_galeria", "dist_galeria_m", "bacia", "codigo_amc"]
    linhas_b = [[round(b["lon"], 6), round(b["lat"], 6), b["un"], b["tipo"], b["estado"], b["origem"], b["rua"], b["bairro"], b["q"], b["l"], b["alt"],
                 b["drua"], b["dpv"], 1 if b["ligada"] else 0, b["dgal"], b["bacia"], b.get("amc") or ""] for b in bocas]
    fonte = ("Base própria da A.M.C. Jardim América (Bússola), construída a partir do cadastro da microdrenagem do Plano Diretor de Drenagem "
             "Urbana de Goiânia (PDDU-GYN — UFG, Seinfra e Prefeitura de Goiânia; versão de 26/08/2025) como fonte de pesquisa, cruzado com o "
             "levantamento de campo da A.M.C., a Base Cadastral municipal e o relevo Copernicus DEM.")
    def grava(nome, obj):
        (SAIDA / nome).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    grava("bocas.json", {"fonte": fonte, "colunas": COL_B, "linhas": linhas_b})
    grava("inspecao.json", {"fonte": fonte, "pocos": {"colunas": ["lon", "lat", "acesso", "bacia", "croqui"],
                                                       "linhas": [[round(a, 6), round(b, 6), c, d, e] for a, b, c, d, e in pv_out]},
                            "lancamentos": {"colunas": ["lon", "lat", "corpo_hidrico", "bacia"], "linhas": [[round(a, 6), round(b, 6), c, d] for a, b, c, d in el_out]}})
    # galerias: coordenadas em micrograus com deltas (como o levantamento)
    def delta(c):
        out, px, py = [], 0, 0
        for lon, lat in c:
            x, y = round(lon * 1e6), round(lat * 1e6)
            out += [x - px, y - py]; px, py = x, y
        return out
    grava("rede.json", {"fonte": fonte, "colunas": ["diametro_m", "material", "comprimento_m", "declividade_pct", "capacidade_m3s", "bacia", "queda_m"],
                        "linhas": [[d["d"], d["mat"], d["comp"], d["decl"], d["cap"], d["bacia"], d["queda"], delta(d["c"])] for d in dutos]})
    grava("analises.json", {"fonte": fonte, "sem_boca": sem_boca, "pontos_baixos": {"colunas": ["lon", "lat", "boca_mais_proxima_m", "cruzamento", "desnivel_m"], "linhas": baixos}})

    # números por bairro e da cidade
    por_bairro = defaultdict(Counter)
    for b in bocas:
        if b["bid"] and b["estado"] != "Não implantada":
            c = por_bairro[b["bid"]]
            c["drenagem_bocas"] += 1; c["drenagem_unidades"] += b["un"]
            if not b["ligada"]: c["drenagem_bocas_sem_galeria"] += 1
            if b["estado"] == "Ruim": c["drenagem_bocas_ruins"] += 1
    for x in pv_out:
        ba = bairro_em(x[0], x[1])
        if ba:
            por_bairro[ba[0]]["drenagem_pocos"] += 1
            if x[2] != "Acessível": por_bairro[ba[0]]["drenagem_pocos_fechados"] += 1
    for d in dutos:
        c = d["c"][len(d["c"]) // 2]
        ba = bairro_em(*c)
        if ba: por_bairro[ba[0]]["drenagem_galeria_m"] += d["comp"]
    for s in sem_boca:
        ba = bairro_em(*s["c"][len(s["c"]) // 2])
        if ba: por_bairro[ba[0]]["drenagem_ruas_sem_boca_m"] += s["m"]
    for p in baixos:
        ba = bairro_em(p[0], p[1])
        if ba: por_bairro[ba[0]]["drenagem_pontos_baixos"] += 1
    resumo = {"fonte": fonte, "gerado_em": "2026-11-26",
              "cidade": {"bocas": len(existentes), "unidades": sum(b["un"] for b in existentes), "nao_implantadas": len(bocas) - len(existentes),
                         "so_amc": sum(b["origem"] == "Só no levantamento da A.M.C." for b in bocas),
                         "conferidas_amc": sum(b["origem"] == "PDDU + A.M.C." for b in bocas),
                         "pocos": len(pv_out), "pocos_fechados": sum(x[2] != "Acessível" for x in pv_out), "lancamentos": len(el_out),
                         "galeria_km": round(sum(d["comp"] for d in dutos) / 1000, 1), "bocas_sem_galeria": sum(not b["ligada"] for b in existentes),
                         "ruas_sem_boca_km": round(sum(s["m"] for s in sem_boca) / 1000, 1), "pontos_baixos": len(baixos)},
              "por_bacia": defaultdict(Counter)}
    for b in existentes:
        if b["bacia"]: resumo["por_bacia"][b["bacia"]]["bocas"] += 1
    for d in dutos:
        if d["bacia"]: resumo["por_bacia"][d["bacia"]]["galeria_m"] += d["comp"]
    resumo["por_bacia"] = {k: {kk: round(vv) for kk, vv in v.items()} for k, v in sorted(resumo["por_bacia"].items())}
    resumo["cobertura_km2"] = round(len(coberto) * 0.0625, 1)
    grava("resumo.json", resumo)
    rb = RAIZ / "docs/data/bairros_resumo.json"
    if rb.exists():
        R = json.loads(rb.read_text(encoding="utf-8"))
        R["rotulos"].update({"drenagem_bocas": "Bocas de lobo", "drenagem_unidades": "Unidades de boca de lobo",
                             "drenagem_bocas_sem_galeria": "Bocas sem galeria a até 15 m", "drenagem_bocas_ruins": "Bocas em estado ruim",
                             "drenagem_pocos": "Poços de visita", "drenagem_pocos_fechados": "Poços de visita lacrados ou sob o asfalto",
                             "drenagem_galeria_m": "Galerias pluviais (m)", "drenagem_ruas_sem_boca_m": "Ruas sem boca de lobo a 80 m (m)",
                             "drenagem_pontos_baixos": "Pontos baixos de rua sem boca de lobo"})
        for bid, c in por_bairro.items():
            if bid in R["bairros"]:
                R["bairros"][bid]["c"].update({k: round(v) for k, v in c.items()})
        rb.write_text(json.dumps(R, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(resumo["cidade"], ensure_ascii=False))
    for f in sorted(SAIDA.glob("*.json")):
        print(f.name, round(f.stat().st_size / 1e6, 2), "MB")


if __name__ == "__main__":
    main()
