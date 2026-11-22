"""Importa o levantamento da Associação (KML + planilha) para docs/data/levantamento.json.

    python scripts/importar_levantamento.py caminho/compilado.kml caminho/compilado.xlsx

Leva tudo: todas as colunas de todas as abas da planilha e, do KML, a geometria dos lotes,
dos limites e das áreas públicas, os locais de votação por zona e por região do Conselho
Tutelar e as setas dos locais transferidos.
"""
from __future__ import annotations

import html
import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import openpyxl

SAIDA = Path(__file__).resolve().parent.parent / "docs" / "data" / "levantamento.json"
BAIRROS = ["Jardim América", "Setor Nova Suíça"]

RE_NOME = re.compile(r"<name>(.*?)</name>", re.S)
RE_ESTILO = re.compile(r"<styleUrl>#(.*?)</styleUrl>")
RE_DESC = re.compile(r"<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</description>", re.S)
RE_ANEL = re.compile(r"<(outer|inner)BoundaryIs>\s*<LinearRing>\s*<coordinates>(.*?)</coordinates>", re.S)
RE_PONTO = re.compile(r"<Point>\s*<coordinates>(.*?)</coordinates>", re.S)
RE_LINHA = re.compile(r"<LineString>.*?<coordinates>(.*?)</coordinates>", re.S)
RE_CI = re.compile(r"CI (\d{6,})")


def kml_cor(c: str) -> str:
    """aabbggrr (KML) -> #rrggbb."""
    return f"#{c[6:8]}{c[4:6]}{c[2:4]}"


def pares(texto: str) -> list[tuple[float, float]]:
    out = []
    for p in texto.split():
        lon, lat = p.split(",")[:2]
        out.append((float(lon), float(lat)))
    return out


def anel(texto: str) -> list[int]:
    """Coordenadas em inteiros de micrograus, com deltas."""
    pts = [(round(x * 1e6), round(y * 1e6)) for x, y in pares(texto)]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    out, px, py = [], 0, 0
    for x, y in pts:
        out += [x - px, y - py]
        px, py = x, y
    return out


def geometria(pm: str) -> list[list[int]]:
    return [anel(c) for _, c in RE_ANEL.findall(pm)]


def texto_desc(pm: str) -> list[str]:
    """Descrição HTML do KML -> linhas de texto."""
    m = RE_DESC.search(pm)
    if not m:
        return []
    t = re.sub(r"<br\s*/?>", "\n", m.group(1))
    t = html.unescape(re.sub(r"<[^>]+>", "", t))
    return [x.strip() for x in t.split("\n") if x.strip()]


def pastas(kml: str):
    """Percorre o KML guardando a trilha de pastas de cada Placemark."""
    trilha = []
    token = re.compile(r"<Folder>\s*<name>(.*?)</name>|</Folder>|<Placemark>(.*?)</Placemark>", re.S)
    for m in token.finditer(kml):
        if m.group(1) is not None:
            trilha.append(html.unescape(m.group(1)))
        elif m.group(0) == "</Folder>":
            trilha.pop()
        else:
            yield list(trilha), m.group(2)


def valor(v):
    if v is None:
        return None
    if isinstance(v, (datetime, date)):
        return v.strftime("%d/%m/%Y")
    if isinstance(v, float):
        return int(v) if v.is_integer() else round(v, 6)
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def num(v):
    try:
        f = float(str(v).replace(",", "."))
        return int(f) if f.is_integer() else round(f, 1)
    except (TypeError, ValueError):
        return None


def tabela(wb, aba):
    it = wb[aba].iter_rows(values_only=True)
    cab = [str(c or "").strip() for c in next(it)]
    linhas = [[valor(v) for v in r] for r in it if any(v not in (None, "") for v in r)]
    return cab, linhas


def main(kml_path: str, xlsx_path: str) -> int:
    kml = Path(kml_path).read_text(encoding="utf-8")
    estilos = {m.group(1): kml_cor(m.group(2)) for m in re.finditer(
        r'<Style id="([^"]+)">.*?<PolyStyle><color>([0-9a-fA-F]{8})</color>', kml, re.S)}

    limites, geo_lotes, areas_kml, pontos, setas = [], {}, [], [], []
    for trilha, pm in pastas(kml):
        nome = html.unescape(RE_NOME.search(pm).group(1)) if RE_NOME.search(pm) else ""
        topo = trilha[0] if trilha else ""
        estilo = (RE_ESTILO.search(pm) or [None, ""])[1] if RE_ESTILO.search(pm) else ""
        if topo == "Limites dos bairros":
            limites.append({"nome": nome, "aneis": geometria(pm), "desc": texto_desc(pm)})
        elif topo.startswith("Lotes por finalidade"):
            desc = RE_DESC.search(pm).group(1)
            ci = RE_CI.search(desc)
            bairro = next((b for b in BAIRROS if any(t.startswith(b) for t in trilha)), "")
            g = {"g": geometria(pm), "cor": estilos.get(estilo, "#9aa3ad"), "desc": texto_desc(pm)}
            if ci:
                geo_lotes[(bairro, ci.group(1))] = g
            geo_lotes[(bairro, "nome", nome)] = g
        elif topo.startswith("Áreas públicas"):
            areas_kml.append({"nome": nome, "cat": trilha[1].split(" (")[0] if len(trilha) > 1 else "",
                              "cor": estilos.get(estilo, "#2e9d57"), "g": geometria(pm), "desc": texto_desc(pm)})
        elif topo.startswith("Eleitoral"):
            grupo = trilha[2] if len(trilha) > 2 else ""
            if estilo == "seta":
                linha = RE_LINHA.search(pm)
                if linha:
                    p = pares(linha.group(1))
                    setas.append({"de": [round(p[0][0], 6), round(p[0][1], 6)], "para": [round(p[-1][0], 6), round(p[-1][1], 6)],
                                  "regiao": re.sub(r"^Região |\s+—.*$", "", grupo), "nome": nome, "desc": texto_desc(pm)})
                continue
            ponto = RE_PONTO.search(pm)
            if not ponto:
                continue
            lon, lat = pares(ponto.group(1))[0]
            tipo = {"v_geral": "geral", "v_ct": "ct", "v_transf": "transferido", "v_sem": "sem"}.get(estilo, "geral")
            if tipo == "geral":
                grupo = re.sub(r"\s*\(.*$", "", grupo)                      # "1ª zona"
            elif tipo == "sem":
                grupo = ""
            else:
                grupo = re.sub(r"^Região |\s+—.*$", "", trilha[2] if len(trilha) > 2 else "")  # "Campinas"
            pontos.append({"nome": nome, "lon": round(lon, 6), "lat": round(lat, 6), "tipo": tipo, "grupo": grupo, "desc": texto_desc(pm)})

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    abas = {nome: tabela(wb, nome) for nome in wb.sheetnames}

    # ---------------------------------------------------------------- lotes
    cab, linhas = abas["Lotes"]
    ix = {c: i for i, c in enumerate(cab)}
    lotes, idx_lote, finalidades, sem_geo = [], {}, {}, 0
    for r in linhas:
        bairro = r[ix["Bairro"]] or ""
        ci = str(r[ix["Inscrição do lote (CI)"]] or "")
        q, l = str(r[ix["Quadra"]] or ""), str(r[ix["Lote"]] or "")
        g = geo_lotes.get((bairro, ci)) or geo_lotes.get((bairro, "nome", f"Qd {q} Lt {l}"))
        if not g:
            sem_geo += 1
            continue
        fin = r[ix["Finalidade"]] or "Não identificado"
        finalidades.setdefault(fin, {"nome": fin, "cor": g["cor"], "n": 0})["n"] += 1
        idx_lote[(bairro, q.upper(), l.upper())] = len(lotes)
        lotes.append({"b": BAIRROS.index(bairro) if bairro in BAIRROS else 0, "q": q, "l": l, "f": fin,
                      "pav": num(r[ix["Pavimentos (conferido)"]]) or num(r[ix["Pavimentos"]]),
                      "alt": num(r[ix["Altura 3D (m)"]]), "v": r, "g": g["g"]})
        # (A descrição do KML de cada lote repete o que já está nas colunas e na aba Empresas.)

    def lote_de(bairro, q, l):
        q, l = str(q or "").strip().upper(), str(l or "").strip().upper()
        if (bairro, q, l) in idx_lote:
            return idx_lote[(bairro, q, l)]
        for parte in re.split(r"[/,;]|\sE\s", l):
            if (bairro, q, parte.strip()) in idx_lote:
                return idx_lote[(bairro, q, parte.strip())]
        return None

    def ligar(aba, campo_bairro="Bairro", campo_q="Quadra", campo_l="Lote"):
        cab, linhas = abas[aba]
        ix = {c: i for i, c in enumerate(cab)}
        saida = []
        for r in linhas:
            k = lote_de(r[ix[campo_bairro]], r[ix[campo_q]], r[ix[campo_l]]) if campo_q in ix else None
            saida.append({"lote": k, "v": r})
        return {"colunas": cab, "linhas": saida}

    empresas = ligar("Empresas")
    google = ligar("Google Maps")
    condominios = ligar("Condomínios e prédios")
    cab_sem, sem_lote = abas["Empresas sem lote"]

    # ------------------------------------------------------- áreas públicas
    cab_ap, linhas_ap = abas["Áreas públicas"]
    por_nome = {str(r[cab_ap.index("Nome / identificação")] or ""): r for r in linhas_ap}
    areas = [{**a, "v": por_nome.get(a["nome"])} for a in areas_kml]

    # ------------------------------------------------------------ eleitoral
    cab_loc, linhas_loc = abas["Locais de votação"]
    cab_ct, linhas_ct = abas["Conselho Tutelar"]

    for lim in limites:
        lim["lotes"] = sum(1 for x in lotes if BAIRROS[x["b"]] == lim["nome"])

    resumo_cab, resumo = abas["Resumo"]
    dados = {
        "fonte": "Levantamento da Associação (A.M.C.): Mapa Fácil, Receita Federal (CNPJ), Google Maps, TSE e edital do Conselho Tutelar 2023",
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "bairros": BAIRROS,
        "finalidades": sorted(finalidades.values(), key=lambda f: -f["n"]),
        "limites": limites,
        "colunas_lote": cab, "lotes": lotes,
        "empresas": empresas, "empresas_sem_lote": {"colunas": cab_sem, "linhas": sem_lote},
        "google": google, "condominios": condominios,
        "colunas_area": cab_ap, "areas": areas,
        "eleitoral": {"pontos": pontos, "setas": setas,
                      "locais": {"colunas": cab_loc, "linhas": linhas_loc},
                      "conselho": {"colunas": cab_ct, "linhas": linhas_ct}},
        "resumo": {"colunas": resumo_cab, "linhas": resumo},
    }
    SAIDA.write_text(json.dumps(dados, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    ligadas = sum(1 for e in empresas["linhas"] if e["lote"] is not None)
    print(f"{len(lotes)} lotes ({sem_geo} sem geometria), {len(empresas['linhas'])} empresas ({ligadas} ligadas a lote), "
          f"{len(sem_lote)} empresas sem lote, {len(google['linhas'])} Google Maps, {len(condominios['linhas'])} condomínios, "
          f"{len(areas)} áreas públicas, {len(pontos)} pontos eleitorais, {len(setas)} setas, {len(limites)} limites "
          f"-> {SAIDA} ({SAIDA.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
