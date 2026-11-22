"""Importa o levantamento da Associação (KML + planilha) para docs/data/levantamento.json.

    python scripts/importar_levantamento.py caminho/compilado.kml caminho/compilado.xlsx

O arquivo gerado vai para um site público: ficam de fora contatos e telefones de pessoas,
e-mails e números de CPF que aparecem no nome de empresas individuais (MEI).
"""
from __future__ import annotations

import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

SAIDA = Path(__file__).resolve().parent.parent / "docs" / "data" / "levantamento.json"
BAIRROS = ["Jardim América", "Setor Nova Suíça"]

RE_PM = re.compile(r"<Placemark>(.*?)</Placemark>", re.S)
RE_NOME = re.compile(r"<name>(.*?)</name>", re.S)
RE_ESTILO = re.compile(r"<styleUrl>#(.*?)</styleUrl>")
RE_DESC = re.compile(r"<description>(.*?)</description>", re.S)
RE_ANEL = re.compile(r"<(outer|inner)BoundaryIs>\s*<LinearRing>\s*<coordinates>(.*?)</coordinates>", re.S)
RE_PONTO = re.compile(r"<Point>\s*<coordinates>(.*?)</coordinates>", re.S)
RE_CI = re.compile(r"CI (\d{6,})")
RE_CPF = re.compile(r"\b\d{11}\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b")
RE_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
RE_FONE = re.compile(r"\(?\b\d{2}\)?\s?9?[.\s]?\d{4}-?\d{4}\b")


def kml_cor(c: str) -> str:
    """aabbggrr (KML) -> #rrggbb."""
    return f"#{c[6:8]}{c[4:6]}{c[2:4]}"


def anel(texto: str) -> list[int]:
    """Coordenadas em inteiros de micrograus, com deltas (compacto e sem perda visível)."""
    pts = []
    for p in texto.split():
        lon, lat = p.split(",")[:2]
        pts.append((round(float(lon) * 1e6), round(float(lat) * 1e6)))
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    out, px, py = [], 0, 0
    for x, y in pts:
        out += [x - px, y - py]
        px, py = x, y
    return out


def geometria(pm: str) -> list[list[int]]:
    return [anel(c) for _, c in RE_ANEL.findall(pm)]


def pastas(kml: str):
    """Percorre o KML guardando a trilha de pastas de cada Placemark."""
    trilha, pos = [], 0
    token = re.compile(r"<Folder>\s*<name>(.*?)</name>|</Folder>|<Placemark>(.*?)</Placemark>", re.S)
    for m in token.finditer(kml):
        if m.group(1) is not None:
            trilha.append(html.unescape(m.group(1)))
        elif m.group(0) == "</Folder>":
            trilha.pop()
        else:
            yield list(trilha), m.group(2)


def limpar_nome(s) -> str:
    s = RE_FONE.sub("", RE_EMAIL.sub("", RE_CPF.sub("", str(s or "")))).strip(" -;,")
    if not re.search(r"[A-Za-zÀ-ú]{2}", s):
        return ""
    return re.sub(r"\s{2,}", " ", s)


def num(v):
    if v in (None, ""):
        return None
    try:
        f = float(str(v).replace(",", "."))
        return int(f) if f.is_integer() else round(f, 1)
    except ValueError:
        return None


def main(kml_path: str, xlsx_path: str) -> int:
    kml = Path(kml_path).read_text(encoding="utf-8")
    estilos = {m.group(1): kml_cor(m.group(2)) for m in re.finditer(
        r'<Style id="([^"]+)">.*?<PolyStyle><color>([0-9a-fA-F]{8})</color>', kml, re.S)}

    limites, geo_lotes, areas, locais_kml = [], {}, [], {}
    for trilha, pm in pastas(kml):
        nome = html.unescape(RE_NOME.search(pm).group(1)) if RE_NOME.search(pm) else ""
        topo = trilha[0] if trilha else ""
        if topo == "Limites dos bairros":
            limites.append({"nome": nome, "aneis": geometria(pm)})
        elif topo.startswith("Lotes por finalidade"):
            desc = RE_DESC.search(pm).group(1)
            ci = RE_CI.search(desc)
            bairro = next((b for b in BAIRROS if any(t.startswith(b) for t in trilha)), "")
            estilo = RE_ESTILO.search(pm).group(1)
            chave = (bairro, ci.group(1)) if ci else (bairro, nome)
            geo_lotes[chave] = {"g": geometria(pm), "cor": estilos.get(estilo, "#9aa3ad"), "fin": trilha[2].split(" (")[0] if len(trilha) > 2 else ""}
            geo_lotes.setdefault((bairro, "nome", nome), geo_lotes[chave])
        elif topo.startswith("Áreas públicas"):
            areas.append({"nome": nome, "cat": trilha[1].split(" (")[0] if len(trilha) > 1 else "", "g": geometria(pm)})

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)

    def linhas(aba):
        it = wb[aba].iter_rows(values_only=True)
        cab = [str(c or "").strip() for c in next(it)]
        for r in it:
            if any(v not in (None, "") for v in r):
                yield dict(zip(cab, r))

    # Locais de votação
    locais, idx_local = [], {}
    for r in linhas("Locais de votação"):
        lat, lon = num(r.get("Latitude")), num(r.get("Longitude"))
        if lat is None or lon is None:
            continue
        idx_local[str(r.get("Local de votação") or "").strip().upper()] = len(locais)
        locais.append({"z": str(r.get("Zona") or ""), "n": str(r.get("Nº do local") or ""), "nome": str(r.get("Local de votação") or "").strip(),
                       "end": str(r.get("Endereço") or "").strip(), "bai": str(r.get("Bairro") or "").strip(),
                       "sec": num(r.get("Seções")), "ele": num(r.get("Eleitores")), "uso": r.get("Em uso em 2026") == "Sim",
                       "ct": str(r.get("Conselho Tutelar 2023 — situação") or "").strip(), "ctr": str(r.get("CT — região") or "").strip(),
                       "lat": lat, "lon": lon})

    finalidades, lotes, sem_geo = {}, [], 0
    for r in linhas("Lotes"):
        bairro = str(r.get("Bairro") or "").strip()
        ci = str(r.get("Inscrição do lote (CI)") or "").strip()
        q, l = str(r.get("Quadra") or "").strip(), str(r.get("Lote") or "").strip()
        g = geo_lotes.get((bairro, ci)) or geo_lotes.get((bairro, "nome", f"Qd {q} Lt {l}"))
        if not g:
            sem_geo += 1
            continue
        fin = str(r.get("Finalidade") or "Não identificado").strip()
        finalidades.setdefault(fin, {"nome": fin, "cor": g["cor"], "n": 0})["n"] += 1
        empresas = [limpar_nome(x) for x in str(r.get("Empresas (nome)") or "").split(";") if limpar_nome(x)]
        lotes.append({k: v for k, v in {
            "b": BAIRROS.index(bairro) if bairro in BAIRROS else 0, "q": q, "l": l, "ci": ci,
            "end": str(r.get("Endereço (cadastro)") or "").strip(), "f": fin,
            "st": str(r.get("Subtipo") or "").strip(), "ar": str(r.get("Área do comércio (principal)") or "").strip(),
            "aa": str(r.get("Todas as áreas no lote") or "").strip(), "cnpj": num(r.get("CNPJs ativos no lote")),
            "emp": empresas[:8], "un": num(r.get("Unidades no cadastro")), "ur": num(r.get("Unid. residenciais")),
            "unr": num(r.get("Unid. não residenciais")), "pav": num(r.get("Pavimentos (conferido)")) or num(r.get("Pavimentos")),
            "alt": num(r.get("Altura 3D (m)")), "edif": str(r.get("Edifício / condomínio") or "").strip(),
            "at": num(r.get("Área do terreno (m²)")), "ae": num(r.get("Área edificada total (m²)")),
            "alv": num(r.get("Alvarás municipais")), "gm": str(r.get("Google Maps (estabelecimentos)") or "").strip(),
            "cat": str(r.get("Categorias no levantamento (KML)") or "").strip(),
            "ap": str(r.get("Área pública no lote") or "").strip(),
            "vot": idx_local.get(str(r.get("Local de votação mais próximo (2026)") or "").strip().upper()),
            "dist": num(r.get("Distância ao local (m)")), "cts": str(r.get("Conselho Tutelar 2023 — situação do local") or "").strip(),
            "ctr": str(r.get("Conselho Tutelar — região") or "").strip(),
            "ctv": idx_local.get(str(r.get("Conselho Tutelar — onde votou") or "").strip().upper(), str(r.get("Conselho Tutelar — onde votou") or "").strip()),
            "id": str(r.get("ID do lote (Mapa Fácil)") or "").strip(), "g": g["g"],
        }.items() if v not in (None, "", [], "0") or k in ("b", "g")})
        for k in ("end", "edif", "gm", "cat", "ap", "aa", "ar", "st"):
            if isinstance(lotes[-1].get(k), str):
                lotes[-1][k] = limpar_nome(lotes[-1][k]) or lotes[-1].pop(k)

    # Áreas públicas: junta a planilha (atributos) com o KML (geometria) pelo nome.
    attrs = {str(r.get("Nome / identificação") or "").strip(): r for r in linhas("Áreas públicas")}
    for a in areas:
        r = attrs.get(a["nome"], {})
        a.update({k: v for k, v in {"bai": str(r.get("Bairro") or "").strip(), "dest": str(r.get("Destinação") or "").strip(),
                  "uso": str(r.get("Uso") or "").strip(), "prop": str(r.get("Proprietário") or "").strip(),
                  "area": num(r.get("Área (m²)")), "fontes": str(r.get("Fontes") or "").strip()}.items() if v not in (None, "")})

    for lim in limites:
        lim["lotes"] = sum(1 for x in lotes if BAIRROS[x["b"]] == lim["nome"])

    dados = {
        "fonte": "Levantamento da Associação (A.M.C.): Mapa Fácil, Receita Federal (CNPJ), Google Maps, TSE e edital do Conselho Tutelar 2023",
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "nota": "Coordenadas em micrograus com deltas por anel. Sem contatos, telefones, e-mails ou CPF.",
        "bairros": BAIRROS,
        "finalidades": sorted(finalidades.values(), key=lambda f: -f["n"]),
        "limites": limites, "lotes": lotes, "areas": areas, "locais": locais,
    }
    SAIDA.write_text(json.dumps(dados, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(lotes)} lotes ({sem_geo} sem geometria), {len(areas)} áreas públicas, {len(locais)} locais, "
          f"{len(limites)} limites -> {SAIDA} ({SAIDA.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
