import type { Decisao } from "@/types";

interface MockSeparacaoItem {
  produto_id: number;
  sku: string;
  gtin: string | null;
  descricao: string;
  quantidade_pedida: number;
  quantidade_bipada: number;
  bipado_completo: boolean;
  localizacao: string | null;
}

interface PedidoSeparacaoMock {
  id: string;
  numero: string;
  data: string;
  cliente_nome: string;
  nome_ecommerce: string;
  forma_envio_descricao: string;
  status_separacao: string;
  decisao?: Decisao | null;
  separado_por?: string | null;
  embalado_em?: string | null;
  etiqueta_status?: string | null;
  itens: MockSeparacaoItem[];
}

export const mockSeparacaoPedidos: PedidoSeparacaoMock[] = [
  // ─── Aguardando NF ────────────────────────────────────────────────────────
  {
    id: "sep-001",
    numero: "1048280",
    data: "2026-03-10T08:10:00Z",
    cliente_nome: "Marcos Vinícius Almeida",
    nome_ecommerce: "Mercado Livre",
    forma_envio_descricao: "Mercado Envios Full",
    status_separacao: "aguardando_nf",
    decisao: "propria",
    itens: [
      {
        produto_id: 80001,
        sku: "19-0432",
        gtin: "7898456123001",
        descricao: "Pastilha de Freio Dianteira Cerâmica - Civic 2018/2022",
        quantidade_pedida: 2,
        quantidade_bipada: 0,
        bipado_completo: false,
        localizacao: "A-12-03",
      },
      {
        produto_id: 80002,
        sku: "19-0871",
        gtin: "7898456123002",
        descricao: "Disco de Freio Ventilado 280mm - Civic 2018/2022",
        quantidade_pedida: 2,
        quantidade_bipada: 0,
        bipado_completo: false,
        localizacao: "A-12-05",
      },
    ],
  },
  {
    id: "sep-002",
    numero: "1048281",
    data: "2026-03-10T06:30:00Z", // > 2h ago => overdue
    cliente_nome: "Fernanda Cristina Barbosa",
    nome_ecommerce: "Shopee",
    forma_envio_descricao: "Shopee Envios Standard",
    status_separacao: "aguardando_nf",
    decisao: "transferencia",
    itens: [
      {
        produto_id: 80003,
        sku: "LD-7821",
        gtin: "7898456123003",
        descricao: "Amortecedor Dianteiro Esquerdo - Corolla 2020/2024",
        quantidade_pedida: 1,
        quantidade_bipada: 0,
        bipado_completo: false,
        localizacao: "C-03-07",
      },
    ],
  },

  // ─── Pendentes (em separação) ─────────────────────────────────────────────
  {
    id: "sep-003",
    numero: "1048282",
    data: "2026-03-10T09:15:00Z",
    cliente_nome: "Ricardo José Santos",
    nome_ecommerce: "Mercado Livre",
    forma_envio_descricao: "Mercado Envios Coleta",
    status_separacao: "pendente",
    decisao: "propria",
    itens: [
      {
        produto_id: 80004,
        sku: "G-44021",
        gtin: "7898456123004",
        descricao: "Sensor de Rotação ABS Traseiro - HB20 2016/2022",
        quantidade_pedida: 1,
        quantidade_bipada: 0,
        bipado_completo: false,
        localizacao: "E-08-01",
      },
      {
        produto_id: 80005,
        sku: "M-22091",
        gtin: "7898456123005",
        descricao: "Bieleta Barra Estabilizadora Dianteira - HB20 2016/2022",
        quantidade_pedida: 2,
        quantidade_bipada: 1,
        bipado_completo: false,
        localizacao: "E-09-04",
      },
      {
        produto_id: 80006,
        sku: "TH-3120",
        gtin: "7898456123006",
        descricao: "Kit Coxim Superior Amortecedor - HB20 2016/2022",
        quantidade_pedida: 2,
        quantidade_bipada: 2,
        bipado_completo: true,
        localizacao: "C-03-12",
      },
    ],
  },
  {
    id: "sep-004",
    numero: "1048283",
    data: "2026-03-10T09:40:00Z",
    cliente_nome: "Luciana Aparecida Ferreira",
    nome_ecommerce: "Mercado Livre",
    forma_envio_descricao: "Mercado Envios Full",
    status_separacao: "pendente",
    decisao: "propria",
    itens: [
      {
        produto_id: 80007,
        sku: "L0-5540",
        gtin: "7898456123007",
        descricao: "Terminal de Direção Esquerdo - Tracker 2021/2025",
        quantidade_pedida: 1,
        quantidade_bipada: 0,
        bipado_completo: false,
        localizacao: "G-01-03",
      },
      {
        produto_id: 80008,
        sku: "L0-5541",
        gtin: "7898456123008",
        descricao: "Terminal de Direção Direito - Tracker 2021/2025",
        quantidade_pedida: 1,
        quantidade_bipada: 0,
        bipado_completo: false,
        localizacao: "G-01-04",
      },
    ],
  },
  {
    id: "sep-005",
    numero: "1048284",
    data: "2026-03-10T10:00:00Z",
    cliente_nome: "Paulo Henrique Nascimento",
    nome_ecommerce: "Shopee",
    forma_envio_descricao: "Shopee Envios Standard",
    status_separacao: "em_separacao",
    decisao: "propria",
    itens: [
      {
        produto_id: 80009,
        sku: "CAK-0912",
        gtin: "7898456123009",
        descricao: "Bomba de Combustível Elétrica - Onix 2017/2023",
        quantidade_pedida: 1,
        quantidade_bipada: 1,
        bipado_completo: true,
        localizacao: "D-02-01",
      },
      {
        produto_id: 80010,
        sku: "CS-4410",
        gtin: "7898456123010",
        descricao: "Bobina de Ignição - Onix 2017/2023",
        quantidade_pedida: 4,
        quantidade_bipada: 3,
        bipado_completo: false,
        localizacao: "D-05-02",
      },
    ],
  },
  {
    id: "sep-006",
    numero: "1048285",
    data: "2026-03-10T10:20:00Z",
    cliente_nome: "Camila Rodrigues Lima",
    nome_ecommerce: "Mercado Livre",
    forma_envio_descricao: "Mercado Envios Full",
    status_separacao: "pendente",
    decisao: "transferencia",
    itens: [
      {
        produto_id: 80011,
        sku: "19-0550",
        gtin: "7898456123011",
        descricao: "Correia Dentada Motor - Fit 2015/2021",
        quantidade_pedida: 1,
        quantidade_bipada: 0,
        bipado_completo: false,
        localizacao: "A-05-02",
      },
    ],
  },

  // ─── Embalados ────────────────────────────────────────────────────────────
  {
    id: "sep-007",
    numero: "1048270",
    data: "2026-03-10T08:30:00Z",
    cliente_nome: "Anderson Luis Oliveira",
    nome_ecommerce: "Mercado Livre",
    forma_envio_descricao: "Mercado Envios Full",
    status_separacao: "embalado",
    decisao: "propria",
    separado_por: "Eryk",
    embalado_em: "2026-03-10T09:45:00Z",
    etiqueta_status: "impresso",
    itens: [
      {
        produto_id: 80012,
        sku: "19-1120",
        gtin: "7898456123012",
        descricao: "Filtro de Óleo Motor - Hilux 2016/2023",
        quantidade_pedida: 1,
        quantidade_bipada: 1,
        bipado_completo: true,
        localizacao: "A-01-01",
      },
    ],
  },
  {
    id: "sep-008",
    numero: "1048271",
    data: "2026-03-10T08:45:00Z",
    cliente_nome: "Tatiana Souza Pereira",
    nome_ecommerce: "Shopee",
    forma_envio_descricao: "Shopee Envios Standard",
    status_separacao: "embalado",
    decisao: "propria",
    separado_por: "Eryk",
    embalado_em: "2026-03-10T10:10:00Z",
    etiqueta_status: "falhou",
    itens: [
      {
        produto_id: 80013,
        sku: "G-33012",
        gtin: "7898456123013",
        descricao: "Sensor de Temperatura Água Motor - Onix 2020/2024",
        quantidade_pedida: 1,
        quantidade_bipada: 1,
        bipado_completo: true,
        localizacao: "E-02-01",
      },
      {
        produto_id: 80014,
        sku: "TH-2200",
        gtin: "7898456123014",
        descricao: "Pivô de Suspensão Inferior Esquerdo - T-Cross 2019/2024",
        quantidade_pedida: 1,
        quantidade_bipada: 1,
        bipado_completo: true,
        localizacao: "C-04-01",
      },
    ],
  },
  {
    id: "sep-009",
    numero: "1048272",
    data: "2026-03-10T09:00:00Z",
    cliente_nome: "Diego Martins Costa",
    nome_ecommerce: "Mercado Livre",
    forma_envio_descricao: "Mercado Envios Coleta",
    status_separacao: "embalado",
    decisao: "transferencia",
    separado_por: "Eryk",
    embalado_em: "2026-03-10T10:30:00Z",
    etiqueta_status: "impresso",
    itens: [
      {
        produto_id: 80015,
        sku: "LD-4220",
        gtin: "7898456123015",
        descricao: "Mola Helicoidal Dianteira - Creta 2017/2024",
        quantidade_pedida: 2,
        quantidade_bipada: 2,
        bipado_completo: true,
        localizacao: "C-06-03",
      },
    ],
  },

  // ─── Expedidos ────────────────────────────────────────────────────────────
  {
    id: "sep-010",
    numero: "1048250",
    data: "2026-03-10T07:00:00Z",
    cliente_nome: "Maria Helena Campos",
    nome_ecommerce: "Mercado Livre",
    forma_envio_descricao: "Mercado Envios Full",
    status_separacao: "expedido",
    decisao: "propria",
    separado_por: "Eryk",
    embalado_em: "2026-03-10T07:45:00Z",
    etiqueta_status: "impresso",
    itens: [
      {
        produto_id: 80016,
        sku: "19-0220",
        gtin: "7898456123016",
        descricao: "Jogo de Velas de Ignição - Civic 2018/2022",
        quantidade_pedida: 4,
        quantidade_bipada: 4,
        bipado_completo: true,
        localizacao: "A-10-01",
      },
    ],
  },
  {
    id: "sep-011",
    numero: "1048251",
    data: "2026-03-10T07:20:00Z",
    cliente_nome: "José Carlos Ribeiro",
    nome_ecommerce: "Mercado Livre",
    forma_envio_descricao: "Mercado Envios Coleta",
    status_separacao: "expedido",
    decisao: "propria",
    separado_por: "Eryk",
    embalado_em: "2026-03-10T08:00:00Z",
    etiqueta_status: "impresso",
    itens: [
      {
        produto_id: 80017,
        sku: "M-15500",
        gtin: "7898456123017",
        descricao: "Bucha Estabilizadora Traseira - Compass 2017/2023",
        quantidade_pedida: 2,
        quantidade_bipada: 2,
        bipado_completo: true,
        localizacao: "F-03-05",
      },
    ],
  },
];
