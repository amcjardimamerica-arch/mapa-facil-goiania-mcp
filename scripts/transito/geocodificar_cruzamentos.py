"""Localiza cruzamentos citados por nome ("Avenida T-9 x Rua Flemington") na rede viária oficial do Mapa Fácil."""
import pickle, re, unicodedata, collections, math, json, sys
D = "/home/claude/sin/out/dados"
segs = pickle.load(open(f"{D}/segs.pkl", "rb"))["segs"]
ORD = {"1A": "PRIMEIRA", "2A": "SEGUNDA", "3A": "TERCEIRA", "4A": "QUARTA", "5A": "QUINTA", "6A": "SEXTA"}
TIPOS = r"^(AVENIDA|AV|AVE|RUA|R|ALAMEDA|AL|PRACA|PCA|PC|RODOVIA|RDV|MARGINAL|MRG|TRAVESSA|TV|VIELA|ESTRADA|ETR|VIA)\.?\s+"
def norm(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").upper()
    s = re.sub(r",.*$", "", s)                       # ", no Setor Sul"
    s = re.sub(r"\b(\d)ª", lambda m: {"1": "PRIMEIRA", "2": "SEGUNDA", "3": "TERCEIRA", "4": "QUARTA", "5": "QUINTA", "6": "SEXTA"}[m.group(1)], s)
    s = s.replace("ª", "A").replace("º", "")
    s = re.sub(r"[.;]", " ", s); s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(TIPOS, "", s); s = re.sub(TIPOS, "", s)
    s = re.sub(r"\b(DR|DOM|PROFESSOR|PROF|PADRE|PE|GENERAL|GAL|SENADOR|SEN|DEPUTADO|DEP|PRESIDENTE|PRES|ENGENHEIRO|ENG|DONA|D)\b\s*", "", s)
    s = re.sub(r"([A-Z])\s*-\s*(\d)", r"\1 \2", s); s = s.replace("-", " ")
    s = re.sub(r"\b(DA|DE|DO|DAS|DOS)\b", " ", s)
    s = re.sub(r"\b(\d+)\s+([A-Z])\b", r"\1\2", s)
    return re.sub(r"\s+", " ", s).strip()
no = collections.defaultdict(set)
for s in segs:
    n = norm(s["nm"])
    if not n: continue
    for q in (s["a"], s["b"]): no[(round(q[0], 5), round(q[1], 5))].add(n)
indice = collections.defaultdict(list)
for k, ns in no.items():
    for n in ns: indice[n].append(k)
def candidatos(nome):
    n = norm(nome)
    if n in indice: return {n}
    tok = set(n.split())
    return {k for k in indice if k.startswith(n + " ") or k.endswith(" " + n) or (len(n) > 5 and n in k) or (len(tok) > 1 and tok <= set(k.split()))}
def achar(a, b):
    ca, cb = candidatos(a), candidatos(b)
    pts = [k for k, ns in no.items() if ns & ca and ns & cb]
    if not pts:  # vias que não se tocam no cadastro (praça, alça, pista dupla): pontas mais próximas a até 120 m
        pa = [k for n in ca for k in indice[n]]; pb = [k for n in cb for k in indice[n]]
        if not pa or not pb or len(pa) * len(pb) > 4_000_000: return None
        import numpy as np
        from scipy.spatial import cKDTree
        A = np.array([(x * 106600, y * 110540) for x, y in pa]); B = cKDTree(np.array([(x * 106600, y * 110540) for x, y in pb]))
        d, i = B.query(A); j = int(d.argmin())
        if d[j] > 120: return None
        q = pb[int(i[j])]; return (pa[j][0] + q[0]) / 2, (pa[j][1] + q[1]) / 2, 0, False
    lon = sum(p[0] for p in pts) / len(pts); lat = sum(p[1] for p in pts) / len(pts)
    disp = max(math.dist((p[0] * 106600, p[1] * 110540), (lon * 106600, lat * 110540)) for p in pts)
    if disp > 250:  # dois cruzamentos homônimos: fica o primeiro grupo
        p0 = pts[0]; pts = [p for p in pts if math.dist((p[0] * 106600, p[1] * 110540), (p0[0] * 106600, p0[1] * 110540)) < 250]
        lon = sum(p[0] for p in pts) / len(pts); lat = sum(p[1] for p in pts) / len(pts)
    return lon, lat, len(pts), disp > 250
if __name__ == "__main__":
    lista = json.load(open(sys.argv[1])); out = []
    for item in lista:
        partes = re.split(r"\s+x\s+|\s+com\s+", item["cruzamento"], flags=re.I)
        r = achar(partes[0], partes[1]) if len(partes) >= 2 else None
        out.append({**item, "lon": r[0] if r else None, "lat": r[1] if r else None, "nos": r[2] if r else 0, "ambiguo": r[3] if r else False})
    json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False)
    ok = [o for o in out if o["lon"]]; print(len(ok), "/", len(out)); print([o["cruzamento"] for o in out if not o["lon"]])
