"""Baixa camadas do Mapa Fácil (ArcGIS) em GeoJSON, paginando por OBJECTID."""
import json, sys, time, urllib.parse, urllib.request
M = "https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer"
UA = {"User-Agent": "Bussola-Sinalizacao/1.0 (pesquisa; A.M.C. Jardim America)"}
def req(url, p):
    d = urllib.parse.urlencode(p).encode()
    for i in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=d, headers=UA), timeout=180) as r:
                o = json.loads(r.read().decode("utf-8", "replace"))
            if isinstance(o, dict) and o.get("error"): raise RuntimeError(o["error"])
            return o
        except Exception as e:
            print("  retry", i, e, flush=True); time.sleep(4 * (i + 1))
    raise SystemExit("falhou " + url)
def esri2geo(g):
    if not g: return None
    if "x" in g: return {"type": "Point", "coordinates": [g["x"], g["y"]]}
    if "paths" in g: return {"type": "MultiLineString", "coordinates": g["paths"]}
    if "rings" in g: return {"type": "Polygon", "coordinates": g["rings"]}
def baixar(camada, saida, pagina=500, campos="*"):
    url = f"{M}/{camada}/query"
    ids = sorted(req(url, {"where": "1=1", "returnIdsOnly": "true", "f": "json"}).get("objectIds") or [])
    feats = []
    for i in range(0, len(ids), pagina):
        fc = req(url, {"objectIds": ",".join(map(str, ids[i:i + pagina])), "outFields": campos,
                       "returnGeometry": "true", "outSR": "4326", "geometryPrecision": "6", "f": "json"})
        for f in fc.get("features") or []:
            feats.append({"type": "Feature", "properties": f.get("attributes"), "geometry": esri2geo(f.get("geometry"))})
        print(camada, len(feats), "/", len(ids), flush=True); time.sleep(0.3)
    json.dump({"type": "FeatureCollection", "features": feats}, open(saida, "w"), ensure_ascii=False)
if __name__ == "__main__":
    for par in sys.argv[1:]:
        c, s = par.split("=")
        baixar(c, s)
