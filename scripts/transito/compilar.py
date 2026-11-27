"""Compila o mapa de sinalização de trânsito de Goiânia a partir de todas as fontes coletadas.

Base: equipamentos oficiais da SET (API pública do site da Secretaria).
Cruzamento: OpenStreetMap, Pardal (Goiás), Mapa Fácil (vias, bairros, escolas, saúde, ônibus)
e cronogramas de sinalização publicados pela SET (2021-2022).
Saída: /home/claude/sin/out/dados/*.json (camadas padronizadas) para os geradores de KMZ, XLSX e estudo.
"""
import csv, json, math, re, collections, unicodedata
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import shape, Point, LineString
from shapely.strtree import STRtree
from shapely.ops import unary_union

R = Path("/home/claude/sin/raw"); OUT = Path("/home/claude/sin/out/dados"); OUT.mkdir(parents=True, exist_ok=True)
LAT0, LON0 = -16.68, -49.26
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110540
def xy(lon, lat): return ((lon - LON0) * KX, (lat - LAT0) * KY)
def tree(pts): return cKDTree(np.array([xy(*p) for p in pts])) if pts else None
def sem_acento(s): return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").upper().strip()

# ------------------------------------------------------------------ território
bai_f = json.load(open(R / "mf/bairros.geojson"))["features"]
EXPANDE = {"Jd": "Jardim", "S": "Setor", "Res": "Residencial", "Vl": "Vila", "Prq": "Parque", "Ch": "Chácara",
           "Bro": "Bairro", "Cj": "Conjunto", "Con": "Condomínio", "Lot": "Loteamento", "Glb": "Gleba"}
bairros, bgeom = [], []
for f in bai_f:
    if not f["geometry"]: continue
    g = shape(f["geometry"]).buffer(0)
    if g.is_empty: continue
    p = f["properties"]
    nome = (p.get("nm_bai") or "").strip()
    PREF = {"Jd": "Jardim", "Vl": "Vila", "Prq": "Parque", "Res": "Residencial", "Ch": "Chácara", "Lot": "Loteamento",
            "Con": "Condomínio", "Vlg": "Village", "Sir": "Sítio de Recreio", "Cjr": "Residencial", "Grj": "Granja", "Sit": "Sítio", "Faz": "Fazenda"}
    if nome and nome.lower() != "gleba" and PREF.get(p.get("tp_bai")) and not nome.startswith(PREF[p.get("tp_bai")]):
        nome = PREF[p.get("tp_bai")] + " " + nome
    if not nome or nome.lower() in ("gleba",):
        nome = (p.get("nm1") or p.get("nm") or "").strip()
        tp = p.get("tp_bai") or ""
        if nome.startswith(tp + " ") and tp in EXPANDE: nome = nome[len(tp) + 1:]
    bairros.append({"id": p.get("id"), "nome": nome, "tipo": p.get("tp_bai"), "pop": p.get("pop_total") or 0})
    bgeom.append(g)
BT = STRtree(bgeom)
GOIANIA = unary_union(bgeom).buffer(0.0003)
reg_f = json.load(open(R / "mf/regioes.geojson"))["features"]
regioes = [(f["properties"]["nm_reg"].replace("REGIÃO ", "").title(), shape(f["geometry"]).buffer(0)) for f in reg_f if f["geometry"]]
RT = STRtree([g for _, g in regioes])
def onde(lon, lat):
    pt = Point(lon, lat); b = r = ""
    for i in BT.query(pt):
        if bgeom[i].contains(pt): b = bairros[i]["nome"]; break
    for i in RT.query(pt):
        if regioes[i][1].contains(pt): r = regioes[i][0]; break
    return b, r
def em_goiania(lon, lat): return GOIANIA.contains(Point(lon, lat))

# ------------------------------------------------------------------ SET (base oficial)
TIPO_SET = {"Misto": "Radar misto (velocidade + avanço de sinal/parada sobre a faixa)", "Fixo": "Radar fixo de velocidade",
            "Lombada": "Lombada eletrônica", "Faixa Exclusiva": "Fiscalização de faixa exclusiva de ônibus"}
setq = json.load(open(R / "set/set_equipamentos.json"))
fisc = []
for it in setq:
    fv = {f["key"]: f["value"] for f in it["fields"]}
    lat, lon = float(fv["latitude"]), float(fv["longitude"])
    t = it["types"][0]
    fisc.append({"codigo": it["code"], "tipo": TIPO_SET.get(t, t), "tipo_set": t, "lat": lat, "lon": lon,
                 "endereco": it["address"], "sentido": fv.get("sentido"), "faixas": fv.get("faixas"),
                 "numero_serie": fv.get("numero_serie"), "pagina_set": it["url"],
                 "documentos": " | ".join(f'{d["label"]}: {d["url"]}' for d in it["documents"]),
                 "n_documentos": len(it["documents"]), "fonte": "SET – API pública de equipamentos de fiscalização",
                 "confirmacao": [], "status": "Oficial SET"})

# ------------------------------------------------------------------ OSM
osm = json.load(open(R / "osm/osm_sinal.json"))["elements"]
def centro(e):
    if e["type"] == "node": return e["lon"], e["lat"]
    g = e.get("geometry") or []
    if not g: return None
    ls = LineString([(p["lon"], p["lat"]) for p in g]) if len(g) > 1 else Point(g[0]["lon"], g[0]["lat"])
    c = ls.interpolate(0.5, normalized=True) if len(g) > 1 else ls
    return c.x, c.y
osm_pts = []
for e in osm:
    c = centro(e)
    if c and em_goiania(*c): osm_pts.append((e, c))
def osm_url(e): return f'https://www.openstreetmap.org/{e["type"]}/{e["id"]}'

# Pardal (Goiás) — filtra Goiânia
def ler_csv(n): return list(csv.DictReader(open(R / f"pardal/{n}", encoding="utf-8")))
par_rad = [r for r in ler_csv("radares.csv") if em_goiania(float(r["lng"]), float(r["lat"]))]
par_lom = [r for r in ler_csv("lombadas.csv") if em_goiania(float(r["lng"]), float(r["lat"]))]
par_ate = [r for r in ler_csv("pontos_atencao.csv") if em_goiania(float(r["lng"]), float(r["lat"]))]

# ------------------------------------------------------------------ radares: SET x OSM x Pardal
ft = tree([(f["lon"], f["lat"]) for f in fisc])
radares_extra = []
def casa_radar(lon, lat, origem, info):
    d, i = ft.query(xy(lon, lat))
    if d <= 80:
        fisc[i]["confirmacao"].append(f"{origem} ({d:.0f} m)")
        return True
    radares_extra.append({"lat": lat, "lon": lon, "origem": origem, "detalhe": info, "dist_set_m": round(float(d))})
    return False
for e, (lon, lat) in osm_pts:
    if e.get("tags", {}).get("highway") == "speed_camera":
        t = e["tags"]; casa_radar(lon, lat, "OpenStreetMap", f'maxspeed={t.get("maxspeed","")} {osm_url(e)}')
for r in par_rad:
    casa_radar(float(r["lng"]), float(r["lat"]), f'Pardal/{r["source"]}', f'{r["kind"]} limite={r["limit_kmh"]} ativo={r["active"]}')
# radares fora da SET a menos de 60 m um do outro viram um só
ext = []
for r in radares_extra:
    for x in ext:
        if math.dist(xy(r["lon"], r["lat"]), xy(x["lon"], x["lat"])) < 60:
            x["origem"] += " + " + r["origem"]; x["detalhe"] += " | " + r["detalhe"]; break
    else: ext.append(dict(r))
radares_extra = ext

# ------------------------------------------------------------------ semáforos (cruzamentos semaforizados)
sig = [(e, c) for e, c in osm_pts if "traffic_signals" in (e.get("tags", {}).get("highway") or "") and e["type"] == "node"]
clusters = []
for e, (lon, lat) in sig:
    p = xy(lon, lat)
    for c in clusters:
        if math.dist(p, c["xy"]) < 40:
            c["nos"].append(osm_url(e)); n = len(c["nos"])
            c["lon"] += (lon - c["lon"]) / n; c["lat"] += (lat - c["lat"]) / n; c["xy"] = xy(c["lon"], c["lat"]); break
    else: clusters.append({"lon": lon, "lat": lat, "xy": p, "nos": [osm_url(e)]})
semaforos = []
for c in clusters:
    semaforos.append({"lat": c["lat"], "lon": c["lon"], "focos_osm": len(c["nos"]), "osm": " ".join(c["nos"][:6]),
                      "fonte": "OpenStreetMap", "confirmacao_set": "", "status": "Mapeado (OSM)"})
stree = tree([(s["lon"], s["lat"]) for s in semaforos])
for f in fisc:
    if f["tipo_set"] != "Misto": continue
    d, i = stree.query(xy(f["lon"], f["lat"]))
    if d <= 70:
        s = semaforos[i]; s["confirmacao_set"] = (s["confirmacao_set"] + " " + f["codigo"]).strip(); s["status"] = "Confirmado (OSM + radar misto SET)"
    else:
        semaforos.append({"lat": f["lat"], "lon": f["lon"], "focos_osm": 0, "osm": "", "fonte": "SET (radar misto indica semáforo)",
                          "confirmacao_set": f["codigo"], "status": "Indicado pela SET – não mapeado no OSM"})
# mistos próximos entre si (sentidos opostos) indicam um só cruzamento
dedup = []
for s in semaforos:
    if s["fonte"].startswith("SET"):
        alvo = next((x for x in dedup if x["fonte"].startswith("SET") and math.dist(xy(s["lon"], s["lat"]), xy(x["lon"], x["lat"])) < 90), None)
        if alvo: alvo["confirmacao_set"] += " " + s["confirmacao_set"]; continue
    dedup.append(s)
semaforos = dedup

# ------------------------------------------------------------------ travessias e faixas de pedestres
def classe_travessia(t):
    cr = (t.get("crossing") or "") + ";" + (t.get("crossing:markings") or "") + ";" + (t.get("highway") or "")
    if "traffic_signals" in cr or "pedestrian_signals" in cr: return "Faixa com semáforo"
    if re.search(r"zebra|marked|uncontrolled|yes", cr) and "unmarked" not in cr and "markings=no" not in cr: return "Faixa de pedestres pintada"
    if "unmarked" in cr or (t.get("crossing:markings") == "no"): return "Travessia sem faixa pintada"
    return "Travessia (tipo não informado)"
trav = []
for e, (lon, lat) in osm_pts:
    t = e.get("tags", {})
    if t.get("highway") == "crossing" or t.get("footway") == "crossing" or ("crossing" in t and e["type"] == "node" and "traffic_signals" not in (t.get("highway") or "")):
        if t.get("railway"): continue
        trav.append({"lat": lat, "lon": lon, "classe": classe_travessia(t), "tag_crossing": t.get("crossing", ""),
                     "marcacao": t.get("crossing:markings", ""), "elevada": "sim" if t.get("traffic_calming") == "table" else "",
                     "osm": osm_url(e), "fonte": "OpenStreetMap"})
# nó + via da mesma travessia: une a menos de 8 m, preservando a classe mais informativa
ordem = ["Faixa com semáforo", "Faixa de pedestres pintada", "Travessia sem faixa pintada", "Travessia (tipo não informado)"]
trav.sort(key=lambda r: ordem.index(r["classe"]))
tv = []; tt = None; pts = []
for r in trav:
    p = xy(r["lon"], r["lat"])
    if pts:
        tt = cKDTree(np.array(pts)); d, i = tt.query(p)
        if d < 8: tv[i]["osm"] += " " + r["osm"]; continue
    tv.append(r); pts.append(p)
travessias = tv

# ------------------------------------------------------------------ lombadas e redutores
lomb = []
for e, (lon, lat) in osm_pts:
    t = e.get("tags", {}); tc = t.get("traffic_calming")
    if not tc: continue
    nome = {"hump": "Lombada física", "bump": "Lombada física (curta)", "table": "Faixa elevada / plataforma",
            "island": "Ilha / canteiro redutor", "cushion": "Almofada redutora", "rumble_strip": "Sonorizador",
            "chicane": "Chicane", "choker": "Estreitamento de pista"}.get(tc, f"Redutor ({tc})")
    lomb.append({"lat": lat, "lon": lon, "tipo": nome, "fonte": "OpenStreetMap", "ref": osm_url(e)})
for r in par_lom:
    lon, lat = float(r["lng"]), float(r["lat"])
    if any(math.dist(xy(lon, lat), xy(x["lon"], x["lat"])) < 15 for x in lomb): continue
    lomb.append({"lat": lat, "lon": lon, "tipo": {"HUMP": "Lombada física", "TABLE": "Faixa elevada / plataforma", "RUMBLE_STRIP": "Sonorizador"}.get(r["kind"], r["kind"]),
                 "fonte": "Pardal (OSM/Goiás)", "ref": ""})
for f in fisc:
    if f["tipo_set"] == "Lombada":
        lomb.append({"lat": f["lat"], "lon": f["lon"], "tipo": "Lombada eletrônica (SET)", "fonte": "SET", "ref": f["codigo"]})

# ------------------------------------------------------------------ placas, rotatórias e pontos de atenção
placas = []
for e, (lon, lat) in osm_pts:
    h = e.get("tags", {}).get("highway")
    nome = {"stop": "Placa PARE (R-1)", "give_way": "Dê a preferência (R-2)", "mini_roundabout": "Mini-rotatória"}.get(h)
    if e.get("tags", {}).get("railway") == "level_crossing": nome = "Passagem em nível (ferrovia)"
    if nome: placas.append({"lat": lat, "lon": lon, "tipo": nome, "fonte": "OpenStreetMap", "ref": osm_url(e)})
rot = json.load(open(R / "osm/osm_rot.json"))["elements"]
seen = []
for e in rot:
    c = e.get("center")
    if not c or not em_goiania(c["lon"], c["lat"]): continue
    p = xy(c["lon"], c["lat"])
    if any(math.dist(p, q) < 40 for q in seen): continue
    seen.append(p)
    placas.append({"lat": c["lat"], "lon": c["lon"], "tipo": "Rotatória", "fonte": "OpenStreetMap", "ref": osm_url(e)})
for r in par_ate:
    placas.append({"lat": float(r["lat"]), "lon": float(r["lng"]), "tipo": f'Ponto de atenção ({r["kind"]})', "fonte": "Pardal", "ref": ""})

# ------------------------------------------------------------------ localização (bairro/região) em todas as camadas
for camada in (fisc, radares_extra, semaforos, travessias, lomb, placas):
    for r in camada: r["bairro"], r["regiao"] = onde(r["lon"], r["lat"])
for f in fisc: f["confirmacao"] = "; ".join(f["confirmacao"]) or "Só na SET"

# ------------------------------------------------------------------ rede viária oficial (Mapa Fácil)
def rank(h):
    if h in (11, 12): return 1
    if h in (21, 22): return 2
    if h in (31, 32): return 3
    if h == 40: return 4
    if h and h >= 50: return 5
    return 1
NOME_RANK = {1: "Local", 2: "Coletora", 3: "Arterial de 2ª categoria", 4: "Arterial de 1ª categoria", 5: "Expressa / rodovia / anel"}
vias = json.load(open(R / "mf/vias.geojson"))["features"]
segs = []
for f in vias:
    g = f["geometry"]
    if not g: continue
    p = f["properties"]
    for path in g["coordinates"]:
        if len(path) < 2: continue
        segs.append({"nm": (p.get("nm") or "").strip(), "rk": rank(p.get("in_hie")), "bus": p.get("in_onibus") == 1,
                     "cor": (p.get("nm_cor") or "").strip(" <Null>"), "a": path[0], "b": path[-1], "path": path})
# comprimento por bairro (km de via) e índice espacial dos trechos
node = collections.defaultdict(list)
for i, s in enumerate(segs):
    for q in (s["a"], s["b"]): node[(round(q[0], 5), round(q[1], 5))].append(i)
inters = []
for k, idx in node.items():
    nomes = {}
    for i in idx:
        s = segs[i]
        if s["nm"]: nomes[sem_acento(s["nm"])] = max(nomes.get(sem_acento(s["nm"]), (0, False, "", "")), (s["rk"], s["bus"], s["nm"], s["cor"]))
    if len(nomes) < 2: continue
    v = sorted(nomes.values(), reverse=True)
    inters.append({"lon": k[0], "lat": k[1], "r1": v[0][0], "r2": v[1][0], "bus": any(x[1] for x in v),
                   "vias": " x ".join(x[2] for x in v[:3]), "corredor": next((x[3] for x in v if x[3]), "")})
# agrupa nós a menos de 35 m (pistas duplas)
inters.sort(key=lambda r: -(r["r1"] + r["r2"]))
grade, ig = collections.defaultdict(list), []
for r in inters:
    p = xy(r["lon"], r["lat"]); gx, gy = int(p[0] // 35), int(p[1] // 35)
    if any(math.dist(p, q) < 35 for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in grade[(gx + dx, gy + dy)]): continue
    grade[(gx, gy)].append(p); ig.append(r)
inters = ig
print("cruzamentos de logradouros distintos:", len(inters))

# ------------------------------------------------------------------ cronograma SET por bairro
crono = json.load(open(R / "crono/cronograma.json"))
idx_b = {sem_acento(b["nome"]): b["nome"] for b in bairros}
CORR = {"PARQUE DAS AMENDOREIRAS": "PARQUE DAS AMENDOEIRAS", "MARECHAL RONDOM": "MARECHAL RONDON", "ST. DOS FUNCIONARIOS": "DOS FUNCIONARIOS"}
def casa_bairro(s):
    s = sem_acento(s).replace("ST. ", "SETOR "); s = CORR.get(s, s)
    for cand in (s, re.sub(r"^(SETOR|BAIRRO|CONJUNTO|ST\.?)\s+", "", s)):
        cand = CORR.get(cand, cand)
        if cand in idx_b: return idx_b[cand]
    return ""
for c in crono: c["bairro_oficial"] = casa_bairro(c["bairro"])

for nome, obj in [("fiscalizacao_set", fisc), ("radares_fora_set", radares_extra), ("semaforos", semaforos),
                  ("travessias", travessias), ("lombadas", lomb), ("placas_rotatorias", placas), ("cronograma_set", crono)]:
    json.dump(obj, open(OUT / f"{nome}.json", "w"), ensure_ascii=False)
json.dump(inters, open(OUT / "cruzamentos.json", "w"), ensure_ascii=False)
json.dump({"bairros": bairros}, open(OUT / "bairros_meta.json", "w"), ensure_ascii=False)
import pickle; pickle.dump({"segs": segs, "NOME_RANK": NOME_RANK}, open(OUT / "segs.pkl", "wb"))
for nome, obj in [("fiscalizacao_set", fisc), ("radares_fora_set", radares_extra), ("semaforos", semaforos), ("travessias", travessias),
                  ("lombadas", lomb), ("placas_rotatorias", placas)]:
    print(nome, len(obj), collections.Counter(r.get("status") or r.get("classe") or r.get("tipo") or r.get("origem") for r in obj).most_common(8))
print("confirmação SET:", collections.Counter(f["confirmacao"] != "Só na SET" for f in fisc))
print("cronograma casado com bairro:", sum(1 for c in crono if c["bairro_oficial"]), "/", len(crono))
