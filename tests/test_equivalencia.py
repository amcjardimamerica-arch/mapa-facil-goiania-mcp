"""Equivalência das respostas do banco local (passo 2 do roteiro de desempenho).

200 consultas sorteadas com semente fixa passam pelo interceptador (fetch), com o servidor da Prefeitura bloqueado.
Cada resposta é reduzida a uma forma canônica (feições ordenadas, coordenadas arredondadas) e resumida por SHA-256.
A primeira execução grava a referência (tests/equivalencia-referencia.json.gz); as seguintes comparam.
BUSSOLA_REGRAVAR_EQUIVALENCIA=1 regrava — só com justificativa escrita no commit.
"""
import gzip
import hashlib
import json
import os
import random
from pathlib import Path

import pytest

from test_app import _contexto, navegador, servidor  # noqa: F401 (fixtures)

pytestmark = pytest.mark.navegador
REF = Path(__file__).resolve().parent / "equivalencia-referencia.json.gz"
MS = "https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer"
GYN = (-49.36, -16.76, -49.20, -16.60)  # retângulo urbano para sortear pontos


def _consultas(cis):
    rnd = random.Random(20261124)
    ponto = lambda: (rnd.uniform(GYN[0], GYN[2]), rnd.uniform(GYN[1], GYN[3]))
    env = lambda lon, lat, m: f"{lon - m / 107000},{lat - m / 110500},{lon + m / 107000},{lat + m / 110500}"
    q = []
    for ci in rnd.sample(cis, 60):
        q.append(("Feature_Base/MapServer/0/query", {"where": f"ci = '{ci}'", "outFields": "*", "outSR": "4326"}))
    for _ in range(40):
        lon, lat = ponto()
        q.append(("Feature_Base/MapServer/0/query", {"geometry": env(lon, lat, 150), "geometryType": "esriGeometryEnvelope", "inSR": "4326",
                                                    "outSR": "3857", "spatialRel": "esriSpatialRelIntersects", "outFields": "nm_lot,ci", "where": "1=1"}))
    for ci in rnd.sample(cis, 30):
        q.append(("Feature_Base/MapServer/3/query", {"where": f"ci = '{ci}'", "outFields": "*", "orderByFields": "nrinscr", "returnGeometry": "false"}))
    for _ in range(30):
        lon, lat = ponto()
        q.append(("Feature_Base/MapServer/identify", {"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "sr": "4326", "layers": "all:0,1,2",
                                                     "tolerance": "2", "mapExtent": env(lon, lat, 300), "imageDisplay": "600,600,96", "returnGeometry": "true"}))
    for srv in ("Mapa_UsoDoSoloNew/MapServer/4", "Mapa_Energia/MapServer/4", "Mapa_ModeloEspacial/MapServer/1"):
        for _ in range(7 if srv.endswith("/4") else 6):
            lon, lat = ponto()
            q.append((f"{srv}/query", {"geometry": env(lon, lat, 150), "geometryType": "esriGeometryEnvelope", "inSR": "4326", "outSR": "4326",
                                       "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "where": "1=1"}))
    for camada in (2, 7, 10):
        for _ in range(7 if camada != 10 else 6):
            lon, lat = ponto()
            q.append((f"Feature_Base/MapServer/{camada}/query", {"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": "4326",
                                                                "distance": "200", "units": "esriSRUnit_Meter", "outFields": "*", "outSR": "4326", "where": "1=1"}))
    return q[:200]


def _canonica(resp):
    def arred(v):
        if isinstance(v, float):
            return round(v, 6) if abs(v) < 400 else round(v, 1)
        if isinstance(v, list):
            return [arred(x) for x in v]
        if isinstance(v, dict):
            return {k: arred(x) for k, x in v.items()}
        return v
    itens = resp.get("features") or resp.get("results") or []
    chave = lambda f: json.dumps([f.get("layerId"), (f.get("attributes") or {}).get("nrinscr"), sorted((f.get("attributes") or {}).items(), key=str)[:6]], default=str)
    itens = sorted((arred(f) for f in itens), key=chave)
    return hashlib.sha256(json.dumps({"n": len(itens), "f": itens, "erro": bool(resp.get("error"))}, sort_keys=True, default=str).encode()).hexdigest()


def test_equivalencia_do_banco(navegador, servidor):  # noqa: F811
    ctx = _contexto(navegador)
    ctx.route("**/portalmapa.goiania.go.gov.br/**", lambda r: r.abort())
    p = ctx.new_page()
    p.set_default_timeout(180_000)
    p.goto(f"{servidor}/sistema.html#ed=0&r=0")
    p.wait_for_function("window.bussola && bussola.pronto", timeout=240_000)
    cis = p.evaluate(f"""async () => {{
      const r = await (await fetch('{MS}/Feature_Base/MapServer/0/query', {{ method: 'POST', body: new URLSearchParams({{ f: 'json', where: '1=1',
        geometry: '-49.30,-16.73,-49.26,-16.69', geometryType: 'esriGeometryEnvelope', inSR: '4326', outFields: 'ci', returnGeometry: 'false' }}) }})).json();
      return [...new Set((r.features || []).map((f) => String(f.attributes.ci)).filter((x) => x && x !== 'null'))].sort().slice(0, 2000);
    }}""")
    assert len(cis) > 100
    consultas = _consultas(cis)
    resps = p.evaluate(f"""async (lista) => {{
      const saida = [];
      for (const [caminho, prm] of lista) {{
        try {{ saida.push(await (await fetch('{MS}/' + caminho, {{ method: 'POST', body: new URLSearchParams({{ f: 'json', ...prm }}) }})).json()); }}
        catch (e) {{ saida.push({{ error: String(e) }}); }}
      }}
      return saida;
    }}""", consultas)
    ctx.close()
    atuais = {f"{i:03d} {c[0]} {json.dumps(c[1], sort_keys=True)}": _canonica(r) for i, (c, r) in enumerate(zip(consultas, resps))}
    if not REF.exists() or os.environ.get("BUSSOLA_REGRAVAR_EQUIVALENCIA") == "1":
        REF.write_bytes(gzip.compress(json.dumps(atuais, indent=0).encode()))
        pytest.skip("referência de equivalência gravada")
    ref = json.loads(gzip.decompress(REF.read_bytes()))
    diferentes = [k for k in ref if atuais.get(k) != ref[k]]
    assert not diferentes, f"{len(diferentes)} consultas diferentes: {diferentes[:5]}"
