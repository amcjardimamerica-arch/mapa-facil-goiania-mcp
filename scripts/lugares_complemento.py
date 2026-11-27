"""Lugares a mais para a busca (1.29.0): parques, lagos, bosques e demais unidades de conservação pelo nome
(Mapa_MeioAmbiente/12 e /11) e shoppings (Mapa_Acessibilidade/22), lidos do banco local.

    python scripts/lugares_complemento.py

Grava docs/data/lugares_complemento.json no mesmo formato de lugares.json ({n, tipo, r, k, d, c}).
Antes, "Lago das Rosas", "Zoológico" e os shoppings não eram achados pela busca.
"""
from __future__ import annotations

import glob
import gzip
import json
import re
import unicodedata
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
BANCO = RAIZ / "docs" / "banco" / "dados"


def camada(s, i):
    base = BANCO / s / str(i)
    arqs = [base / "todos.json.gz"] if (base / "todos.json.gz").exists() else [Path(a) for a in glob.glob(str(base / "*" / "*.json.gz")) if "/indice-" not in a]
    cols, f = [], {}
    for a in arqs:
        d = json.load(gzip.open(a)); cols = d["c"]
        for it in d["f"]:
            f.setdefault(it[0], (it[1], it[2] if len(it) > 2 else None))
    return cols, f


def centro(g):
    if not g:
        return None
    if isinstance(g[0], (int, float)):
        return [round(g[0] / 1e6, 5), round(g[1] / 1e6, 5)]
    a = g[0]; x = y = 0; pts = []
    for i in range(0, len(a) - 1, 2):
        x += a[i]; y += a[i + 1]; pts.append((x / 1e6, y / 1e6))
    return [round(sum(p[0] for p in pts) / len(pts), 5), round(sum(p[1] for p in pts) / len(pts), 5)] if pts else None


def sa(t):
    return "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn").lower()


def titulo(t):
    t = re.sub(r"\s+", " ", str(t or "")).strip()
    pequenas = {"de", "da", "do", "das", "dos", "e"}
    return " ".join(w.lower() if i and w.lower() in pequenas else w.capitalize() for i, w in enumerate(t.split()))


NOMEADOS = re.compile(r"Arena|Rodovi[aá]ria|Pal[aá]cio|Pal\\.|Conven[cç]|Hip[oó]dromo|Aut[oó]dromo|Est[aá]dio|Ferrovi|Cemit[eé]rio|"
                      r"Aterro|Hemocentro|Materno|Bib\\.|Museu|Obelisco|Inmetro|Crea|Unip|Pedreira|Bombeamento|Arisco|Gabinete|"
                      r"Cepal|Vigil[aâ]ncia|Esmeraldas|COMPAV|Heliporto Org", re.I)


def main():
    out, vistos = [], set()

    def add(n, r, c, d=""):
        if not n or not c:
            return
        k = sa(n)
        if k in vistos:
            return
        vistos.add(k)
        out.append({"n": n, "tipo": "parque" if r in ("Unidade de conservação", "Parque") else "lugar", "r": r, "k": k, "d": d, "c": c})

    c, f = camada("Mapa_MeioAmbiente", 12)
    for v, g in f.values():
        tp, nm = titulo(v[c.index("tp_unc")]), titulo(v[c.index("nm_unc")])
        if not nm:
            continue
        n = nm if sa(nm).startswith(sa(tp)) else f"{tp} {nm}".strip()
        add(n, "Unidade de conservação", centro(g))
        m = re.search(r"\(([^)]+)\)", nm)   # "Educativo (Zoológico - Lago das Rosas)" também por "Lago das Rosas"
        if m:
            for parte in re.split(r"\s*-\s*", m.group(1)):
                add(titulo(parte), "Unidade de conservação", centro(g), n)
    c, f = camada("Mapa_MeioAmbiente", 11)
    for v, g in f.values():
        nm = titulo(v[c.index("nm_unc")])
        if nm:
            add(nm if sa(nm).startswith("parque") else f"Parque {nm}", "Parque", centro(g))
    c, f = camada("Mapa_Acessibilidade", 22)
    for v, g in f.values():
        add(str(v[c.index("NM_SHOPP")]).strip(), "Shopping", centro(g), str(v[c.index("INFO_SHOPP")] or ""))
    # Grandes equipamentos (estádios, arenas, terminais, autódromo, centros de convenções…) e terminais de ônibus:
    # antes "Estádio Serra Dourada" levava à Rua Serra Dourada.
    c, f = camada("Mapa_PontosNotaveis", 2)
    for v, g in f.values():
        nm = str(v[c.index("nm_gre")] or "").strip()
        # a camada traz também as partes de cada equipamento ("Gramado", "Galpão", "Guarita"…): só os nomes próprios
        if len(nm) > 2 and NOMEADOS.search(nm):
            add(titulo(nm) if nm.isupper() else nm, "Grande equipamento", centro(g))
    c, f = camada("Mapa_Acessibilidade", 40)
    for v, g in f.values():
        nm = re.sub(r"^T\.\s*", "Terminal ", str(v[c.index("Name")] or "").strip())
        if nm:
            add(nm, "Terminal de ônibus", centro(g))
    (RAIZ / "docs/data/lugares_complemento.json").write_text(json.dumps({"fonte": "Banco local: Meio Ambiente (unidades de conservação e parques), Acessibilidade (shoppings e terminais) e Pontos Notáveis (grandes equipamentos)", "lugares": out},
                                                                       ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(len(out), [x["n"] for x in out if re.search("Rosas|Serra Dourada|Terminal", x["n"])][:12])


if __name__ == "__main__":
    main()
