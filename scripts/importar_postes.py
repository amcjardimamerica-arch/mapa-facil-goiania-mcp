"""Postes do Jardim América e do Nova Suíça a partir do KML do levantamento (08 - Postes.kml).

    python scripts/importar_postes.py caminho/08_-_Postes.kml

Junta cada poste do KML com o ponto de iluminação do cadastro (scripts/dados/levantamento.json):
primeiro pela plaqueta (nº do barramento), depois pela distância (até 6 m). Os pontos de iluminação
sem poste no KML entram também, para nada se perder. Grava docs/data/postes.json.
"""
from __future__ import annotations

import html
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SIGLA = {"Jardim América": "JA", "Setor Nova Suíça": "NS", "Nova Suíça": "NS"}


def dist(lon1, lat1, lon2, lat2):
    return math.hypot((lon2 - lon1) * math.cos(math.radians(lat1)) * 111320, (lat2 - lat1) * 110540)


def dentro(aneis, x, y):
    d = False
    for a in aneis:
        j = len(a) - 1
        for i in range(len(a)):
            xi, yi = a[i]
            xj, yj = a[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                d = not d
            j = i
    return d


def decodificar(anel):
    pts, x, y = [], 0, 0
    for i in range(0, len(anel), 2):
        x += anel[i]
        y += anel[i + 1]
        pts.append((x / 1e6, y / 1e6))
    return pts


def ler_kml(caminho):
    s = Path(caminho).read_text(encoding="utf-8")
    cores = {}
    for m in re.finditer(r'<gx:CascadingStyle kml:id="([^"]+)_normal">(.*?)</gx:CascadingStyle>', s, re.S):
        c = re.search(r"icon\?color=([0-9a-fA-F]{6})", m.group(2))
        cores[m.group(1)] = f"#{c.group(1).lower()}" if c else None
    trilha, saida = [], []
    for m in re.finditer(r"<Folder[^>]*>|</Folder>|<Placemark[^>]*>(.*?)</Placemark>", s, re.S):
        t = m.group(0)
        if t.startswith("<Folder"):
            n = re.search(r"<name>([^<]*)</name>", s[m.end():m.end() + 600])
            trilha.append(html.unescape(n.group(1)) if n else "")
            continue
        if t == "</Folder>":
            trilha.pop()
            continue
        p = m.group(1)
        nome = html.unescape((re.search(r"<name>(.*?)</name>", p, re.S) or [0, ""])[1]).strip()
        desc = (re.search(r"<description>(.*?)</description>", p, re.S) or [0, ""])[1]
        desc = re.sub(r"<!\[CDATA\[|\]\]>", "", desc)
        desc = re.sub(r"<br\s*/?>|</div>|<div>", "\n", html.unescape(desc))
        linhas = [l.replace("\xa0", " ").strip() for l in html.unescape(re.sub(r"<[^>]+>", "", desc)).split("\n")]
        estilo = (re.search(r"<styleUrl>#?([^<]+)</styleUrl>", p) or [0, ""])[1]
        c = re.search(r"<coordinates>\s*([-\d.]+),([-\d.]+)", p)
        saida.append({"nome": nome, "linhas": [l for l in linhas if l], "cor": cores.get(estilo),
                      "lon": float(c.group(1)), "lat": float(c.group(2)), "pasta": " / ".join(trilha[1:]) or (trilha[0] if trilha else "")})
    return saida


def main(kml):
    lev = json.loads((RAIZ / "scripts/dados/levantamento.json").read_text(encoding="utf-8"))
    il = lev["iluminacao"]
    C = il["colunas"]
    ix = {c: i for i, c in enumerate(C)}
    limites = [(l["nome"], [decodificar(a) for a in l["aneis"]]) for l in lev["limites"]]

    def bairro(lon, lat):
        for nome, aneis in limites:
            if dentro(aneis, lon, lat):
                return nome
        return "Entorno"

    norm = lambda t: re.sub(r"[^0-9X]", "", str(t or "").upper())
    por_plaqueta = {}
    for k, r in enumerate(il["linhas"]):
        por_plaqueta.setdefault(norm(r["v"][ix["Nº do barramento (plaqueta)"]]), []).append(k)

    postes, usados = [], set()
    for p in ler_kml(kml):
        n, texto = p["nome"], " | ".join(p["linhas"])
        m = re.match(r"(?:Poste\s+|Iluminação\s+-\s+)?(.*?)\s+-\s*(.*)$", n)
        local, resto = (m.group(1), m.group(2)) if m else (n, "")
        material = ("M" if re.search(r"\(M\)|Madeira", n + texto, re.I) else
                    "R" if re.search(r"\bR\b|Concreto R", n + " " + texto) else
                    "Q" if re.search(r"\bQ\b|Concreto Q", n + " " + texto) else "")
        campos = {}
        for l in p["linhas"]:
            mm = re.match(r"(Poste|Lâmpada|Potência|Tensão)\s*-\s*(.*)$", l)
            if mm and mm.group(2).strip():
                campos[mm.group(1)] = mm.group(2).strip()
        transformador = bool(re.search(r"Transformador", n, re.I)) or p["cor"] == "#d32f2f"
        tensao = campos.get("Tensão") or {"#f57c00": "Alta", "#ffee58": "Baixa"}.get(p["cor"], "")
        pl = re.search(r"([0-9]{6,8}[xX0-9]?)", resto)
        plaqueta = pl.group(1).upper() if pl else ""
        datas = [re.search(r"\d{2}/\d{2}/\d{4}", l).group(0) for l in p["linhas"] if re.search(r"\d{2}/\d{2}/\d{4}", l)]
        obs = [l for l in p["linhas"] if not re.match(r"(Poste|Lâmpada|Potência|Tensão)\s*-", l) and not re.fullmatch(r"\d{2}/\d{2}/\d{4}", l)]
        alvo = None
        for k in por_plaqueta.get(norm(plaqueta), []) if plaqueta else []:
            v = il["linhas"][k]["v"]
            if k not in usados and dist(p["lon"], p["lat"], v[ix["Longitude"]], v[ix["Latitude"]]) < 60:
                alvo, via = k, "plaqueta"
                break
        if alvo is None:
            perto = [(dist(p["lon"], p["lat"], r["v"][ix["Longitude"]], r["v"][ix["Latitude"]]), k) for k, r in enumerate(il["linhas"])
                     if k not in usados and abs(r["v"][ix["Longitude"]] - p["lon"]) < 2e-4 and abs(r["v"][ix["Latitude"]] - p["lat"]) < 2e-4]
            if perto and min(perto)[0] <= 6:
                alvo, via = min(perto)[1], "proximidade"
        poste = {"nome": n, "local": local, "pasta": p["pasta"], "plaqueta": plaqueta, "material": material,
                 "transformador": transformador, "tensao": tensao, "tipo_poste": campos.get("Poste", ""),
                 "lampada": campos.get("Lâmpada", ""), "potencia": campos.get("Potência", ""),
                 "datas": datas, "obs": obs, "cor_kml": p["cor"], "lon": round(p["lon"], 7), "lat": round(p["lat"], 7), "origem": "KML"}
        if alvo is not None:
            usados.add(alvo)
            v = il["linhas"][alvo]["v"]
            poste["iluminacao"] = {c: v[i] for i, c in enumerate(C) if v[i] not in (None, "")}
            poste["casamento"] = via
        postes.append(poste)
    # Pontos de iluminação do cadastro que não estão no KML: entram como poste do cadastro.
    for k, r in enumerate(il["linhas"]):
        if k in usados:
            continue
        v = r["v"]
        postes.append({"nome": f"Poste {v[ix['Logradouro (cadastro)']] or ''} - {v[ix['Nº do barramento (plaqueta)']] or ''}".strip(),
                       "local": v[ix["Logradouro (cadastro)"]] or "", "pasta": "", "plaqueta": str(v[ix["Nº do barramento (plaqueta)"]] or ""),
                       "material": "", "transformador": False, "tensao": "", "tipo_poste": "", "lampada": v[ix["Tipo de lâmpada"]] or "",
                       "potencia": str(v[ix["Potência (W)"]] or ""), "datas": [], "obs": [], "cor_kml": None,
                       "lon": v[ix["Longitude"]], "lat": v[ix["Latitude"]], "origem": "Cadastro de iluminação",
                       "iluminacao": {c: v[i] for i, c in enumerate(C) if v[i] not in (None, "")}, "casamento": "só no cadastro"})
    contagem = {}
    for p in postes:
        p["bairro"] = bairro(p["lon"], p["lat"])
        s = SIGLA.get(p["bairro"], "EN")
        contagem[s] = contagem.get(s, 0) + 1
        p["codigo"] = f"PT-{s}-{contagem[s]:04d}"
        p["altura"] = float((p.get("iluminacao") or {}).get("Altura 3D estimada (m)") or (7.5 if p["material"] == "M" else 10 if p["transformador"] else 9))
    resumo = {
        "kml": sum(1 for p in postes if p["origem"] == "KML"),
        "kml_com_lampada_no_cadastro": sum(1 for p in postes if p["origem"] == "KML" and p.get("iluminacao")),
        "kml_sem_lampada_no_cadastro": sum(1 for p in postes if p["origem"] == "KML" and not p.get("iluminacao")),
        "so_no_cadastro": sum(1 for p in postes if p["origem"] != "KML"),
        "transformadores": sum(p["transformador"] for p in postes),
        "tensao_alta": sum(p["tensao"] == "Alta" for p in postes), "tensao_baixa": sum(p["tensao"] == "Baixa" for p in postes),
        "concreto_redondo": sum(p["material"] == "R" for p in postes), "concreto_quadrado": sum(p["material"] == "Q" for p in postes),
        "madeira": sum(p["material"] == "M" for p in postes), "com_pedidos": sum(bool(p["datas"]) for p in postes),
    }
    saida = {"fonte": "08 - Postes.kml (levantamento da Associação) + cadastro de iluminação do Mapa Fácil",
             "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"), "resumo": resumo, "postes": postes}
    (RAIZ / "docs/data/postes.json").write_text(json.dumps(saida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(resumo, ensure_ascii=False), len(postes))


if __name__ == "__main__":
    main(sys.argv[1])
