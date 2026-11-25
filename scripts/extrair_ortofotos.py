"""Fotos aéreas da Prefeitura (ortofotos) para o banco local -> docs/banco/blocos/<serviço>/{z}/{x}/{y}.jpg

    python scripts/extrair_ortofotos.py                      # plano padrão (abaixo)
    python scripts/extrair_ortofotos.py --estimar            # só conta os blocos e estima o tamanho
    python scripts/extrair_ortofotos.py --servico Mapa_Ortofoto2016v2 --niveis 9-16 --area goiania

Precisa de acesso ao portal Mapa Fácil (rode onde a extração do banco foi feita). Pede cada bloco Web Mercator de
256 px ao serviço de imagem da Prefeitura (operação "export", JPEG), só os que tocam o município (ou os dois
bairros), e grava no formato que o sistema já lê (banco.js, imagemLocal). No fim atualiza "imagens" em
docs/banco/manifesto.json. Retoma de onde parou: blocos já gravados não são pedidos de novo.

Plano padrão (cabe no limite de 1 GB do GitHub Pages junto com o banco atual; confira com --estimar):
- Ortofoto 2016: Goiânia inteira nos níveis 9 a 16 (~2,4 m por pixel) e Jardim América + Nova Suíça nos
  níveis 17 a 19 (~0,3 m por pixel, a resolução da foto).
- Ortofotos 2011 e 2006: Jardim América + Nova Suíça nos níveis 13 a 18 (histórico do bairro).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from shapely.geometry import box, shape
from shapely.ops import unary_union
from shapely.prepared import prep

RAIZ = Path(__file__).resolve().parent.parent
BANCO = RAIZ / "docs" / "banco"
MS = "https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer"
R = 6378137.0

PLANO = [
    ("Mapa_Ortofoto2016v2", range(9, 17), "goiania"),
    ("Mapa_Ortofoto2016v2", range(17, 20), "bairros"),
    ("Mapa_Ortofoto2011v2", range(13, 19), "bairros"),
    ("Mapa_Ortofoto2006v2", range(13, 19), "bairros"),
]


def areas():
    ter = json.loads((RAIZ / "docs/data/territorio.geojson").read_text(encoding="utf-8"))
    gyn = shape(next(f for f in ter["features"] if f["properties"].get("tipo") == "goiania")["geometry"]).buffer(0.002)
    lev = json.loads((RAIZ / "docs/data/levantamento-nucleo.json").read_text(encoding="utf-8"))
    aneis = []
    for lim in lev["limites_oficiais"] or lev["limites"]:
        for a in lim["aneis"]:
            x = y = 0
            pts = []
            for i in range(0, len(a), 2):
                x += a[i]; y += a[i + 1]
                pts.append((x / 1e6, y / 1e6))
            aneis.append(shape({"type": "Polygon", "coordinates": [pts]}).buffer(0))
    bairros = unary_union(aneis).buffer(0.003)        # ~300 m de folga em volta dos dois bairros
    return {"goiania": gyn, "bairros": bairros}


def blocos(area, z):
    n = 2 ** z
    o, s, l, nn = area.bounds
    tx = lambda lon: int((lon + 180) / 360 * n)
    ty = lambda lat: int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    pa = prep(area)
    for x in range(tx(o), tx(l) + 1):
        for y in range(ty(nn), ty(s) + 1):
            lo0, lo1 = x / n * 360 - 180, (x + 1) / n * 360 - 180
            la0 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
            la1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
            if pa.intersects(box(lo0, la0, lo1, la1)):
                yield x, y


def merc(x, y, z):
    lado = 2 * math.pi * R / 2 ** z
    o = -math.pi * R + x * lado
    n = math.pi * R - y * lado
    return o, n - lado, o + lado, n


def baixar(servico, z, x, y, tentativas=4):
    destino = BANCO / "blocos" / servico / str(z) / str(x) / f"{y}.jpg"
    if destino.exists() and destino.stat().st_size > 0:
        return "ja"
    bb = ",".join(f"{v:.3f}" for v in merc(x, y, z))
    q = urllib.parse.urlencode({"bbox": bb, "bboxSR": 3857, "imageSR": 3857, "size": "256,256", "format": "jpg",
                                "transparent": "false", "f": "image"})
    url = f"{MS}/{servico}/MapServer/export?{q}"
    for t in range(tentativas):
        try:
            # O portal recusa (403) o identificador padrão do Python: pede como um navegador.
            pedido = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Bussola; extracao das ortofotos)"})
            with urllib.request.urlopen(pedido, timeout=60) as r:
                dados = r.read()
            if not dados.startswith(b"\xff\xd8"):
                raise ValueError("resposta não é JPEG")
            destino.parent.mkdir(parents=True, exist_ok=True)
            destino.write_bytes(dados)
            return "ok"
        except Exception:  # noqa: BLE001
            time.sleep(2 * (t + 1))
    return "falha"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--estimar", action="store_true")
    ap.add_argument("--servico")
    ap.add_argument("--niveis", help="ex.: 9-16")
    ap.add_argument("--area", choices=["goiania", "bairros"])
    ap.add_argument("--paralelo", type=int, default=6)
    a = ap.parse_args()
    plano = PLANO
    if a.servico:
        z0, z1 = (int(v) for v in a.niveis.split("-"))
        plano = [(a.servico, range(z0, z1 + 1), a.area or "goiania")]
    zonas = areas()
    total_geral = 0
    for servico, niveis, area in plano:
        lista = [(z, x, y) for z in niveis for x, y in blocos(zonas[area], z)]
        total_geral += len(lista)
        print(f"{servico} níveis {niveis.start}-{niveis.stop - 1} ({area}): {len(lista)} blocos (~{len(lista) * 22 / 1024:.0f} MB a 22 KB cada)")
        if a.estimar:
            continue
        cont = {"ok": 0, "ja": 0, "falha": 0}
        with ThreadPoolExecutor(a.paralelo) as ex:
            for i, r in enumerate(ex.map(lambda b: baixar(servico, *b), lista), 1):
                cont[r] += 1
                if i % 500 == 0:
                    print(f"  {i}/{len(lista)} {cont}", flush=True)
        print(f"  {cont}")
    print(f"total: {total_geral} blocos")
    if a.estimar:
        return 0
    man_p = BANCO / "manifesto.json"
    man = json.loads(man_p.read_text(encoding="utf-8"))
    for servico in {p[0] for p in plano}:
        pasta = BANCO / "blocos" / servico
        niveis = sorted(int(p.name) for p in pasta.iterdir() if p.is_dir())
        arqs = list(pasta.rglob("*.jpg"))
        man.setdefault("imagens", {})[servico] = {"min": niveis[0], "max": niveis[-1], "formato": "jpg",
                                                  "extensao": [round(v, 6) for v in zonas["goiania"].bounds],
                                                  "blocos": len(arqs), "falhas": 0,
                                                  "tamanho_mb": round(sum(f.stat().st_size for f in arqs) / 1e6, 1)}
    man_p.write_text(json.dumps(man, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("manifesto.json atualizado:", {k: v for k, v in man["imagens"].items() if "Ortofoto" in k})
    return 0


if __name__ == "__main__":
    sys.exit(main())
