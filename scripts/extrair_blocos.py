"""Etapa 4 (python scripts/extrair_blocos.py Mapa_Basico3 11 17 jpg): blocos de imagem (z/x/y) dos serviços que só existem como imagem, recortados em Goiânia."""
import json, math, sys, time, threading
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from shapely.geometry import shape, box
from shapely.prepared import prep
import extrair_mapafacil as mf

TERR = json.load(open(Path(__file__).resolve().parent.parent / 'docs' / 'data' / 'territorio.geojson'))
GYN = shape(next(f for f in TERR['features'] if f['properties']['tipo'] == 'goiania')['geometry'])
P = prep(GYN.buffer(0.002))

def ret(x, y, z):
    n = 2 ** z
    lon0 = x / n * 360 - 180; lon1 = (x + 1) / n * 360 - 180
    lat = lambda yy: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))
    return lon0, lat(y + 1), lon1, lat(y)

def merc(lon, lat):
    return lon * 20037508.342789244 / 180, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * 6378137

def blocos(z):
    o, s, l, n = GYN.bounds
    n2 = 2 ** z
    x0 = int((o + 180) / 360 * n2); x1 = int((l + 180) / 360 * n2)
    def ty(lat):
        r = math.radians(lat); return int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * n2)
    y0, y1 = ty(n), ty(s)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            if P.intersects(box(*ret(x, y, z))):
                yield x, y

def baixar(S, zs, formato):
    pasta = mf.SAIDA / 'blocos' / S
    lista = [(z, x, y) for z in zs for x, y in blocos(z)]
    print(S, len(lista), 'blocos', flush=True)
    falhas = []
    t0 = time.time()
    def um(t):
        z, x, y = t
        arq = pasta / str(z) / str(x) / f'{y}.{formato}'
        if arq.exists():
            return arq.stat().st_size
        o, s, l, n = ret(x, y, z)
        a, b = merc(o, s); c, d = merc(l, n)
        try:
            img = mf.pedir(f'{mf.BASE}/{S}/MapServer/export', {'bbox': f'{a},{b},{c},{d}', 'bboxSR': 3857, 'imageSR': 3857,
                     'size': '256,256', 'format': 'jpg' if formato == 'jpg' else 'png32', 'transparent': 'false' if formato == 'jpg' else 'true',
                     'f': 'image'}, bruto=True, timeout=120)
            if not img[:4] in (b'\x89PNG', b'\xff\xd8\xff\xe0', b'\xff\xd8\xff\xdb') and img[:3] != b'\xff\xd8\xff':
                raise ValueError(img[:200])
            arq.parent.mkdir(parents=True, exist_ok=True)
            arq.write_bytes(img)
            return len(img)
        except Exception as e:
            falhas.append(f'{z}/{x}/{y}: {str(e)[:100]}')
            return 0
    tot = 0
    with ThreadPoolExecutor(4) as ex:
        for i, n in enumerate(ex.map(um, lista)):
            tot += n
            if i % 500 == 499:
                print(f'  {i+1}/{len(lista)} {tot/1e6:.0f} MB {time.time()-t0:.0f}s', flush=True)
    json.dump({'servico': S, 'niveis': zs, 'blocos': len(lista), 'falhas': falhas, 'bytes': tot, 'formato': formato,
               'extensao': list(GYN.bounds)}, open(pasta / 'conferencia.json', 'w'), ensure_ascii=False)
    print(S, 'ok', tot / 1e6, 'MB, falhas', len(falhas), flush=True)

if __name__ == '__main__':
    if sys.argv[1] == 'contar':
        for z in range(11, 18):
            print(z, sum(1 for _ in blocos(z)))
    else:
        baixar(sys.argv[1], list(range(int(sys.argv[2]), int(sys.argv[3]) + 1)), sys.argv[4])
