// Monta o `documento` do `POST /v1/nfse`: a DPS, a declaração que a SEFIN transforma em NFS-e. É o que o seu ERP
// faz com os dados dele; aqui é o mínimo de ponta a ponta, para o corpo da emissão ser lido ao lado da Referência.
//
// O que NÃO vai no documento, porque a plataforma resolve e ignora o que vier: o prestador (CNPJ, inscrição
// municipal e telefone saem do cadastro do emitente, e o município emissor também), o `dhEmi`, a série, o número,
// o `tpEmit` e o ambiente. O regime do prestador (`opSimpNac`, `regApTribSN`) deriva do CRT do cadastro.

export type PedidoNfse = {
  /** `AAAA-MM-DD`: é por ela que o ISSQN se apura. */
  competencia: string;
  /** CPF (11 dígitos) ou CNPJ (14 caracteres, as 12 primeiras podendo ser letras), sem pontuação. */
  tomadorDocumento: string;
  tomadorNome: string;
  /** O município onde o serviço foi prestado: código IBGE de 7 dígitos. */
  municipioPrestacao: string;
  /** O código de tributação nacional do ISSQN, 6 dígitos. */
  codigoTributacaoNacional: string;
  descricaoServico: string;
  valorServico: number;
  /** O percentual aproximado dos tributos do Simples Nacional. Só vai para o ME/EPP; os demais regimes o ignoram. */
  percentualSimples: number | null;
};

/**
 * ME/EPP (CRT 1 e 2) é `opSimpNac` 3, e o ramo `indTotTrib` ("sem informação de tributos") lhe é vedado: a SEFIN
 * recusa com E0712, porque a lei da transparência exige o percentual do Simples. Nos outros regimes (CRT 3, e o MEI,
 * CRT 4) a regra não veda o `indTotTrib`, e é o ramo que este exemplo manda.
 */
export const exigePercentualSimples = (crt: number): boolean => crt === 1 || crt === 2;

/**
 * O E0063 recusa a substituta que muda a competência, o valor ou o tomador da original quando o prestador era ME/EPP na
 * original e, na competência da substituta, continua ME/EPP ou passa a MEI. Pelo CRT de hoje, a substituta de um ME/EPP
 * (CRT 1 e 2) ou de um MEI (CRT 4) pode cair nele; a do Regime Normal (CRT 3) não. O regime da ORIGINAL a tela não sabe:
 * por isso o aviso é condicional, e quem decide é quem conhece o histórico do prestador.
 */
export const podeSofrerE0063 = (crt: number): boolean => crt === 1 || crt === 2 || crt === 4;

export const ehCpf =(documento: string): boolean => /^\d{11}$/.test(documento);
/** CNPJ alfanumérico: as 12 primeiras posições podem ser letras, as 2 últimas são dígitos. */
export const ehCnpj = (documento: string): boolean => /^[0-9A-Z]{12}\d{2}$/.test(documento);

export function montarDps(pedido: PedidoNfse, crt: number): Record<string, unknown> {
  return {
    dCompet: pedido.competencia,
    toma: {
      ...(ehCpf(pedido.tomadorDocumento) ? { cpf: pedido.tomadorDocumento } : { cnpj: pedido.tomadorDocumento }),
      razaoSocial: pedido.tomadorNome,
    },
    serv: {
      cLocPrestacao: pedido.municipioPrestacao,
      cTribNac: pedido.codigoTributacaoNacional,
      xDescServ: pedido.descricaoServico,
    },
    valores: {
      vServ: pedido.valorServico,
      // O mínimo do `tribMun`: tribISSQN 1 = tributável, e tpRetISSQN 1 = ISSQN não retido.
      tribMun: { tribISSQN: '1', tpRetISSQN: '1' },
      totTrib: exigePercentualSimples(crt) ? { pTotTribSN: pedido.percentualSimples } : { indTotTrib: '0' },
    },
  };
}
