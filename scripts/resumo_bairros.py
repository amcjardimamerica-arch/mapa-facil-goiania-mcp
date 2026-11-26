"""Levantamento de cada bairro de Goiânia para a ficha do bairro (clique com a câmera acima de 5 km).

Lê só o banco local do site (docs/banco/dados, extraído do Mapa Fácil) e grava docs/data/bairros_resumo.json:
para cada bairro (pelo id da Base Cadastral), população, área, quadras, lotes, lotes vagos, praças, áreas verdes,
parques, escolas, igrejas e templos, supermercados e mercados, condomínios, locais esportivos, feiras, saúde,
edifícios cadastrados e o cadastro de atividades econômicas por ramo — com os nomes de cada item.

Cada item entra no bairro em que está o seu ponto (ou o centro da sua área): as camadas do Mapa Fácil usam códigos
de bairro diferentes entre si, e o cruzamento espacial com as divisas oficiais é o único que vale para todas.

    python scripts/resumo_bairros.py
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
from shapely.geometry import Polygon, MultiPolygon

RAIZ = Path(__file__).resolve().parents[1]
BANCO = RAIZ / "docs" / "banco" / "dados"
SAIDA = RAIZ / "docs" / "data" / "bairros_resumo.json"
MAX_NOMES = 80  # nomes por categoria em cada bairro (o total vem sempre inteiro)


def camada(servico: str, cid: int):
    """Todas as feições de uma camada do banco: (colunas, {oid: (valores, geometria)})."""
    base = BANCO / servico / str(cid)
    arqs = [base / "todos.json.gz"] if (base / "todos.json.gz").exists() else [
        Path(a) for a in glob.glob(str(base / "*" / "*.json.gz")) if "/indice-" not in a]
    cols, feicoes = None, {}
    for a in arqs:
        d = json.load(gzip.open(a))
        cols = d["c"]
        for item in d["f"]:
            oid, v = item[0], item[1]
            g = item[2] if len(item) > 2 else None
            if oid not in feicoes:
                feicoes[oid] = (v, g)
    return cols or [], feicoes


def aneis(g):
    """Anéis em micrograus com deltas -> [[(lon, lat), …], …]."""
    out = []
    for a in g or []:
        x = y = 0
        pts = []
        for i in range(0, len(a) - 1, 2):
            x += a[i]; y += a[i + 1]
            pts.append((x / 1e6, y / 1e6))
        if len(pts) >= 3:
            out.append(pts)
    return out


def ponto_de(g):
    """Ponto representativo: o próprio ponto, ou a média dos vértices do primeiro anel."""
    if not g:
        return None
    if isinstance(g[0], (int, float)):
        return (g[0] / 1e6, g[1] / 1e6)
    a = aneis(g) or [[]]
    pts = a[0] if a and a[0] else None
    if not pts:  # linha: primeiro trecho
        return None
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def sem_acento(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", str(t or "")) if unicodedata.category(c) != "Mn").upper()


def limpo(t) -> str:
    return re.sub(r"\s+", " ", str(t or "")).strip()


def poligono(rings):
    """Anéis -> polígono (o anel externo é o maior; anéis dentro dele viram buracos)."""
    ps = [Polygon(r).buffer(0) for r in rings]
    ps = [p for p in ps if not p.is_empty]
    if not ps:
        return None
    u = shapely.unary_union(ps) if len(ps) > 1 else ps[0]
    return u


def area_km2(geom) -> float:
    lat = geom.centroid.y
    kx = 111.32 * math.cos(math.radians(lat))
    return geom.area * kx * 110.54


# ---------------------------------------------------------------- categorias
CNAE = [
    ("igrejas", "Igrejas e templos", ("9491",)),
    ("supermercados", "Supermercados e mercados", ("4711301", "4711302", "4712")),
    ("padarias", "Padarias e confeitarias", ("47211", "10911")),
    ("acougues", "Açougues", ("4722901",)),
    ("farmacias", "Farmácias e drogarias", ("47717",)),
    ("restaurantes", "Restaurantes e lanchonetes", ("5611201", "5611203", "5611204", "5611205", "5620")),
    ("bares", "Bares", ("5611202",)),
    ("escolas_privadas", "Escolas particulares", ("8511", "8512", "8513", "852", "853")),
    ("cursos", "Cursos (idiomas, preparatórios, artes e outros)", ("855", "859")),
    ("academias", "Academias, clubes e instalações esportivas", ("9311", "9312", "9313", "9319")),
    ("saude_privada", "Clínicas, consultórios e laboratórios", ("86",)),
    ("combustivel", "Postos de combustível", ("4731",)),
    ("bancos", "Bancos e lotéricas", ("6421", "6422", "6423", "6424", "8299706")),
    ("hoteis", "Hotéis e pousadas", ("5510", "5590")),
    ("condominios", "Condomínios residenciais e comerciais (cadastro econômico)", ("8112",)),
    ("associacoes", "Associações e entidades", ("9430", "9493", "9499")),
]

AREAS = [
    ("pracas", "Praças", lambda g, d: "PRACA" in d),
    ("parques", "Parques e bosques", lambda g, d: g in ("PARQUES MUNICIPAIS", "RESERVAS ECOLOGICAS") or ("PARQUE" in d and "INFANTIL" not in d and "ESPORTIVO" not in d) or "BOSQUE" in d),
    ("areas_verdes", "Áreas verdes", lambda g, d: g.startswith("AREAS VERDES")),
    ("esportivos", "Locais esportivos públicos (ginásios, campos e quadras)", lambda g, d: g == "ESPORTIVO" or "ESPORTE" in d),
    ("escolas_publicas", "Escolas e creches públicas (áreas)", lambda g, d: g == "EDUCACIONAL"),
    ("saude_publica", "Saúde pública (áreas)", lambda g, d: g == "SAUDE"),
    ("feiras", "Feiras e mercados públicos", lambda g, d: g == "ABASTECIMENTO"),
    ("religiosos_publicos", "Áreas públicas de uso religioso", lambda g, d: g == "RELIGIOSO"),
    ("comunitarios", "Centros comunitários e assistenciais", lambda g, d: g in ("COMUNITARIO", "ASSISTENCIAL", "CULTURA")),
    ("seguranca", "Segurança pública", lambda g, d: g == "SEGURANCA"),
    ("outras_areas", "Outras áreas públicas (institucionais, dominiais e demais)", lambda g, d: True),
]


def main():
    # ------------------------------------------------------------ bairros
    cb, fb = camada("Feature_Base", 2)
    kid, knm, kpop, kpm, kpf, ktp = (cb.index(c) for c in ("id", "nm", "pop_total", "pop_masc", "pop_fem", "tp_bai"))
    ids, geoms, res = [], [], {}
    for v, g in fb.values():
        p = poligono(aneis(g))
        if p is None:
            continue
        ids.append(v[kid]); geoms.append(p)
        res[v[kid]] = {"nome": limpo(v[knm]), "tipo": limpo(v[ktp]), "populacao": v[kpop] or 0, "homens": v[kpm] or 0,
                       "mulheres": v[kpf] or 0, "area_km2": round(area_km2(p), 3),
                       "contagem": Counter(), "nomes": defaultdict(list)}
    arvore = shapely.STRtree(geoms)

    def bairro_de(pontos):
        """Lista de (lon, lat) -> lista de id de bairro (ou None)."""
        if not pontos:
            return []
        pts = shapely.points(np.array(pontos))
        par = arvore.query(pts, predicate="within")
        out = [None] * len(pontos)
        for i_pt, i_b in zip(par[0], par[1]):
            if out[i_pt] is None:
                out[i_pt] = ids[i_b]
        return out

    def somar(itens, chave, nome_de=None):
        """itens: [(ponto, objeto)] -> conta por bairro e guarda nomes."""
        validos = [(p, o) for p, o in itens if p]
        for (p, o), b in zip(validos, bairro_de([p for p, _ in validos])):
            if b is None:
                continue
            r = res[b]
            r["contagem"][chave] += 1
            if nome_de:
                n = nome_de(o)
                if n and len(r["nomes"][chave]) < MAX_NOMES and n not in r["nomes"][chave]:
                    r["nomes"][chave].append(n)

    # ------------------------------------------------------------ quadras e lotes
    cq, fq = camada("Feature_Base", 1)
    kqid, kqb = cq.index("id"), cq.index("id_bai")
    bairro_da_quadra = {}
    for v, g in fq.values():
        bairro_da_quadra[v[kqid]] = v[kqb]
        if v[kqb] in res:
            res[v[kqb]]["contagem"]["quadras"] += 1
    cl, fl = camada("Feature_Base", 0)
    klq, klc, kln = cl.index("id_qdr"), cl.index("in_cond"), cl.index("nm_cond")
    for v, g in fl.values():
        b = bairro_da_quadra.get(v[klq])
        if b in res:
            r = res[b]
            r["contagem"]["lotes"] += 1
            if v[klc] == 1:  # lote marcado como condomínio (horizontal) na Base Cadastral
                r["contagem"]["lotes_condominio"] += 1
                nc = limpo(v[kln])
                if nc and nc != "0" and nc not in r["nomes"]["lotes_condominio"] and len(r["nomes"]["lotes_condominio"]) < MAX_NOMES:
                    r["nomes"]["lotes_condominio"].append(nc)

    # Lotes vagos (Uso do Solo → Vazios Urbanos)
    cv, fv = camada("Mapa_UsoDoSoloNew", 16)
    somar([(ponto_de(g), v) for v, g in fv.values()], "lotes_vagos")

    # ------------------------------------------------------------ áreas públicas
    ca, fa = camada("Feature_Base", 4)
    kgr, kde, kes, koc, klg, kqd, klt = (ca.index(c) for c in ("nm_grupo_d", "nm_destin", "nm_estab", "nm_ocupant", "nm_log", "nm_qdr", "nm_lot"))
    por_cat = defaultdict(list)
    for v, g in fa.values():
        gr, de = sem_acento(v[kgr]), sem_acento(v[kde])
        for chave, _, teste in AREAS:
            if teste(gr, de):
                por_cat[chave].append((ponto_de(g), v))
                break
    def nome_area(v):
        """Ocupante (se houver), destinação e a referência: logradouro, quadra e lote."""
        ref = ", ".join(p for p in (limpo(v[klg]).title(), f"Qd {limpo(v[kqd])}" if re.match(r"^\d+[A-Z]?$", limpo(v[kqd])) else "",
                                    f"Lt {limpo(v[klt])}" if re.match(r"^\d+[A-Z]?$", limpo(v[klt])) else "") if p)
        partes = [limpo(v[kes]) or limpo(v[koc]), limpo(v[kde]).capitalize(), ref]
        return " · ".join(p for p in partes if p) or None
    for chave, _, _ in AREAS:
        somar(por_cat[chave], chave, nome_area)

    # ------------------------------------------------------------ cadastro econômico
    ce, fe = camada("Feature_Base", 9)
    kc1, kfan, ksoc = ce.index("CD_ATIV1"), ce.index("NM_FANT"), ce.index("NM_SOCIAL")
    por_cnae = defaultdict(list)
    todas = []
    for v, g in fe.values():
        p = ponto_de(g)
        todas.append((p, v))
        cn = str(v[kc1] or "").rjust(9, "0")[:7]
        for chave, _, pref in CNAE:
            if cn.startswith(pref):
                por_cnae[chave].append((p, v))
                break
    somar(todas, "empresas")
    nome_emp = lambda v: limpo(v[kfan]) or limpo(v[ksoc])
    for chave, _, _ in CNAE:
        somar(por_cnae[chave], chave, nome_emp)

    # ------------------------------------------------------------ demais camadas
    cu, fu = camada("Mapa_UsoDoSoloNew", 5)  # imóveis de uso religioso (cadastro imobiliário)
    ku = cu.index("nmedificio") if "nmedificio" in cu else None
    somar([(ponto_de(g), v) for v, g in fu.values()], "imoveis_religiosos")
    for faixa, cid in (("1 a 3", 1), ("4 a 10", 2), ("11 a 20", 3), ("21 a 30", 4), ("mais de 30", 5)):
        ced, fed = camada("Mapa_Edificios", cid)
        knm_e = ced.index("NM_EDI")
        somar([(ponto_de(g), v) for v, g in fed.values()], "edificios", lambda v, f=faixa: f"{limpo(v[knm_e]) or 'Sem nome'} ({f} pavimentos)")
        somar([(ponto_de(g), v) for v, g in fed.values()], f"edificios_{cid}")
    cpe, fpe = camada("Mapa_PontosNotaveis", 0)
    somar([(ponto_de(g), v) for v, g in fpe.values()], "educacao_municipal", lambda v: limpo(v[cpe.index("nm")]))
    cps, fps = camada("Mapa_PontosNotaveis", 1)
    somar([(ponto_de(g), v) for v, g in fps.values()], "saude_municipal", lambda v: limpo(v[cps.index("nm_sau")]) or limpo(v[cps.index("nm")]))
    _, fo = camada("Mapa_Acessibilidade", 41)
    somar([(ponto_de(g), v) for v, g in fo.values()], "pontos_onibus")
    _, far = camada("Mapa_MeioAmbiente", 3)
    somar([(ponto_de(g), v) for v, g in far.values()], "arvores")
    _, fn = camada("Mapa_MeioAmbiente", 1)
    somar([(ponto_de(g), v) for v, g in fn.values()], "nascentes")

    # Região administrativa (12) e Conselho Tutelar pelo centro do bairro.
    def regioes(servico, cid, campo):
        c, f = camada(servico, cid)
        k = c.index(campo)
        out = []
        for v, g in f.values():
            p = poligono(aneis(g))
            if p is not None:
                out.append((limpo(v[k]), p))
        return out
    reg = regioes("Mapa_Limites", 6, "nm")
    conselhos = []
    geo_ct = RAIZ / "docs" / "data" / "conselho_regioes.geojson"
    if geo_ct.exists():
        from shapely.geometry import shape
        for ft in json.loads(geo_ct.read_text(encoding="utf-8"))["features"]:
            if ft["properties"].get("tipo") == "conselho":
                conselhos.append((ft["properties"].get("regiao"), shape(ft["geometry"])))
    for bid, geom in zip(ids, geoms):
        c = geom.representative_point()
        res[bid]["regiao"] = next((n for n, p in reg if p.contains(c)), "")
        res[bid]["conselho_tutelar"] = next((n for n, p in conselhos if p.contains(c)), "")

    # ------------------------------------------------------------ saída
    rotulos = {"quadras": "Quadras", "lotes": "Lotes", "lotes_vagos": "Lotes vagos (vazios urbanos)",
               "lotes_condominio": "Lotes de condomínio horizontal", "empresas": "Empresas e atividades no cadastro econômico",
               "imoveis_religiosos": "Imóveis de uso religioso (cadastro imobiliário)", "edificios": "Edifícios cadastrados",
               "edificios_1": "Edifícios de 1 a 3 pavimentos", "edificios_2": "Edifícios de 4 a 10 pavimentos",
               "edificios_3": "Edifícios de 11 a 20 pavimentos", "edificios_4": "Edifícios de 21 a 30 pavimentos",
               "edificios_5": "Edifícios com mais de 30 pavimentos", "educacao_municipal": "Escolas e CMEIs municipais",
               "saude_municipal": "Unidades municipais de saúde", "pontos_onibus": "Pontos e plataformas de ônibus",
               "arvores": "Árvores cadastradas", "nascentes": "Nascentes"}
    rotulos.update({k: t for k, t, _ in AREAS})
    rotulos.update({k: t for k, t, _ in CNAE})
    bairros = {}
    for bid, r in res.items():
        bairros[bid] = {k: v for k, v in {
            "nome": r["nome"], "tipo": r["tipo"], "populacao": r["populacao"], "homens": r["homens"], "mulheres": r["mulheres"],
            "area_km2": r["area_km2"], "regiao": r.get("regiao", ""), "conselho_tutelar": r.get("conselho_tutelar", ""),
            "c": dict(r["contagem"]), "n": {k: v for k, v in r["nomes"].items() if v}}.items() if v not in ("", None)}
    saida = {"fonte": "Banco local do Bússola (dados do Mapa Fácil — Prefeitura de Goiânia); cruzamento espacial com as divisas oficiais dos bairros",
             "rotulos": rotulos, "bairros": bairros}
    SAIDA.write_text(json.dumps(saida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    ja = next((b for b in bairros.values() if b["nome"].endswith("Jardim América")), None)
    print(f"{len(bairros)} bairros → {SAIDA} ({SAIDA.stat().st_size / 1e6:.1f} MB)")
    if ja:
        print(json.dumps(ja["c"], ensure_ascii=False))


if __name__ == "__main__":
    main()
