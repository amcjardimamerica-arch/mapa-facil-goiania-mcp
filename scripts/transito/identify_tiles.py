"""Coleta pontos de camadas do Mapa Fácil cuja consulta (query) devolve geometria nula,
usando a operação identify por quadrículas (envelopes) sobre Goiânia."""
import json, time, urllib.parse, urllib.request, sys
URL = "https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer/Mapa_Acessibilidade/MapServer/identify"
UA = {"User-Agent": "Bussola-Sinalizacao/1.0 (pesquisa; A.M.C. Jardim America)"}
X0, X1, Y0, Y1, P = -49.45, -49.07, -16.86, -16.45, 0.02
camadas = sys.argv[1]; saida = sys.argv[2]
res = {}
y = Y0
while y < Y1:
    x = X0
    while x < X1:
        env = f"{x},{y},{x+P},{y+P}"
        p = {"geometry": env, "geometryType": "esriGeometryEnvelope", "sr": "4326", "layers": f"all:{camadas}", "tolerance": "0",
             "mapExtent": env, "imageDisplay": "1000,1000,96", "returnGeometry": "true", "f": "json"}
        for i in range(5):
            try:
                with urllib.request.urlopen(urllib.request.Request(URL, data=urllib.parse.urlencode(p).encode(), headers=UA), timeout=120) as r:
                    d = json.loads(r.read().decode("utf-8", "replace")); break
            except Exception as e:
                time.sleep(3 * (i + 1)); d = {}
        rs = d.get("results") or []
        if len(rs) >= 1000: print("ATENÇÃO limite", env, flush=True)
        for r in rs:
            g = r.get("geometry") or {}
            k = (r["layerId"], json.dumps(r["attributes"], sort_keys=True), round(g.get("x", 0), 6), round(g.get("y", 0), 6))
            res[k] = {"camada": r["layerId"], "nome_camada": r["layerName"], "valor": r.get("value"), "atributos": r["attributes"], "lon": g.get("x"), "lat": g.get("y")}
        x += P; time.sleep(0.15)
    print(round(y, 3), len(res), flush=True); y += P
json.dump(list(res.values()), open(saida, "w"), ensure_ascii=False)
