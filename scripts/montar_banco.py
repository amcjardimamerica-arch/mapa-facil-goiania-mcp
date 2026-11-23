"""Monta o banco local da Bússola (docs/banco/) a partir da extração do Mapa Fácil.

    python scripts/montar_banco.py CAMINHO_DA_EXTRACAO [--so Feature_Base]

CAMINHO_DA_EXTRACAO é a pasta com servicos/{S}/*.json e dados/{S}/{id}-{nome}.geojson.gz
(o pacote "bussola-dados" extraído). O resultado substitui o servidor da Prefeitura no sistema:

docs/banco/
  manifesto.json                         serviços, camadas, campos, blocos e índices
  servicos/{S}/MapServer.json, legend.json, {id}.json   metadados originais (desenho, escalas, legenda)
  dados/{S}/{id}/todos.json.gz           camada pequena num arquivo só
  dados/{S}/{id}/{z}/{x}_{y}.json.gz     camada grande em blocos Web Mercator (feição em todo bloco que toca)
  dados/{S}/{id}/indice-{campo}/{fim}.json.gz  valor do campo -> blocos ({fim} = 2 últimos caracteres do valor)
  dados/Feature_Base/3/ci/{pre}.json.gz  cadastro imobiliário agrupado pela inscrição do lote (ci)

Formato de um arquivo de dados: {"c": [campos], "g": "ponto|linha|area|", "f": [[oid, [valores], geometria], ...]}
Geometria em inteiros de 1e-6 grau, com diferenças: ponto [x, y]; linha/área [[x0, y0, dx, dy, ...], ...]
(um vetor por caminho ou anel; anéis no sentido do ArcGIS: externo horário, buraco anti-horário).
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import shutil
import sys
from collections import defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
BANCO = RAIZ / "docs" / "banco"
ESCALA = 1e6


def bloco(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    s = math.sin(math.radians(lat))
    y = int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n)
    return x, y


def balde(v: str) -> str:
    """Arquivo do índice: os 2 últimos caracteres do valor (espalha bem id e inscrição)."""
    return v[-2:].replace("/", "_").replace(" ", "_") or "_"


def zoom_da_camada(total: int, geo: str) -> int | None:
    if total <= 6000:
        return None
    if total <= 40000 and geo == "area":
        return 13
    return 15


def coords(g):
    """Lista de vetores de coordenadas [(x, y), ...] (caminhos/anéis) e tipo."""
    t, c = g["type"], g["coordinates"]
    if t == "Point":
        return "ponto", [[c]]
    if t == "MultiPoint":
        return "ponto", [[p] for p in c]
    if t == "LineString":
        return "linha", [c]
    if t == "MultiLineString":
        return "linha", c
    if t == "Polygon":
        return "area", c
    if t == "MultiPolygon":
        return "area", [a for p in c for a in p]
    return None, []


def area_assinada(a):
    return sum(a[i][0] * a[i + 1][1] - a[i + 1][0] * a[i][1] for i in range(len(a) - 1)) / 2


def codificar(geo, partes):
    if geo == "ponto":
        if len(partes) == 1:
            x, y = partes[0][0][:2]
            return [round(x * ESCALA), round(y * ESCALA)]
        return [[round(p[0][0] * ESCALA), round(p[0][1] * ESCALA)] for p in partes]
    out = []
    for parte in partes:
        v, px, py = [], 0, 0
        for p in parte:
            x, y = round(p[0] * ESCALA), round(p[1] * ESCALA)
            if v and x == px and y == py:
                continue
            v += [x - px, y - py]
            px, py = x, y
        out.append(v)
    return out


def corrigir_aneis(g):
    """GeoJSON Polygon/MultiPolygon -> anéis no sentido ArcGIS (externos horários, buracos anti-horários)."""
    t, c = g["type"], g["coordinates"]
    polis = [c] if t == "Polygon" else c
    aneis = []
    for p in polis:
        for k, a in enumerate(p):
            horario = area_assinada(a) < 0
            if (k == 0) != horario:
                a = a[::-1]
            aneis.append(a)
    return aneis


def ler_geojson(arq: Path):
    with gzip.open(arq, "rt", encoding="utf-8") as f:
        d = json.load(f)
    return d


def gravar_gz(caminho: Path, obj):
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(caminho, "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    return caminho.stat().st_size


def montar_camada(S, cid, arq: Path, meta: dict):
    d = ler_geojson(arq)
    campos_meta = [c for c in meta.get("fields") or [] if c.get("type") != "esriFieldTypeGeometry"]
    campos = [c["name"] for c in campos_meta]
    oid = next((c["name"] for c in campos_meta if c.get("type") == "esriFieldTypeOID"), None)
    feats = d["features"]
    geo_tipo = {"esriGeometryPoint": "ponto", "esriGeometryMultipoint": "ponto", "esriGeometryPolyline": "linha",
                "esriGeometryPolygon": "area"}.get(meta.get("geometryType"), "")
    pasta = BANCO / "dados" / S / str(cid)
    if pasta.exists():
        shutil.rmtree(pasta)
    linhas = []
    for k, ft in enumerate(feats):
        at = ft.get("properties") or {}
        chave = at.get(oid) if oid else k + 1
        g = ft.get("geometry")
        geo, partes, enc, ext = "", [], None, None
        if g:
            geo, partes = coords(g)
            if geo == "area":
                partes = corrigir_aneis(g)
            if partes:
                enc = codificar(geo, partes)
                xs = [p[0] for pt in partes for p in pt]
                ys = [p[1] for pt in partes for p in pt]
                ext = (min(xs), min(ys), max(xs), max(ys))
        linhas.append((chave, [at.get(c) for c in campos], enc, ext))
    z = zoom_da_camada(len(linhas), geo_tipo) if geo_tipo else None
    info = {"nome": meta.get("name"), "geo": geo_tipo, "campos": campos, "oid": oid, "display": meta.get("displayField"),
            "total": len(linhas), "z": z, "blocos": None, "indices": [], "bytes": 0}
    if z is None:
        info["bytes"] = gravar_gz(pasta / "todos.json.gz", {"c": campos, "g": geo_tipo, "f": [[a, b, c] for a, b, c, _ in linhas]})
        return info
    blocos = defaultdict(list)
    sem, grandes = [], []
    for ln in linhas:
        ext = ln[3]
        if ext is None:
            sem.append(ln)
            continue
        x0, y1 = bloco(ext[0], ext[1], z)
        x1, y0 = bloco(ext[2], ext[3], z)
        if (x1 - x0 + 1) * (y1 - y0 + 1) > 16:  # feição extensa (rodovia, divisa): arquivo próprio, lido em toda consulta
            grandes.append(ln)
            continue
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                blocos[f"{x}_{y}"].append(ln)
    total = 0
    for chave, lista in blocos.items():
        total += gravar_gz(pasta / str(z) / f"{chave}.json.gz", {"c": campos, "g": geo_tipo, "f": [[a, b, c] for a, b, c, _ in lista]})
    if grandes:
        total += gravar_gz(pasta / "grandes.json.gz", {"c": campos, "g": geo_tipo, "f": [[a, b, c] for a, b, c, _ in grandes]})
        info["grandes"] = len(grandes)
    if sem:
        total += gravar_gz(pasta / "sem-geometria.json.gz", {"c": campos, "g": geo_tipo, "f": [[a, b, c] for a, b, c, _ in sem]})
    info["blocos"] = sorted(blocos)
    info["sem_geometria"] = len(sem)
    # visão de longe (bloco 3 níveis acima, geometria simplificada) para linhas e áreas não tão numerosas
    if geo_tipo in ("linha", "area") and z >= 15 and len(linhas) <= 150000:
        from shapely.geometry import shape as _shape
        zv = z - 3
        vis = defaultdict(list)
        for k, ft in enumerate(feats):
            g = ft.get("geometry")
            ln = linhas[k]
            if not g or ln[3] is None:
                continue
            try:
                gs = _shape(g).simplify(0.00003, preserve_topology=True)
                gj = gs.__geo_interface__
                tipo, partes = coords(gj)
                if tipo == "area":
                    partes = corrigir_aneis(gj)
                enc = codificar(tipo, partes) if partes else ln[2]
            except Exception:
                enc = ln[2]
            ext = ln[3]
            x0, y1 = bloco(ext[0], ext[1], zv)
            x1, y0 = bloco(ext[2], ext[3], zv)
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    vis[f"{x}_{y}"].append([ln[0], ln[1], enc])
        for chave, lista in vis.items():
            total += gravar_gz(pasta / f"v{zv}" / f"{chave}.json.gz", {"c": campos, "g": geo_tipo, "f": lista})
        info["zv"] = zv
        info["blocos_v"] = sorted(vis)
    # índices por id e por inscrição
    for campo in ("id", "ci"):
        if campo not in campos:
            continue
        i = campos.index(campo)
        idx = defaultdict(lambda: defaultdict(set))
        for chave_b, lista in list(blocos.items()) + [("grandes", grandes)]:
            for ln in lista:
                v = str(ln[1][i] or "").strip()
                if v:
                    idx[balde(v)][v].add(chave_b)
        for pre, m in idx.items():
            total += gravar_gz(pasta / f"indice-{campo}" / f"{pre}.json.gz", {v: sorted(b) for v, b in m.items()})
        info["indices"].append(campo)
    info["bytes"] = total
    return info


def montar_cadastro(S, arq: Path, meta: dict):
    d = ler_geojson(arq)
    campos = [c["name"] for c in meta["fields"] if c.get("type") != "esriFieldTypeGeometry"]
    grupos = defaultdict(list)
    for ft in d["features"]:
        at = ft["properties"]
        ci = str(at.get("ci") or "").strip() or "sem-ci"
        grupos[ci[:5]].append([at.get("ESRI_OID"), [at.get(c) for c in campos], None])
    pasta = BANCO / "dados" / S / "3"
    if pasta.exists():
        shutil.rmtree(pasta)
    total = sum(gravar_gz(pasta / "ci" / f"{pre}.json.gz", {"c": campos, "g": "", "f": lista}) for pre, lista in grupos.items())
    return {"nome": meta.get("name"), "geo": "", "campos": campos, "oid": "ESRI_OID", "display": meta.get("displayField"),
            "total": len(d["features"]), "z": None, "blocos": None, "agrupado": "ci", "grupos": len(grupos),
            "indices": ["ci"], "bytes": total,
            "nota": "A geometria de cada unidade é o polígono do lote (Feature_Base 0, mesmo ci)."}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("extracao")
    ap.add_argument("--so", help="só este serviço")
    a = ap.parse_args()
    ext = Path(a.extracao)
    man_arq = BANCO / "manifesto.json"
    man = json.loads(man_arq.read_text(encoding="utf-8")) if man_arq.exists() else {"servicos": {}}
    inv = ext / "inventario.csv"
    copias = {}
    sem_contagem = set()
    conf_csv = ext / "conferencia.csv"
    if conf_csv.exists():
        import csv as _csv
        for l in _csv.DictReader(conf_csv.open(encoding="utf-8")):
            if not l.get("esperado"):
                sem_contagem.add((l["servico"], l["id"]))
    if inv.exists():
        import csv
        for l in csv.DictReader(inv.open(encoding="utf-8")):
            if l.get("copia_de"):
                copias[(l["servico"], l["id"])] = l["copia_de"]
    for pasta_s in sorted((ext / "servicos").iterdir()):
        S = pasta_s.name
        if a.so and S != a.so:
            continue
        destino = BANCO / "servicos" / S
        destino.mkdir(parents=True, exist_ok=True)
        for m in pasta_s.glob("*.json"):
            shutil.copy(m, destino / m.name)
        servico = man["servicos"].setdefault(S, {"camadas": {}})
        for arq in sorted((ext / "dados" / S).glob("*.geojson.gz")) if (ext / "dados" / S).exists() else []:
            cid = int(arq.name.split("-")[0])
            meta = json.loads((pasta_s / f"{cid}.json").read_text(encoding="utf-8"))
            print(f"{S}/{cid} {meta.get('name')}…", flush=True)
            info = montar_cadastro(S, arq, meta) if (S == "Feature_Base" and cid == 3) else montar_camada(S, cid, arq, meta)
            if (S, str(cid)) in sem_contagem:
                info["incompleta"] = True  # o servidor não informa o total: consulta sem resultado segue para ele
            servico["camadas"][str(cid)] = info
            print(f"   {info['total']} feições, {info['bytes'] / 1e6:.1f} MB, z={info['z']}", flush=True)
        for (s, cid), orig in copias.items():
            if s == S:
                servico["camadas"][str(cid)] = {"copia_de": orig}
    # blocos de imagem (serviços que só existem como imagem)
    for pasta_b in sorted((ext / "blocos").iterdir()) if (ext / "blocos").exists() else []:
        S = pasta_b.name
        if a.so and S != a.so:
            continue
        conf_b = json.loads((pasta_b / "conferencia.json").read_text(encoding="utf-8")) if (pasta_b / "conferencia.json").exists() else {}
        niveis = sorted(int(p.name) for p in pasta_b.iterdir() if p.is_dir() and p.name.isdigit())
        if not niveis:
            continue
        destino = BANCO / "blocos" / S
        if destino.exists():
            shutil.rmtree(destino)
        shutil.copytree(pasta_b, destino, ignore=shutil.ignore_patterns("conferencia.json"))
        formato = conf_b.get("formato") or next(pasta_b.rglob("*.*")).suffix.lstrip(".")
        man.setdefault("imagens", {})[S] = {"min": niveis[0], "max": niveis[-1], "formato": formato,
                                            "extensao": conf_b.get("extensao"), "blocos": sum(1 for _ in destino.rglob(f"*.{formato}")),
                                            "falhas": len(conf_b.get("falhas") or [])}
        print(f"imagens {S}: níveis {niveis[0]}–{niveis[-1]}, {man['imagens'][S]['blocos']} blocos", flush=True)
    import datetime
    man["montado_em"] = datetime.datetime.now().isoformat(timespec="seconds")
    man["fonte"] = "Mapa Fácil — Prefeitura de Goiânia (portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer)"
    conf = ext / "conferencia.csv"
    if conf.exists():
        shutil.copy(conf, BANCO / "conferencia.csv")
    if inv.exists():
        shutil.copy(inv, BANCO / "inventario.csv")
    man_arq.write_text(json.dumps(man, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("manifesto:", sum(len(s["camadas"]) for s in man["servicos"].values()), "camadas")


if __name__ == "__main__":
    sys.exit(main())
