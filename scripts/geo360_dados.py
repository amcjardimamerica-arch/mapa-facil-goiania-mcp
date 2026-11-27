"""Dados do Geo360 Goiânia incorporados ao Bússola (camada "Geo360 (atualização 2024-2025)").

Converte os dados públicos do portal Geo360 (portal-goiania.geo360.com.br, Prefeitura de Goiânia / Topocart),
obtidos pela Lei de Acesso à Informação, para o formato de dados do Bússola em docs/data/geo360/:

  - equipamentos.json    Guarda Civil Municipal, Cultura e Assistência Social (pontos)
  - condominios.json     condomínios oficiais por tipo (polígonos)
  - planta_valores.json  Planta de Valores Genéricos 2016-2025 (polígonos)
  - risco_geologico.json setores de risco geológico CPRM/Defesa Civil (polígonos)

Entrada: os arquivos brutos baixados do portal ficam em raw/ (fora do repositório). Este script só faz a
conversão; a extração é feita à parte. Polígonos em micrograus delta (como a Drenagem Pluvial).
Fonte: Geo360 Goiânia — Prefeitura de Goiânia.
"""
import json, os
os.makedirs('/home/claude/geo360/out', exist_ok=True)
bairro={str(b['id']): (b.get('nome') or b.get('nm_bai') or '').strip() for b in json.load(open('raw/bairro.json'))}
def enc_ring(coords):
    out=[]; px=py=0
    for lo,la in coords:
        x=round(lo*1e6); y=round(la*1e6)
        out+=[x-px, y-py]; px,py=x,y
    return out
def rings(geom):
    if not geom: return []
    t=geom['type']; c=geom['coordinates']
    polys = c if t=='MultiPolygon' else [c]
    out=[]
    for poly in polys:
        for ring in poly:
            if len(ring)>=4: out.append(enc_ring(ring))
    return out
def centroide(geom):
    rs=rings(geom)
    if not rs: return None
    # decode first ring, average
    r=rs[0]; x=y=0; pts=[]
    for i in range(0,len(r),2):
        x+=r[i]; y+=r[i+1]; pts.append((x/1e6,y/1e6))
    return [round(sum(p[0] for p in pts)/len(pts),6), round(sum(p[1] for p in pts)/len(pts),6)]

# 1) EQUIPAMENTOS (pontos)
eq=[]
for arq,tp in [('gcm','Guarda Civil Municipal'),('cultura','Cultura'),('assist','Assistência Social')]:
    for x in json.load(open(f'raw/{arq}.json')):
        lon=x.get('long') or x.get('long_'); lat=x.get('lat')
        g=x.get('geom')
        if (lon is None or lat is None) and g and g.get('type')=='Point': lon,lat=g['coordinates']
        if lon is None or lat is None: continue
        nome=(x.get('nome') or x.get('nome_unida') or '').strip()
        log=(x.get('logradouro') or x.get('nome_log') or '').strip()
        num=str(x.get('numero') or '').strip()
        bai=(x.get('bairro') or '').strip()
        end=', '.join(p for p in [f"{log} {num}".strip(), bai] if p)
        eq.append({'t':tp,'n':nome,'c':[round(float(lon),6),round(float(lat),6)],'e':end,'b':bai,
                   'cep':str(x.get('cep') or '').strip(),'cl':(x.get('clas_unid') or x.get('tipo_imove') or x.get('tipo_imovel') or '').strip()})
json.dump({'fonte':'Geo360 Goiânia (Prefeitura de Goiânia) — equipamentos de Guarda Civil Municipal, Cultura e Assistência Social','equipamentos':eq},
          open('out/equipamentos.json','w'), ensure_ascii=False, separators=(',',':'))
print('equipamentos', len(eq))

# 2) CONDOMINIOS (poligonos)
TPC={1:'Horizontal',2:'Horizontal fechado',3:'Vertical',4:'Vertical informal',5:'Sem categoria'}
linhas=[]
for x in json.load(open('raw/condominio.json')):
    rs=rings(x.get('geom'))
    if not rs: continue
    linhas.append({'n':(x.get('nome') or '').strip(),'tp':TPC.get(x.get('tipo_condominio'),'Outro'),
        'ap':x.get('area_privativa_total'),'ac':x.get('area_comum_total'),
        'acp':x.get('area_construida_privativa_total'),'acc':x.get('area_construida_comum_total'),
        'b':bairro.get(str(x.get('id_bairro')),''),'g':rs})
json.dump({'fonte':'Geo360 Goiânia (Prefeitura de Goiânia) — condomínios (recadastramento 2024-2025)','condominios':linhas},
          open('out/condominios.json','w'), ensure_ascii=False, separators=(',',':'))
print('condominios', len(linhas))

# 3) PLANTA DE VALORES (poligonos)
pv=[]
for x in json.load(open('raw/planta_valores.json')):
    rs=rings(x.get('geom'))
    if not rs: continue
    vals={a:x.get(f'vl_{a}') for a in range(2016,2026)}
    if not any(vals.values()): continue
    pv.append({'s':str(x.get('nm_plv') or '').strip(),'area':x.get('area'),'v':[vals[a] for a in range(2016,2026)],'g':rs})
json.dump({'fonte':'Geo360 Goiânia (Prefeitura de Goiânia) — Planta de Valores Genéricos 2016-2025','anos':list(range(2016,2026)),'planta':pv},
          open('out/planta_valores.json','w'), ensure_ascii=False, separators=(',',':'))
print('planta_valores', len(pv))

# 4) RISCO GEOLOGICO (poligonos)
rc=[]
for x in json.load(open('raw/risco.json')):
    rs=rings(x.get('geom'))
    if not rs: continue
    rc.append({'local':(x.get('local') or '').strip(),'tipo':(x.get('tipolo_g1') or '').strip(),'material':(x.get('tipolo_e1') or '').strip(),
        'grau':(x.get('grau_risco') or '').strip(),'vuln':(x.get('grau_vulne') or '').strip(),'moradias':x.get('num_morad'),'pessoas':x.get('num_pessoa'),
        'situacao':(x.get('situacao') or '').strip(),'desc':(x.get('descricao') or '').strip(),'interv':(x.get('sug_interv') or '').strip(),
        'orgao':(x.get('orgao_exec') or '').strip(),'data':(str(x.get('data_setor') or '')[:10]),'g':rs})
json.dump({'fonte':'Geo360 Goiânia (Prefeitura de Goiânia) — setores de risco geológico (CPRM / Defesa Civil)','risco':rc},
          open('out/risco_geologico.json','w'), ensure_ascii=False, separators=(',',':'))
print('risco', len(rc))
