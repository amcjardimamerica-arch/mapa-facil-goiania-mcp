"""Estudo de sinalização de Goiânia inteira: cruza a sinalização compilada com a rede viária,
escolas, saúde e pontos de ônibus do Mapa Fácil e aponta lacunas a verificar em campo."""
import json, math, pickle, collections
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

D = Path("/home/claude/sin/out/dados"); R = Path("/home/claude/sin/raw/mf")
LAT0, LON0 = -16.68, -49.26
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110540
def xy(lon, lat): return ((lon - LON0) * KX, (lat - LAT0) * KY)
L = lambda n: json.load(open(D / f"{n}.json"))
fisc, sem, trav, lomb, plac, cruz, crono = (L(n) for n in ("fiscalizacao_set", "semaforos", "travessias", "lombadas", "placas_rotatorias", "cruzamentos", "cronograma_set"))
fora = L("radares_fora_set")
pk = pickle.load(open(D / "segs.pkl", "rb")); segs, NR = pk["segs"], pk["NOME_RANK"]

def arvore(rows): return cKDTree(np.array([xy(r["lon"], r["lat"]) for r in rows])) if rows else None
def perto(t, lon, lat, r): return t.query_ball_point(xy(lon, lat), r) if t is not None else []
def dist(t, lon, lat):
    d, i = t.query(xy(lon, lat)); return float(d), int(i)

T_sem = arvore(sem)
faixas_ok = [t for t in trav if t["classe"] in ("Faixa com semáforo", "Faixa de pedestres pintada")]
T_fx = arvore(faixas_ok); T_trav = arvore(trav)
T_rot = arvore([p for p in plac if p["tipo"] == "Rotatória"]); T_mini = arvore([p for p in plac if p["tipo"] == "Mini-rotatória"])
T_lomb = arvore([l for l in lomb if "Lombada" in l["tipo"] or "elevada" in l["tipo"]])
T_rad = arvore(fisc)

# trechos da rede viária (metros) para achar a via mais próxima de cada ponto
linhas = [LineString([xy(*c) for c in s["path"]]) for s in segs]
ST = STRtree(linhas)
def via_proxima(lon, lat, raio=40):
    p = Point(xy(lon, lat)); idx = ST.query(p.buffer(raio))
    melhor = None
    for i in idx:
        d = linhas[i].distance(p)
        if d <= raio and (melhor is None or (segs[i]["rk"], -d) > (segs[melhor[0]]["rk"], -melhor[1])): melhor = (i, d)
    if not melhor: return None
    s = segs[melhor[0]]; return {"via": s["nm"], "rank": s["rk"], "hierarquia": NR[s["rk"]], "onibus": s["bus"], "dist": round(melhor[1])}

def pts(arq, nome_campos):
    out = []
    for f in json.load(open(R / arq))["features"]:
        if not f["geometry"]: continue
        lon, lat = f["geometry"]["coordinates"]; p = f["properties"]
        nome = next((p[k] for k in nome_campos if p.get(k)), "")
        end = next((v for k, v in p.items() if ("END" in k.upper()) and v), "")
        out.append({"lon": lon, "lat": lat, "nome": str(nome).strip(), "endereco": str(end).strip(), "origem": arq.split(".")[0]})
    return out
def dedup(rows, raio=40):
    res, P = [], []
    for r in rows:
        p = xy(r["lon"], r["lat"])
        if any(math.dist(p, q) < raio for q in P): continue
        res.append(r); P.append(p)
    return res
AC = json.load(open(R / "acess_pontos.json"))
def ac(camadas, origem):
    out = []
    for r in AC:
        if r["camada"] in camadas and r["lon"]:
            a = r["atributos"]; end = next((v for k, v in a.items() if "END" in k.upper() and v and v != "Null"), "")
            out.append({"lon": r["lon"], "lat": r["lat"], "nome": str(a.get("NOME") or a.get("Name") or r["valor"] or "").strip(), "endereco": str(end).strip(), "origem": origem})
    return out
escolas = dedup(pts("pn_educacao.geojson", ["nm_edm", "nm", "NOME"]) + ac({3}, "Escolas públicas (SIEG)") + ac({2}, "Estabelecimentos de educação (SIGGO)"))
saude = dedup(pts("pn_saude.geojson", ["nm_sau", "nm", "NOME"]) + ac({13}, "Atendimento hospitalar (CAE)"))
onibus = ac({41}, "Pontos de ônibus (CMTC)"); terminais = ac({40}, "Terminais (CMTC)")
T_esc = arvore(escolas); T_sau = arvore(saude)

bairros_geo = [(f["properties"], shape(f["geometry"]).buffer(0)) for f in json.load(open(R / "bairros.geojson"))["features"] if f["geometry"]]
meta = json.load(open(D / "bairros_meta.json"))["bairros"]
bairros_geo = [(p, g) for p, g in bairros_geo if not g.is_empty]
assert len(bairros_geo) == len(meta), (len(bairros_geo), len(meta))
BG = [g for _, g in bairros_geo]; BT = STRtree(BG)
def bairro(lon, lat):
    pt = Point(lon, lat)
    for i in BT.query(pt):
        if BG[i].contains(pt): return meta[i]["nome"] if i < len(meta) else ""
    return ""

# ------------------------------------------------------------ 1. cruzamentos sem semáforo
cand = []
for c in cruz:
    if c["r1"] < 3 or c["r2"] < 2: continue
    if "RFFSA" in c["vias"].upper() or c["vias"].startswith("Fer "): continue
    if any(v.strip().startswith(("Pça", "PÇA", "Pca")) for v in c["vias"].split(" x ")): continue  # praças funcionam como rotatórias
    lon, lat = c["lon"], c["lat"]
    if perto(T_sem, lon, lat, 60) or perto(T_rot, lon, lat, 70) or perto(T_mini, lon, lat, 40): continue
    esc = len(perto(T_esc, lon, lat, 200)); sau = len(perto(T_sau, lon, lat, 300))
    fx = len(perto(T_fx, lon, lat, 50)); lb = len(perto(T_lomb, lon, lat, 80)); rd = len(perto(T_rad, lon, lat, 150))
    rodovia = any(k in c["vias"] for k in ("RDV ", "Anel Viário", "ACS ", "ACs ", "Acs ", "Mrg ", "MRG "))
    nivel = "R" if rodovia else "A" if (c["r1"] >= 4 and c["r2"] >= 3) else ("B" if c["r2"] >= 3 else "C")
    pont = c["r1"] + c["r2"] + (1 if c["bus"] else 0) + (1 if esc else 0) + (1 if sau else 0) - (1 if lb or rd else 0)
    cand.append({**c, "lon": lon, "lat": lat, "nivel": nivel, "pontuacao": pont, "hier_1": NR[c["r1"]], "hier_2": NR[c["r2"]],
                 "escolas_200m": esc, "saude_300m": sau, "faixas_50m": fx, "lombadas_80m": lb, "radares_150m": rd,
                 "bairro": bairro(lon, lat),
                 "recomendacao": "Verificar se a interseção é em nível; se for, exige dispositivo (rotatória, semáforo ou viaduto) com a autoridade da rodovia" if nivel == "R" else ("Estudo de semaforização (contagem volumétrica e de conflitos, Manual Brasileiro de Sinalização de Trânsito, Volume V)" if nivel in "AB"
                                  else "Estudo de canalização, PARE/preferência e travessia; semáforo só se a contagem justificar")})
cand.sort(key=lambda r: ("ABCR".index(r["nivel"]), -r["pontuacao"]))

# ------------------------------------------------------------ 2. escolas, 3. saúde
def avalia(rows, raio_fx=150):
    out = []
    for r in rows:
        lon, lat = r["lon"], r["lat"]
        v = via_proxima(lon, lat, 60) or {"via": "", "rank": 0, "hierarquia": "Sem via a 60 m", "onibus": False, "dist": None}
        dfx = dist(T_fx, lon, lat)[0]; dsem = dist(T_sem, lon, lat)[0]; dl = dist(T_lomb, lon, lat)[0]
        prot = min(dfx, dsem)
        if prot <= raio_fx: sit = "Travessia sinalizada mapeada a até 150 m"
        elif v["rank"] >= 2: sit = "SEM travessia sinalizada mapeada – via coletora/arterial"
        else: sit = "Sem travessia mapeada – via local"
        out.append({**r, "bairro": bairro(lon, lat), "via_proxima": v["via"], "hierarquia_via": v["hierarquia"], "via_com_onibus": "sim" if v["onibus"] else "",
                    "dist_faixa_m": round(dfx), "dist_semaforo_m": round(dsem), "dist_lombada_m": round(dl),
                    "travessias_100m": len(perto(T_trav, lon, lat, 100)), "situacao": sit,
                    "prioridade": (3 if v["rank"] >= 3 else 2 if v["rank"] == 2 else 1) if prot > raio_fx else 0})
    return out
esc_av = avalia(escolas); sau_av = avalia(saude)

# ------------------------------------------------------------ 4. pontos de ônibus em vias estruturais
bus_av = []
for r in onibus:
    v = via_proxima(r["lon"], r["lat"], 25)
    if not v or v["rank"] < 3: continue
    dfx = dist(T_fx, r["lon"], r["lat"])[0]; dsem = dist(T_sem, r["lon"], r["lat"])[0]
    if min(dfx, dsem) <= 120: continue
    bus_av.append({**r, "bairro": bairro(r["lon"], r["lat"]), "via": v["via"], "hierarquia_via": v["hierarquia"],
                   "dist_faixa_m": round(dfx), "dist_semaforo_m": round(dsem)})

# ------------------------------------------------------------ 5. painel por bairro
seg_bai = collections.Counter(); bus_km = collections.Counter()
for s, ln in zip(segs, linhas):
    m = s["path"][len(s["path"]) // 2]; b = bairro(*m)
    seg_bai[b] += ln.length / 1000
bp = collections.defaultdict(lambda: collections.Counter())
for nome, rows, chave in [("semaforos", sem, None), ("radares_set", fisc, None), ("faixas", faixas_ok, None), ("travessias", trav, None),
                          ("lombadas", lomb, None), ("pare", [p for p in plac if p["tipo"].startswith("Placa PARE")], None),
                          ("rotatorias", [p for p in plac if "otatória" in p["tipo"]], None)]:
    for r in rows: bp[r.get("bairro") or bairro(r["lon"], r["lat"])][nome] += 1
for r in cand: bp[r["bairro"]]["cruz_" + r["nivel"]] += 1
for r in esc_av:
    bp[r["bairro"]]["escolas"] += 1
    if r["prioridade"] >= 2: bp[r["bairro"]]["escolas_sem_faixa_estrut"] += 1
for r in bus_av: bp[r["bairro"]]["onibus_sem_travessia"] += 1
for c in crono:
    if c.get("bairro_oficial"): bp[c["bairro_oficial"]]["servicos_cronograma"] += 1
painel = []
for b in set(list(bp) + list(seg_bai)):
    if not b: continue
    c = bp[b]; km = seg_bai.get(b, 0)
    if km < 0.3 and not sum(c.values()): continue
    car = 3 * c["cruz_A"] + 2 * c["cruz_B"] + c["cruz_C"] + 2 * c["escolas_sem_faixa_estrut"] + 0.5 * c["onibus_sem_travessia"]
    painel.append({"bairro": b, "km_vias": round(km, 1), **{k: c[k] for k in ("semaforos", "radares_set", "faixas", "travessias", "lombadas", "pare", "rotatorias",
                   "escolas", "escolas_sem_faixa_estrut", "onibus_sem_travessia", "cruz_A", "cruz_B", "cruz_C", "servicos_cronograma")},
                   "faixas_por_km": round(c["faixas"] / km, 2) if km else 0, "indice_carencia": round(car, 1),
                   "lacuna_mapeamento": "provável" if km >= 5 and c["travessias"] == 0 and c["pare"] == 0 else ""})
painel.sort(key=lambda r: -r["indice_carencia"])

# ------------------------------------------------------------ resumo
res = {
    "fiscalizacao_set": len(fisc), "fisc_por_tipo": collections.Counter(f["tipo_set"] for f in fisc),
    "fisc_por_regiao": collections.Counter(f["regiao"] for f in fisc), "fisc_confirmados": sum(1 for f in fisc if f["confirmacao"] != "Só na SET"),
    "radares_fora_set": len(fora), "semaforos": len(sem), "sem_status": collections.Counter(s["status"] for s in sem),
    "sem_por_regiao": collections.Counter(s["regiao"] for s in sem),
    "travessias": len(trav), "trav_classe": collections.Counter(t["classe"] for t in trav), "lombadas": collections.Counter(l["tipo"] for l in lomb),
    "placas": collections.Counter(p["tipo"] for p in plac), "cruzamentos_total": len(cruz),
    "cruzamentos_estruturais": sum(1 for c in cruz if c["r1"] >= 3 and c["r2"] >= 2),
    "candidatos": len(cand), "cand_nivel": collections.Counter(c["nivel"] for c in cand),
    "escolas": len(esc_av), "esc_sit": collections.Counter(e["situacao"] for e in esc_av),
    "saude": len(sau_av), "sau_sit": collections.Counter(e["situacao"] for e in sau_av),
    "onibus_total": len(onibus), "onibus_estrut_sem_travessia": len(bus_av), "cronograma": len(crono),
    "bairros_painel": len(painel), "bairros_lacuna": sum(1 for p in painel if p["lacuna_mapeamento"]),
    "km_vias": round(sum(seg_bai.values())),
}
for n, o in [("estudo_cruzamentos", cand), ("estudo_escolas", esc_av), ("estudo_saude", sau_av), ("estudo_onibus", bus_av),
             ("estudo_bairros", painel), ("resumo", res)]:
    json.dump(o, open(D / f"{n}.json", "w"), ensure_ascii=False, indent=0 if n == "resumo" else None)
print(json.dumps(res, ensure_ascii=False, indent=1))
print("top bairros:", [(p["bairro"], p["indice_carencia"]) for p in painel[:12]])
print("top cruz:", [(c["vias"], c["nivel"], c["pontuacao"], c["bairro"]) for c in cand[:12]])
