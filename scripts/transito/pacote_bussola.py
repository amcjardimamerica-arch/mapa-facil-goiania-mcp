"""Monta os dados de trânsito no formato compacto do módulo transito.js da Bússola.
Cada camada vira docs/dados/transito/<chave>.json = {"titulo","grupo","tipo","campos":[...],"itens":[[lon,lat,...]]}
(pontos) ou {"tipo":"linha", "itens":[{"c":[[lon,lat],...], "p":[...]}]}."""
import json, pickle
from pathlib import Path
D = Path("/home/claude/sin/out/dados"); OUT = Path("/home/claude/sin/bussola/docs/dados/transito"); OUT.mkdir(parents=True, exist_ok=True)
L = lambda n: json.load(open(D / f"{n}.json"))
r6 = lambda v: round(v, 6)
camadas = []
def ponto(chave, titulo, grupo, icone, cor, rows, campos, rot, dist=None, ligada=True, filtro=None):
    itens = [[r6(r["lon"]), r6(r["lat"])] + [("" if r.get(c) is None else r.get(c)) for c in campos] for r in rows if r.get("lon") and (filtro is None or filtro(r))]
    json.dump({"titulo": titulo, "grupo": grupo, "tipo": "ponto", "icone": icone, "cor": cor, "campos": campos, "rotulos": rot, "distancia_max": dist, "itens": itens},
              open(OUT / f"{chave}.json", "w"), ensure_ascii=False, separators=(",", ":"))
    camadas.append({"chave": chave, "titulo": titulo, "grupo": grupo, "icone": icone, "cor": cor, "tipo": "ponto", "quantidade": len(itens), "ligada": ligada})
def linha(chave, titulo, grupo, cor, largura, rows, campos, rot, ligada=False):
    itens = [{"c": [[r6(x), r6(y)] for x, y in r["coords"]], "p": [r.get(c, "") for c in campos]} for r in rows]
    json.dump({"titulo": titulo, "grupo": grupo, "tipo": "linha", "cor": cor, "largura": largura, "campos": campos, "rotulos": rot, "itens": itens},
              open(OUT / f"{chave}.json", "w"), ensure_ascii=False, separators=(",", ":"))
    camadas.append({"chave": chave, "titulo": titulo, "grupo": grupo, "cor": cor, "tipo": "linha", "quantidade": len(itens), "ligada": ligada})

fisc, fora, sem, trav, lomb, plac, dl, lic, noti, ln = (L(n) for n in ("fiscalizacao_set", "radares_fora_set", "semaforos", "travessias", "lombadas", "placas_rotatorias", "direita_livre", "licitacao_2023", "noticias", "linhas_osm"))
cruz, esc, sau, bus = (L(n) for n in ("estudo_cruzamentos", "estudo_escolas", "estudo_saude", "estudo_onibus"))
G1, G2, G3, G4 = "Sinalização semafórica", "Sinalização horizontal e dispositivos", "Fiscalização eletrônica", "Estudo e fontes"

ponto("semaforos", "Cruzamentos semaforizados", G1, "semaforo", "#00c853", sem, ["status", "confirmacao_set", "focos_osm", "bairro", "regiao", "fonte", "osm"],
      ["Situação", "Confirmação", "Grupos focais mapeados", "Bairro", "Região", "Fonte", "Referência"])
ponto("direita_livre", "Direita Livre e Esquerda Livre", G1, "seta", "#00e676", dl, ["cruzamento", "localizacao", "bairro", "fonte"], ["Cruzamento", "Localização", "Bairro", "Fonte"])
ponto("faixas", "Faixas de pedestres", G2, "faixa", "#ffffff", trav, ["classe", "tag_crossing", "marcacao", "bairro", "regiao", "fonte", "osm"],
      ["Classe", "Tipo (OSM)", "Marcação", "Bairro", "Região", "Fonte", "Referência"], dist=6000)
ponto("quebra_molas", "Quebra-molas e faixas elevadas", G2, "lombada", "#ffab00", lomb, ["tipo", "bairro", "regiao", "fonte", "ref"], ["Tipo", "Bairro", "Região", "Fonte", "Referência"],
      filtro=lambda r: "SET" not in r["fonte"] and "Ilha" not in r["tipo"])
ponto("pare", "PARE (parada obrigatória)", G2, "pare", "#d50000", plac, ["tipo", "bairro", "regiao", "fonte", "ref"], ["Tipo", "Bairro", "Região", "Fonte", "Referência"],
      dist=4000, ligada=False, filtro=lambda r: r["tipo"].startswith("Placa PARE"))
ponto("rotatorias", "Rotatórias e mini-rotatórias", G2, "rotatoria", "#64dd17", plac, ["tipo", "bairro", "regiao", "fonte", "ref"], ["Tipo", "Bairro", "Região", "Fonte", "Referência"],
      dist=8000, ligada=False, filtro=lambda r: "otatória" in r["tipo"])
linha("ciclovias", "Ciclovias e ciclofaixas", G2, "#00c853", 3, ln["ciclovias"], ["nome", "tipo", "osm"], ["Via", "Tipo", "Referência"])
linha("faixas_onibus", "Faixas e pistas exclusivas de ônibus", G2, "#2962ff", 4, ln["onibus"], ["nome", "tipo", "osm"], ["Via", "Tipo", "Referência"])
ponto("fiscalizacao", "Radares, lombadas eletrônicas e faixa exclusiva (SET)", G3, "radar", "#d50000", fisc,
      ["codigo", "tipo", "endereco", "sentido", "faixas", "numero_serie", "bairro", "regiao", "confirmacao", "pagina_set", "documentos"],
      ["Código SET", "Tipo", "Endereço", "Sentido", "Faixas", "Nº de série", "Bairro", "Região", "Conferência", "Página SET", "Documentos"])
ponto("licitacao_2023", "Locais previstos na licitação de 2023", G3, "radar", "#ff80ab", lic, ["tipo", "endereco", "situacao", "dist_set_m", "bairro", "fonte"],
      ["Tipo", "Endereço", "Situação", "Distância à SET (m)", "Bairro", "Fonte"], ligada=False, filtro=lambda r: r["tipo"] != "Videomonitoramento")
ponto("videomonitoramento", "Câmeras de videomonitoramento (licitação 2023)", G3, "camera", "#00b8d4", lic, ["endereco", "bairro", "fonte"], ["Endereço", "Bairro", "Fonte"],
      ligada=False, filtro=lambda r: r["tipo"] == "Videomonitoramento")
ponto("radares_fora_set", "Radares em outras fontes (fora da lista SET)", G3, "radar", "#9e9e9e", fora, ["origem", "detalhe", "dist_set_m", "bairro"],
      ["Origem", "Detalhe", "Distância à SET (m)", "Bairro"], ligada=False)
ponto("noticias", "Notícias oficiais da Prefeitura (cruzamentos citados)", G4, "noticia", "#ffd600", noti, ["categoria", "cruzamento", "acao", "data", "titulo", "link", "trecho", "bairro"],
      ["Assunto", "Cruzamento", "Ação", "Data", "Notícia", "Link", "Trecho", "Bairro"], ligada=False)
ponto("estudo_cruzamentos", "Estudo: cruzamentos estruturais sem semáforo mapeado", G4, "alerta", "#ff6d00", cruz,
      ["vias", "nivel", "pontuacao", "hier_1", "hier_2", "escolas_200m", "saude_300m", "bairro", "recomendacao"],
      ["Cruzamento", "Nível", "Pontuação", "Via principal", "Via secundária", "Escolas a 200 m", "Saúde a 300 m", "Bairro", "Recomendação"], ligada=False)
ponto("estudo_escolas", "Estudo: escolas sem faixa em via estrutural", G4, "escola", "#ff1744", esc,
      ["nome", "endereco", "situacao", "via_proxima", "hierarquia_via", "dist_faixa_m", "dist_semaforo_m", "bairro"],
      ["Escola", "Endereço", "Situação", "Via mais próxima", "Hierarquia", "Distância à faixa (m)", "Distância ao semáforo (m)", "Bairro"],
      ligada=False, filtro=lambda r: r["prioridade"] >= 2)
ponto("estudo_saude", "Estudo: saúde sem faixa em via estrutural", G4, "saude", "#ff1744", sau,
      ["nome", "situacao", "via_proxima", "hierarquia_via", "dist_faixa_m", "bairro"], ["Unidade", "Situação", "Via mais próxima", "Hierarquia", "Distância à faixa (m)", "Bairro"],
      ligada=False, filtro=lambda r: r["prioridade"] >= 2)
ponto("estudo_onibus", "Estudo: pontos de ônibus em arterial sem travessia", G4, "onibus", "#2979ff", bus, ["nome", "via", "hierarquia_via", "dist_faixa_m", "bairro"],
      ["Ponto", "Via", "Hierarquia", "Distância à faixa (m)", "Bairro"], ligada=False)
indice = {"versao": "1.0", "gerado_em": "2026-11-26", "escopo": "Sinalização sem placas verticais: semafórica, horizontal, dispositivos e fiscalização eletrônica",
          "camadas": camadas,
          "fontes": [
              {"nome": "SET – API de equipamentos de fiscalização eletrônica", "url": "https://www.goiania.go.gov.br/set/wp-json/set-goiania/v1/equipamentos"},
              {"nome": "Prefeitura – Termo de Referência da manutenção semafórica (721 cruzamentos)", "url": "https://www10.goiania.go.gov.br/DadosINTER/PUBLIC/PREG%C3%83OELETR%C3%94NICO-SEMAD/2023/arq_3294745.pdf"},
              {"nome": "Prefeitura – Termo de Referência da fiscalização eletrônica de 2023", "url": "https://www10.goiania.go.gov.br/DadosINTER/PUBLIC/PREG%C3%83OELETR%C3%94NICO-SEMAD/2023/arq_3496036.pdf"},
              {"nome": "Prefeitura – notícias oficiais de trânsito (2019–2026)", "url": "https://www.goiania.go.gov.br/agora/"},
              {"nome": "Mapa Fácil – rede viária, bairros, escolas, saúde e ônibus", "url": "https://portalmapa.goiania.go.gov.br/mapafacil/"},
              {"nome": "OpenStreetMap (ODbL) – semáforos, faixas, quebra-molas, PARE, rotatórias, ciclovias", "url": "https://www.openstreetmap.org/copyright"},
              {"nome": "Pardal – radares e lombadas de Goiás (ODbL)", "url": "https://github.com/murkiriel/pardal"},
              {"nome": "Jornal Opção – lista de Direita Livre divulgada pela SET", "url": "https://www.jornalopcao.com.br/ultimas-noticias/goiania-reforca-placas-de-direita-livre-em-84-cruzamentos-saiba-onde-e-permitido-virar-no-vermelho-869505/"}]}
json.dump(indice, open(OUT / "indice.json", "w"), ensure_ascii=False, indent=1)
tot = sum((OUT / f"{c['chave']}.json").stat().st_size for c in camadas)
print(len(camadas), "camadas", round(tot / 1e6, 2), "MB"); [print(" ", c["chave"], c["quantidade"]) for c in camadas]
