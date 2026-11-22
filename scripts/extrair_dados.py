#!/usr/bin/env python3
"""Extrai do portal Mapa Fácil (Prefeitura de Goiânia) os dados da Bússola.

Fontes oficiais lidas (todas públicas, sem autenticação):

* configuração do aplicativo Mapa Fácil (``config.json``, mapa web, pesquisa e
  galeria de mapas base) — define a lista de temas exatamente como o portal;
* servidor ArcGIS ``servicogyn`` — limites municipais, bairros, edifícios,
  lotes, parques, patrimônio histórico e o catálogo completo de serviços.

Arquivos gerados em ``docs/data``:

``territorio.geojson``  Goiânia + municípios limítrofes (máscara cinza)
``bairros.json``        índice de bairros para a busca (nome, centro, população)
``edificios.json``      edifícios em altura com base aproximada para o 3D
``lugares.json``        parques e equipamentos de educação e saúde (busca e "Explorar")
``logradouros.json``    índice de logradouros por bairro (busca sem acento)
``camadas.json``        temas do portal, mapas base, fontes de busca e catálogo
``manifest.json``       data da extração, contagens e fontes

Uso::

    python scripts/extrair_dados.py                 # tudo
    python scripts/extrair_dados.py --etapas territorio,camadas
    python scripts/extrair_dados.py --saida /tmp/dados

Dependência única além da biblioteca padrão: ``shapely`` (>= 2.0).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import LinearRing, MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import unary_union

VERSAO = "1.0.0"
PORTAL = "https://portalmapa.goiania.go.gov.br"
APP = f"{PORTAL}/mapafacil"
REST = f"{PORTAL}/servicogyn/rest/services"
MS = f"{REST}/MapaServer"
UA = {"User-Agent": f"Bussola-Extrator/{VERSAO} (+github.com/amcjardimamerica-arch/mapa-facil-goiania-mcp)"}

# Município limítrofe = encosta em Goiânia (distância até CONTATO_MAXIMO_M).
# Com menos de DIVISA_MINIMA_M de linha comum o contato é só um vértice
# (caso de Aragoiânia e Bonfinópolis) e fica registrado como "vertice".
CONTATO_MAXIMO_M = 30.0
DIVISA_MINIMA_M = 100.0
# Altura adotada por pavimento no modelo 3D (o cadastro só informa o número de pavimentos).
METROS_POR_PAVIMENTO = 3.0
RAIO_TERRA = 6_378_137.0
CENTRO_GOIANIA = (-49.2648, -16.6869)  # lon, lat — ponto de teste dos serviços de imagem

ETAPAS = ("territorio", "bairros", "edificios", "lugares", "logradouros", "camadas")


# --------------------------------------------------------------------------- rede
def baixar_json(url: str, params: dict | None = None, *, post: bool = False,
                tentativas: int = 5, timeout: int = 180):
    """GET/POST com novas tentativas; trata o erro JSON que o ArcGIS devolve com HTTP 200."""
    dados = urllib.parse.urlencode(params or {})
    ultimo: Exception | None = None
    for i in range(tentativas):
        try:
            if post:
                req = urllib.request.Request(url, data=dados.encode(), headers=UA, method="POST")
            else:
                req = urllib.request.Request(url + ("?" + dados if dados else ""), headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                obj = json.loads(r.read().decode("utf-8", "replace"))
            if isinstance(obj, dict) and obj.get("error"):
                raise RuntimeError(f"ArcGIS: {obj['error']}")
            return obj
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError) as e:
            ultimo = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"Falha ao consultar {url}: {ultimo}")


def esri_para_shapely(geom: dict | None):
    """Converte geometria Esri JSON (ponto ou polígono) em shapely; ``None`` se vazia.

    O servidor falha em ``f=geojson`` quando a camada tem alguma feição sem
    geometria, por isso toda a extração usa ``f=json`` e converte aqui.
    Em Esri JSON os anéis externos são horários e os furos anti-horários.
    """
    if not geom:
        return None
    if "x" in geom and "y" in geom:
        if geom["x"] is None or geom["y"] is None or geom["x"] != geom["x"]:
            return None
        return Point(geom["x"], geom["y"])
    externos, furos = [], []
    for anel in geom.get("rings") or []:
        pts = [(c[0], c[1]) for c in anel]
        if len(pts) < 4:
            continue
        (furos if LinearRing(pts).is_ccw else externos).append(Polygon(pts).buffer(0))
    if not externos:  # base com orientação invertida
        externos, furos = furos, []
    if not externos:
        return None
    g = unary_union(externos)
    if furos:
        g = g.difference(unary_union(furos))
    return None if g.is_empty else g


def consultar(camada: str, where: str = "1=1", campos: str = "*", *, geometria: bool = True,
              extra: dict | None = None, pagina: int = 500, paginar: bool = True) -> list[dict]:
    """Baixa todas as feições de uma camada (WGS84), paginando por OBJECTID.

    ``paginar=False`` faz uma consulta única: necessário nas camadas cujo
    identificador é gerado na hora (ESRI_OID) e por isso não é estável entre
    requisições (Logradouro, Logradouro por Bairro, Cadastro Imobiliário).

    Devolve ``[{"properties": atributos, "geometry": shapely | None}, …]``.
    """
    url = f"{MS}/{camada}/query"
    if paginar:
        ids = baixar_json(url, {"where": where, "returnIdsOnly": "true", "f": "json"}, post=True)
        oids = sorted(ids.get("objectIds") or [])
        blocos = [{"objectIds": ",".join(map(str, oids[i:i + pagina]))} for i in range(0, len(oids), pagina)]
    else:
        blocos = [{"where": where}]
    feicoes: list[dict] = []
    for bloco in blocos:
        p = {**bloco, "outFields": campos,
             "returnGeometry": "true" if geometria else "false",
             "outSR": "4326", "geometryPrecision": "7", "f": "json"}
        p.update(extra or {})
        fc = baixar_json(url, p, post=True)
        if fc.get("exceededTransferLimit"):
            raise RuntimeError(f"{camada}: resposta truncada pelo servidor (exceededTransferLimit)")
        for f in fc.get("features") or []:
            feicoes.append({"properties": f.get("attributes") or {},
                            "geometry": esri_para_shapely(f.get("geometry")) if geometria else None})
    return feicoes


# ----------------------------------------------------------------------- geometria
def projecao_local(lon0: float, lat0: float):
    """Par de funções graus<->metros numa projeção equirretangular local.

    Para a extensão de Goiânia (~45 km) o erro de escala é inferior a 0,1 %,
    suficiente para recuos de lote, comprimentos de divisa e simplificação.
    """
    kx = math.cos(math.radians(lat0)) * RAIO_TERRA * math.pi / 180.0
    ky = RAIO_TERRA * math.pi / 180.0

    def ida(xy):
        return np.column_stack(((xy[:, 0] - lon0) * kx, (xy[:, 1] - lat0) * ky))

    def volta(xy):
        return np.column_stack((xy[:, 0] / kx + lon0, xy[:, 1] / ky + lat0))

    return (lambda g: shapely.transform(g, ida)), (lambda g: shapely.transform(g, volta))


def maior_poligono(g):
    if g is None or g.is_empty:
        return None
    if isinstance(g, Polygon):
        return g
    polis = [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon) and not p.is_empty]
    return max(polis, key=lambda p: p.area) if polis else None


def so_poligonos(g):
    """Descarta linhas/pontos residuais de operações de sobreposição."""
    if isinstance(g, (Polygon, MultiPolygon)):
        return g
    polis = [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon) and p.area > 0]
    return unary_union(polis) if polis else Polygon()


def arredondar(coords, casas=6):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], casas), round(coords[1], casas)]
    return [arredondar(c, casas) for c in coords]


def geojson_geom(g, casas=6) -> dict:
    m = mapping(g)
    return {"type": m["type"], "coordinates": arredondar(m["coordinates"], casas)}


def sem_acento(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").lower().strip()


def gravar(caminho: Path, obj, *, compacto: bool = True) -> int:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    tmp = caminho.with_suffix(caminho.suffix + ".tmp")
    if compacto:
        texto = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    else:
        texto = json.dumps(obj, ensure_ascii=False, indent=2)
    tmp.write_text(texto, encoding="utf-8")
    tmp.replace(caminho)
    return len(texto.encode("utf-8"))


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------- 1 território
def etapa_territorio(saida: Path) -> dict:
    """Goiânia e seus limítrofes, a partir de ``Mapa_Limites`` (Divisas de Município)."""
    log("[territorio] baixando Divisas de Município…")
    feicoes = consultar("Mapa_Limites/MapServer/1", campos="id,nm_mun,in_metro")
    geos = {}
    for f in feicoes:
        nome = (f["properties"].get("nm_mun") or "").strip()
        if nome and f.get("geometry") is not None:
            geos[nome] = (f["geometry"].buffer(0), f["properties"])
    if "Goiânia" not in geos:
        raise RuntimeError("Município de Goiânia não encontrado em Mapa_Limites")

    gyn_g = geos["Goiânia"][0]
    c = gyn_g.centroid
    para_m, para_g = projecao_local(c.x, c.y)
    gyn = para_m(gyn_g)
    # 2 m de tolerância: mantém o contorno oficial e reduz o arquivo em ~90 %.
    gyn_s = maior_poligono(gyn.simplify(2.0, preserve_topology=True))
    faixa = gyn_s.buffer(6000)  # onde posicionar o nome dos vizinhos (perto de Goiânia)

    vizinhos = []
    for nome, (g, props) in sorted(geos.items()):
        if nome == "Goiânia":
            continue
        gm = para_m(g)
        if gm.distance(gyn) > CONTATO_MAXIMO_M:
            continue
        divisa = gm.buffer(5).intersection(gyn.boundary).length
        contato = "divisa" if divisa >= DIVISA_MINIMA_M else "vertice"
        # Simplifica a união com Goiânia e depois recorta: a divisa comum fica
        # idêntica à de Goiânia (sem frestas nem sobreposições na máscara).
        uniao = unary_union([gm.buffer(0.5), gyn_s]).simplify(12.0, preserve_topology=True)
        recorte = so_poligonos(uniao.difference(gyn_s.buffer(0.01)))
        partes = [p for p in getattr(recorte, "geoms", [recorte]) if p.area > 300_000]  # sem lascas do recorte
        gv = unary_union(partes)
        perto = maior_poligono(gv.intersection(faixa)) or maior_poligono(gv)
        rotulo = para_g(perto.representative_point())
        vizinhos.append({
            "type": "Feature",
            "properties": {
                "tipo": "vizinho", "nome": nome, "id": props.get("id"),
                "regiao_metropolitana": bool(props.get("in_metro")),
                "contato": contato,  # "vertice" = encosta em Goiânia em um único ponto
                "divisa_km": round(divisa / 1000, 1) if contato == "divisa" else 0,
                "area_km2": round(gm.area / 1e6, 1),
                "rotulo": [round(rotulo.x, 5), round(rotulo.y, 5)],
            },
            "geometry": geojson_geom(para_g(gv)),
        })
        log(f"   vizinho: {nome:28s} " + (f"divisa {divisa/1000:6.1f} km" if contato == "divisa" else "toca em um ponto"))

    gyn_final = para_g(gyn_s)
    o, s, l, n = gyn_final.bounds
    rot = para_g(gyn_s.representative_point())
    fc = {
        "type": "FeatureCollection",
        "name": "territorio",
        "fonte": f"{MS}/Mapa_Limites/MapServer/1",
        "bbox": [round(o, 5), round(s, 5), round(l, 5), round(n, 5)],
        "features": [{
            "type": "Feature",
            "properties": {"tipo": "goiania", "nome": "Goiânia", "id": geos["Goiânia"][1].get("id"),
                           "area_km2": round(gyn.area / 1e6, 1),
                           "perimetro_km": round(gyn.length / 1000, 1),
                           "rotulo": [round(rot.x, 5), round(rot.y, 5)]},
            "geometry": geojson_geom(gyn_final),
        }] + vizinhos,
    }
    tam = gravar(saida / "territorio.geojson", fc)
    log(f"[territorio] Goiânia {gyn.area/1e6:.1f} km², {len(vizinhos)} limítrofes, {tam/1024:.0f} KB")
    return {"vizinhos": [v["properties"]["nome"] for v in vizinhos],
            "area_goiania_km2": round(gyn.area / 1e6, 1), "bytes": tam}


def carregar_goiania(saida: Path):
    fc = json.loads((saida / "territorio.geojson").read_text(encoding="utf-8"))
    return shape(next(f for f in fc["features"] if f["properties"]["tipo"] == "goiania")["geometry"])


# -------------------------------------------------------------------------- 2 bairros
def etapa_bairros(saida: Path) -> dict:
    log("[bairros] baixando Divisas de Bairro…")
    feicoes = consultar(
        "Feature_Base/MapServer/2",
        campos="id,tp_bai,nm_bai,nm,id_sis,pop_total,pop_masc,pop_fem,in_cond",
        extra={"maxAllowableOffset": "0.00005", "geometryPrecision": "6"})
    gyn = carregar_goiania(saida).buffer(0.002)
    lista = []
    for f in feicoes:
        p = f["properties"]
        if f.get("geometry") is None or not (p.get("nm") or "").strip():
            continue
        g = f["geometry"]
        if g.is_empty or not g.intersects(gyn):
            continue
        rp = g.representative_point()
        o, s, l, n = g.bounds
        lista.append({
            "id": p.get("id"), "n": p["nm"].strip(), "t": (p.get("tp_bai") or "").strip(),
            "b": (p.get("nm_bai") or "").strip(), "k": sem_acento(p["nm"]),
            "c": [round(rp.x, 5), round(rp.y, 5)],
            "e": [round(o, 5), round(s, 5), round(l, 5), round(n, 5)],
            "pop": p.get("pop_total") or 0, "cond": 1 if p.get("in_cond") else 0,
        })
    lista.sort(key=lambda b: (-b["pop"], b["k"]))
    tam = gravar(saida / "bairros.json", {
        "fonte": f"{MS}/Feature_Base/MapServer/2",
        "campos": {"n": "nome", "t": "tipo", "b": "nome sem tipo", "k": "chave de busca",
                   "c": "centro [lon,lat]", "e": "extensão [O,S,L,N]",
                   "pop": "população total (campo pop_total)", "cond": "condomínio horizontal"},
        "bairros": lista})
    log(f"[bairros] {len(lista)} bairros, {tam/1024:.0f} KB")
    return {"total": len(lista), "populacao_somada": sum(b["pop"] for b in lista), "bytes": tam}


# ------------------------------------------------------------------------ 3 edifícios
def _base_do_edificio(lote_m, ponto_m, quantos: int, indice: int):
    """Base aproximada (metros locais) de um edifício dentro do seu lote.

    O cadastro traz o ponto do edifício e o lote, não a projeção da torre.
    * 1 edifício em lote de até 3.000 m²: lote recuado (afastamentos).
    * demais casos (condomínios, lotes grandes): torre quadrada no ponto,
      alinhada ao lote e limitada a ele.
    """
    if lote_m is None or lote_m.is_empty:
        return ponto_m.buffer(11, cap_style=3)
    area = lote_m.area
    mrr = lote_m.minimum_rotated_rectangle
    xs, ys = mrr.exterior.coords.xy
    d1 = math.hypot(xs[1] - xs[0], ys[1] - ys[0])
    d2 = math.hypot(xs[2] - xs[1], ys[2] - ys[1])
    if quantos == 1 and area <= 3000:
        # recuo proporcional à menor dimensão do lote: não vira "palito" em lote estreito
        recuo = min(0.12 * min(d1, d2), 5.0)
        for r in (recuo, recuo / 2, 0.5):
            base = maior_poligono(lote_m.buffer(-r, join_style=2))
            if base is not None and base.area >= 60:
                return base
        return lote_m
    lado = max(16.0, min(30.0, 0.5 * math.sqrt(area / max(quantos, 1))))
    ang = math.degrees(math.atan2(ys[1] - ys[0], xs[1] - xs[0]))
    centro = ponto_m if lote_m.contains(ponto_m) else lote_m.representative_point()
    if quantos > 1:  # espalha as torres do condomínio ao longo do eixo maior do lote
        eixo = ang if d1 >= d2 else ang + 90
        passo = min(lado * 1.35, max(d1, d2) * 0.8 / quantos)
        desloc = (indice - (quantos - 1) / 2) * passo
        cl = lote_m.centroid if not lote_m.contains(ponto_m) else ponto_m
        centro = Point(cl.x + desloc * math.cos(math.radians(eixo)),
                       cl.y + desloc * math.sin(math.radians(eixo)))
    quad = affinity.rotate(centro.buffer(lado / 2, cap_style=3), ang, origin=centro)
    base = maior_poligono(quad.intersection(lote_m.buffer(-1.5)))
    return base if base is not None and base.area >= 40 else quad


def etapa_edificios(saida: Path) -> dict:
    log("[edificios] baixando Edifício em altura (5 faixas de pavimentos)…")
    pontos = []
    for camada in (1, 2, 3, 4, 5):
        pontos += consultar(f"Mapa_Edificios/MapServer/{camada}",
                            campos="CD_EDI,NM_EDI,NR_PAV,TL_APT,TL_TERRENO,DT_AVERBAC,id_lot,CI")
    vistos, edis = set(), []
    for f in pontos:
        p = f["properties"]
        if f.get("geometry") is None or p.get("CD_EDI") in vistos:
            continue
        vistos.add(p.get("CD_EDI"))
        edis.append(f)
    ids_lote = sorted({(f["properties"].get("id_lot") or "").strip() for f in edis} - {""})
    log(f"[edificios] {len(edis)} edifícios em {len(ids_lote)} lotes; baixando lotes…")
    lotes: dict[str, Polygon] = {}
    for i in range(0, len(ids_lote), 100):
        lista = ",".join(f"'{x}'" for x in ids_lote[i:i + 100])
        fc = baixar_json(f"{MS}/Feature_Base/MapServer/0/query", {
            "where": f"id IN ({lista})", "outFields": "id", "returnGeometry": "true",
            "outSR": "4326", "geometryPrecision": "7", "f": "json"}, post=True)
        for f in fc.get("features") or []:
            g = maior_poligono(esri_para_shapely(f.get("geometry")))
            if g is not None:
                lotes[f["attributes"]["id"].strip()] = g

    gyn = carregar_goiania(saida)
    c = gyn.centroid
    para_m, para_g = projecao_local(c.x, c.y)
    grupos: dict[str, list] = {}
    for f in edis:
        grupos.setdefault((f["properties"].get("id_lot") or "").strip(), []).append(f)

    saida_edis, sem_lote = [], 0
    for id_lote, grupo in grupos.items():
        lote = lotes.get(id_lote)
        lote_m = para_m(lote) if lote is not None else None
        if lote is None:
            sem_lote += len(grupo)
        quantos = len(grupo) if lote is not None else 1
        for i, f in enumerate(sorted(grupo, key=lambda x: x["properties"].get("CD_EDI") or 0)):
            p = f["properties"]
            pt = f["geometry"]
            base_m = _base_do_edificio(lote_m, para_m(pt), quantos, i)
            # "abertura" de 1,2 m remove pontas finas herdadas do desenho do lote
            base_m = maior_poligono(base_m.buffer(-1.2, join_style=2).buffer(1.2, join_style=2)) or base_m
            base_m = maior_poligono(base_m.simplify(0.4, preserve_topology=True)) or base_m
            base = para_g(base_m)
            anel = arredondar(list(base.exterior.coords)[:-1], 6)
            cen = base.centroid
            pav = int(p.get("NR_PAV") or 0)
            ano = None
            if p.get("DT_AVERBAC") is not None:
                try:
                    a = datetime.fromtimestamp(p["DT_AVERBAC"] / 1000, tz=timezone.utc).year
                    ano = a if 1930 <= a <= datetime.now().year else None  # 1900 = data não informada
                except (OverflowError, OSError, ValueError):
                    ano = None
            saida_edis.append({
                "id": p.get("CD_EDI"), "n": (p.get("NM_EDI") or "").strip() or "Edifício sem nome",
                "p": pav, "a": int(p.get("TL_APT") or 0), "t": round(p.get("TL_TERRENO") or 0),
                "ano": ano, "ci": (p.get("CI") or "").strip(), "l": id_lote,
                "c": [round(cen.x, 6), round(cen.y, 6)], "f": anel,
            })
    saida_edis.sort(key=lambda e: -e["p"])
    tam = gravar(saida / "edificios.json", {
        "fonte": f"{MS}/Mapa_Edificios/MapServer (camadas 1–5) + Feature_Base/MapServer/0",
        "metros_por_pavimento": METROS_POR_PAVIMENTO,
        "nota": "Base (f) aproximada a partir do lote; altura = pavimentos × metros_por_pavimento. "
                "Modelo esquemático, não é levantamento da edificação.",
        "campos": {"n": "nome", "p": "pavimentos", "a": "apartamentos", "t": "área do terreno (m²)",
                   "ano": "ano de averbação", "ci": "inscrição cadastral", "l": "id do lote",
                   "c": "centro [lon,lat]", "f": "base aproximada [[lon,lat],…]"},
        "edificios": saida_edis})
    log(f"[edificios] {len(saida_edis)} edifícios ({sem_lote} sem lote), "
        f"mais alto: {saida_edis[0]['n']} ({saida_edis[0]['p']} pav.), {tam/1024:.0f} KB")
    return {"total": len(saida_edis), "sem_lote": sem_lote, "max_pavimentos": saida_edis[0]["p"], "bytes": tam}


# -------------------------------------------------------------------------- 4 lugares
SIGLAS = {"CAIS", "CSF", "UPA", "CIAMS", "SAMU", "CMEI", "CMAI", "EM", "CEI", "CAPS", "II", "III", "IV", "GO"}
MINUSCULAS = {"de", "da", "do", "das", "dos", "e", "em"}


def titulo(texto: str) -> str:
    """'BOSQUE DOS BURITIS' -> 'Bosque dos Buritis' (preserva siglas)."""
    palavras = []
    for i, w in enumerate(" ".join((texto or "").split()).split(" ")):
        if w.upper() in SIGLAS:
            palavras.append(w.upper())
        elif w.lower() in MINUSCULAS and i > 0:
            palavras.append(w.lower())
        else:
            palavras.append(w[:1].upper() + w[1:].lower())
    return " ".join(palavras)


def etapa_lugares(saida: Path) -> dict:
    """Parques e equipamentos municipais de educação e saúde (busca local e "Explorar")."""
    log("[lugares] baixando parques e equipamentos municipais…")

    def limpo(v):
        return " ".join(str(v or "").split())

    fontes = [
        ("parque", "Parque", "Mapa_MeioAmbiente/MapServer/11",
         lambda p: titulo(f"{limpo(p.get('tp_unc'))} {limpo(p.get('nm_unc'))}"),
         lambda p: "; ".join(x for x in (limpo(p.get("endereco")), titulo(limpo(p.get("situacao")))) if x)),
        ("educacao", "Educação municipal", "Mapa_PontosNotaveis/MapServer/0",
         lambda p: limpo(p.get("nm")), lambda p: ""),
        ("saude", "Saúde", "Mapa_PontosNotaveis/MapServer/1",
         lambda p: titulo(limpo(p.get("nm"))),
         lambda p: "; ".join(x for x in (
             titulo(f"{limpo(p.get('tp_log'))} {limpo(p.get('nm_log'))}".strip()),
             titulo(limpo(p.get("nm_bai"))), limpo(p.get("in_turno")).capitalize()) if x)),
    ]
    lugares, contagem = [], {}
    for tipo, rotulo, camada, f_nome, f_desc in fontes:
        feicoes = consultar(camada, campos="*", extra={"maxAllowableOffset": "0.00003", "geometryPrecision": "6"})
        juntos: dict[str, list] = {}
        for f in feicoes:
            nome = f_nome(f["properties"])
            if nome and f.get("geometry") is not None:
                juntos.setdefault(nome, []).append(f)
        for nome, itens in juntos.items():
            g = unary_union([i["geometry"] for i in itens])
            if g.is_empty:
                continue
            rp = g.representative_point()
            o, s, l, n = g.bounds
            item = {"n": nome, "tipo": tipo, "r": rotulo, "k": sem_acento(nome),
                    "d": f_desc(itens[0]["properties"])[:240], "c": [round(rp.x, 5), round(rp.y, 5)]}
            if (l - o) > 1e-5:  # ponto não tem extensão
                item["e"] = [round(o, 5), round(s, 5), round(l, 5), round(n, 5)]
            lugares.append(item)
        contagem[tipo] = sum(1 for x in lugares if x["tipo"] == tipo)
    lugares.sort(key=lambda x: (x["tipo"], x["k"]))
    tam = gravar(saida / "lugares.json", {
        "fonte": [f"{MS}/{f[2]}" for f in fontes], "lugares": lugares})
    log(f"[lugares] {len(lugares)} lugares {contagem}, {tam/1024:.0f} KB")
    return {"total": len(lugares), **contagem, "bytes": tam}


# ---------------------------------------------------------------------- 5 logradouros
def etapa_logradouros(saida: Path) -> dict:
    """Índice de logradouros por bairro para busca local.

    A busca do servidor diferencia maiúsculas e acentos ("Anhanguera" não acha
    "Anhangüera"); com o índice local a busca do aplicativo ignora ambos.
    """
    log("[logradouros] baixando Logradouro por Bairro…")
    feicoes = consultar("Feature_Base/MapServer/10", campos="id,nm,nm_bai", geometria=False, paginar=False)
    bairros: dict[str, int] = {}
    ruas, vistos = [], set()
    for f in feicoes:
        p = f["properties"]
        nome = " ".join((p.get("nm") or "").split())
        bai = " ".join((p.get("nm_bai") or "").split())
        ident = (p.get("id") or "").strip()
        if not nome or not ident or (ident, bai) in vistos:
            continue
        vistos.add((ident, bai))
        ruas.append([ident, nome, bairros.setdefault(bai, len(bairros))])
    ruas.sort(key=lambda r: sem_acento(r[1]))
    tam = gravar(saida / "logradouros.json", {
        "fonte": f"{MS}/Feature_Base/MapServer/10",
        "campos": "ruas = [id do logradouro, nome, índice em bairros]",
        "bairros": list(bairros), "ruas": ruas})
    log(f"[logradouros] {len(ruas)} trechos logradouro×bairro, {tam/1024:.0f} KB")
    return {"total": len(ruas), "bytes": tam}


# -------------------------------------------------------------------------- 6 camadas
# Serviços do servidor que não entram como "mais camadas": bases, imagens,
# cópias datadas, testes e amostras.
IGNORAR_EXTRAS = ("Ortofoto", "QuickBird", "Basico", "Teste", "teste", "SampleWorld", "Tableau",
                  "_2022", "_2024", "Desenvolvimento", "Des2019", "MeioAmbiente1", "Vetor")
ROTULOS_EXTRAS = {
    "Mapa_Acessibilidade": "Acessibilidade a Serviços",
    "Mapa_Documentacao": "Documentação de Bairros",
    "Mapa_ExpansaoUrbana": "Expansão Urbana",
    "Mapa_Fiscalizacao": "Fiscalização",
    "Mapa_SaudeFamilia": "Saúde da Família",
    "Mapa_Simplifica_Goiania_UsoDoSolo": "Simplifica Goiânia – Uso do Solo",
    "Mapa_Telecomunicacao": "Telecomunicação (versão anterior)",
    "Mapa_Tributario_Web": "Tributário",
    "Mapa_UsoDoSoloNew": "Uso do Solo",
}


def _https(url: str) -> str:
    return url.replace("http://", "https://", 1)


def _descrever_servico(url: str) -> dict:
    """Árvore de camadas de um MapServer (id, nome, pai, filhos, visibilidade, escalas)."""
    d = baixar_json(url, {"f": "json"})
    camadas = []
    for l in d.get("layers") or []:
        camadas.append({
            "id": l["id"], "nome": " ".join((l.get("name") or "").split()),
            "pai": l.get("parentLayerId", -1),
            "grupo": bool(l.get("subLayerIds")),
            "visivel": bool(l.get("defaultVisibility")),
            "escala_min": l.get("minScale") or 0, "escala_max": l.get("maxScale") or 0,
        })
    return {"camadas": camadas, "capacidades": d.get("capabilities"),
            "max_registros": d.get("maxRecordCount"), "em_cache": bool(d.get("singleFusedMapCache")),
            "descricao": " ".join((d.get("serviceDescription") or d.get("description") or "").split())[:400],
            "creditos": d.get("copyrightText") or ""}


def _nivel_minimo_export(url: str, lon: float, lat: float) -> int:
    """Menor nível de bloco (Web Mercator, 512 px) em que o serviço devolve imagem.

    As ortofotos em cache recusam escalas muito pequenas (a de 2016 só responde
    a partir do nível 11) e devolvem uma página de erro no lugar da imagem.
    """
    meio = 20037508.342789244
    for nivel in (9, 10, 11, 12, 13):
        n = 2 ** nivel
        x = int((lon + 180) / 360 * n)
        y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
        lado = 2 * meio / n
        caixa = (-meio + x * lado, meio - (y + 1) * lado, -meio + (x + 1) * lado, meio - y * lado)
        consulta = urllib.parse.urlencode({
            "bbox": ",".join(f"{v:.3f}" for v in caixa), "bboxSR": "3857", "imageSR": "3857",
            "size": "256,256", "format": "jpg", "transparent": "false", "f": "image"})
        for _ in range(2):
            try:
                req = urllib.request.Request(f"{url}/export?{consulta}", headers=UA)
                with urllib.request.urlopen(req, timeout=90) as r:
                    if (r.headers.get("Content-Type") or "").startswith("image/"):
                        return nivel
                break  # respondeu, mas não com imagem: tenta o próximo nível
            except (urllib.error.URLError, TimeoutError, OSError):
                time.sleep(2)
    return 11


def etapa_camadas(saida: Path) -> dict:
    log("[camadas] lendo a configuração do aplicativo Mapa Fácil…")
    cfg = baixar_json(f"{APP}/config.json")
    item = cfg["map"]["itemId"]
    webmap = baixar_json(f"{PORTAL}/portalgyn/sharing/rest/content/items/{item}/data", {"f": "json"})

    def cfg_widget(nome_uri: str):
        for w in (cfg.get("widgetOnScreen", {}).get("widgets") or []) + \
                 [w for g in (cfg.get("widgetPool", {}).get("groups") or []) for w in g.get("widgets", [])] + \
                 (cfg.get("widgetPool", {}).get("widgets") or []):
            if nome_uri in (w.get("uri") or "") and w.get("config"):
                return baixar_json(f"{APP}/" + urllib.parse.quote(w["config"]))
        return {}

    temas, usados = [], set()
    # O portal desenha a lista de baixo para cima; aqui o primeiro tema é o do topo da lista.
    for op in reversed(webmap.get("operationalLayers") or []):
        url = _https(op["url"]).rstrip("/")
        nome_serv = url.split("/services/")[1].rsplit("/MapServer", 1)[0]
        usados.add(nome_serv)
        try:
            info = _descrever_servico(url)
        except RuntimeError as e:
            log(f"   ! {op.get('title')}: {e}")
            continue
        vis = op.get("visibleLayers")
        folhas = [c for c in info["camadas"] if not c["grupo"]]
        if vis is not None:
            marcadas = set(vis)
            for c in info["camadas"]:
                c["visivel"] = c["id"] in marcadas
        chave = nome_serv.split("/")[-1]
        # Feature_Base é desenhado todo em branco (serve para consulta/seleção no
        # portal): aqui entra só como fonte de consulta por clique, sem imagem.
        so_consulta = chave.startswith("Feature_")
        titulo = "Base Cadastral (lotes, quadras, bairros)" if so_consulta else op.get("title")
        temas.append({"chave": chave, "titulo": titulo, "url": url,
                      "ligado_no_portal": bool(op.get("visibility")), "opacidade": op.get("opacity", 1),
                      "oficial": True, "somente_consulta": so_consulta, **info})
        log(f"   tema: {titulo:42s} {len(folhas):3d} camadas")

    lista = baixar_json(f"{MS}", {"f": "json"})
    catalogo = []
    for s in lista.get("services") or []:
        catalogo.append({"nome": s["name"], "tipo": s["type"]})
        nome = s["name"]
        if s["type"] != "MapServer" or nome in usados or any(x in nome for x in IGNORAR_EXTRAS) \
                or nome.split("/")[-1].startswith("Feature_Base"):
            continue
        url = f"{REST}/{nome}/MapServer"
        try:
            info = _descrever_servico(url)
        except RuntimeError as e:
            log(f"   ! extra {nome}: {e}")
            continue
        if not info["camadas"]:
            continue
        chave = nome.split("/")[-1]
        temas.append({"chave": chave, "titulo": ROTULOS_EXTRAS.get(chave, chave.replace("Mapa_", "").replace("_", " ")),
                      "url": url, "ligado_no_portal": False, "opacidade": 1, "oficial": False,
                      "somente_consulta": False, **info})
        log(f"   extra: {temas[-1]['titulo']:41s} {sum(1 for c in info['camadas'] if not c['grupo']):3d} camadas")

    galeria = cfg_widget("eBasemapGallery").get("basemapGallery", {}).get("basemaps", [])
    bases = []
    for b in galeria:
        url = _https(b["layers"][0]["url"]).rstrip("/")
        ano = "".join(ch for ch in b["title"] if ch.isdigit())
        bases.append({"chave": f"orto{ano}", "titulo": b["title"], "ano": int(ano) if ano else None, "url": url,
                      "nivel_minimo": _nivel_minimo_export(url, *CENTRO_GOIANIA)})
    bases.sort(key=lambda b: b["ano"] or 0)
    hibrido = None
    for bm in webmap.get("baseMap", {}).get("baseMapLayers", []):
        url = _https(bm["url"]).rstrip("/")
        bases.append({"chave": "basico", "titulo": "Mapa Básico (cartografia municipal)", "ano": None, "url": url,
                      "nivel_minimo": _nivel_minimo_export(url, *CENTRO_GOIANIA)})
        # O mesmo serviço, exportado com fundo transparente, vira a camada de
        # nomes e divisas sobre o satélite (ruas, bairros, quadras e lotes).
        escalas = [c for c in _descrever_servico(url)["camadas"] if c["pai"] == -1 and c["grupo"]]
        hibrido = {"titulo": "Nomes e divisas (ruas, bairros, quadras, lotes)", "url": url,
                   "escala_min": max((c["escala_min"] for c in escalas), default=0),
                   "escala_max": min((c["escala_max"] for c in escalas if c["escala_max"]), default=0)}

    buscas = []
    for f in cfg_widget("widgets/Search").get("sources", []):
        buscas.append({"nome": f.get("name"), "url": _https(f["url"]).replace("/FeatureServer/", "/MapServer/"),
                       "campos": f.get("searchFields"), "exibir": f.get("displayField"),
                       "dica": f.get("placeholder")})

    ext = cfg["map"]["mapOptions"]["extent"]
    doc = {
        "fonte": {"aplicativo": f"{APP}/", "config": f"{APP}/config.json", "mapa_web": item, "servidor": REST},
        "titulo_portal": cfg.get("title"), "extensao_portal_utm": [ext["xmin"], ext["ymin"], ext["xmax"], ext["ymax"]],
        "temas": temas, "bases": bases, "hibrido": hibrido, "buscas": buscas, "catalogo_servidor": catalogo,
    }
    tam = gravar(saida / "camadas.json", doc)
    oficiais = [t for t in temas if t["oficial"]]
    log(f"[camadas] {len(oficiais)} temas do portal + {len(temas)-len(oficiais)} extras, "
        f"{sum(len(t['camadas']) for t in temas)} camadas, {len(bases)} bases, {tam/1024:.0f} KB")
    return {"temas_portal": len(oficiais), "temas_extras": len(temas) - len(oficiais),
            "camadas": sum(len(t["camadas"]) for t in temas), "bases": len(bases),
            "servicos_no_servidor": len(catalogo), "bytes": tam}


# ------------------------------------------------------------------------------ main
def main(argv: list[str] | None = None) -> int:
    raiz = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--saida", type=Path, default=raiz / "docs" / "data", help="pasta de saída (padrão: docs/data)")
    ap.add_argument("--etapas", default=",".join(ETAPAS), help=f"etapas separadas por vírgula ({', '.join(ETAPAS)})")
    args = ap.parse_args(argv)
    pedidas = [e.strip() for e in args.etapas.split(",") if e.strip()]
    invalidas = [e for e in pedidas if e not in ETAPAS]
    if invalidas:
        ap.error(f"etapa desconhecida: {', '.join(invalidas)}")
    if any(e in pedidas for e in ("bairros", "edificios")) and "territorio" not in pedidas \
            and not (args.saida / "territorio.geojson").exists():
        pedidas.insert(0, "territorio")

    funcoes = {"territorio": etapa_territorio, "bairros": etapa_bairros, "edificios": etapa_edificios,
               "lugares": etapa_lugares, "logradouros": etapa_logradouros, "camadas": etapa_camadas}
    caminho_manifesto = args.saida / "manifest.json"
    manifesto = {}
    if caminho_manifesto.exists():
        try:
            manifesto = json.loads(caminho_manifesto.read_text(encoding="utf-8"))
        except ValueError:
            manifesto = {}
    manifesto.setdefault("etapas", {})
    falhas = []
    for etapa in [e for e in ETAPAS if e in pedidas]:
        t0 = time.time()
        try:
            resumo = funcoes[etapa](args.saida)
            resumo["extraido_em"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            resumo["segundos"] = round(time.time() - t0, 1)
            manifesto["etapas"][etapa] = resumo
        except Exception as e:  # noqa: BLE001 - mantém os arquivos anteriores e segue
            falhas.append(etapa)
            log(f"[{etapa}] FALHOU: {e}")
    manifesto.update({"versao_extrator": VERSAO, "portal": f"{APP}/", "servidor": REST,
                      "atualizado_em": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    gravar(caminho_manifesto, manifesto, compacto=False)
    if falhas:
        log(f"Etapas com falha (arquivos anteriores preservados): {', '.join(falhas)}")
        return 1
    log("Extração concluída.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
