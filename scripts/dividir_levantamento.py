"""Divide scripts/dados/levantamento.json em núcleo (o que o painel Associação precisa para abrir) e detalhes.

    python scripts/dividir_levantamento.py

- levantamento-nucleo.json: bairros, limites, finalidades, lotes só com desenho e filtro (b, q, l, f, pav, alt, g),
  áreas públicas, bocas de lobo, pontos e setas dos locais de votação, manutenção e as empresas de ensino (para o filtro de escolas).
  É o que o mapa baixa logo ao abrir o sistema (cerca de 0,25 MB comprimido).
- levantamento-detalhes.json: as colunas de cada lote (fichas e busca), empresas, empresas sem lote, Google Maps,
  condomínios, unidades, iluminação, conferências e as planilhas dos locais de votação. Chega em segundo plano, depois que os filtros já estão na tela.

Os dois levam o mesmo "gerado_em" do levantamento; o sistema só junta detalhes do mesmo levantamento do núcleo.
O levantamento.json inteiro continua sendo a fonte dos scripts (regioes_conselho, lotes_eleitorais, canteiros…).
Rodar de novo sempre que o levantamento.json mudar (importar_levantamento.py já chama este script no fim).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

DADOS = Path(__file__).resolve().parent.parent / "docs" / "data"
CAMPOS_LOTE = ("b", "q", "l", "f", "pav", "alt", "g")
DETALHES = ("empresas", "empresas_sem_lote", "google", "condominios", "unidades", "iluminacao",
            "conferencia", "conferencia_condominios")
# Mesmo critério de escolas.js (categoriaDoCnae): ensino infantil, fundamental, médio, superior e cursos livres.
ENSINO = re.compile(r"^(851[123]|852|8541|853|855|859)")


def gravar(nome: str, dados) -> int:
    texto = json.dumps(dados, ensure_ascii=False, separators=(",", ":"))
    (DADOS / nome).write_text(texto, encoding="utf-8")
    return len(texto.encode("utf-8"))


def main() -> int:
    d = json.loads((DADOS.parent.parent / "scripts" / "dados" / "levantamento.json").read_text(encoding="utf-8"))
    nucleo = {k: v for k, v in d.items() if k not in DETALHES and k != "lotes"}
    nucleo["lotes"] = [{k: l.get(k) for k in CAMPOS_LOTE} for l in d["lotes"]]
    ce = d["empresas"]["colunas"]
    kc = ce.index("CNAE principal")
    nucleo["empresas_ensino"] = {"colunas": ce, "linhas": [e for e in d["empresas"]["linhas"]
                                                           if ENSINO.match(re.sub(r"\D", "", str(e["v"][kc] or "")))]}
    # Tabelas dos locais de votação (planilhas) só aparecem na ficha: vão para os detalhes.
    nucleo["eleitoral"] = {k: v for k, v in d["eleitoral"].items() if k not in ("locais", "conselho")}
    nucleo["contagem"] = {"empresas": len(d["empresas"]["linhas"]) + len(d["empresas_sem_lote"]["linhas"])}
    detalhes = {k: d[k] for k in DETALHES if k in d}
    detalhes["gerado_em"] = d.get("gerado_em")
    detalhes["eleitoral_tabelas"] = {k: d["eleitoral"][k] for k in ("locais", "conselho") if k in d["eleitoral"]}
    detalhes["lotes_v"] = [l["v"] for l in d["lotes"]]
    tn = gravar("levantamento-nucleo.json", nucleo)
    td = gravar("levantamento-detalhes.json", detalhes)
    print(f"levantamento-nucleo.json {tn / 1e6:.2f} MB ({len(nucleo['lotes'])} lotes, "
          f"{len(nucleo['empresas_ensino']['linhas'])} empresas de ensino); levantamento-detalhes.json {td / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
