// Configuração da Bússola. Tudo que depende de endereço externo fica aqui.
export const VERSAO = '1.5.0';

const REST = 'https://portalmapa.goiania.go.gov.br/servicogyn/rest/services';

export const CFG = {
  dados: 'data/',
  portal: 'https://portalmapa.goiania.go.gov.br/mapafacil/',
  rest: REST,
  ms: `${REST}/MapaServer`,
  baseCadastral: `${REST}/MapaServer/Feature_Base/MapServer`,

  // Fundo "Earth": mosaico de satélite mundial (sem chave). Nível 19 só existe
  // na área urbana; onde falta, o descarte de blocos usa o nível anterior.
  satelite: {
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    nivelMaximo: 19,
    blocoAusente: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/23/4578405/3046311',
    credito: 'Imagem de satélite: Esri, Maxar, Earthstar Geographics',
  },

  // Opcional: chave da Google Map Tiles API. Preenchida, o fundo padrão passa a
  // ser o satélite do Google (é o mesmo acervo do Google Earth). Requer conta
  // de faturamento no Google Cloud. Vazio = satélite Esri acima.
  googleMapsApiKey: '',

  relevo: {
    url: 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer',
    nivelAmostra: 12,
  },

  cores: {
    fora: '#3a3e44',          // tudo que não é Goiânia nem limítrofe
    vizinho: '#5b6067',       // território dos municípios limítrofes
    divisaVizinho: '#9299a1',
    contorno: '#ffffff',      // divisa de Goiânia
    destaque: '#ffd54a',      // seleção (amarelo ipê)
    medida: '#4dd0e1',
  },

  visaoInicial: { rumo: 0, inclinacao: -58, distancia: 82000 },
  camera: { distanciaMinima: 45, distanciaMaxima: 150000, folgaGraus: 0.35 },

  // Cor dos prédios em 3D pelo uso. Cinza quando não dá para diferenciar.
  usosEdificios: [
    { uso: 'horizontal', rotulo: 'Condomínio horizontal (casas, 1 andar)', cor: '#00bfa5' },
    { uso: 'residencial', rotulo: 'Residencial', cor: '#2196f3' },
    { uso: 'comercial', rotulo: 'Comercial', cor: '#e91e63' },
    { uso: 'misto', rotulo: 'Misto (residencial e comercial)', cor: '#8d6e63' },
    { uso: 'indefinido', rotulo: 'Uso não diferenciado', cor: '#9e9e9e' },
  ],
  // Faixas de pavimentos iguais às do tema "Edificações" do Mapa Fácil.
  faixasEdificios: [
    { ate: 3, rotulo: '0 – 3', cor: '#e9edf2' },
    { ate: 10, rotulo: '4 – 10', cor: '#b9d3f0' },
    { ate: 20, rotulo: '11 – 20', cor: '#7fb0ea' },
    { ate: 30, rotulo: '21 – 30', cor: '#4688dd' },
    { ate: 999, rotulo: '+ 30', cor: '#f4b942' },
  ],

  // Camadas da Base Cadastral consultadas em todo clique (lote, quadra, bairro).
  consultaPadrao: [0, 1, 2],
};

// Rótulos legíveis para os campos mais comuns das camadas do Mapa Fácil.
export const ROTULOS_CAMPOS = {
  id: 'Identificador', nm: 'Nome', nm1: 'Nome', nm_bai: 'Bairro', tp_bai: 'Tipo de bairro',
  nm_lot: 'Lote', nm_qdr: 'Quadra', nm_imovel: 'Imóvel', ci: 'Inscrição cadastral (CI)',
  ci_lot: 'CI do lote', ci_qdr: 'CI da quadra', nm_cond: 'Condomínio', in_cond: 'Condomínio horizontal',
  pop_total: 'População', pop_masc: 'População masculina', pop_fem: 'População feminina',
  id_sis: 'Código do bairro', in_cart: 'Cartório', in_vist: 'Vistoriado',
  nm_mun: 'Município', nm_log: 'Logradouro', tp_log: 'Tipo de logradouro', nm_unc: 'Unidade de conservação',
  tp_unc: 'Tipo', situacao: 'Situação', endereco: 'Endereço', descricao: 'Descrição',
  NM_EDI: 'Edifício', NR_PAV: 'Pavimentos', TL_APT: 'Apartamentos', TL_TERRENO: 'Área do terreno (m²)',
  DT_AVERBAC: 'Data de averbação', CD_EDI: 'Código do edifício', CI: 'Inscrição cadastral (CI)',
  nm_sau: 'Unidade de saúde', in_turno: 'Funcionamento', nr_tele: 'Telefone', cep: 'CEP',
  in_lei181: 'Lei 181', in_lei228: 'Lei 228', IN_LEI8618: 'Lei 8.618', in_puama: 'PUAMA', in_doc: 'Documentação',
  in_tur: 'Interesse turístico', nm_gre: 'Equipamento', nm_phs: 'Patrimônio histórico', nm_prq: 'Parque',
  'shape.STArea()': 'Área (m²)', 'shape.STLength()': 'Perímetro (m)',
};

// Campos técnicos que não interessam na ficha.
export const CAMPOS_OCULTOS = new Set([
  'objectid', 'shape', 'esri_oid', 'created_user', 'created_date', 'last_edited_user',
  'last_edited_date', 'cd_err', 'x_coord', 'y_coord', 'id_dis', 'id_seg', 'id_prc', 'id_pti',
  'id_re7', 'id_mun', 'id_mzo', 'id_qdr', 'id_bai', 'id_lot', 'nm2', 'nm3', 'ql_bai', 'globalid',
]);

// Indicadores 0/1 exibidos como Não/Sim (os demais "in_*" são códigos).
export const CAMPOS_SIM_NAO = new Set(['in_cond', 'in_vist', 'in_lei181', 'in_lei228', 'in_lei8618', 'in_puama', 'in_tur', 'in_metro']);
