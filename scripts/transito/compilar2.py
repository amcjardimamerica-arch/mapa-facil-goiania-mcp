"""Segunda rodada: categorias que faltavam (licitação de 2023, Direita Livre, sentido de vias, velocidade,
proibições de conversão, ciclovias, corredores de ônibus, videomonitoramento e IBGE – Censo 2022 entorno)."""
import json, math, collections, pickle
from pathlib import Path
from shapely.geometry import shape, Point, LineString
from shapely.strtree import STRtree

R = Path("/home/claude/sin/raw"); D = Path("/home/claude/sin/out/dados")
LAT0, LON0 = -16.68, -49.26
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110540
def xy(lon, lat): return ((lon - LON0) * KX, (lat - LAT0) * KY)

# território / bairro / região (mesmas regras da 1ª rodada)
meta = json.load(open(D / "bairros_meta.json"))["bairros"]
bg = [shape(f["geometry"]).buffer(0) for f in json.load(open(R / "mf/bairros.geojson"))["features"] if f["geometry"]]
bg = [g for g in bg if not g.is_empty]; BT = STRtree(bg)
from shapely.ops import unary_union
GOIANIA = unary_union(bg).buffer(0.0003)
reg = [(f["properties"]["nm_reg"].replace("REGIÃO ", "").title(), shape(f["geometry"]).buffer(0)) for f in json.load(open(R / "mf/regioes.geojson"))["features"]]
RT = STRtree([g for _, g in reg])
def onde(lon, lat):
    p = Point(lon, lat); b = r = ""
    for i in BT.query(p):
        if bg[i].contains(p): b = meta[i]["nome"]; break
    for i in RT.query(p):
        if reg[i][1].contains(p): r = reg[i][0]; break
    return b, r

# ------------------------------------------------ 1. licitação de fiscalização (2023) x lista atual da SET
fisc = json.load(open(D / "fiscalizacao_set.json"))
TIPO_TR = {"01": "Radar fixo", "02": "Redutor eletrônico (lombada)", "03": "Radar misto", "04": "Fiscalização de faixa exclusiva", "06": "Videomonitoramento"}
tr = json.load(open(R / "licit/tr2023_locais.json"))
licit = []
for t in tr:
    d = min(math.dist(xy(t["lon"], t["lat"]), xy(f["lon"], f["lat"])) for f in fisc)
    b, r = onde(t["lon"], t["lat"])
    sit = ("Videomonitoramento previsto (não é fiscalização)" if t["item"] == "06" else
           "Na lista atual da SET" if d <= 60 else "Previsto em 2023, ausente da lista atual da SET")
    licit.append({"tipo": TIPO_TR.get(t["item"], t["item"]), "endereco": t["endereco"], "lat": t["lat"], "lon": t["lon"],
                  "dist_set_m": round(d), "situacao": sit, "bairro": b, "regiao": r,
                  "fonte": "Pregão Eletrônico SEMAD/SMM 2023 – Termo de Referência, relação de locais (arq_3496036.pdf)"})

# ------------------------------------------------ 2. Direita Livre (lista publicada)
dl = []
for o in json.load(open(R / "extra/direita_livre.json")):
    b, r = onde(o["lon"], o["lat"]) if o["lon"] else ("", "")
    dl.append({**o, "bairro": b, "regiao": r, "localizacao": "Localizado pelo nome das vias (aproximado)" if o["lon"] else "Não localizado automaticamente"})
dl.append({"cruzamento": "Avenida T-3 x Avenida T-10 (Esquerda Livre)", "fonte": "Jornal Opção, 17/10/2026 – primeira Esquerda Livre",
           "lon": None, "lat": None, "nos": 0, "ambiguo": False, "bairro": "Bueno", "regiao": "Sul", "localizacao": "Não localizado automaticamente"})
import sys; sys.path.insert(0, "/home/claude/sin/scripts")
import geocodificar_cruzamentos as g
r = g.achar("Avenida T-3", "Avenida T-10")
if r: dl[-1].update({"lon": r[0], "lat": r[1], "localizacao": "Localizado pelo nome das vias (aproximado)"})

# ------------------------------------------------ 3. OSM: sentido, velocidade, ciclovias, ônibus
vias = json.load(open(R / "osm/osm_vias.json"))["elements"]
linhas = {"sentido_unico": [], "velocidade": [], "ciclovias": [], "onibus": []}
for e in vias:
    t = e["tags"]; geo = [(p["lon"], p["lat"]) for p in e.get("geometry") or []]
    if len(geo) < 2: continue
    mid = geo[len(geo) // 2]
    if not GOIANIA.contains(Point(mid)): continue
    base = {"osm": f'https://www.openstreetmap.org/way/{e["id"]}', "nome": t.get("name", ""), "tipo_via": t.get("highway", ""), "coords": geo}
    if t.get("oneway") in ("yes", "-1", "1", "true"):
        linhas["sentido_unico"].append({**base, "oneway": t["oneway"]})
    if "maxspeed" in t:
        linhas["velocidade"].append({**base, "maxspeed": t["maxspeed"]})
    cyc = [t.get(k) for k in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both")]
    if t.get("highway") == "cycleway" or any(c in ("lane", "track", "shared_lane", "opposite_lane", "opposite", "shared_busway") for c in cyc):
        tipo = "Ciclovia segregada" if t.get("highway") == "cycleway" or "track" in cyc else "Ciclofaixa" if "lane" in cyc or "opposite_lane" in cyc else "Via compartilhada sinalizada"
        linhas["ciclovias"].append({**base, "tipo": tipo})
    if t.get("highway") == "busway" or "busway" in t or "lanes:bus" in t or "bus:lanes" in t:
        linhas["onibus"].append({**base, "tipo": "Faixa/pista exclusiva de ônibus (OSM)"})
# corredores oficiais do Mapa Fácil
segs = pickle.load(open(D / "segs.pkl", "rb"))["segs"]
corr = [{"nome": s["nm"], "corredor": s["cor"], "coords": s["path"], "tipo": "Corredor (Mapa Fácil)"} for s in segs if s["cor"] and s["cor"] not in ("<Null>",)]

# proibições de conversão e câmeras (OSM)
outros = json.load(open(R / "osm/osm_outros.json"))["elements"]
NOME_R = {"no_left_turn": "Proibido virar à esquerda", "no_right_turn": "Proibido virar à direita", "no_u_turn": "Proibido retorno",
          "no_straight_on": "Proibido seguir em frente", "only_straight_on": "Somente seguir em frente", "only_right_turn": "Somente à direita",
          "only_left_turn": "Somente à esquerda"}
restr, cams = [], []
for e in outros:
    t = e.get("tags", {}); c = e.get("center") or ({"lon": e.get("lon"), "lat": e.get("lat")} if "lon" in e else None)
    if not c or not GOIANIA.contains(Point(c["lon"], c["lat"])): continue
    if t.get("type") == "restriction" and t.get("restriction") in NOME_R:
        restr.append({"lon": c["lon"], "lat": c["lat"], "tipo": NOME_R[t["restriction"]], "osm": f'https://www.openstreetmap.org/relation/{e["id"]}'})
    if t.get("man_made") == "surveillance":
        cams.append({"lon": c["lon"], "lat": c["lat"], "tipo": "Câmera (OSM)", "osm": f'https://www.openstreetmap.org/node/{e["id"]}'})
for x in restr + cams: x["bairro"], x["regiao"] = onde(x["lon"], x["lat"])

# ------------------------------------------------ 4. IBGE – Censo 2022, entorno por setor
setores = json.load(open(R / "extra/setores_entorno_goiania.geojson"))["features"]
ibge = []
tot = collections.Counter()
for f in setores:
    p = f["properties"]
    if not p.get("V05400"): continue
    n = p["V05400"]
    for k in ("V05400", "V05415", "V05418", "V05421", "V05427", "V05424", "V05406", "V05412"): tot[k] += p.get(k) or 0
    ibge.append({"setor": p["CD_SETOR"], "bairro_ibge": p.get("NM_BAIRRO") or "", "faces": n,
                 "pct_bicicleta": round(100 * (p.get("V05418") or 0) / n, 1), "pct_rampa": round(100 * (p.get("V05427") or 0) / n, 1),
                 "pct_calcada": round(100 * (p.get("V05421") or 0) / n, 1), "pct_obstaculo": round(100 * (p.get("V05424") or 0) / n, 1),
                 "pct_onibus": round(100 * (p.get("V05415") or 0) / n, 1), "pct_pavimentada": round(100 * (p.get("V05406") or 0) / n, 1),
                 "pct_iluminacao": round(100 * (p.get("V05412") or 0) / n, 1), "geometry": f["geometry"]})

json.dump(licit, open(D / "licitacao_2023.json", "w"), ensure_ascii=False)
json.dump(dl, open(D / "direita_livre.json", "w"), ensure_ascii=False)
json.dump({**linhas, "corredores_mf": corr}, open(D / "linhas_osm.json", "w"), ensure_ascii=False)
json.dump({"restricoes": restr, "cameras_osm": cams}, open(D / "restricoes.json", "w"), ensure_ascii=False)
json.dump(ibge, open(D / "ibge_setores.json", "w"), ensure_ascii=False)
km = lambda L: round(sum(LineString([xy(*c) for c in l["coords"]]).length for l in L) / 1000)
res2 = {"licitacao": collections.Counter(l["situacao"] for l in licit), "licit_tipo": collections.Counter(l["tipo"] for l in licit),
        "licit_ausente_tipo": collections.Counter(l["tipo"] for l in licit if l["situacao"].startswith("Previsto")),
        "direita_livre_publicados": len(dl), "direita_livre_localizados": sum(1 for d in dl if d["lon"]),
        "sentido_unico_trechos": len(linhas["sentido_unico"]), "sentido_unico_km": km(linhas["sentido_unico"]),
        "velocidade_trechos": len(linhas["velocidade"]), "velocidade_km": km(linhas["velocidade"]),
        "velocidades": collections.Counter(l["maxspeed"] for l in linhas["velocidade"]).most_common(8),
        "ciclo": collections.Counter(l["tipo"] for l in linhas["ciclovias"]), "ciclo_km": km(linhas["ciclovias"]),
        "onibus_osm_trechos": len(linhas["onibus"]), "onibus_osm_km": km(linhas["onibus"]),
        "corredores_mf_km": km(corr), "corredores_mf": collections.Counter(c["corredor"] for c in corr).most_common(30),
        "restricoes": collections.Counter(r["tipo"] for r in restr), "cameras_osm": len(cams),
        "ibge_setores": len(ibge), "ibge_faces": tot["V05400"],
        "ibge_pct": {k: round(100 * tot[v] / tot["V05400"], 1) for k, v in (("bicicleta", "V05418"), ("rampa", "V05427"), ("calcada", "V05421"),
                     ("obstaculo", "V05424"), ("onibus", "V05415"), ("pavimentada", "V05406"), ("iluminacao", "V05412"))},
        "semaforos_oficial": 721, "semaforos_mapa": len(json.load(open(D / "semaforos.json")))}
json.dump(res2, open(D / "resumo2.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps(res2, ensure_ascii=False, indent=1))
