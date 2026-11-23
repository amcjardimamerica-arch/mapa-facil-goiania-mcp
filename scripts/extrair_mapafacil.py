"""Extração dos dados públicos do Mapa Fácil (Prefeitura de Goiânia) para o banco local da Bússola.

A pasta de saída é BUSSOLA_EXTRACAO (padrão: extracao/saida). Depois: python scripts/montar_banco.py extracao/saida

    python scripts/extrair_mapafacil.py inventario            # etapa 1
    python scripts/extrair_mapafacil.py baixar Feature_Base   # etapa 2 (ou outro serviço)
    python scripts/extrair_mapafacil.py baixar Feature_Base 3 # só uma camada

Saída em ./saida/ : servicos/{S}/..., dados/{S}/{id}-{nome}.geojson.gz, inventario.csv, conferencia.csv
"""
from __future__ import annotations

import csv
import os
import gzip
import json
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
SAIDA = Path(os.environ.get("BUSSOLA_EXTRACAO", "extracao/saida")).resolve()
SERVICOS = ["Feature_Base", "Mapa_TelecomunicacaoNew", "Mapa_Energia", "Mapa_Sanemanento", "Mapa_COMURG",
            "Mapa_PontosNotaveis", "Mapa_PUAMA", "Mapa_Edificios", "Mapa_RedeViaria", "Mapa_MeioAmbiente",
            "Mapa_PatrimonioHistorico", "Mapa_OcupacaoIlegal", "Mapa_Legislacao", "Mapa_ModeloEspacial",
            "Mapa_Limites", "Mapa_Acessibilidade", "Mapa_Documentacao", "Mapa_Fiscalizacao",
            "Mapa_Simplifica_Goiania_UsoDoSolo", "Mapa_Tributario_Web", "Mapa_UsoDoSoloNew"]
SIMULT = threading.Semaphore(3)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class ErroServidor(Exception):
    pass


def pedir(url: str, params: dict | None = None, *, bruto=False, tentativas=6, timeout=150):
    dados = urllib.parse.urlencode(params or {}).encode()
    espera = 2
    for t in range(tentativas):
        try:
            with SIMULT:
                req = urllib.request.Request(url, data=dados if params else None,
                                             headers={"User-Agent": UA, "Referer": "https://portalmapa.goiania.go.gov.br/mapafacil/"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    corpo = r.read()
                time.sleep(0.3)
            if bruto:
                return corpo
            j = json.loads(corpo)
            if isinstance(j, dict) and "error" in j:
                cod = j["error"].get("code")
                if cod in (500, 502, 503, 504) and t < tentativas - 1:
                    raise ErroServidor(json.dumps(j["error"])[:300])
                raise ValueError(json.dumps(j["error"], ensure_ascii=False)[:400])
            return j
        except ValueError:
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, ErroServidor, json.JSONDecodeError, OSError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code in (400, 403, 404):
                raise
            if t == tentativas - 1:
                raise
            time.sleep(espera)
            espera = min(espera * 2, 60)


def slug(s: str) -> str:
    s = "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()[:60] or "camada"


def gravar(caminho: Path, obj):
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------- inventário
def inventario():
    linhas = []
    for s in SERVICOS:
        pasta = SAIDA / "servicos" / s
        try:
            ms = pedir(f"{BASE}/{s}/MapServer", {"f": "json"})
        except Exception as e:
            log(s, "SEM METADADOS", e)
            linhas.append({"servico": s, "observacao": f"MapServer indisponível: {e}"})
            continue
        gravar(pasta / "MapServer.json", ms)
        try:
            gravar(pasta / "legend.json", pedir(f"{BASE}/{s}/MapServer/legend", {"f": "json"}))
        except Exception as e:
            log(s, "legenda falhou", e)
        for cam in ms.get("layers", []) + ms.get("tables", []):
            cid = cam["id"]
            try:
                meta = pedir(f"{BASE}/{s}/MapServer/{cid}", {"f": "json"})
            except Exception as e:
                linhas.append({"servico": s, "id": cid, "nome": cam.get("name"), "observacao": f"metadados falharam: {e}"})
                continue
            gravar(pasta / f"{cid}.json", meta)
            if meta.get("type") == "Group Layer":
                continue
            oid = next((f["name"] for f in meta.get("fields") or [] if f.get("type") == "esriFieldTypeOID"), None)
            linha = {"servico": s, "id": cid, "nome": meta.get("name"), "geometria": meta.get("geometryType") or meta.get("type"),
                     "feicoes": "", "campos": len(meta.get("fields") or []), "oid": oid or "",
                     "paginacao": (meta.get("advancedQueryCapabilities") or {}).get("supportsPagination"),
                     "maxRecordCount": meta.get("maxRecordCount"), "oid_min": "", "oid_max": "", "observacao": ""}
            obs = []
            if "Query" not in (meta.get("capabilities") or ""):
                obs.append("sem consulta (só imagem)")
            else:
                try:
                    linha["feicoes"] = pedir(f"{BASE}/{s}/MapServer/{cid}/query", {"where": "1=1", "returnCountOnly": "true", "f": "json"}, tentativas=3).get("count")
                except Exception as e:
                    obs.append(f"contagem falhou: {str(e)[:120]}")
                if oid:
                    try:
                        st = pedir(f"{BASE}/{s}/MapServer/{cid}/query", {"where": "1=1", "f": "json", "returnGeometry": "false",
                                   "outStatistics": json.dumps([{"statisticType": "min", "onStatisticField": oid, "outStatisticFieldName": "a"},
                                                                {"statisticType": "max", "onStatisticField": oid, "outStatisticFieldName": "b"}])}, tentativas=3)
                        at = st["features"][0]["attributes"]
                        linha["oid_min"], linha["oid_max"] = at.get("a") or at.get("A"), at.get("b") or at.get("B")
                    except Exception as e:
                        obs.append(f"min/max falhou: {str(e)[:120]}")
            linha["observacao"] = "; ".join(obs)
            log(s, cid, linha["nome"], linha["feicoes"], linha["oid_min"], linha["oid_max"], linha["observacao"])
            linhas.append(linha)
    campos = ["servico", "id", "nome", "geometria", "feicoes", "campos", "oid", "paginacao", "maxRecordCount", "oid_min", "oid_max", "observacao"]
    with open(SAIDA / "inventario.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, campos, extrasaction="ignore")
        w.writeheader()
        w.writerows(linhas)
    log("inventário:", len(linhas), "camadas")


# ---------------------------------------------------------------- geometria
def _area(anel):
    return sum(anel[i][0] * anel[i + 1][1] - anel[i + 1][0] * anel[i][1] for i in range(len(anel) - 1)) / 2


def _dentro(p, anel):
    x, y = p
    d = False
    for i in range(len(anel) - 1):
        (x1, y1), (x2, y2) = anel[i], anel[i + 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-300) + x1:
            d = not d
    return d


def esri_geojson(g):
    if not g:
        return None
    r = lambda c: [round(c[0], 7), round(c[1], 7)]
    if "x" in g:
        return None if g["x"] is None or g["x"] != g["x"] else {"type": "Point", "coordinates": r([g["x"], g["y"]])}
    if "points" in g:
        return {"type": "MultiPoint", "coordinates": [r(p) for p in g["points"]]} if g["points"] else None
    if "paths" in g:
        ps = [[r(c) for c in p] for p in g["paths"] if len(p) >= 2]
        if not ps:
            return None
        return {"type": "LineString", "coordinates": ps[0]} if len(ps) == 1 else {"type": "MultiLineString", "coordinates": ps}
    if "rings" in g:
        aneis = [[r(c) for c in a] for a in g["rings"] if len(a) >= 4]
        if not aneis:
            return None
        ext = [a for a in aneis if _area(a) <= 0]  # Esri: externo no sentido horário (área negativa)
        buracos = [a for a in aneis if _area(a) > 0]
        if not ext:
            ext, buracos = [a[::-1] for a in buracos], []
        polis = [[a[::-1]] for a in ext]  # GeoJSON: externo anti-horário
        for b in buracos:
            for p in polis:
                if _dentro(b[0], p[0]):
                    p.append(b[::-1] if _area(b) > 0 else b)
                    break
            else:
                polis.append([b])
        return {"type": "Polygon", "coordinates": polis[0]} if len(polis) == 1 else {"type": "MultiPolygon", "coordinates": polis}
    return None


# ---------------------------------------------------------------- download
def quartos(v):
    o, s, l, n = v
    mx, my = (o + l) / 2, (s + n) / 2
    return [(o, s, mx, my), (mx, s, l, my), (o, my, mx, n), (mx, my, l, n)]


def faixas_de_ids(url, oid, meta):
    """Lista de identificadores (returnIdsOnly) ou None."""
    try:
        j = pedir(f"{url}/query", {"where": "1=1", "returnIdsOnly": "true", "f": "json"}, timeout=240, tentativas=4)
        ids = j.get("objectIds")
        if ids is not None:
            return sorted(ids)
    except Exception as e:
        log("   ids falhou:", str(e)[:150])
    return None


def baixar_camada(s, cid, meta, linha_inv):
    url = f"{BASE}/{s}/MapServer/{cid}"
    oid = next((f["name"] for f in meta.get("fields") or [] if f.get("type") == "esriFieldTypeOID"), None)
    nome = meta.get("name") or str(cid)
    destino = SAIDA / "dados" / s / f"{cid}-{slug(nome)}.geojson.gz"
    if destino.exists():
        log("já baixada:", destino.name)
        return json.loads((destino.with_suffix("").with_suffix(".conf.json")).read_text())
    tem_geo = bool(meta.get("geometryType"))
    # campos binários (anexos de documentos) derrubam o servidor: vêm só os dados descritivos
    campos_sem_blob = ",".join(f["name"] for f in meta.get("fields") or [] if f.get("type") not in ("esriFieldTypeBlob", "esriFieldTypeGeometry", "esriFieldTypeRaster")) or "*"
    mrc = int(meta.get("maxRecordCount") or 1000)
    passo = max(200, min(mrc, 2000 if s == "Feature_Base" else 1000))
    lotes = []
    ids = faixas_de_ids(url, oid, meta) if oid else None
    if ids:
        lotes = [("ids", ids[i:i + passo]) for i in range(0, len(ids), passo)]
    elif oid and linha_inv.get("oid_min") not in ("", None):
        a, b = int(float(linha_inv["oid_min"])), int(float(linha_inv["oid_max"]))
        lotes = [("faixa", (i, i + passo)) for i in range(a, b + 1, passo)]
    else:
        # sem identificadores nem faixa: recorte espacial de Goiânia, dividindo cada quadrado cheio
        o, sl, l, n = -49.46, -16.86, -49.06, -16.45
        k = 8
        lotes = [("env", (o + (l - o) * i / k, sl + (n - sl) * j / k, o + (l - o) * (i + 1) / k, sl + (n - sl) * (j + 1) / k))
                 for i in range(k) for j in range(k)]
    log(f"{s}/{cid} {nome}: {len(lotes)} pedidos")
    feats, falhas = {}, []
    trava = threading.Lock()

    def um(lote):
        tipo, v = lote
        p = {"outFields": campos_sem_blob, "f": "json", "outSR": "4326", "returnGeometry": "true" if tem_geo else "false"}
        if tipo == "ids":
            p["objectIds"] = ",".join(map(str, v))
        elif tipo == "faixa":
            p["where"] = f"{oid} >= {v[0]} AND {oid} < {v[1]}"
        elif tipo == "env":
            p.update({"geometry": ",".join(f"{c:.6f}" for c in v), "geometryType": "esriGeometryEnvelope", "inSR": "4326",
                      "spatialRel": "esriSpatialRelIntersects"})
        else:
            p["where"] = "1=1"
        try:
            j = pedir(f"{url}/query", p, timeout=240)
        except Exception as e:
            # divide o lote ao meio antes de desistir
            if tipo == "ids" and len(v) > 50:
                m = len(v) // 2
                return um(("ids", v[:m])) + um(("ids", v[m:]))
            if tipo == "faixa" and v[1] - v[0] > 50:
                m = (v[0] + v[1]) // 2
                return um(("faixa", (v[0], m))) + um(("faixa", (m, v[1])))
            if tipo == "env" and v[2] - v[0] > 0.002:
                return sum(um(("env", q)) for q in quartos(v))
            with trava:
                falhas.append(f"{tipo} {str(v)[:60]}: {str(e)[:150]}")
            return 0
        n = 0
        with trava:
            for f in j.get("features") or []:
                at = f.get("attributes") or {}
                chave = at.get(oid) if oid else len(feats)
                feats[chave] = {"type": "Feature", "id": chave, "properties": at,
                                "geometry": esri_geojson(f.get("geometry")) if tem_geo else None}
                n += 1
        if tipo == "env" and (len(j.get("features") or []) >= mrc or j.get("exceededTransferLimit")) and v[2] - v[0] > 0.0005:
            return n + sum(um(("env", q)) for q in quartos(v))
        if tipo == "faixa" and n >= mrc and v[1] - v[0] > 1:  # faixa cheia: pode ter cortado
            m = (v[0] + v[1]) // 2
            return n + um(("faixa", (v[0], m))) + um(("faixa", (m, v[1])))
        return n

    t0 = time.time()
    with ThreadPoolExecutor(4) as ex:
        for k, _ in enumerate(ex.map(um, lotes)):
            if k % 50 == 49:
                log(f"   {k + 1}/{len(lotes)} pedidos, {len(feats)} feições, {time.time() - t0:.0f}s")
    lista = [feats[k] for k in sorted(feats, key=lambda x: (x is None, x))]
    destino.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(destino, "wt", encoding="utf-8") as f:
        f.write('{"type":"FeatureCollection","servico":%s,"camada":%d,"nome":%s,"campos":%s,"features":[\n' % (
            json.dumps(s), cid, json.dumps(nome, ensure_ascii=False),
            json.dumps([{"name": c["name"], "alias": c.get("alias"), "type": c.get("type")} for c in meta.get("fields") or []], ensure_ascii=False)))
        for i, ft in enumerate(lista):
            f.write(("," if i else "") + json.dumps(ft, ensure_ascii=False, separators=(",", ":")) + "\n")
        f.write("]}\n")
    # conferência
    sem_geo = [ft["id"] for ft in lista if tem_geo and not ft["geometry"]]
    fora = 0
    if tem_geo:
        for ft in lista:
            g = ft["geometry"]
            if not g:
                continue
            c = g["coordinates"]
            while isinstance(c[0], list):
                c = c[0]
            if not (-49.6 <= c[0] <= -48.9 and -17.0 <= c[1] <= -16.3):
                fora += 1
    esperado = linha_inv.get("feicoes")
    conf = {"servico": s, "id": cid, "nome": nome, "esperado": esperado, "baixado": len(lista),
            "diferenca": (len(lista) - int(esperado)) if str(esperado).isdigit() else "",
            "sem_geometria": len(sem_geo), "exemplos_sem_geometria": " ".join(map(str, sem_geo[:10])),
            "fora_do_retangulo": fora, "ids_repetidos": 0, "falhas": len(falhas), "detalhe_falhas": " | ".join(falhas[:5]),
            "arquivo": str(destino.relative_to(SAIDA)), "bytes": destino.stat().st_size, "segundos": round(time.time() - t0)}
    (destino.with_suffix("").with_suffix(".conf.json")).write_text(json.dumps(conf, ensure_ascii=False))
    log(f"   ok {len(lista)} (esperado {esperado}), {conf['bytes'] / 1e6:.1f} MB, falhas {len(falhas)}")
    return conf


def baixar(servicos, so=None):
    inv = {}
    with open(SAIDA / "inventario.csv", encoding="utf-8") as f:
        for l in csv.DictReader(f):
            if l.get("id") not in (None, ""):
                inv[(l["servico"], int(l["id"]))] = l
    for s in servicos:
        for (sv, cid), l in sorted(inv.items()):
            if sv != s or (so is not None and cid != so):
                continue
            if l.get("observacao", "").startswith("sem consulta") or l.get("observacao", "").startswith("metadados falharam"):
                continue
            if l.get("copia_de") or (s == "Feature_Base" and cid == 3):
                continue
            meta = json.loads((SAIDA / "servicos" / s / f"{cid}.json").read_text(encoding="utf-8"))
            try:
                baixar_camada(s, cid, meta, l)
            except Exception as e:
                log("FALHOU", s, cid, e)


# ---------------------------------------------------------------- cadastro imobiliário (Feature_Base 3)
def baixar_cadastro():
    """Camada 3 não aceita contagem nem paginação geral: baixa por código de bairro tributário (cdbairro).
    A geometria de cada unidade é o polígono do lote (campo id = id do lote na camada 0); não é repetida aqui."""
    s, cid = "Feature_Base", 3
    meta = json.loads((SAIDA / "servicos" / s / f"{cid}.json").read_text(encoding="utf-8"))
    url = f"{BASE}/{s}/MapServer/{cid}/query"
    destino = SAIDA / "dados" / s / f"{cid}-{slug(meta['name'])}.geojson.gz"
    parcial = SAIDA / "parcial-cadastro"
    parcial.mkdir(exist_ok=True)
    faixas = [("cdbairro < 1", None)] + [(f"cdbairro = {k}", k) for k in range(1, 1500)]
    falhas = []

    def um(item):
        w, k = item
        arq = parcial / f"{k if k is not None else 'zero'}.json"
        if arq.exists():
            return len(json.loads(arq.read_text()))
        try:
            n = pedir(url, {"where": w, "returnCountOnly": "true", "f": "json"})["count"]
            linhas = []
            if n:
                if n <= 3000:
                    j = pedir(url, {"where": w, "outFields": "*", "returnGeometry": "false", "f": "json"}, timeout=600, tentativas=8)
                    linhas += [f["attributes"] for f in j.get("features") or []]
                else:  # bairro grande: páginas de 2.000 em ordem de inscrição (a camada aceita paginação)
                    for ini in range(0, n, 2000):
                        j = pedir(url, {"where": w, "outFields": "*", "returnGeometry": "false", "f": "json",
                                        "orderByFields": "OBJECTID,nrinscr", "resultOffset": ini, "resultRecordCount": 2000}, timeout=600, tentativas=8)
                        linhas += [f["attributes"] for f in j.get("features") or []]
                    vistos_b, unicas = set(), []
                    for at in linhas:
                        chave_u = (at.get("OBJECTID"), at.get("nrinscr"))
                        if chave_u not in vistos_b:
                            vistos_b.add(chave_u)
                            unicas.append(at)
                    linhas = unicas
                if len(linhas) != n:
                    falhas.append(f"{w}: contagem {n}, baixadas {len(linhas)}")
            arq.write_text(json.dumps(linhas, ensure_ascii=False))
            return len(linhas)
        except Exception as e:
            falhas.append(f"{w}: {str(e)[:150]}")
            return 0

    t0 = time.time()
    total = 0
    with ThreadPoolExecutor(4) as ex:
        for i, n in enumerate(ex.map(um, faixas)):
            total += n
            if i % 100 == 99:
                log(f"   cadastro: {i + 1}/{len(faixas)} códigos, {total} unidades, {time.time() - t0:.0f}s")
    vistos, lista, rep = set(), [], 0
    for arq in sorted(parcial.glob("*.json")):
        for at in json.loads(arq.read_text()):
            k = (at.get("OBJECTID"), at.get("nrinscr"))  # ESRI_OID é só o número da linha na resposta
            if k in vistos:
                rep += 1
                continue
            vistos.add(k)
            lista.append(at)
    with gzip.open(destino, "wt", encoding="utf-8") as f:
        f.write('{"type":"FeatureCollection","servico":"Feature_Base","camada":3,"nome":%s,"geometria":"polígono do lote: ligar pelo campo id à camada 0","campos":%s,"features":[\n' % (
            json.dumps(meta["name"], ensure_ascii=False),
            json.dumps([{"name": c["name"], "alias": c.get("alias"), "type": c.get("type")} for c in meta["fields"]], ensure_ascii=False)))
        for i, at in enumerate(lista):
            f.write(("," if i else "") + json.dumps({"type": "Feature", "id": at.get("ESRI_OID"), "properties": at, "geometry": None},
                                                    ensure_ascii=False, separators=(",", ":")) + "\n")
        f.write("]}\n")
    conf = {"servico": s, "id": cid, "nome": meta["name"], "esperado": 795418, "baixado": len(lista),
            "diferenca": len(lista) - 795418, "sem_geometria": "geometria = lote (camada 0, campo id)",
            "exemplos_sem_geometria": "", "fora_do_retangulo": "", "ids_repetidos": rep, "falhas": len(falhas),
            "detalhe_falhas": " | ".join(falhas[:10]), "arquivo": str(destino.relative_to(SAIDA)),
            "bytes": destino.stat().st_size, "segundos": round(time.time() - t0)}
    destino.with_suffix("").with_suffix(".conf.json").write_text(json.dumps(conf, ensure_ascii=False))
    log("cadastro:", conf)


def reparar(s, cid):
    """Completa uma camada já gravada: pede de novo os identificadores que faltaram."""
    meta = json.loads((SAIDA / "servicos" / s / f"{cid}.json").read_text(encoding="utf-8"))
    destino = SAIDA / "dados" / s / f"{cid}-{slug(meta.get('name') or str(cid))}.geojson.gz"
    conf_arq = destino.with_suffix("").with_suffix(".conf.json")
    d = json.load(gzip.open(destino, "rt", encoding="utf-8"))
    oid = next((f["name"] for f in meta.get("fields") or [] if f.get("type") == "esriFieldTypeOID"), None)
    url = f"{BASE}/{s}/MapServer/{cid}"
    ids = faixas_de_ids(url, oid, meta) or []
    try:  # a lista de ids pode vir incompleta; a consulta só de atributos traz todos
        j = pedir(f"{url}/query", {"where": "1=1", "outFields": oid, "returnGeometry": "false", "f": "json"}, timeout=300)
        ids = sorted(set(ids) | {f["attributes"][oid] for f in j.get("features") or []})
    except Exception as e:
        log("   lista por atributos falhou:", str(e)[:100])
    if not ids:
        log("sem lista de ids; nada a reparar")
        return
    tem = {f["id"] for f in d["features"]}
    faltam = [i for i in ids if i not in tem]
    log(f"{s}/{cid}: faltam {len(faltam)} de {len(ids)}")
    tem_geo = bool(meta.get("geometryType"))
    novos, falhas = [], []
    def um(lote, geo=tem_geo):
        try:
            j = pedir(f"{url}/query", {"objectIds": ",".join(map(str, lote)), "outFields": "*", "f": "json", "outSR": "4326",
                                        "returnGeometry": "true" if geo else "false"}, timeout=240, tentativas=8)
            return [{"type": "Feature", "id": f["attributes"].get(oid), "properties": f["attributes"],
                     "geometry": esri_geojson(f.get("geometry")) if geo else None} for f in j.get("features") or []]
        except Exception as e:
            if len(lote) > 1:  # divide até achar o registro que o servidor não consegue devolver
                m = len(lote) // 2
                return um(lote[:m], geo) + um(lote[m:], geo)
            if geo:  # registro com geometria defeituosa no servidor: guarda ao menos os atributos
                r = um(lote, False)
                if r:
                    falhas.append(f"id {lote[0]}: geometria recusada pelo servidor, só atributos")
                    return r
            falhas.append(f"id {lote[0]}: {str(e)[:100]}")
            return []
    with ThreadPoolExecutor(3) as ex:
        for r in ex.map(um, [faltam[i:i + 200] for i in range(0, len(faltam), 200)]):
            novos += r
    d["features"] += novos
    d["features"].sort(key=lambda f: f["id"])
    with gzip.open(destino, "wt", encoding="utf-8") as f:
        corpo = {k: v for k, v in d.items() if k != "features"}
        f.write(json.dumps(corpo, ensure_ascii=False)[:-1] + ',"features":[\n')
        for i, ft in enumerate(d["features"]):
            f.write(("," if i else "") + json.dumps(ft, ensure_ascii=False, separators=(",", ":")) + "\n")
        f.write("]}\n")
    conf = json.loads(conf_arq.read_text())
    conf["baixado"] = len(d["features"])
    if str(conf.get("esperado")).isdigit():
        conf["diferenca"] = conf["baixado"] - int(conf["esperado"])
    conf["falhas"] = len(falhas)
    conf["detalhe_falhas"] = " | ".join(falhas[:5])
    conf["sem_geometria"] = sum(1 for f in d["features"] if tem_geo and not f["geometry"])
    conf["bytes"] = destino.stat().st_size
    conf_arq.write_text(json.dumps(conf, ensure_ascii=False))
    log(f"   reparado: +{len(novos)}, falhas {len(falhas)}")


def geometria_por_identify(s, cid):
    """Camadas cuja consulta devolve a geometria vazia (Mapa_Acessibilidade): busca a geometria pelo identify,
    em quadrados de Goiânia divididos em 4 sempre que a resposta vier cheia, e completa o arquivo já baixado."""
    meta = json.loads((SAIDA / "servicos" / s / f"{cid}.json").read_text(encoding="utf-8"))
    destino = SAIDA / "dados" / s / f"{cid}-{slug(meta.get('name') or str(cid))}.geojson.gz"
    if not destino.exists():
        return
    d = json.load(gzip.open(destino, "rt", encoding="utf-8"))
    vazias = [f for f in d["features"] if not f["geometry"]]
    if not vazias or not meta.get("geometryType"):
        return
    oid = next((f["name"] for f in meta.get("fields") or [] if f.get("type") == "esriFieldTypeOID"), None)
    log(f"{s}/{cid}: {len(vazias)} sem geometria; identify…")
    achadas = {}

    def quadro(v, prof=0):
        o, sl, l, n = v
        try:
            j = pedir(f"{BASE}/{s}/MapServer/identify", {"f": "json", "geometry": json.dumps({"xmin": o, "ymin": sl, "xmax": l, "ymax": n}),
                      "geometryType": "esriGeometryEnvelope", "sr": "4326", "layers": f"all:{cid}", "tolerance": "0",
                      "mapExtent": f"{o},{sl},{l},{n}", "imageDisplay": "1000,1000,96", "returnGeometry": "true"}, timeout=240)
        except Exception as e:
            log("   identify falhou", v, str(e)[:100])
            return
        rs = j.get("results") or []
        if len(rs) >= 1000 and prof < 8:
            for q in quartos(v):
                quadro(q, prof + 1)
            return
        for r in rs:
            at = r.get("attributes") or {}
            k = at.get(oid) or at.get("OBJECTID") or at.get("FID")
            g = esri_geojson(r.get("geometry"))
            if g is not None and k is not None:
                try:
                    achadas[int(str(k).replace(".", "").replace(",", "").strip())] = g
                except ValueError:
                    pass

    quadro((-49.46, -16.86, -49.06, -16.45))
    n = 0
    for f in d["features"]:
        if not f["geometry"] and f["id"] in achadas:
            f["geometry"] = achadas[f["id"]]
            n += 1
    with gzip.open(destino, "wt", encoding="utf-8") as fo:
        corpo = {k: v for k, v in d.items() if k != "features"}
        fo.write(json.dumps(corpo, ensure_ascii=False)[:-1] + ',"features":[\n')
        for i, ft in enumerate(d["features"]):
            fo.write(("," if i else "") + json.dumps(ft, ensure_ascii=False, separators=(",", ":")) + "\n")
        fo.write("]}\n")
    conf_arq = destino.with_suffix("").with_suffix(".conf.json")
    conf = json.loads(conf_arq.read_text())
    conf["sem_geometria"] = sum(1 for f in d["features"] if not f["geometry"])
    conf["detalhe_falhas"] = (conf.get("detalhe_falhas") or "") + f" | geometria pelo identify: {n} de {len(vazias)}"
    conf_arq.write_text(json.dumps(conf, ensure_ascii=False))
    log(f"   geometria completada em {n} de {len(vazias)}")


if __name__ == "__main__":
    SAIDA.mkdir(exist_ok=True)
    if sys.argv[1] == "inventario":
        inventario()
    elif sys.argv[1] == "conferencia":
        campos = ["servico", "id", "nome", "esperado", "baixado", "diferenca", "sem_geometria", "exemplos_sem_geometria",
                  "fora_do_retangulo", "ids_repetidos", "falhas", "detalhe_falhas", "arquivo", "bytes", "segundos"]
        with open(SAIDA / "conferencia.csv", "w", newline="", encoding="utf-8") as fo:
            w = csv.DictWriter(fo, campos, extrasaction="ignore")
            w.writeheader()
            for c in sorted((SAIDA / "dados").glob("*/*.conf.json"), key=lambda p: (p.parent.name, int(p.name.split("-")[0]))):
                w.writerow(json.loads(c.read_text()))
        log("conferencia.csv gravado")
    elif sys.argv[1] == "conferir_cadastro":
        parcial = SAIDA / "parcial-cadastro"
        for arq in sorted(parcial.glob("*.json")):
            if arq.stem == "zero":
                continue
            L = json.loads(arq.read_text())
            if len(L) <= 3000:
                continue
            n = pedir(f"{BASE}/Feature_Base/MapServer/3/query", {"where": f"cdbairro = {arq.stem}", "returnCountOnly": "true", "f": "json"}, tentativas=10)["count"]
            u = len({(a.get("OBJECTID"), a.get("nrinscr")) for a in L})
            if u != n:
                log(f"cdbairro {arq.stem}: servidor {n}, arquivo {u} -> refazer")
                arq.unlink()
    elif sys.argv[1] == "reparar_todos":
        for c in sorted((SAIDA / "dados").glob("*/*.conf.json")):
            cf = json.loads(c.read_text())
            if cf["id"] == 3 and cf["servico"] == "Feature_Base":
                continue
            dif = cf.get("diferenca")
            if (isinstance(dif, int) and dif < 0) or cf.get("falhas"):
                try:
                    reparar(cf["servico"], cf["id"])
                except Exception as e:
                    log("reparo falhou", cf["servico"], cf["id"], e)
            cf = json.loads(c.read_text())
            if cf.get("sem_geometria") and isinstance(cf["sem_geometria"], int) and cf["sem_geometria"] > 0:
                try:
                    geometria_por_identify(cf["servico"], cf["id"])
                except Exception as e:
                    log("identify falhou", cf["servico"], cf["id"], e)
    elif sys.argv[1] == "identify":
        for c in sys.argv[3:]:
            geometria_por_identify(sys.argv[2], int(c))
    elif sys.argv[1] == "reparar":
        reparar(sys.argv[2], int(sys.argv[3]))
    elif sys.argv[1] == "cadastro":
        baixar_cadastro()
    elif sys.argv[1] == "baixar":
        baixar([sys.argv[2]] if sys.argv[2] != "todos" else SERVICOS[1:], int(sys.argv[3]) if len(sys.argv) > 3 else None)
