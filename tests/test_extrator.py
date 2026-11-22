"""Testes de unidade do extrator (sem rede)."""
from __future__ import annotations

import pytest
from shapely.geometry import Point, Polygon

import extrair_dados as ex


def test_esri_ponto_e_vazio():
    assert ex.esri_para_shapely(None) is None
    assert ex.esri_para_shapely({"x": None, "y": 1}) is None
    assert ex.esri_para_shapely({"x": float("nan"), "y": 1}) is None
    assert ex.esri_para_shapely({"rings": []}) is None
    p = ex.esri_para_shapely({"x": -49.25, "y": -16.68})
    assert isinstance(p, Point) and (p.x, p.y) == (-49.25, -16.68)


def test_esri_poligono_com_furo():
    externo = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]      # horário
    furo = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]              # anti-horário
    g = ex.esri_para_shapely({"rings": [externo, furo]})
    assert g.area == pytest.approx(100 - 4)
    assert not g.contains(Point(5, 5)) and g.contains(Point(1, 1))


def test_esri_orientacao_invertida_e_multiplas_partes():
    anti = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    assert ex.esri_para_shapely({"rings": [anti]}).area == pytest.approx(100)
    a = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]
    b = [[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]]
    g = ex.esri_para_shapely({"rings": [a, b]})
    assert g.geom_type == "MultiPolygon" and g.area == pytest.approx(2)


def test_projecao_local_ida_e_volta():
    para_m, para_g = ex.projecao_local(-49.26, -16.69)
    p = Point(-49.20, -16.60)
    m = para_m(p)
    assert m.y == pytest.approx(0.09 * 111_319.49, rel=1e-4)       # 0,09° de latitude
    assert m.x == pytest.approx(0.06 * 111_319.49 * 0.95788, rel=1e-3)
    v = para_g(m)
    assert (v.x, v.y) == pytest.approx((p.x, p.y), abs=1e-12)


def test_textos():
    assert ex.sem_acento("  Anhangüera  ") == "anhanguera"
    assert ex.titulo("BOSQUE DOS BURITIS") == "Bosque dos Buritis"
    assert ex.titulo("CAIS  JARDIM GUANABARA III") == "CAIS Jardim Guanabara III"
    assert ex.titulo("upa maria pires perillo") == "UPA Maria Pires Perillo"
    assert ex._https("http://x/y") == "https://x/y"


def test_arredondar():
    assert ex.arredondar([1.23456789, 2.0]) == [1.234568, 2.0]
    assert ex.arredondar([[1.11111111, 2.22222222]], 2) == [[1.11, 2.22]]


def test_base_lote_pequeno_fica_dentro_do_lote():
    lote = Polygon([(0, 0), (12, 0), (12, 40), (0, 40)])           # lote estreito 12 × 40 m
    base = ex._base_do_edificio(lote, Point(6, 20), 1, 0)
    assert lote.contains(base)
    assert 0.5 * lote.area < base.area < lote.area
    xmin, _, xmax, _ = base.bounds
    assert xmax - xmin > 8, "lote estreito não pode virar 'palito'"


def test_base_condominio_gera_torres_separadas():
    lote = Polygon([(0, 0), (120, 0), (120, 60), (0, 60)])         # 7.200 m², 3 torres no mesmo ponto
    ponto = Point(60, 30)
    torres = [ex._base_do_edificio(lote, ponto, 3, i) for i in range(3)]
    for t in torres:
        assert lote.buffer(0.01).contains(t) and 150 < t.area < 1000
    assert torres[0].intersection(torres[1]).area < 0.2 * torres[0].area
    assert torres[0].centroid.distance(torres[2].centroid) > 20


def test_base_sem_lote_e_lote_grande():
    assert ex._base_do_edificio(None, Point(0, 0), 1, 0).area == pytest.approx(22 * 22, rel=0.05)
    grande = Polygon([(0, 0), (200, 0), (200, 200), (0, 200)])
    torre = ex._base_do_edificio(grande, Point(50, 50), 1, 0)
    assert torre.area < 1000 and torre.contains(Point(50, 50))


def test_etapa_invalida_encerra_com_erro(tmp_path):
    with pytest.raises(SystemExit):
        ex.main(["--saida", str(tmp_path), "--etapas", "inexistente"])


def test_gravar_e_atomico(tmp_path):
    destino = tmp_path / "a" / "x.json"
    tamanho = ex.gravar(destino, {"á": 1})
    assert destino.read_text(encoding="utf-8") == '{"á":1}' and tamanho == 8
    assert not list(destino.parent.glob("*.tmp"))
