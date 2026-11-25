"""Relevo próprio da Bússola a partir do Copernicus DEM GLO-30 -> docs/relevo/.

    python scripts/relevo_local.py CAMINHO/Copernicus_DSM_COG_10_S17_00_W050_00_DEM.tif

O modelo de elevação Copernicus GLO-30 (ESA/União Europeia, uso e redistribuição gratuitos com a menção
"produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018
provided under COPERNICUS by the European Union and ESA; all rights reserved") cobre Goiânia inteira numa
única folha de 1°x1° (S17 W050), baixada de https://copernicus-dem-30m.s3.amazonaws.com/.

Grava:
- docs/relevo/goiania.bin.gz: grade de altitudes (Int16, 1/4 de metro, diferença para o ponto à esquerda),
  recortada no retângulo de Goiânia com folga; docs/relevo/goiania.json descreve a grade;
- docs/relevo/sombra/{z}/{x}/{y}.png: relevo sombreado (luz do noroeste, 45°) em blocos Web Mercator,
  níveis 9 a 13, para o "Mapa" sem fotos (multiplicado sobre o desenho).
"""
from __future__ import annotations

import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent
SAIDA = RAIZ / "docs" / "relevo"
# Retângulo de Goiânia (territorio.geojson) com ~2 km de folga.
OESTE, SUL, LESTE, NORTE = -49.47, -16.855, -49.055, -16.43
NIVEIS = range(9, 14)
CREDITO = "Relevo: Copernicus DEM GLO-30 (ESA/União Europeia)"


def ler_folha(caminho: str):
    im = Image.open(caminho)
    z = np.array(im, dtype=np.float32)
    # Folha S17 W050: canto noroeste em (-50, -16), 3600x3600 células de 1".
    lon0, lat0, passo = -50.0, -16.0, 1.0 / z.shape[1]
    return z, lon0, lat0, passo


def main(caminho: str) -> int:
    z, lon0, lat0, passo = ler_folha(caminho)
    c0, c1 = int((OESTE - lon0) / passo), int(math.ceil((LESTE - lon0) / passo))
    l0, l1 = int((lat0 - NORTE) / passo), int(math.ceil((lat0 - SUL) / passo))
    g = z[l0:l1, c0:c1]
    g = np.where(np.isfinite(g) & (g > -100), g, np.nan)
    if np.isnan(g).any():
        g = np.where(np.isnan(g), np.nanmean(g), g)
    alt, larg = g.shape
    oeste, norte = lon0 + c0 * passo, lat0 - l0 * passo
    SAIDA.mkdir(parents=True, exist_ok=True)

    q = np.round(g * 4).astype(np.int32)                         # 1/4 de metro
    d = np.diff(q, axis=1, prepend=0).astype(np.int16)            # diferença para a célula à esquerda
    (SAIDA / "goiania.bin.gz").write_bytes(gzip.compress(d.tobytes(), 9))
    meta = {"fonte": CREDITO, "largura": larg, "altura": alt, "oeste": oeste, "norte": norte, "passo": passo,
            "escala": 0.25, "codificacao": "int16 little-endian, linha a linha do norte para o sul; cada valor é a diferença "
                                         "para a célula à esquerda (a primeira da linha é absoluta), em 1/4 de metro",
            "minimo": float(g.min()), "maximo": float(g.max())}
    (SAIDA / "goiania.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    # Relevo sombreado (algoritmo de Horn), luz a 315° e 45°, com exagero 2x para o cerrado plano aparecer.
    lat_m = math.radians((NORTE + SUL) / 2)
    dx = passo * 111320 * math.cos(lat_m)
    dy = passo * 110540
    p = np.pad(g, 1, mode="edge") * 2.0
    gx = ((p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])) / (8 * dx)
    gy = ((p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])) / (8 * dy)
    decl = np.arctan(np.hypot(gx, gy))
    aspecto = np.arctan2(gy, -gx)
    az, el = math.radians(360 - 315 + 90), math.radians(45)
    luz = np.sin(el) * np.cos(decl) + np.cos(el) * np.sin(decl) * np.cos(az - aspecto)
    plano = math.sin(el)
    sombra = np.clip(235 + (luz - plano) * 420, 120, 255)        # plano quase branco: o multiplicar só escurece encostas

    def amostrar(lon, lat):
        cx = (lon - oeste) / passo - 0.5
        cy = (norte - lat) / passo - 0.5
        x0 = np.clip(np.floor(cx).astype(int), 0, larg - 2); y0 = np.clip(np.floor(cy).astype(int), 0, alt - 2)
        fx = np.clip(cx - x0, 0, 1); fy = np.clip(cy - y0, 0, 1)
        a = sombra[y0, x0] * (1 - fx) + sombra[y0, x0 + 1] * fx
        b = sombra[y0 + 1, x0] * (1 - fx) + sombra[y0 + 1, x0 + 1] * fx
        return a * (1 - fy) + b * fy

    def tile_lonlat(z_, x, y):
        n = 2 ** z_
        i = (np.arange(256) + 0.5) / 256
        lon = (x + i) / n * 360 - 180
        lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * (y + i) / n))))
        return np.meshgrid(lon, lat)

    def faixa(z_):
        n = 2 ** z_
        x0 = int((OESTE + 180) / 360 * n); x1 = int((LESTE + 180) / 360 * n)
        ty = lambda la: int((1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * n)
        return range(x0, x1 + 1), range(ty(NORTE), ty(SUL) + 1)

    total = 0
    for z_ in NIVEIS:
        xs, ys = faixa(z_)
        for x in xs:
            for y in ys:
                lon, lat = tile_lonlat(z_, x, y)
                v = amostrar(lon, lat)
                fora = (lon < oeste) | (lon > oeste + larg * passo) | (lat > norte) | (lat < norte - alt * passo)
                v = np.where(fora, 255, v)
                destino = SAIDA / "sombra" / str(z_) / str(x)
                destino.mkdir(parents=True, exist_ok=True)
                Image.fromarray(v.astype(np.uint8), "L").save(destino / f"{y}.png", optimize=True)
                total += 1
    tam = sum(f.stat().st_size for f in SAIDA.rglob("*") if f.is_file())
    print(f"grade {larg}x{alt} ({meta['minimo']:.0f} a {meta['maximo']:.0f} m), {total} blocos de sombra, {tam / 1e6:.1f} MB em docs/relevo")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
