"""Terceira rodada: notícias oficiais da Prefeitura e lista de Direita Livre completam os semáforos;
camada de notícias com cada cruzamento citado (semáforo, faixa, lombada, ciclofaixa, rotatória, Direita Livre)."""
import json, math, collections
from pathlib import Path
R = Path("/home/claude/sin/raw"); D = Path("/home/claude/sin/out/dados")
LAT0, LON0 = -16.68, -49.26
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110540
def xy(lon, lat): return ((lon - LON0) * KX, (lat - LAT0) * KY)
import sys; sys.path.insert(0, "/home/claude/sin/scripts")
from compilar2 import onde  # mesmo critério de bairro e região

sem = json.load(open(D / "semaforos.json"))
sem = [s for s in sem if not s["status"].startswith("Indicado por fonte oficial")]
noticias = json.load(open(R / "news/achados_noticias.json"))
dl = json.load(open(D / "direita_livre.json"))
for n in noticias: n["bairro"], n["regiao"] = onde(n["lon"], n["lat"]) if n["lon"] else ("", "")
fontes = []
for n in noticias:
    if n["lon"] and n["categoria"] in ("Semáforo", "Direita/Esquerda Livre") and n["acao"] != "retirada":
        fontes.append((n["lon"], n["lat"], f'Notícia oficial {n["data"]}: {n["titulo"]}', n["link"], n["cruzamento"]))
for d in dl:
    if d["lon"]: fontes.append((d["lon"], d["lat"], "Lista de Direita Livre divulgada pela SET", "", d["cruzamento"]))
novos = 0
for lon, lat, fonte, link, nome in fontes:
    p = xy(lon, lat)
    alvo = min(sem, key=lambda s: math.dist(p, xy(s["lon"], s["lat"])))
    if math.dist(p, xy(alvo["lon"], alvo["lat"])) <= 70:
        if "fonte oficial" not in alvo["status"]:
            alvo["status"] = alvo["status"] + " + confirmado por fonte oficial"
        alvo["confirmacao_set"] = (alvo.get("confirmacao_set", "") + " | " + nome).strip(" |")
        continue
    b, r = onde(lon, lat)
    sem.append({"lat": lat, "lon": lon, "focos_osm": 0, "osm": link, "fonte": fonte, "confirmacao_set": nome,
                "status": "Indicado por fonte oficial (notícia ou Direita Livre) – não mapeado no OSM", "bairro": b, "regiao": r})
    novos += 1
json.dump(sem, open(D / "semaforos.json", "w"), ensure_ascii=False)
json.dump(noticias, open(D / "noticias.json", "w"), ensure_ascii=False)
res = collections.Counter(s["status"] for s in sem)
print("semáforos:", len(sem), "novos:", novos); [print(" ", k, v) for k, v in res.most_common()]
print("notícias:", collections.Counter((n["categoria"], bool(n["lon"])) for n in noticias))
r2 = json.load(open(D / "resumo2.json")); r2["semaforos_mapa"] = len(sem); r2["semaforos_novos_fontes_oficiais"] = novos
json.dump(r2, open(D / "resumo2.json", "w"), ensure_ascii=False, indent=1)
