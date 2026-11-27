"""Gera o mapa compilado (KMZ e GeoJSON) e a planilha (XLSX) da sinalização de Goiânia."""
import json, zipfile, html, datetime
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

D = Path("/home/claude/sin/out/dados"); O = Path("/home/claude/sin/out"); HOJE = "26/11/2026"
L = lambda n: json.load(open(D / f"{n}.json"))
fisc, fora, sem, trav, lomb, plac = (L(n) for n in ("fiscalizacao_set", "radares_fora_set", "semaforos", "travessias", "lombadas", "placas_rotatorias"))
cruz, esc, sau, bus, painel, crono, res = (L(n) for n in ("estudo_cruzamentos", "estudo_escolas", "estudo_saude", "estudo_onibus", "estudo_bairros", "cronograma_set", "resumo"))
import pickle
segs = pickle.load(open(D / "segs.pkl", "rb"))["segs"]

FONTES = [
    ("SET – API pública de equipamentos de fiscalização eletrônica", "https://www.goiania.go.gov.br/set/wp-json/set-goiania/v1/equipamentos",
     "261 equipamentos (132 mistos, 70 fixos, 36 lombadas eletrônicas, 23 de faixa exclusiva), com coordenada, sentido, faixas, nº de série e 5 documentos cada", "Base oficial do mapa", "Publicação oficial (Resolução CONTRAN sobre medidores de velocidade)"),
    ("SET – página Equipamentos de Fiscalização e relação em PDF (Lotes 01 e 02, nov/2026)", "https://www.goiania.go.gov.br/set/equipamentos-fiscalizacao/",
     "260 dos 261 códigos da API conferidos no PDF; nenhum código só no PDF", "Conferência da base oficial", "Publicação oficial"),
    ("SET – relação em PDF de março/2026", "https://www.goiania.go.gov.br/set/equipamentos-fiscalizadores/",
     "157 códigos, todos presentes na API atual (a API acrescentou 104)", "Histórico da base oficial", "Publicação oficial"),
    ("SET – Cronograma de sinalização (2021–2022)", "https://www.goiania.go.gov.br/set/cronograma-de-sinalizacao/",
     "37 PDFs, 867 serviços de sinalização por local, bairro, região e turno (722 casados com bairro oficial)", "Histórico de atendimento por bairro", "Publicação oficial"),
    ("SET – Consulta de sinalização (WebSinalizacao / www10.goiania.go.gov.br/sinal)", "https://www.goiania.go.gov.br/sing_servicos/consulta-de-semaforo-e-fiscalizacao-eletronica/",
     "O sistema antigo de consulta de semáforos hoje redireciona para tela de login", "Não utilizado (exige login – nenhuma proteção foi contornada)", "—"),
    ("SET – Boletins de acidentes de trânsito com vítimas fatais (2015–2021)", "https://www.goiania.go.gov.br/set/boletim-acidentes-de-transito-com-vitimas-fatais/",
     "Relatórios agregados, sem coordenadas", "Consulta de contexto para o estudo", "Publicação oficial"),
    ("Mapa Fácil (Prefeitura) – Rede Viária, Logradouro Principal", "https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer/Mapa_RedeViaria/MapServer/3",
     "69.288 trechos com hierarquia (in_hie), ônibus, corredor e pavimentação; 27.636 cruzamentos derivados", "Rede viária oficial do estudo", "Dado público municipal"),
    ("Mapa Fácil – Divisas de Bairro e Regiões", "https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer/Feature_Base/MapServer/2",
     "1.209 bairros/glebas e 12 regiões", "Localização de cada ponto", "Dado público municipal"),
    ("Mapa Fácil – Pontos Notáveis (educação e saúde municipais) e Acessibilidade (escolas SIEG/SIGGO, hospitais CAE, pontos e terminais de ônibus CMTC)",
     "https://portalmapa.goiania.go.gov.br/servicogyn/rest/services/MapaServer/Mapa_Acessibilidade/MapServer",
     "Equipamentos de educação, saúde e transporte; a consulta comum devolve geometria vazia nessas camadas, por isso foi usada a operação identify por quadrículas", "Polos geradores de travessia", "Dado público municipal"),
    ("OpenStreetMap (Overpass API – espelho maps.mail.ru)", "https://www.openstreetmap.org/copyright",
     "≈8 mil feições em Goiânia: semáforos, travessias, lombadas, radares, PARE, rotatórias", "Camadas complementares (semáforos, faixas, lombadas, placas)", "ODbL 1.0 – © colaboradores do OpenStreetMap"),
    ("Pardal – radares e lombadas do Brasil (estados/GO)", "https://github.com/murkiriel/pardal",
     "Radares de DER-GO/Goinfra, DNIT, ANTT, Inmetro e OSM; lombadas e pontos de atenção no território de Goiânia", "Conferência dos radares e radares fora da SET", "ODbL (base) – fontes oficiais listadas no repositório"),
    ("Portal de Dados Abertos de Goiânia", "https://dadosabertos.goiania.go.gov.br",
     "29 conjuntos; os viários (logradouros, corredores, educação) são de 2018 e repetem o Mapa Fácil; nenhum de sinalização", "Conferido; não usado como base por estar desatualizado", "CC-BY"),
    ("Prefeitura – Pregão de manutenção semafórica (Termo de Referência 2022 e 2023)", "https://www10.goiania.go.gov.br/DadosINTER/PUBLIC/PREG%C3%83OELETR%C3%94NICO-SEMAD/2023/arq_3294745.pdf",
     "Número oficial: 721 cruzamentos semaforizados e 652 controladores centralizados; sem a lista dos cruzamentos", "Referência de completude dos semáforos", "Publicação oficial"),
    ("Prefeitura – Pregão de fiscalização eletrônica e videomonitoramento (Termo de Referência 2023)", "https://www10.goiania.go.gov.br/DadosINTER/PUBLIC/PREG%C3%83OELETR%C3%94NICO-SEMAD/2023/arq_3496036.pdf",
     "330 locais com coordenadas: 142 mistos, 108 fixos, 36 lombadas eletrônicas, 24 de faixa exclusiva e 20 de videomonitoramento", "Locais previstos x lista atual da SET; câmeras", "Publicação oficial"),
    ("Jornal Opção – Direita Livre em 84 cruzamentos (lista divulgada pela SET)", "https://www.jornalopcao.com.br/ultimas-noticias/goiania-reforca-placas-de-direita-livre-em-84-cruzamentos-saiba-onde-e-permitido-virar-no-vermelho-869505/",
     "82 cruzamentos nominados (a Prefeitura cita 110); 60 localizados na rede viária oficial pelo nome das vias, mais a Esquerda Livre da T-3 x T-10", "Camada Direita Livre", "Notícia que reproduz informação oficial"),
    ("OpenStreetMap – vias (sentido, velocidade, ciclovias, ônibus) e proibições de conversão", "https://www.openstreetmap.org/copyright",
     "13.355 trechos de mão única, 5.034 com limite de velocidade, 417 cicloviários, 327 de ônibus, 2.129 restrições de conversão", "Camadas 8 a 11", "ODbL 1.0"),
    ("IBGE – Censo 2022, Características urbanísticas do entorno (agregados por setor)", "https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/Agregados_por_Setores_Censitarios_Caracteristicas_urbanisticas_do_entorno_dos_domicilios/",
     "79.668 faces de quadra de Goiânia em 2.276 setores: via sinalizada para bicicleta, rampa, calçada, obstáculo, ponto de ônibus", "Camada 12 – levantamento oficial completo, agregado por setor", "Dado público federal"),
    ("IBGE – Malha de setores censitários 2022 (GO)", "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/setores/gpkg/UF/GO/",
     "Polígonos dos setores de Goiânia", "Geometria da camada 12", "Dado público federal"),
    ("Mapa 360° Goiânia (portal-goiania.geo360.com.br)", "https://portal-goiania.geo360.com.br/",
     "Plataforma da Prefeitura que exige cadastro; a Prefeitura diz usá-la no planejamento de semáforos", "Não acessado (exige cadastro do cidadão)", "—"),
    ("Mapillary – detecções de placas e objetos em imagens de rua", "https://www.mapillary.com/developer",
     "Detecção automática de placas, semáforos e faixas a partir de fotos; a API exige chave gratuita", "Não acessado (exige chave)", "CC-BY-SA"),
    ("PRF – Dados abertos de acidentes", "https://www.gov.br/prf/pt-br/acesso-a-informacao/dados-abertos/dados-abertos-da-prf",
     "Site não acessível deste ambiente de coleta", "Não utilizado", "—"),
]

# ------------------------------------------------------------------ KMZ
def kcor(hexrgb, a="ff"): h = hexrgb.lstrip("#"); return a + h[4:6] + h[2:4] + h[0:2]
ICO = "http://maps.google.com/mapfiles/kml/shapes/"
ESTILOS = {
    "misto": ("#d50000", "camera.png", 1.0), "fixo": ("#ff6d00", "camera.png", 0.9), "lombele": ("#aa00ff", "camera.png", 0.9),
    "faixaex": ("#2962ff", "camera.png", 0.9), "fora": ("#9e9e9e", "camera.png", 0.8),
    "sem_conf": ("#00c853", "target.png", 0.9), "sem_osm": ("#ffd600", "target.png", 0.8), "sem_set": ("#ff1744", "target.png", 0.9),
    "fx_sem": ("#00e5ff", "man.png", 0.7), "fx_pint": ("#ffffff", "man.png", 0.7), "fx_sem_faixa": ("#ff9100", "man.png", 0.7), "fx_ni": ("#bdbdbd", "man.png", 0.6),
    "lomb": ("#ffab00", "triangle.png", 0.7), "ilha": ("#8d6e63", "triangle.png", 0.6),
    "pare": ("#d50000", "forbidden.png", 0.6), "rot": ("#64dd17", "arrow-reverse.png", 0.7), "outro": ("#90a4ae", "caution.png", 0.6),
    "cA": ("#ff0000", "star.png", 1.1), "cB": ("#ff6d00", "star.png", 1.0), "cC": ("#ffd600", "star.png", 0.9), "cR": ("#7e57c2", "star.png", 0.9),
    "esc3": ("#ff1744", "schools.png", 1.0), "esc2": ("#ff9100", "schools.png", 0.9), "esc1": ("#ffd600", "schools.png", 0.8), "esc0": ("#00c853", "schools.png", 0.7),
    "sau": ("#ff1744", "hospitals.png", 0.9), "sau0": ("#00c853", "hospitals.png", 0.7), "bus": ("#2979ff", "bus.png", 0.8),
    "dl": ("#00e676", "arrow.png", 0.9), "dl0": ("#9e9e9e", "arrow.png", 0.7), "lic": ("#ff80ab", "camera.png", 0.8), "vid": ("#00b8d4", "camera.png", 1.0),
    "rest": ("#ff5252", "forbidden.png", 0.5), "cam": ("#00b8d4", "camera.png", 0.7),
}
def estilos_kml():
    s = []
    for k, (c, ic, sc) in ESTILOS.items():
        s.append(f'<Style id="{k}"><IconStyle><color>{kcor(c)}</color><scale>{sc}</scale><Icon><href>{ICO}{ic}</href></Icon></IconStyle>'
                 f'<LabelStyle><scale>0</scale></LabelStyle></Style>')
    for k, (c, w) in {"v5": ("#d50000", 4), "v4": ("#ff6d00", 3.5), "v3": ("#ffd600", 2.5), "ow": ("#7c4dff", 2), "s20": ("#2e7d32", 3), "s40": ("#9ccc65", 3),
                      "s50": ("#fdd835", 3), "s60": ("#fb8c00", 3), "s80": ("#e53935", 3.5), "cic": ("#00c853", 3.5), "cif": ("#76ff03", 3), "cic2": ("#b2ff59", 2),
                      "bus": ("#2962ff", 4), "corA": ("#304ffe", 3), "corP": ("#8c9eff", 2.5)}.items():
        s.append(f'<Style id="{k}"><LineStyle><color>{kcor(c, "cc")}</color><width>{w}</width></LineStyle></Style>')
    for k, c in {"ib0": "#d73027", "ib1": "#fc8d59", "ib2": "#fee08b", "ib3": "#91cf60", "ib4": "#1a9850"}.items():
        s.append(f'<Style id="{k}"><LineStyle><color>{kcor("#ffffff", "66")}</color><width>0.5</width></LineStyle><PolyStyle><color>{kcor(c, "80")}</color></PolyStyle></Style>')
    return "".join(s)
def desc(campos):
    linhas = []
    for k, v in campos:
        if v in (None, "", 0) and k not in ("Faixas",): continue
        v = str(v)
        if v.startswith("http"): v = " ".join(f'<a href="{html.escape(u)}">{html.escape(u.split("/")[-1] or u)}</a>' for u in v.split())
        elif " | " in v and "http" in v:
            v = "<br>".join(f'<a href="{html.escape(p.split(": ",1)[1])}">{html.escape(p.split(": ",1)[0])}</a>' if ": http" in p else html.escape(p) for p in v.split(" | "))
        else: v = html.escape(v)
        linhas.append(f"<tr><td><b>{html.escape(k)}</b></td><td>{v}</td></tr>")
    return "<![CDATA[<table border='0' cellpadding='2' style='font-family:Arial;font-size:12px'>" + "".join(linhas) + "</table>]]>"
def pm(nome, estilo, lon, lat, campos):
    return (f"<Placemark><name>{html.escape(str(nome))}</name><styleUrl>#{estilo}</styleUrl><description>{desc(campos)}</description>"
            f"<Point><coordinates>{lon:.6f},{lat:.6f},0</coordinates></Point></Placemark>")
def pasta(nome, itens, aberta=0, visivel=1): return f"<Folder><name>{html.escape(nome)} ({len(itens)})</name><open>{aberta}</open><visibility>{visivel}</visibility>{''.join(itens)}</Folder>"
def grupo(nome, conteudo, aberta=0): return f"<Folder><name>{html.escape(nome)}</name><open>{aberta}</open>{conteudo}</Folder>"

F = []
por = {}
for f in fisc:
    est = {"Misto": "misto", "Fixo": "fixo", "Lombada": "lombele", "Faixa Exclusiva": "faixaex"}[f["tipo_set"]]
    por.setdefault(f["tipo"], []).append(pm(f["codigo"], est, f["lon"], f["lat"], [
        ("Código SET", f["codigo"]), ("Tipo", f["tipo"]), ("Endereço", f["endereco"]), ("Sentido", f["sentido"]), ("Faixas", f["faixas"]),
        ("Nº de série", f["numero_serie"]), ("Bairro", f["bairro"]), ("Região", f["regiao"]), ("Conferência em outras fontes", f["confirmacao"]),
        ("Página SET", f["pagina_set"]), ("Documentos", f["documentos"]), ("Fonte", f["fonte"])]))
cam1 = "".join(pasta(k, v) for k, v in sorted(por.items(), key=lambda x: -len(x[1])))
cam1 += pasta("Radares em outras fontes, ausentes da lista da SET (verificar)", [pm("Radar fora da SET", "fora", r["lon"], r["lat"], [
    ("Origem", r["origem"]), ("Detalhe", r["detalhe"]), ("Distância ao equipamento SET mais próximo (m)", r["dist_set_m"]), ("Bairro", r["bairro"]), ("Região", r["regiao"])]) for r in fora], visivel=0)
F.append(grupo("1. Fiscalização eletrônica – base oficial SET", cam1, 1))

ss = {}
for s in sem:
    est = "sem_conf" if ("Confirmado" in s["status"] or "confirmado" in s["status"]) else "sem_set" if s["status"].startswith("Indicado") else "sem_osm"
    ss.setdefault(s["status"], []).append(pm("Cruzamento semaforizado", est, s["lon"], s["lat"], [
        ("Situação", s["status"]), ("Radar misto SET no cruzamento", s["confirmacao_set"]), ("Grupos focais mapeados (OSM)", s["focos_osm"]),
        ("Bairro", s["bairro"]), ("Região", s["regiao"]), ("Fonte", s["fonte"]), ("OSM", s["osm"])]))
F.append(grupo("2. Semáforos (cruzamentos semaforizados)", "".join(pasta(k, v) for k, v in ss.items())))

tt = {}
EST_T = {"Faixa com semáforo": "fx_sem", "Faixa de pedestres pintada": "fx_pint", "Travessia sem faixa pintada": "fx_sem_faixa", "Travessia (tipo não informado)": "fx_ni"}
for t in trav:
    tt.setdefault(t["classe"], []).append(pm(t["classe"], EST_T[t["classe"]], t["lon"], t["lat"], [
        ("Classe", t["classe"]), ("crossing (OSM)", t["tag_crossing"]), ("Marcação", t["marcacao"]), ("Bairro", t["bairro"]), ("Região", t["regiao"]), ("Fonte", t["fonte"]), ("OSM", t["osm"])]))
F.append(grupo("3. Faixas de pedestres e travessias", "".join(pasta(k, tt[k]) for k in EST_T if k in tt)))

ll = {}
for l in lomb:
    ll.setdefault(l["tipo"], []).append(pm(l["tipo"], "ilha" if "Ilha" in l["tipo"] else "lomb" if "SET" not in l["fonte"] else "lombele", l["lon"], l["lat"], [
        ("Tipo", l["tipo"]), ("Bairro", l["bairro"]), ("Região", l["regiao"]), ("Fonte", l["fonte"]), ("Referência", l["ref"])]))
F.append(grupo("4. Lombadas e redutores de velocidade", "".join(pasta(k, v) for k, v in sorted(ll.items(), key=lambda x: -len(x[1])))))

pp = {}
plac = [p for p in plac if p["tipo"] in ("Placa PARE (R-1)", "Rotatória", "Mini-rotatória")]
for p in plac:
    if p["tipo"] == "Placa PARE (R-1)": p["tipo"] = "PARE (parada obrigatória)"
for p in plac:
    est = "pare" if "PARE" in p["tipo"] else "rot" if "otatória" in p["tipo"] else "outro"
    pp.setdefault(p["tipo"], []).append(pm(p["tipo"], est, p["lon"], p["lat"], [("Tipo", p["tipo"]), ("Bairro", p["bairro"]), ("Região", p["regiao"]), ("Fonte", p["fonte"]), ("Referência", p["ref"])]))
F.append(grupo("5. PARE, rotatórias e mini-rotatórias", "".join(pasta(k, v, visivel=0 if "PARE" in k else 1) for k, v in sorted(pp.items(), key=lambda x: -len(x[1])))))

# Estudo
NIV = {"A": "Nível A – arterial de 1ª categoria x arterial", "B": "Nível B – arterial x arterial", "C": "Nível C – arterial x coletora", "R": "Interseções com rodovia/anel/acesso (verificar se em nível)"}
cc = {}
for c in cruz:
    cc.setdefault(c["nivel"], []).append(pm(c["vias"], "c" + c["nivel"], c["lon"], c["lat"], [
        ("Cruzamento", c["vias"]), ("Nível", NIV[c["nivel"]]), ("Pontuação de prioridade", c["pontuacao"]), ("Hierarquia da via principal", c["hier_1"]),
        ("Hierarquia da via secundária", c["hier_2"]), ("Linha de ônibus", "sim" if c["bus"] else ""), ("Corredor", c["corredor"]),
        ("Escolas a 200 m", c["escolas_200m"]), ("Saúde a 300 m", c["saude_300m"]), ("Faixas a 50 m", c["faixas_50m"]), ("Lombadas a 80 m", c["lombadas_80m"]),
        ("Radares SET a 150 m", c["radares_150m"]), ("Bairro", c["bairro"]), ("Recomendação", c["recomendacao"])]))
est = "".join(pasta(NIV[k], cc[k], visivel=1 if k in "AB" else 0) for k in "ABCR" if k in cc)
ee = {}
for e in esc:
    ee.setdefault(e["situacao"], []).append(pm(e["nome"] or "Escola", f'esc{e["prioridade"]}', e["lon"], e["lat"], [
        ("Escola", e["nome"]), ("Endereço", e["endereco"]), ("Situação", e["situacao"]), ("Via mais próxima", e["via_proxima"]), ("Hierarquia", e["hierarquia_via"]),
        ("Via com ônibus", e["via_com_onibus"]), ("Distância à faixa pintada/semaforizada (m)", e["dist_faixa_m"]), ("Distância ao semáforo (m)", e["dist_semaforo_m"]),
        ("Distância à lombada (m)", e["dist_lombada_m"]), ("Bairro", e["bairro"]), ("Origem do dado", e["origem"])]))
est += grupo("Escolas x travessias", "".join(pasta(k, v, visivel=1 if k.startswith("SEM") else 0) for k, v in sorted(ee.items())))
sa = {}
for e in sau:
    sa.setdefault(e["situacao"], []).append(pm(e["nome"] or "Unidade de saúde", "sau0" if e["prioridade"] == 0 else "sau", e["lon"], e["lat"], [
        ("Unidade", e["nome"]), ("Situação", e["situacao"]), ("Via mais próxima", e["via_proxima"]), ("Hierarquia", e["hierarquia_via"]),
        ("Distância à faixa (m)", e["dist_faixa_m"]), ("Distância ao semáforo (m)", e["dist_semaforo_m"]), ("Bairro", e["bairro"]), ("Origem do dado", e["origem"])]))
est += grupo("Saúde x travessias", "".join(pasta(k, v, visivel=0) for k, v in sorted(sa.items())))
est += pasta("Pontos de ônibus em vias arteriais sem travessia sinalizada a 120 m", [pm(b["nome"], "bus", b["lon"], b["lat"], [
    ("Ponto", b["nome"]), ("Via", b["via"]), ("Hierarquia", b["hierarquia_via"]), ("Distância à faixa (m)", b["dist_faixa_m"]),
    ("Distância ao semáforo (m)", b["dist_semaforo_m"]), ("Bairro", b["bairro"])]) for b in bus], visivel=0)
F.append(grupo("6. Estudo – lacunas de sinalização (verificar em campo)", est, 1))

vv = {5: [], 4: [], 3: []}
for s in segs:
    if s["rk"] >= 3:
        coords = " ".join(f"{x:.6f},{y:.6f},0" for x, y in s["path"])
        vv[s["rk"]].append(f'<Placemark><name>{html.escape(s["nm"])}</name><styleUrl>#v{s["rk"]}</styleUrl><LineString><tessellate>1</tessellate><coordinates>{coords}</coordinates></LineString></Placemark>')
NRK = {5: "Expressas, rodovias e anéis", 4: "Arteriais de 1ª categoria", 3: "Arteriais de 2ª categoria"}
F.append(grupo("7. Hierarquia viária oficial (Mapa Fácil)", "".join(pasta(NRK[k], vv[k], visivel=0) for k in (5, 4, 3))))
# ------------------------------------------------------------------ 2ª rodada: categorias que faltavam
lic, dl, ln, rs, ib, res2 = (L(n) for n in ("licitacao_2023", "direita_livre", "linhas_osm", "restricoes", "ibge_setores", "resumo2"))
def linha(nome, est, coords, campos):
    c = " ".join(f"{x:.6f},{y:.6f},0" for x, y in coords)
    return f'<Placemark><name>{html.escape(str(nome))}</name><styleUrl>#{est}</styleUrl><description>{desc(campos)}</description><LineString><tessellate>1</tessellate><coordinates>{c}</coordinates></LineString></Placemark>'
g8 = {}
for d in dl:
    if d["lon"]:
        g8.setdefault("Localizados", []).append(pm(d["cruzamento"], "dl", d["lon"], d["lat"], [("Cruzamento", d["cruzamento"]), ("Localização", d["localizacao"]),
            ("Bairro", d["bairro"]), ("Fonte", d["fonte"])]))
F.append(grupo("8. Direita Livre e Esquerda Livre", "".join(pasta(k, v) for k, v in g8.items())))
g9 = {}
for l in lic:
    est = "vid" if l["tipo"] == "Videomonitoramento" else "lic"
    g9.setdefault(l["situacao"], []).append(pm(l["tipo"], est, l["lon"], l["lat"], [("Tipo", l["tipo"]), ("Endereço", l["endereco"]), ("Situação", l["situacao"]),
        ("Distância ao equipamento SET mais próximo (m)", l["dist_set_m"]), ("Bairro", l["bairro"]), ("Fonte", l["fonte"])]))
for c in rs["cameras_osm"]:
    g9.setdefault("Câmeras mapeadas no OpenStreetMap", []).append(pm("Câmera", "cam", c["lon"], c["lat"], [("Fonte", "OpenStreetMap"), ("OSM", c["osm"])]))
F.append(grupo("9. Licitação de 2023 (locais previstos) e videomonitoramento", "".join(pasta(k, v, visivel=0 if k.startswith("Na lista") else 1) for k, v in g9.items())))
def vel_est(v):
    try: n = int(str(v).split()[0])
    except Exception: return "s50"
    return "s20" if n <= 30 else "s40" if n <= 40 else "s50" if n <= 50 else "s60" if n <= 60 else "s80"
gv = {}
for l in ln["velocidade"]:
    gv.setdefault(f'{l["maxspeed"]} km/h', []).append(linha(f'{l["nome"]} – {l["maxspeed"]} km/h', vel_est(l["maxspeed"]), l["coords"], [("Via", l["nome"]), ("Limite", l["maxspeed"]), ("OSM", l["osm"])]))
gc = {}
for l in ln["ciclovias"]:
    gc.setdefault(l["tipo"], []).append(linha(l["nome"] or l["tipo"], {"Ciclovia segregada": "cic", "Ciclofaixa": "cif"}.get(l["tipo"], "cic2"), l["coords"], [("Tipo", l["tipo"]), ("Via", l["nome"]), ("OSM", l["osm"])]))
gb = {}
for c in ln["corredores_mf"]:
    gb.setdefault(c["corredor"], []).append(linha(c["nome"], "corA" if "exclusivo" in c["corredor"] else "corP", c["coords"], [("Via", c["nome"]), ("Corredor (cadastro do Mapa Fácil, pode estar desatualizado)", c["corredor"])]))
F.append(grupo("10. Ciclovias, ciclofaixas, faixas e corredores de ônibus",
    grupo("Ciclovias e ciclofaixas (OSM)", "".join(pasta(k, v) for k, v in gc.items()))
    + pasta("Faixas e pistas exclusivas de ônibus (OSM)", [linha(l["nome"], "bus", l["coords"], [("Via", l["nome"]), ("OSM", l["osm"])]) for l in ln["onibus"]])
    + grupo("Corredores de transporte coletivo (Mapa Fácil)", "".join(pasta(k, v, visivel=0) for k, v in sorted(gb.items())))))
noti = L("noticias")
gn = {}
for n in noti:
    if n["lon"]:
        gn.setdefault(n["categoria"], []).append(pm(n["cruzamento"], {"Semáforo": "sem_set", "Direita/Esquerda Livre": "dl", "Rotatória": "rot", "Ciclofaixa / ciclovia": "dl0",
            "Quebra-mola / lombada": "lomb", "Faixa elevada": "lomb", "Faixa de pedestres": "fx_pint"}.get(n["categoria"], "outro"), n["lon"], n["lat"], [
            ("Cruzamento", n["cruzamento"]), ("Assunto", n["categoria"]), ("Ação na notícia", n["acao"]), ("Data", n["data"]), ("Notícia", n["titulo"]),
            ("Trecho", n["trecho"]), ("Link", n["link"]), ("Bairro", n["bairro"])]))
F.append(grupo("11. Notícias oficiais da Prefeitura – cruzamentos citados (2019–2026)", "".join(pasta(k, v, visivel=0) for k, v in sorted(gn.items(), key=lambda x: -len(x[1])))))
def poly(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    out = []
    for pg in polys:
        rings = "".join(("<outerBoundaryIs>" if i == 0 else "<innerBoundaryIs>") + "<LinearRing><coordinates>" + " ".join(f"{x:.6f},{y:.6f},0" for x, y in r) + "</coordinates></LinearRing>" + ("</outerBoundaryIs>" if i == 0 else "</innerBoundaryIs>") for i, r in enumerate(pg))
        out.append(f"<Polygon>{rings}</Polygon>")
    return "<MultiGeometry>" + "".join(out) + "</MultiGeometry>"
def classe(v): return "ib0" if v < 5 else "ib1" if v < 20 else "ib2" if v < 40 else "ib3" if v < 70 else "ib4"
gi = {}
for t in ib:
    k = ["Menos de 5%", "5% a 20%", "20% a 40%", "40% a 70%", "70% ou mais"][int(classe(t["pct_rampa"])[-1])]
    gi.setdefault(k, []).append(f'<Placemark><name>Setor {t["setor"]}</name><styleUrl>#{classe(t["pct_rampa"])}</styleUrl><description>{desc([("Setor censitário", t["setor"]), ("Bairro (IBGE)", t["bairro_ibge"]), ("Faces de quadra", t["faces"]), ("Com rampa para cadeirante (%)", t["pct_rampa"]), ("Via sinalizada para bicicleta (%)", t["pct_bicicleta"]), ("Com calçada (%)", t["pct_calcada"]), ("Calçada com obstáculo (%)", t["pct_obstaculo"]), ("Com ponto de ônibus (%)", t["pct_onibus"]), ("Fonte", "IBGE – Censo 2022, entorno dos domicílios")])}</description>{poly(t["geometry"])}</Placemark>')
F.append(grupo("12. IBGE Censo 2022 – via sinalizada para bicicleta e rampas por setor", "".join(pasta("Rampa para cadeirante: " + k, gi[k], visivel=0) for k in ["Menos de 5%", "5% a 20%", "20% a 40%", "40% a 70%", "70% ou mais"] if k in gi)))


fontes_txt = "<br>".join(f"• <b>{html.escape(n)}</b> – {html.escape(u)}" for n, u, *_ in FONTES)
kml = ('<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
       '<name>Sinalização de Trânsito de Goiânia – mapa compilado</name><open>1</open>'
       f'<description><![CDATA[Compilação de {HOJE}. Base oficial: equipamentos de fiscalização eletrônica da SET. '
       'Cruzamentos: OpenStreetMap, Pardal e Mapa Fácil. As camadas do estudo indicam pontos a verificar em campo, não ausência comprovada de sinalização.<br><br>'
       f'<b>Fontes (meio de pesquisa)</b><br>{fontes_txt}]]></description>'
       f'<LookAt><longitude>-49.2648</longitude><latitude>-16.6869</latitude><range>32000</range><tilt>0</tilt></LookAt>{estilos_kml()}{"".join(F)}</Document></kml>')
with zipfile.ZipFile(O / "sinalizacao-goiania.kmz", "w", zipfile.ZIP_DEFLATED) as z: z.writestr("doc.kml", kml)

# ------------------------------------------------------------------ GeoJSON único (para a Bússola)
feats = []
def add(camada, rows, chaves):
    for r in rows:
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(r["lon"], 6), round(r["lat"], 6)]},
                      "properties": {"camada": camada, **{k: r.get(k) for k in chaves}}})
add("fiscalizacao_set", fisc, ["codigo", "tipo", "endereco", "sentido", "faixas", "numero_serie", "bairro", "regiao", "confirmacao", "pagina_set", "documentos"])
add("radar_fora_set", fora, ["origem", "detalhe", "dist_set_m", "bairro", "regiao"])
add("semaforo", sem, ["status", "confirmacao_set", "focos_osm", "fonte", "bairro", "regiao", "osm"])
add("travessia", trav, ["classe", "tag_crossing", "marcacao", "fonte", "bairro", "regiao", "osm"])
add("lombada", lomb, ["tipo", "fonte", "ref", "bairro", "regiao"])
add("placa_rotatoria", plac, ["tipo", "fonte", "ref", "bairro", "regiao"])
add("estudo_cruzamento", cruz, ["vias", "nivel", "pontuacao", "hier_1", "hier_2", "bus", "corredor", "escolas_200m", "saude_300m", "bairro", "recomendacao"])
add("estudo_escola", esc, ["nome", "endereco", "situacao", "prioridade", "via_proxima", "hierarquia_via", "dist_faixa_m", "dist_semaforo_m", "bairro"])
add("estudo_saude", sau, ["nome", "situacao", "prioridade", "via_proxima", "hierarquia_via", "dist_faixa_m", "bairro"])
add("estudo_onibus", bus, ["nome", "via", "hierarquia_via", "dist_faixa_m", "dist_semaforo_m", "bairro"])
add("direita_livre", [d for d in dl if d["lon"]], ["cruzamento", "localizacao", "bairro", "fonte"])
add("licitacao_2023", lic, ["tipo", "endereco", "situacao", "dist_set_m", "bairro", "fonte"])
add("noticia_oficial", [n for n in noti if n["lon"]], ["cruzamento", "categoria", "acao", "data", "titulo", "link", "bairro"])
for camada, rows, chaves in (("ciclovia", ln["ciclovias"], ["nome", "tipo", "osm"]), ("faixa_onibus", ln["onibus"], ["nome", "osm"]), ("corredor_mf", ln["corredores_mf"], ["nome", "corredor"])):
    for r in rows: feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[round(x, 6), round(y, 6)] for x, y in r["coords"]]}, "properties": {"camada": camada, **{k: r.get(k) for k in chaves}}})
for t in ib: feats.append({"type": "Feature", "geometry": t["geometry"], "properties": {"camada": "ibge_setor_entorno", **{k: v for k, v in t.items() if k != "geometry"}}})
json.dump({"type": "FeatureCollection", "name": "sinalizacao_goiania", "fontes": [{"nome": n, "url": u} for n, u, *_ in FONTES], "features": feats},
          open(O / "sinalizacao-goiania.geojson", "w"), ensure_ascii=False)

# ------------------------------------------------------------------ XLSX
wb = Workbook(); CAB = PatternFill("solid", fgColor="1F3864"); BR = Font(color="FFFFFF", bold=True)
def aba(nome, cab, linhas, larg=None):
    ws = wb.create_sheet(nome); ws.append(cab)
    for c in ws[1]: c.fill = CAB; c.font = BR; c.alignment = Alignment(wrap_text=True, vertical="center")
    for l in linhas: ws.append(["" if v is None else v for v in l])
    ws.freeze_panes = "A2"; ws.auto_filter.ref = ws.dimensions
    for i, h in enumerate(cab, 1):
        w = (larg or {}).get(h) or min(60, max(10, len(h) + 2, *(len(str(l[i - 1])) * 0.9 for l in linhas[:300]) if linhas else [10]))
        ws.column_dimensions[get_column_letter(i)].width = w
    for col in range(1, len(cab) + 1):
        if cab[col - 1] in ("Página SET", "OSM", "URL", "Mapa"):
            for row in range(2, ws.max_row + 1):
                c = ws.cell(row, col)
                if str(c.value).startswith("http"): c.hyperlink = str(c.value).split()[0]; c.font = Font(color="0563C1", underline="single")
    return ws
ws = wb.active; ws.title = "Resumo"
ws.append(["Sinalização de Trânsito de Goiânia – compilação de " + HOJE]); ws["A1"].font = Font(bold=True, size=14)
linhas = [("Equipamentos de fiscalização eletrônica (SET, oficial)", res["fiscalizacao_set"]), ("   – mistos (radar + avanço de sinal)", res["fisc_por_tipo"]["Misto"]),
          ("   – fixos", res["fisc_por_tipo"]["Fixo"]), ("   – lombadas eletrônicas", res["fisc_por_tipo"]["Lombada"]), ("   – faixa exclusiva", res["fisc_por_tipo"]["Faixa Exclusiva"]),
          ("Equipamentos SET conferidos em outra fonte", res["fisc_confirmados"]), ("Radares em outras fontes, fora da lista SET", res["radares_fora_set"]),
          ("Cruzamentos semaforizados", res["semaforos"]), *[("   – " + k, v) for k, v in res["sem_status"].items()],
          ("Travessias de pedestres", res["travessias"]), *[("   – " + k, v) for k, v in res["trav_classe"].items()],
          ("Lombadas e redutores", sum(res["lombadas"].values())), ("Placas PARE", res["placas"].get("Placa PARE (R-1)", 0)),
          ("Rotatórias e mini-rotatórias", res["placas"].get("Rotatória", 0) + res["placas"].get("Mini-rotatória", 0)),
          ("Rede viária oficial (km)", res["km_vias"]), ("Cruzamentos entre logradouros distintos", res["cruzamentos_total"]),
          ("Cruzamentos arterial x coletora/arterial", res["cruzamentos_estruturais"]), ("Cruzamentos estruturais sem semáforo nem rotatória mapeados", res["candidatos"]),
          *[("   – nível " + k, v) for k, v in sorted(res["cand_nivel"].items())],
          ("Escolas analisadas", res["escolas"]), *[("   – " + k, v) for k, v in res["esc_sit"].items()],
          ("Unidades de saúde analisadas", res["saude"]), *[("   – " + k, v) for k, v in res["sau_sit"].items()],
          ("Pontos de ônibus", res["onibus_total"]), ("Pontos de ônibus em arterial sem travessia sinalizada a 120 m", res["onibus_estrut_sem_travessia"]),
          ("Serviços no cronograma de sinalização da SET (2021–2022)", res["cronograma"]), ("Bairros com provável lacuna de mapeamento", res["bairros_lacuna"])]
for a, b in linhas: ws.append([a, b])
ws.append([]); ws.append(["Leitura: a ausência de um item no mapa não prova a ausência na rua. A base oficial é só a da fiscalização eletrônica; as demais camadas vêm de mapeamento colaborativo e devem ser conferidas em campo."])
ws.column_dimensions["A"].width = 70; ws.column_dimensions["B"].width = 14
aba("Fontes", ["Fonte", "URL", "O que foi obtido", "Uso no mapa", "Licença / natureza"], [list(f) for f in FONTES], {"Fonte": 50, "URL": 60, "O que foi obtido": 70, "Uso no mapa": 35, "Licença / natureza": 30})
aba("Fiscalização SET", ["Código", "Tipo", "Endereço", "Sentido", "Faixas", "Nº de série", "Bairro", "Região", "Latitude", "Longitude", "Conferência", "Página SET", "Documentos"],
    [[f["codigo"], f["tipo"], f["endereco"], f["sentido"], f["faixas"], f["numero_serie"], f["bairro"], f["regiao"], f["lat"], f["lon"], f["confirmacao"], f["pagina_set"], f["documentos"]] for f in fisc], {"Documentos": 60})
aba("Radares fora da SET", ["Origem", "Detalhe", "Distância à SET (m)", "Bairro", "Região", "Latitude", "Longitude"], [[r["origem"], r["detalhe"], r["dist_set_m"], r["bairro"], r["regiao"], r["lat"], r["lon"]] for r in fora])
aba("Semáforos", ["Situação", "Radar misto SET", "Grupos focais (OSM)", "Bairro", "Região", "Latitude", "Longitude", "Fonte", "OSM"], [[s["status"], s["confirmacao_set"], s["focos_osm"], s["bairro"], s["regiao"], s["lat"], s["lon"], s["fonte"], s["osm"]] for s in sem])
aba("Travessias", ["Classe", "crossing (OSM)", "Marcação", "Bairro", "Região", "Latitude", "Longitude", "Fonte", "OSM"], [[t["classe"], t["tag_crossing"], t["marcacao"], t["bairro"], t["regiao"], t["lat"], t["lon"], t["fonte"], t["osm"]] for t in trav])
aba("Lombadas", ["Tipo", "Bairro", "Região", "Latitude", "Longitude", "Fonte", "Referência"], [[l["tipo"], l["bairro"], l["regiao"], l["lat"], l["lon"], l["fonte"], l["ref"]] for l in lomb])
aba("PARE e rotatórias", ["Tipo", "Bairro", "Região", "Latitude", "Longitude", "Fonte", "Referência"], [[p["tipo"], p["bairro"], p["regiao"], p["lat"], p["lon"], p["fonte"], p["ref"]] for p in plac])
aba("Estudo – Cruzamentos", ["Nível", "Pontuação", "Cruzamento", "Via principal", "Via secundária", "Ônibus", "Corredor", "Escolas 200 m", "Saúde 300 m", "Faixas 50 m", "Lombadas 80 m", "Radares 150 m", "Bairro", "Latitude", "Longitude", "Recomendação", "Mapa"],
    [[c["nivel"], c["pontuacao"], c["vias"], c["hier_1"], c["hier_2"], "sim" if c["bus"] else "", c["corredor"], c["escolas_200m"], c["saude_300m"], c["faixas_50m"], c["lombadas_80m"], c["radares_150m"], c["bairro"], c["lat"], c["lon"], c["recomendacao"],
      f'https://www.google.com/maps/@{c["lat"]:.6f},{c["lon"]:.6f},19z'] for c in cruz], {"Recomendação": 60})
aba("Estudo – Escolas", ["Prioridade", "Situação", "Escola", "Endereço", "Via mais próxima", "Hierarquia", "Via com ônibus", "Dist. faixa (m)", "Dist. semáforo (m)", "Dist. lombada (m)", "Travessias 100 m", "Bairro", "Latitude", "Longitude", "Origem"],
    [[e["prioridade"], e["situacao"], e["nome"], e["endereco"], e["via_proxima"], e["hierarquia_via"], e["via_com_onibus"], e["dist_faixa_m"], e["dist_semaforo_m"], e["dist_lombada_m"], e["travessias_100m"], e["bairro"], e["lat"], e["lon"], e["origem"]] for e in sorted(esc, key=lambda e: -e["prioridade"])])
aba("Estudo – Saúde", ["Prioridade", "Situação", "Unidade", "Via mais próxima", "Hierarquia", "Dist. faixa (m)", "Dist. semáforo (m)", "Bairro", "Latitude", "Longitude", "Origem"],
    [[e["prioridade"], e["situacao"], e["nome"], e["via_proxima"], e["hierarquia_via"], e["dist_faixa_m"], e["dist_semaforo_m"], e["bairro"], e["lat"], e["lon"], e["origem"]] for e in sorted(sau, key=lambda e: -e["prioridade"])])
aba("Estudo – Ônibus", ["Ponto", "Via", "Hierarquia", "Dist. faixa (m)", "Dist. semáforo (m)", "Bairro", "Latitude", "Longitude"], [[b["nome"], b["via"], b["hierarquia_via"], b["dist_faixa_m"], b["dist_semaforo_m"], b["bairro"], b["lat"], b["lon"]] for b in bus])
cab = ["bairro", "km_vias", "semaforos", "radares_set", "faixas", "travessias", "lombadas", "pare", "rotatorias", "escolas", "escolas_sem_faixa_estrut", "onibus_sem_travessia", "cruz_A", "cruz_B", "cruz_C", "servicos_cronograma", "faixas_por_km", "indice_carencia", "lacuna_mapeamento"]
nomes = ["Bairro", "Km de vias", "Semáforos", "Radares SET", "Faixas sinalizadas", "Travessias (todas)", "Lombadas", "PARE", "Rotatórias", "Escolas", "Escolas sem faixa (via estrutural)", "Ônibus sem travessia", "Cruzamentos A", "Cruzamentos B", "Cruzamentos C", "Serviços cronograma SET", "Faixas por km", "Índice de carência", "Lacuna de mapeamento"]
aba("Estudo – Bairros", nomes, [[p[k] for k in cab] for p in painel], {"Bairro": 34})
aba("Cronograma SET 2021-22", ["Data", "Local", "Bairro (como publicado)", "Bairro oficial", "Região", "Turno", "Período do arquivo"], [[c["data"], c["local"], c["bairro"], c["bairro_oficial"], c["regiao"], c["turno"], c["periodo"]] for c in crono])

INV = [
 ("Fiscalização eletrônica (radares, lombadas eletrônicas, faixa exclusiva)", "261 (lista atual da SET)", res["fiscalizacao_set"], "Completo e oficial", "SET – API de equipamentos (aberta)", "—"),
 ("Locais previstos na licitação de fiscalização de 2023", "330 locais", len(lic), "Completo (documento oficial)", "Termo de Referência do pregão de 2023", "61 locais previstos não aparecem na lista atual da SET: conferir se foram instalados"),
 ("Cruzamentos semaforizados", "721 (Termo de Referência 2022/2023)", res2["semaforos_mapa"], f'{round(100 * res2["semaforos_mapa"] / 721)}% do total oficial', "OpenStreetMap + radares mistos da SET + notícias oficiais + Direita Livre", "Relatório Semafórico da SET (e-mail smtgeoprocessamento@gmail.com) ou SIC; detecções do Mapillary"),
 ("Direita Livre / Esquerda Livre", "110 (Prefeitura, out/2026)", res2["direita_livre_localizados"], f'{res2["direita_livre_localizados"]} de 110', "Lista de 82 publicada pela SET na imprensa + notícias oficiais", "Pedir à SET a relação completa"),
 ("Faixas de pedestres (pintadas e semaforizadas)", "Sem número oficial publicado", res["trav_classe"].get("Faixa de pedestres pintada", 0) + res["trav_classe"].get("Faixa com semáforo", 0), "Parcial", "OpenStreetMap + notícias", "Relatório de Sinalização Horizontal da SET ('em atualização'); Mapillary detecta faixas nas fotos de rua"),
 ("Quebra-molas (lombadas físicas)", "Sem número oficial publicado", sum(v for k, v in res["lombadas"].items() if "física" in k), "Parcial (baixa)", "OpenStreetMap", "Processos de lombada da SET (Portaria 094/2006); quebra-molas de borracha instalados desde abr/2026 sem lista pública"),
 ("Faixas elevadas", "Sem número oficial publicado", res["lombadas"].get("Faixa elevada / plataforma", 0), "Muito baixa", "OpenStreetMap", "Pedido à SET; Mapillary"),
 ("PARE (parada obrigatória)", "Sem número oficial publicado", res["placas"].get("Placa PARE (R-1)", 0), "Parcial", "OpenStreetMap", "Relatório de Sinalização Horizontal da SET; Mapillary (linha de retenção e legenda PARE)"),
 ("Rotatórias e mini-rotatórias", "Sem número oficial publicado", res["placas"].get("Rotatória", 0) + res["placas"].get("Mini-rotatória", 0), "Boa", "OpenStreetMap + notícias", "—"),
 ("Ciclovias e ciclofaixas", "Sem cadastro oficial publicado", sum(res2["ciclo"].values()), f'{res2["ciclo_km"]} km mapeados', "OpenStreetMap; IBGE (1,9% das faces com via sinalizada para bicicleta)", "—"),
 ("Faixas e corredores exclusivos de ônibus", "Cadastro do Mapa Fácil", res2["onibus_osm_trechos"], f'{res2["corredores_mf_km"]} km de corredores no cadastro', "Mapa Fácil + OpenStreetMap", "O status 'à implantar' do Mapa Fácil está desatualizado para os BRTs"),
 ("Videomonitoramento de trânsito", "61 câmeras PTZ (SET, 2025)", res2["licit_tipo"].get("Videomonitoramento", 0), "Parcial", "Termo de Referência 2023 (20 locais) + OpenStreetMap (8)", "Pedir à SET a relação das câmeras"),
 ("Área Azul (demarcação de vagas)", "3.841 vagas (Campinas 1.979, Centro 1.712, Região da 44: 150)", 0, "Sem dado georreferenciado", "—", "Decretos 2.856 e 2.857/2025 e pedido à SET"),
 ("Vagas de idoso, PcD, carga e descarga (demarcação)", "Sem número publicado", 0, "Sem dado", "—", "Pedido à SET"),
]
aba("Inventário (o que falta)", ["Categoria", "Total oficial conhecido", "No mapa", "Completude", "Fonte usada", "Onde está o dado completo / como obter"], [list(i) for i in INV],
    {"Categoria": 45, "Total oficial conhecido": 34, "Completude": 26, "Fonte usada": 40, "Onde está o dado completo / como obter": 70})
wb.move_sheet("Inventário (o que falta)", offset=-(len(wb.sheetnames) - 2))
aba("Licitação 2023", ["Tipo", "Situação", "Endereço", "Distância à SET (m)", "Bairro", "Latitude", "Longitude", "Fonte"], [[l["tipo"], l["situacao"], l["endereco"], l["dist_set_m"], l["bairro"], l["lat"], l["lon"], l["fonte"]] for l in lic])
aba("Direita Livre", ["Cruzamento", "Localização", "Bairro", "Latitude", "Longitude", "Fonte"], [[d["cruzamento"], d["localizacao"], d["bairro"], d["lat"], d["lon"], d["fonte"]] for d in dl])
aba("Notícias oficiais", ["Assunto", "Cruzamento", "Ação", "Data", "Notícia", "Link", "Bairro", "Latitude", "Longitude", "Trecho"], [[n["categoria"], n["cruzamento"], n["acao"], n["data"], n["titulo"], n["link"], n["bairro"], n["lat"], n["lon"], n["trecho"]] for n in sorted(noti, key=lambda n: n["data"], reverse=True)], {"Trecho": 70, "Notícia": 50})
aba("Ciclovias e faixas de ônibus", ["Camada", "Via", "Valor", "Tipo de via", "OSM"], [["Cicloviário: " + l["tipo"], l["nome"], "", l["tipo_via"], l["osm"]] for l in ln["ciclovias"]] + [["Faixa de ônibus", l["nome"], "", l["tipo_via"], l["osm"]] for l in ln["onibus"]])
aba("IBGE – setores", ["Setor", "Bairro (IBGE)", "Faces", "% rampa", "% bicicleta", "% calçada", "% obstáculo", "% ponto de ônibus", "% pavimentada", "% iluminação"], [[t["setor"], t["bairro_ibge"], t["faces"], t["pct_rampa"], t["pct_bicicleta"], t["pct_calcada"], t["pct_obstaculo"], t["pct_onibus"], t["pct_pavimentada"], t["pct_iluminacao"]] for t in ib])
wb.save(O / "sinalizacao-goiania.xlsx")
print("ok", (O / "sinalizacao-goiania.kmz").stat().st_size, (O / "sinalizacao-goiania.xlsx").stat().st_size, len(feats))
