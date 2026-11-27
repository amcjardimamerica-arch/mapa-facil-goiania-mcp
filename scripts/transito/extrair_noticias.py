"""Extrai das notícias oficiais (site da Prefeitura) os cruzamentos citados junto de cada tipo de sinalização
e localiza cada um na rede viária oficial."""
import json, re, sys, collections
sys.path.insert(0, "/home/claude/sin/scripts")
import geocodificar_cruzamentos as g

TIPO = r"(?:Avenida|Av\.?|Rua|R\.|Alameda|Al\.?|Praça|Pça\.?|Rodovia|Marginal|Viela|Travessa)"
PARE = {"no", "na", "nos", "nas", "em", "e", "que", "para", "pela", "pelo", "onde", "entre", "até", "com", "x", "sentido", "setor", "bairro",
        "jardim", "região", "próximo", "próxima", "esquina", "altura", "cruzamento", "vila", "residencial", "parque", "foi", "será", "serão", "também", "a", "o", "ao", "à"}
def nome_apos(tokens, i):
    """Devolve o nome do logradouro que começa no token i (tipo + até 5 palavras)."""
    out = [tokens[i]]
    for t in tokens[i + 1:i + 7]:
        tl = t.lower().strip(",;.:()\"“”")
        if tl in PARE or not tl or re.fullmatch(TIPO, t.strip(",;")) or (t[:1].isupper() and len(out) > 1 and re.fullmatch(r"[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+", t) and t.lower() in {"reconfiguração", "implantação", "instalação", "local", "locais"}): break
        out.append(t.strip(",;:()\"“”"))
        if re.search(r"[,;.:)]$", t): break
    return " ".join(out).strip(" .")
def cruzamentos(frase):
    toks = frase.split(); res = []
    for i, t in enumerate(toks):
        if re.fullmatch(TIPO, t.strip(",;")) or re.fullmatch(r"(GO|BR)-\d+", t.strip(",;.")):
            a = nome_apos(toks, i); n = len(a.split())
            j = i + n
            if j < len(toks) and toks[j].lower() in ("com", "x", "e", "esquina", "e/ou"):
                k = j + 1
                while k < len(toks) and toks[k].lower() in ("a", "o", "com", "da", "do"): k += 1
                if k < len(toks) and (re.fullmatch(TIPO, toks[k].strip(",;")) or re.fullmatch(r"(GO|BR)-\d+|\d+ª|T-\d+|C-\d+", toks[k].strip(",;."))):
                    b = nome_apos(toks, k) if re.fullmatch(TIPO, toks[k].strip(",;")) else toks[k].strip(",;.")
                    if len(a.split()) > 1 and b: res.append((a, b))
    return res
ACAO = [("retirada", r"retirad|remo[çc][ãa]o|removid|desativad|substitu[ií]d[oa]s? por|extin"), ("implantação", r"implant|instal|nov[oa]s? sem[áa]for|ganh|recebe|receber|entreg|inaugur"),
        ("manutenção/revitalização", r"revitaliz|manuten|repintur|pintura|recupera|reforma|sincroniz|ajust")]
CAT = {"Semáforo": r"sem[áa]foro", "Quebra-mola / lombada": r"lombada|quebra[- ]molas?|redutor(es)? de velocidade", "Faixa elevada": r"faixas? elevadas?|travessias? elevadas?",
       "Faixa de pedestres": r"faixas? de pedestres?", "Sinalização horizontal": r"sinaliza[çc][ãa]o horizontal|pintura|demarca[çc][ãa]o|faixa de reten",
       "Direita/Esquerda Livre": r"(direita|esquerda) livre", "Ciclofaixa / ciclovia": r"ciclofaixa|ciclovia", "Faixa exclusiva de ônibus": r"faixa exclusiva|corredor exclusivo|faixa preferencial",
       "Rotatória": r"rotat[óo]ria"}
if __name__ == "__main__":
    posts = json.load(open(sys.argv[1])); achados = {}
    import html as H
    brutos = {p["id"]: p["content"]["rendered"] for p in json.load(open(sys.argv[1].replace("posts_transito", "posts_prefeitura")))}
    for p in posts:
        bruto = re.sub(r"</?(li|p|br|h\d|tr|td|div)[^>]*>", "\n", brutos.get(p["id"], ""))
        texto = H.unescape(re.sub(r"<[^>]+>", " ", bruto))
        frases = [re.sub(r"\s+", " ", x).strip() for x in re.split(r"\n+|(?<=[.!?;•])\s+|\s+•\s+", texto) if x.strip()]
        cats_post = [k for k, v in CAT.items() if re.search(v, p["titulo"], re.I)] or [k for k, v in CAT.items() if len(re.findall(v, texto, re.I)) >= 2]
        frases = [p["titulo"]] + frases
        for idx, f in enumerate(frases):
            ctx = " ".join(frases[max(0, idx - 1):idx + 1])
            cats = [k for k, v in CAT.items() if re.search(v, f, re.I)] or [k for k, v in CAT.items() if re.search(v, ctx, re.I)] or cats_post
            if not cats: continue
            for a, b in cruzamentos(f):
                acao = next((n for n, r in ACAO if re.search(r, f, re.I)), "citado")
                for cat in cats:
                    k = (cat, g.norm(a), g.norm(b))
                    e = achados.setdefault(k, {"categoria": cat, "via_a": a, "via_b": b, "acao": acao, "data": p["data"], "titulo": p["titulo"], "link": p["link"], "trecho": f[:300], "noticias": 0})
                    e["noticias"] += 1
                    if p["data"] > e["data"]: e.update({"data": p["data"], "titulo": p["titulo"], "link": p["link"], "trecho": f[:300], "acao": acao})
    out = []
    for e in achados.values():
        r = g.achar(e["via_a"], e["via_b"])
        e.update({"cruzamento": f'{e["via_a"]} x {e["via_b"]}', "lon": r[0] if r else None, "lat": r[1] if r else None})
        out.append(e)
    json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False)
    c = collections.Counter((o["categoria"], bool(o["lon"])) for o in out)
    print(len(out)); [print(k, v) for k, v in sorted(c.items())]
