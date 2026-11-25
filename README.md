# Bússola — Sistema de Navegação da Associação

Sistema de navegação da Associação: globo 3D de Goiânia no estilo Earth, com fundo de satélite e, por cima, as camadas e os dados
oficiais do portal [Mapa Fácil](https://portalmapa.goiania.go.gov.br/mapafacil/) da Prefeitura de Goiânia.
Só Goiânia aparece em imagem: os municípios limítrofes ficam em cinza, com o nome e o contorno do
território, e o restante do globo fica neutro.

O projeto é uma página estática (pasta `docs/`), sem servidor próprio e sem etapa de compilação.
As camadas e as consultas vão direto do navegador ao servidor de mapas da Prefeitura.

## O que tem

| Do Earth | Do Mapa Fácil |
| --- | --- |
| Globo 3D com relevo, inclinação, giro, bússola e voo até o destino | Os 15 temas do portal, na mesma ordem e com a mesma seleção padrão, mais 6 temas publicados no servidor |
| Busca com voo até o resultado | Bairros, logradouros por bairro, edifícios, parques, escolas, unidades de saúde, inscrição cadastral e coordenadas |
| Satélite ou mapa, e comparação lado a lado | Mapa desenhado sem fotos (quadras, ruas, nomes e relevo), Mapa Básico da Prefeitura e o satélite em 11 datas, de 2012 a 2025 |
| Edifícios em 3D | 3.393 edifícios do cadastro “Edifício em altura”, com a altura pelo número de pavimentos |
| Ficha do local ao clicar | Lote, quadra, bairro, cadastro imobiliário do lote e o que estiver ligado nos temas |
| Régua (distância e área), marcadores, KML | Coordenadas em UTM 22S SIRGAS 2000, o sistema do Mapa Fácil |
| Link da vista, salvar imagem, “onde estou” | Legenda, opacidade e faixa de escala de cada camada |

## Estrutura

```
docs/                     site publicado (GitHub Pages)
  index.html              portal de acesso (usuário e senha)
  sistema.html            o mapa
  acesso/usuarios.json    contas (só resumos das senhas)
  validacao.html          página de validação: 44 testes ao vivo, no navegador
  css/app.css
  js/                     módulos ES, sem dependência além do CesiumJS (CDN, versão fixada)
    app.js                inicialização e interface
    globo.js              globo, fundos, relevo, câmera e provedores de imagem
    territorio.js         máscara cinza e rótulos dos limítrofes
    camadas.js            temas do Mapa Fácil
    identificar.js        ficha do local
    busca.js  edificios.js  medir.js  marcadores.js  util.js  config.js
  data/                   dados extraídos do Mapa Fácil (gerados pelo script)
scripts/extrair_dados.py  extrator (Python + shapely)
scripts/usuarios.py       cadastro de usuários
tests/                    pytest: dados, extrator e ponta a ponta no Chromium
.github/workflows/
  bussola-testes.yml   testes a cada alteração (único fluxo; nenhum consulta o Mapa Fácil)
dados_mapafacil/          catálogo anterior do servidor (mantido)
```

## Mapa sem fotos e lotes por bairro

- **Fundo "Mapa"** (barra de baixo: Satélite | Mapa): desenhado no navegador com os dados vetoriais da base
  cadastral (`Feature_Base`): quadras, ruas por hierarquia (`in_hie`: locais, coletoras, arteriais e
  expressas), nomes de rua seguindo o traçado, nomes de bairro, número da quadra de perto e o relevo
  sombreado da Esri (World Hillshade), somado ao relevo 3D. Código em `docs/js/mapavetorial.js`.
- **Ruas e quadras** (painel Camadas): a mesma base, transparente, por cima do satélite. Não traz lotes.
- **Lotes por bairro** (painel Camadas): escolha até 6 bairros; só os lotes deles são buscados no servidor
  (primeiro os identificadores, depois as geometrias em partes) e desenhados no navegador. Os bairros
  escolhidos entram no link da vista (`l=`). Código em `docs/js/lotes.js`.
- As ortofotos de 2006, 2011 e 2016 saíram dos fundos. O extrator ainda as registra em `camadas.json`.
- As consultas ao servidor municipal passam por uma fila de no máximo 4 pedidos simultâneos.

## Levantamento do Jardim América e do Nova Suíça

Painel **Bairros** (menu lateral). Dados em `docs/data/levantamento.json`, gerados a partir do KML e da
planilha compilados pela Associação:

```
python scripts/importar_levantamento.py compilado.kmz compilado.xlsx   # aceita .kml ou .kmz
```

- **Limites dos bairros**: a divisa de cada um, em destaque, com o nome.
- **Lotes por finalidade** (9.013), com filtro por finalidade e por bairro. A ficha do lote traz todas as
  colunas da aba Lotes, cada empresa da aba Empresas com todos os campos, os estabelecimentos do Google Maps
  e a linha da aba Condomínios e prédios.
- **Limites**: pelo conjunto dos lotes de cada bairro (Jardim América 8.029, Nova Suíça 984) e, para
  comparar, o limite oficial do Mapa Fácil (tracejado).
- **Áreas públicas** (128) e **condomínios e prédios em 3D** pela altura dos pavimentos.
- **Condomínios** (571): lote com mais de 5 inscrições de IPTU, ou marcado como condomínio no Mapa Fácil, com
  edifício em altura, listado no levantamento ou com CNPJ de condomínio. Quatro finalidades, cada uma com a
  sua cor: horizontal (casas), residencial, comercial e misto. Todos têm polígono e aparecem em 3D.
- **Prédios pelo IPTU**: `docs/data/predios.json` leva à camada "Edifícios em 3D" os 638 prédios e condomínios dos dois
  bairros, entre eles todos os lotes com mais de 5 inscrições de IPTU, com a altura pelos andares. A base não é o lote
  inteiro: prédios que o Mapa Fácil já tinha mantêm o desenho anterior (310 torres); os novos têm a base estimada pela
  construção vista na imagem de satélite (Microsoft Global ML Building Footprints, ODbL), recortada pelo lote, e só a
  torre sobe: estacionamento e lote agregado ficam no chão. Sem construção na imagem, torre esquemática pela regra do
  Mapa Fácil. Casas de condomínio horizontal aparecem cada uma com a sua forma. Gerado por `scripts/bases_predios.py`. Andares = maior valor entre Mapa Fácil, levantamento, cadastro e numeração das unidades (AP 1202 = 12º andar).
  Cor pelo uso: horizontal (1 andar) em verde-água, residencial em azul, comercial em rosa, misto em marrom, cinza sem uso definido.
- **Unidades de condomínio**: na ficha do lote, a lista "Apartamento ou sala" (ou "Casa do condomínio")
  começa em ` -- `, a base geral do condomínio, e traz uma base própria por inscrição de IPTU
  (código `UN-<inscrição>`), com as empresas daquela unidade. Dados em `unidades.por_lote` do arquivo.
- **Bocas de lobo**: 1.580 unidades em 830 pontos, com ícone do número de unidades em sequência.
- **Iluminação pública**: 4.147 pontos com lâmpada e poste em 3D (cadastro do Mapa Fácil anterior ao LED).
- **Pedidos de manutenção**: lote (`LT-JA-<CI>`), área pública (`AP-JA-001`), boca de lobo (`BL-JA-0001`) e
  iluminação (`IP-NS-0001`) têm botão que abre a página de Pedidos de Manutenção no item (`URL#CÓDIGO`).
  Os códigos também funcionam na busca do painel.
- **Eleitoral**: eleição geral 2026 com filtro por zona; Conselho Tutelar 2023 com filtro por região, local
  do CT em estrela, local transferido em cinza e seta até a escola que reuniu as urnas.
- **Busca** em todos os campos dos lotes e das empresas, inclusive as empresas sem lote identificado.
- Todos os dados da planilha e do KML vão para o arquivo, inclusive contatos, telefones e e-mails. O arquivo
  de dados fica acessível a quem tiver o endereço direto, como tudo no GitHub Pages.
- No Mapa e na camada "Ruas e quadras", a divisa de todos os bairros de Goiânia aparece tracejada.

## Banco de dados local: sistema independente do servidor da Prefeitura (1.8)

Os dados públicos do Mapa Fácil foram extraídos e ficam no próprio site, em `docs/banco/`. O sistema passa
a responder ao clique, à busca, ao fundo "Mapa", às quadras e lotes por aproximação e aos temas do painel
Camadas a partir desse banco, sem consultar o servidor municipal.

- **Como funciona.** `docs/js/banco.js` atende, no próprio navegador, as mesmas perguntas que o sistema fazia
  ao servidor ArcGIS da Prefeitura: `query`, `identify`, `legend` e metadados. Os módulos do sistema continuam iguais.
  Só uma pergunta que o banco não sabe responder segue para o servidor municipal, se ele estiver no ar.
  Para nunca consultar o servidor, use `bancoSoLocal: true` em `config.js`. Os serviços listados em
  `servicosSoLocais` (hoje a Base Cadastral, `Feature_Base`) já estão desvinculados: nunca vão ao servidor, nem para
  o que faltar no banco.
- **Carregamento.** O `sw.js` (service worker) guarda no aparelho os arquivos de `banco/` e `data/`: da segunda vez
  em diante o mapa abre com eles na hora e atualiza por trás.
- **Temas do painel Camadas.** Deixam de ser imagens pedidas ao servidor e são desenhados dos dados, com as
  cores, símbolos, rótulos e escalas originais de cada camada (`drawingInfo`). O que só existe como imagem
  (Mapa Básico) fica em blocos de imagem em `docs/banco/blocos/`.
- **Formato.**
  - `manifesto.json`: serviços, camadas, campos, blocos e índices.
  - `servicos/{Serviço}/`: metadados e legendas originais.
  - `dados/{Serviço}/{camada}/`:
    - camadas pequenas num arquivo só;
    - camadas grandes em blocos Web Mercator (nível 15, ou 13 para áreas);
    - visão simplificada para ver de longe;
    - índices por `id` e por inscrição (`ci`).
  - Cadastro imobiliário (unidades de IPTU): agrupado pela inscrição do lote.
  - Tudo em JSON compactado (gzip), com todos os campos e nomes originais.
- **Atualizar.** O banco é uma fotografia do servidor na data da extração (ver `docs/banco/manifesto.json` e
  `docs/banco/conferencia.csv`). Para refazer:

```bash
python scripts/extrair_mapafacil.py inventario          # metadados, legendas e contagens
python scripts/extrair_mapafacil.py baixar Feature_Base # base cadastral (ou "todos" para os projetos)
python scripts/extrair_mapafacil.py cadastro            # cadastro imobiliário, por bairro
python scripts/extrair_mapafacil.py reparar_todos       # completa o que faltou e a geometria pelo identify
python scripts/extrair_blocos.py Mapa_Basico3 11 17 jpg # imagens do Mapa Básico
python scripts/montar_banco.py extracao/saida           # monta docs/banco/
```

O servidor municipal cai com frequência (502). O extrator faz no máximo 3 pedidos simultâneos, espera e tenta de novo,
e retoma de onde parou.

## Postes, seleção e pedidos de manutenção (1.9)

- **Postes (painel Bairros)**: `docs/data/postes.json`, gerado por `scripts/importar_postes.py` a partir do KML
  "08 - Postes" do levantamento, juntado ao cadastro de iluminação (pela plaqueta e, sem ela, pela distância até 6 m).
  São 4.489 postes do KML (3.968 com lâmpada no cadastro e 521 sem) mais 179 pontos de iluminação que não estão no KML.
  Cada poste é um cilindro 3D na cor da rede (amarelo baixa tensão, laranja alta, vermelho com transformador) com um
  prisma no topo de cor livre. A ficha traz material (concreto redondo R, quadrado Q ou madeira M), tensão,
  transformador, lâmpada e o histórico de pedidos com as datas, editáveis. Os postes do resto de Goiânia (Camadas) não mudam.
- **Seleção**: em todo o mapa, o objeto escolhido fica mais claro na cor e na linha, sem ponto nem marcador.
- **Pedidos de manutenção** (`docs/js/manutencao.js`): o botão fica marcado enquanto houver pedido e, clicado de novo,
  retira o pedido; a data e a descrição são editáveis. Relatório para imprimir e planilha CSV no painel Bairros.
  Os pedidos ficam guardados no aparelho.

## Botões e navegação (1.10)

- Sem painel lateral de ícones: **Camadas**, **Bairros**, **Medir** e **Marcar** ficam em linha no canto superior esquerdo,
  sobre a tela de dados; **Fundo** é o ícone dentro da caixa de busca; **Sobre** fica no rodapé, à direita; **Sair** fica no
  canto superior direito.
  Todos abrem a mesma tela de dados à esquerda.
- O pássaro da busca bate as asas só ao clicar: o mesmo movimento e a mesma velocidade da tela de abertura.
- Esferas das luminárias: tamanho mínimo até 1 km de altura da câmera; crescem até 6× (+500%) em 4 km.
- Quadras e lotes aparecem a partir de 5 km de altura da câmera; o número da quadra a partir de 4 km e o do lote a
  partir de 2,5 km, todos, sem esconder nenhum (`ALTURA`/`LIMITE_ALTURA` em `docs/js/mapavetorial.js`); o número da quadra
  fica por baixo, maior e mais claro, e os condomínios em 3D trazem o lote e a quadra chapados no teto.
- Divisa única de bairro em todo o sistema: limite oficial do Mapa Fácil, em preto, amarelo e preto.
- Escolas e cursos em tons de verde: particulares claras, públicas escuras, um tom por nível.
- Condomínio horizontal em 3D: um volume só, no lote inteiro, com 1 pavimento.
- Painel Bairros: imóveis públicos separados de praças e áreas verdes (com canteiros centrais e áreas remanescentes);
  **Escolas e cursos** (`docs/js/escolas.js`) em marcadores: públicas (áreas de Educação) e particulares (CNAE da
  Receita) por nível — infantil, fundamental, médio e superior — e "Aulas diversas" (idiomas, lutas e esportes, dança,
  música, artes, informática, preparatórios e demais cursos).

## Sistema independente do Mapa Fácil (1.13)

- `docs/banco/` traz o banco completo extraído do Mapa Fácil em 23 e 24/11/2026: 219 camadas de 21 serviços (cerca de
  4,7 milhões de feições) e as imagens do Mapa Básico e do Simplifica Goiânia (`docs/banco/blocos/`).
- `bancoSoLocal: true` em `docs/js/config.js`: nada é pedido ao servidor da Prefeitura. A única exceção é abrir um
  documento anexado a um lote.
- Dados pessoais do servidor ficam no cofre cifrado (arquivos `.pess`, AES-256-GCM, chave pela senha do cofre, que não
  está no repositório); a ficha do lote pede a senha para mostrá-los.
- A página de validação confere o banco local (cada tema, consultas e imagens), não o servidor.

## Camadas, eleições e associações (1.16)

- **Camadas** (cidade inteira) e **Associação** (área de cada associação) têm papéis separados.
- **Base Cadastral** liga e desliga o desenho cadastral da cidade e tem opções: nomes das ruas, quadras, lotes,
  divisas e nomes dos bairros, áreas públicas (verde #00FF00, contorno branco) e Cadastro de Atividade Econômica.
- Clique: acima de 5 km seleciona o bairro; de 5 a 2,5 km, a quadra; abaixo de 2,5 km, o lote.
- **Zonas Eleitorais** e **Conselho Tutelar** são mapas próprios (`docs/js/eleicoes.js`), um de cada vez, com divisa
  preta-vermelha-preta e cor clara por área; o clique seleciona a zona/região inteira ou o colégio. As regiões do
  Conselho Tutelar (`docs/data/conselho_regioes.geojson`, `scripts/regioes_conselho.py`) seguem a Resolução
  CMDCA 85/2023: cada Conselho junta duas das 12 Regiões da SEPLAM (divisas internas em branco tracejado).
- **Associação**: `docs/data/associacoes.json` liga cada login à sua associação; a A.M.C. Jardim América (`ve_todas`)
  vê todas. Como o site é estático, a separação é de tela: os arquivos de dados continuam acessíveis pelo endereço.
- Abertura: a câmera começa de cima, com o mapa plano, e desce dando uma volta em torno de Goiânia.

## Desempenho (roteiro, passos 1 e 2)

- `docs/js/desempenho.js`: medidas por etapa (baixar, descompactar, interpretar, consultar, desenhar-tema,
  desenhar-mapa), contadores e tarefas longas. No console: `bussola.desempenho()` e `bussola.zerarDesempenho()`.
- `tests/test_desempenho.py`: roteiro fixo com CPU 4× mais lenta e o servidor da Prefeitura bloqueado; grava em
  `tests/desempenho-base.json` por versão (não reprova por tempo).
- `tests/test_equivalencia.py`: 200 consultas sorteadas (semente 20261124) comparadas com
  `tests/equivalencia-referencia.json.gz`; `BUSSOLA_REGRAVAR_EQUIVALENCIA=1` regrava (com justificativa no commit).

## Acesso com usuário e senha

A página inicial (`docs/index.html`) é o portal de acesso. O mapa fica em `docs/sistema.html` e só abre
com sessão válida; sem ela, a pessoa volta ao portal e, depois de entrar, segue para onde ia (inclusive um
link de indicação).

- As contas ficam em `docs/acesso/usuarios.json`, que guarda só o resumo PBKDF2-SHA256 de cada senha
  (sal próprio e 310 mil iterações), nunca a senha.
- A sessão dura 12 horas, ou 30 dias com "Manter conectado neste aparelho".
- Usuário removido, desativado ou com senha trocada perde o acesso também nos aparelhos já conectados.
- Depois de 5 erros seguidos, o portal impõe uma pausa crescente entre as tentativas.

Gerenciar contas:

```
python scripts/usuarios.py listar
python scripts/usuarios.py adicionar maria "Maria Souza"            # gera e mostra a senha
python scripts/usuarios.py adicionar joao "João Lima" --perfil admin
python scripts/usuarios.py senha maria                              # redefine a senha
python scripts/usuarios.py desativar maria | ativar maria | remover maria
```

Limite conhecido: o GitHub Pages é uma hospedagem pública e sem servidor. O login controla o uso do sistema,
mas os dados do mapa são públicos na origem (Mapa Fácil). Para controle de acesso no servidor, o caminho é
colocar o site atrás de um serviço de autenticação (por exemplo, Cloudflare Access com domínio próprio).

## GPS e indicação de locais

- **Minha localização** (botão de mira à direita ou tecla G): acompanha a posição do aparelho com o ponto
  azul e o círculo de precisão; o mapa pode seguir quem está andando.
- O painel **Indicar** mostra onde a pessoa está: bairro, quadra e lote do Mapa Fácil, coordenadas e UTM.
- **Indicar um local**: pela posição do GPS ou clicando no mapa, com tipo (iluminação, buraco, lixo, poda,
  calçada, água e esgoto, segurança, referência, outro) e descrição.
- Cada indicação gera um link (`sistema.html#ind=…`) que abre a Bússola exatamente no ponto, com botão
  **Como chegar**. O envio usa o compartilhamento do celular ou o WhatsApp.
- As indicações ficam no aparelho, por conta, e podem ser baixadas em planilha (CSV) ou GeoJSON.
- O GPS exige endereço seguro (https), o que o GitHub Pages já oferece.

## Publicar no GitHub Pages

1. Envie estes arquivos para a branch `main`.
2. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch `main`, pasta `/docs`.
3. O mapa abre em `https://amcjardimamerica-arch.github.io/Bussola/` e a validação em
   `…/validacao.html`.

Não há segredo nem chave no projeto. A cada envio, o fluxo **Bússola — testes** confere os dados
e abre o mapa em um Chromium; o resultado aparece na aba **Actions**.

Os dados não se atualizam sozinhos. Uma nova extração do Mapa Fácil é feita à mão, conferida e só então implantada.

## Testar e validar

A suíte tem 21 testes sem rede (dados e extrator) e 10 no navegador, entre eles um de acessibilidade
com o axe-core (WCAG 2.1 A e AA, sem violação grave ou crítica).

**No navegador:** abra `validacao.html`. Ela confere os arquivos de dados, os cálculos e, ao vivo,
cada tema, cada fundo, o identificar, a busca, o satélite e o relevo. Dá para baixar o relatório em JSON.

**No computador:**

```bash
python -m http.server 8000 --directory docs     # abre em http://localhost:8000
pip install -r requirements-dev.txt
pytest -m "not navegador"                        # dados e extrator, sem rede
playwright install chromium && pytest -m navegador   # mapa e validação no Chromium
```

## Atualizar os dados

```bash
pip install shapely
python scripts/extrair_dados.py                  # tudo (3 a 10 minutos; a etapa do satélite é a mais lenta)
python scripts/extrair_dados.py --etapas camadas # só uma etapa
```

Os dados não se atualizam sozinhos: a extração é feita à mão, conferida e só então implantada (não há fluxo
automático). Se uma etapa falha, os arquivos anteriores são preservados.

| Arquivo | Conteúdo | Fonte |
| --- | --- | --- |
| `territorio.geojson` | Goiânia e os limítrofes | `Mapa_Limites` (Divisas de Município) |
| `bairros.json` | 1.209 bairros: nome, centro, extensão, população | `Feature_Base/2` |
| `logradouros.json` | 15.736 trechos logradouro × bairro | `Feature_Base/10` |
| `edificios.json` | 3.393 edifícios com base aproximada | `Mapa_Edificios` + `Feature_Base/0` |
| `lugares.json` | 43 parques, 359 escolas e CMEIs, 145 unidades de saúde | `Mapa_MeioAmbiente/11`, `Mapa_PontosNotaveis/0` e `/1` |
| `camadas.json` | temas, fundos, fontes de busca e catálogo do servidor | `config.json` e mapa web do portal |
| `satelite.json` | 11 datas anteriores do satélite sobre Goiânia | arquivo Esri World Imagery Wayback |

## Como foi resolvido

- **Só Goiânia.** A máscara é uma camada de imagem desenhada em `<canvas>` a partir do contorno
  oficial, sempre por cima de tudo. Ela cobre o satélite e qualquer tema fora do município, em
  qualquer zoom, sem depender de rede.
- **Limítrofes.** São calculados da própria base municipal: oito fazem divisa em linha e dois
  (Aragoiânia e Bonfinópolis) encostam em um único ponto. O conjunto dos dez confere com a malha
  municipal do IBGE.
- **Nomes sobre o satélite.** O Mapa Básico é pedido com fundo transparente e recolorido no navegador:
  traços e textos escuros viram brancos com halo, preenchimentos somem.
- **Base Cadastral.** O serviço `Feature_Base` é desenhado todo em branco, serve só para consulta.
  Por isso entra como fonte do clique, não como imagem.
- **Satélite em outras datas.** O arquivo Wayback da Esri guarda 199 versões do mosaico desde 2014. O extrator
  consulta os metadados no centro de Goiânia e fica com uma versão por data de captura diferente. A data
  vale para o centro; outras regiões do município podem ter sido fotografadas em outro dia.
- **Busca.** O servidor diferencia acentos e maiúsculas (“Anhanguera” não acha “Anhangüera”).
  Os índices locais resolvem isso e respondem na hora.
- **Edifícios 3D.** O cadastro traz o ponto e o número de pavimentos, não a projeção da torre. A base
  é o lote com recuo (ou uma torre no ponto, em condomínios) e a altura é pavimentos × 3 m.
  É um modelo esquemático.

## Limites conhecidos

- O servidor da Prefeitura responde cada imagem em 1 a 5 segundos. O mapa limita a 4 pedidos
  simultâneos para não sobrecarregá-lo.
- A ortofoto de 2016 só responde de perto (nível 11 em diante); o extrator detecta isso.
- O valor venal do cadastro vem sem o exercício de referência.
- A população por bairro é a do campo da base municipal. A soma (1.306.344) equivale à do Censo de 2010
  (1.302.001), não à do Censo de 2022 (1.437.366).
- O fundo de satélite e o relevo são serviços da Esri, usados sem chave. Para uso público em
  produção, confira os termos da Esri ou troque o fundo (a ortofoto de 2016 é municipal).
  `docs/js/config.js` aceita uma chave da Google Map Tiles API em `googleMapsApiKey`; esse caminho
  não foi testado por falta de chave.
- Projeto independente, para teste e validação. Não substitui o portal oficial nem certidões.

## Créditos

Dados e camadas: Prefeitura de Goiânia (Mapa Fácil). Satélite e relevo: Esri, Maxar, Earthstar
Geographics. Globo: [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache 2.0).

## Identidade visual e nomes de bairro (1.5)

- Portal (`docs/index.html`, `docs/css/portal.css`) nas cores e nas facetas da A.M.C. Jardim América, com a
  rosa dos ventos e o contorno de Goiânia. As logomarcas da Associação e do Núcleo de Fiscalização ficam
  separadas, abaixo da rosa dos ventos. Imagens em `docs/img/marca/`.
- A tela de carregamento do mapa segue a mesma identidade, com as duas marcas juntas no canto inferior direito.
- Na busca, o pássaro da logomarca (vetorial, com asa e bico articulados) substitui o círculo; clicar nele
  centraliza o mapa em Goiânia. A busca fica centralizada sobre o mapa.
- Nomes de bairro sem "Bairro", "Setor" ou "Conjunto" na frente e sem abreviações (`nomeBairro` em
  `docs/js/util.js`, `nome_bairro` em `scripts/extrair_dados.py`): "Bro Jardim América" vira
  "Jardim América", "S Bueno" vira "Bueno", "Jd Goiás" vira "Jardim Goiás". Quando o nome começa por
  "da", "de" ou "dos", o tipo fica por extenso ("Bairro da Vitória"). O nome oficial segue no campo `o`.

## Organização das camadas (1.7)

- **Busca no topo**: o botão de opções ao lado do campo traz "Ruas e quadras" e "Lotes por bairro"; em cada bairro
  escolhido, o botão **3D** mostra as edificações só nesse bairro.
- **Camadas → Projetos** (`ORGANIZACAO` em `docs/js/camadas.js`): cada projeto reúne camadas de um ou mais serviços do
  Mapa Fácil. Ordem: Base Cadastral, Zonas Eleitorais, Energia, Saneamento, Sistema Viário, Edificações, Meio Ambiente
  e os demais.
  - **Zonas Eleitorais**: limite das zonas e os locais de votação por zona e do Conselho Tutelar, cada local como o
    lote inteiro do colégio (laranja com borda amarela e o nome em cima). No Conselho Tutelar, o colégio sem votação
    fica cinza com borda branca e uma linha tracejada leva ao colégio que recebeu as urnas. Os lotes dos colégios
    estão em `docs/data/eleitoral_lotes.json` (gerado por `scripts/lotes_eleitorais.py`).
  - **Edificações**: chave única "Edificações em 3D" (desligada por padrão; por bairro, pela busca), mais Edificações,
    equipamentos públicos, Patrimônio Histórico, Regularização Fundiária e Documentação de Bairros.
  - **Meio Ambiente** com o PUAMA; **Uso do Solo** com o Simplifica Goiânia; **Zonas Municipais** (antigo Pontos Notáveis).
  - **Acessibilidade e Serviços** (`docs/js/servicos.js`): marcadores fixos com ícone por tipo, nome branco no satélite e
    preto no mapa sem fotos, e ficha ao clicar.

## Lotes no mapa e polígonos editáveis (1.6)

- **Aproximação progressiva**, como no Mapa Fácil (`NIVEIS` em `docs/js/mapavetorial.js`): de longe, só as divisas dos
  bairros; ao aproximar, as quadras (nível 15) com o número da quadra (16); mais perto, as divisas de todos os lotes dentro
  das quadras, com o número de cada lote (17). Os números crescem conforme a aproximação. Os lotes são carregados do
  servidor do Mapa Fácil por bloco do mapa, só na área visível. As camadas de lotes coloridos (Bairros e levantamento)
  também só aparecem de perto.
- **Polígonos editáveis** (`docs/js/poligonos.js`): na ficha de qualquer lote (clique no mapa ou painel Bairros), o botão
  "Editar como polígono" cria um polígono com as funções do Google Earth:
  - nome e descrição, com o nome no mapa (opcional);
  - estilo: cor e largura da linha, cor e opacidade do preenchimento;
  - altitude: fixado no chão, relativo ao chão ou absoluto, com a altura em metros e a opção de estender os lados até
    o chão (volume em 3D);
  - forma: arrastar vértices, inserir um vértice pelo ponto médio, apagar com o botão direito, desfazer (Ctrl+Z);
  - medidas: área, perímetro e vértices, ao vivo;
  - salvar a vista, voar até, duplicar, ocultar, excluir, restaurar o desenho oficial do lote e exportar em KML
    (com estilo, altitude e vista).
  Também é possível desenhar um polígono novo no painel Marcar. Os polígonos ficam salvos no navegador e entram no
  KML exportado junto com marcadores e medições.
