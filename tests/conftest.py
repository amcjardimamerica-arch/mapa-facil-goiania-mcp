"""Configuração comum dos testes da Bússola."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent
DOCS = RAIZ / "docs"
DADOS = DOCS / "data"
sys.path.insert(0, str(RAIZ / "scripts"))


def ler(nome: str):
    # O levantamento inteiro é fonte dos scripts e fica fora do site (scripts/dados); o site usa núcleo e detalhes.
    pasta = RAIZ / "scripts" / "dados" if nome == "levantamento.json" else DADOS
    return json.loads((pasta / nome).read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def territorio():
    return ler("territorio.geojson")


@pytest.fixture(scope="session")
def goiania(territorio):
    from shapely.geometry import shape
    return shape(next(f for f in territorio["features"] if f["properties"]["tipo"] == "goiania")["geometry"])
