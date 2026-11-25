"""Roteiro fixo de desempenho (passo 1): grava as medidas em tests/desempenho-base.json, por versão.

Não reprova por tempo: o Chromium de teste desenha por software (tempos piores que os reais); o que vale é a
comparação entre versões no mesmo ambiente. O servidor da Prefeitura fica bloqueado (tudo vem do banco local) e a
CPU é desacelerada 4 vezes, como num aparelho modesto.
"""
import json
import os
from pathlib import Path

import pytest

from test_app import _contexto, navegador, servidor  # noqa: F401 (fixtures)

pytestmark = pytest.mark.navegador
BASE = Path(__file__).resolve().parent / "desempenho-base.json"
PONTOS = [(-49.2817, -16.7047), (-49.2850, -16.7080), (-49.2790, -16.7010), (-49.2700, -16.6900), (-49.2900, -16.7150)]


def test_roteiro_de_desempenho(navegador, servidor):  # noqa: F811
    ctx = _contexto(navegador)
    ctx.route("**/portalmapa.goiania.go.gov.br/**", lambda r: r.abort())
    p = ctx.new_page()
    p.set_default_timeout(180_000)
    cdp = ctx.new_cdp_session(p)
    # 4× mais lento como no roteiro; com um único processador no ambiente de teste, 2× (fica registrado no relatório).
    taxa = 4 if (os.cpu_count() or 1) >= 2 else 2
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": taxa})
    p.goto(f"{servidor}/sistema.html#ed=0&r=0")
    p.wait_for_function("window.bussola && bussola.pronto", timeout=240_000)
    p.evaluate("bussola.zerarDesempenho()")
    for alt in (3000, 900, 400):
        p.evaluate(f"bussola.globo.camera.setView({{ destination: Cesium.Cartesian3.fromDegrees(-49.2817, -16.7047, {alt}) }})")
        p.wait_for_function("bussola.globo.cena.globe.tilesLoaded", polling=1000, timeout=420_000)
    p.evaluate("bussola.camadas.ligar('uso', true); bussola.camadas.ligar('energia', true)")
    p.wait_for_timeout(3000)
    p.wait_for_function("bussola.globo.cena.globe.tilesLoaded", polling=1000, timeout=420_000)
    for i, (lon, lat) in enumerate(PONTOS):
        p.evaluate(f"bussola.identificar.emPonto({{ lon: {lon}, lat: {lat}, alt: NaN }})")
        if i == 0:
            p.evaluate("""() => { const b = [...document.querySelectorAll('#ficha-corpo button')].find((x) => /cadastro imobili/i.test(x.textContent)); b?.click(); }""")
            p.wait_for_timeout(1500)
    rel = p.evaluate("bussola.desempenho()")
    rel["ambiente"] = {"cpu_lenta": taxa, "processadores": os.cpu_count()}
    versao = p.evaluate("bussola.versao")
    ctx.close()
    base = json.loads(BASE.read_text(encoding="utf-8")) if BASE.exists() else {}
    base[versao] = rel
    BASE.write_text(json.dumps(base, ensure_ascii=False, indent=1), encoding="utf-8")
    # Desde o passo 4 as consultas rodam nos workers: as etapas deles vêm em rel["workers"].
    etapas = set(rel["etapas"]) | {k for w in rel.get("workers", []) for k in w["etapas"]}
    assert rel["contadores"]["pedidos"] > 0 and "filtrar" in etapas, rel
