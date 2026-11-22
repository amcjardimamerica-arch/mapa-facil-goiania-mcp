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
| Imagens históricas e comparação lado a lado | Ortofotos oficiais de 2006, 2011 e 2016, além do satélite atual e do Mapa Básico |
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
  validacao.html          página de validação: 43 testes ao vivo, no navegador
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
  bussola-testes.yml   testes a cada alteração
  bussola-dados.yml    atualização semanal dos dados
dados_mapafacil/          catálogo anterior do servidor (mantido)
```

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
3. O mapa abre em `https://amcjardimamerica-arch.github.io/mapa-facil-goiania-mcp/` e a validação em
   `…/validacao.html`.

Não há segredo nem chave no projeto. A cada envio, o fluxo **Bússola — testes** confere os dados
e abre o mapa em um Chromium; o resultado aparece na aba **Actions**.

A pasta `docs/data` (2,2 MB) pode ir pronta ou ficar de fora: ao receber `scripts/extrair_dados.py`, o
fluxo **Bússola — atualizar dados** roda sozinho, extrai tudo do portal e grava a pasta no
repositório (cerca de 4 minutos). Ele também pode ser rodado à mão em Actions → Run workflow.

## Testar e validar

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
python scripts/extrair_dados.py                  # tudo (cerca de 3 minutos)
python scripts/extrair_dados.py --etapas camadas # só uma etapa
```

O fluxo **Bússola — atualizar dados** faz isso toda segunda-feira e grava `docs/data` quando
algo mudou. Se uma etapa falha, os arquivos anteriores são preservados.

| Arquivo | Conteúdo | Fonte |
| --- | --- | --- |
| `territorio.geojson` | Goiânia e os limítrofes | `Mapa_Limites` (Divisas de Município) |
| `bairros.json` | 1.209 bairros: nome, centro, extensão, população | `Feature_Base/2` |
| `logradouros.json` | 15.736 trechos logradouro × bairro | `Feature_Base/10` |
| `edificios.json` | 3.393 edifícios com base aproximada | `Mapa_Edificios` + `Feature_Base/0` |
| `lugares.json` | 43 parques, 359 escolas e CMEIs, 145 unidades de saúde | `Mapa_MeioAmbiente/11`, `Mapa_PontosNotaveis/0` e `/1` |
| `camadas.json` | temas, fundos, fontes de busca e catálogo do servidor | `config.json` e mapa web do portal |

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
- O fundo de satélite e o relevo são serviços da Esri, usados sem chave. Para uso público em
  produção, confira os termos da Esri ou troque o fundo (a ortofoto de 2016 é municipal).
  `docs/js/config.js` aceita uma chave da Google Map Tiles API em `googleMapsApiKey`; esse caminho
  não foi testado por falta de chave.
- Projeto independente, para teste e validação. Não substitui o portal oficial nem certidões.

## Créditos

Dados e camadas: Prefeitura de Goiânia (Mapa Fácil). Satélite e relevo: Esri, Maxar, Earthstar
Geographics. Globo: [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache 2.0).
