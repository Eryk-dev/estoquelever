export const LIMITACAO_BUSCA_DIRETA_ML =
  "A busca direta do Mercado Livre não indexa todos os SKUs armazenados apenas nas variações do anúncio.";

export type ResultadoVerificacaoDiretaMl =
  | {
      sku: string;
      situacao: "com_anuncio";
      conclusivo: true;
      anuncios_ativos: number;
      contas_consultadas: number;
      contas_com_erro: Array<{
        conexao_id: string;
        nickname: string;
        erro: string;
      }>;
      limitacao: null;
    }
  | {
      sku: string;
      situacao: "inconclusivo_busca_direta";
      conclusivo: false;
      anuncios_ativos: 0;
      contas_consultadas: number;
      contas_com_erro: [];
      limitacao: string;
    };
