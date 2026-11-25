"""Lote de cada local de votação (colégio) a partir do ponto do levantamento.

    python scripts/lotes_eleitorais.py

Lê os pontos eleitorais de scripts/dados/levantamento.json, acha no Mapa Fácil (Feature_Base, camada 0)
o lote que contém cada ponto (ou o mais próximo, até 40 m, quando o ponto cai na rua) e grava
docs/data/eleitoral_lotes.json: { "lon,lat": { "aneis": [[[lon, lat], …]], "nm_lot", "ci", "nm_imovel", "distancia_m" } }.
"""
from __future__ import annotations

import json
import math
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
URL = "https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer/Feature_Base/MapServer/0/query"
CAB = {"User-Agent": "Mozilla/5.0 (Bussola; +github.com/amcjardimamerica-arch/Bussola)"}


def pedir(parametros: dict, tentativas: int = 5) -> dict:
    corpo = urllib.parse.urlencode({"f": "json", **parametros}).encode()
    for k in range(tentativas):
        try:
            with urllib.request.urlopen(urllib.request.Request(URL, corpo, headers=CAB), timeout=60) as r:
                d = json.loads(r.read())
            if "error" in d:
                raise RuntimeError(d["error"].get("message"))
            return d
        except Exception:  # noqa: BLE001 — servidor instável: tenta de novo com espera crescente
            if k == tentativas - 1:
                raise
            time.sleep(2 ** (k + 1))
    return {}


def distancia_m(lon1, lat1, lon2, lat2) -> float:
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(x, math.radians(lat2 - lat1)) * 6371000


def lote_do_ponto(lon: float, lat: float) -> dict | None:
    base = {"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": "4326", "outSR": "4326",
            "spatialRel": "esriSpatialRelIntersects", "returnGeometry": "true", "geometryPrecision": "7",
            "outFields": "nm_lot,ci,nm_imovel,nm_cond"}
    for raio in (0, 15, 40):
        p = dict(base)
        if raio:
            p.update(distance=str(raio), units="esriSRUnit_Meter")
        fs = pedir(p).get("features", [])
        if not fs:
            continue
        def centro(f):
            a = f["geometry"]["rings"][0]
            return sum(x for x, _ in a) / len(a), sum(y for _, y in a) / len(a)
        f = min(fs, key=lambda f: distancia_m(lon, lat, *centro(f)))
        return {"aneis": [[[round(x, 7), round(y, 7)] for x, y in anel] for anel in f["geometry"]["rings"]],
                **{k: (str(v).strip() if v not in (None, "") else None) for k, v in f["attributes"].items()},
                "distancia_m": raio}
    return None


def main() -> int:
    lev = json.loads((RAIZ / "scripts/dados/levantamento.json").read_text(encoding="utf-8"))
    pontos = sorted({(p["lon"], p["lat"]) for p in lev["eleitoral"]["pontos"]})
    saida, falhas = {}, []

    def tarefa(pt):
        try:
            return pt, lote_do_ponto(*pt)
        except Exception as e:  # noqa: BLE001
            return pt, e

    with ThreadPoolExecutor(4) as ex:
        for (lon, lat), r in ex.map(tarefa, pontos):
            if isinstance(r, dict):
                saida[f"{lon},{lat}"] = r
            else:
                falhas.append((lon, lat, str(r)))
    (RAIZ / "docs/data/eleitoral_lotes.json").write_text(
        json.dumps({"fonte": "Mapa Fácil — Feature_Base, camada 0 (Divisas de Lote)", "lotes": saida},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(saida)} de {len(pontos)} locais com lote; {len(falhas)} sem lote: {falhas[:10]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
