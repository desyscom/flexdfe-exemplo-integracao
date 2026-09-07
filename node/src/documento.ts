// Monta o `documento` do `POST /v1/nfe` a partir dos cadastros locais. É o que o seu ERP faz com os
// dados dele; aqui é curto de propósito, para o corpo da emissão ser lido ao lado da Referência.
//
// O que NÃO vai no documento: o emitente (vem da credencial), os totais (a API calcula a partir dos
// itens), `serie` e `numero` (a série está no topo do corpo; o número, em série managed, a plataforma aloca).

import type { Destinatario, Produto } from './banco.ts';
import type { Emitente } from './cliente-api.ts';

export type ItemPedido = { produto: Produto; quantidade: number };
export type PagamentoPedido = { tPag: string; vPag: number };

export type Pedido = {
  modelo: 55 | 65;
  emitente: Emitente;
  /** Obrigatório no 55. Opcional no 65: o consumidor não identificado é o caso comum do balcão. */
  destinatario: Destinatario | null;
  itens: ItemPedido[];
  pagamentos: PagamentoPedido[];
  /** Troco, no nível do documento (irmão de `pag`), não dentro de cada pagamento. */
  vTroco: number;
};

const arred = (n: number): number => Math.round(n * 100) / 100;

export const totalItens = (itens: ItemPedido[]): number => arred(itens.reduce((s, i) => s + arred(i.quantidade * i.produto.valorUnitario), 0));

/**
 * A conferência que a API faria depois: `Σ vPag − vTroco = vNF`, com tolerância de um centavo. Na API a
 * divergência é um ALERTA (não bloqueia), e é o erro mais comum da NFC-e. Conferir antes de enviar é o que
 * evita descobrir a divergência olhando o resultado.
 */
export function divergenciaPagamento(pedido: Pick<Pedido, 'itens' | 'pagamentos' | 'vTroco'>): string | null {
  const total = totalItens(pedido.itens);
  const liquido = arred(pedido.pagamentos.reduce((s, p) => s + p.vPag, 0) - pedido.vTroco);
  if (Math.abs(liquido - total) <= 0.01) return null;
  return `pagamentos (${liquido.toFixed(2)}) não fecham com o total dos itens (${total.toFixed(2)})`;
}

/** Simples Nacional e MEI classificam por `csosn`; Regime Normal e Simples com excesso, por `cst`. */
export const variantePorCrt = (crt: number): 'simples' | 'normal' => (crt === 1 || crt === 4 ? 'simples' : 'normal');

export function montarDocumento(pedido: Pedido): Record<string, unknown> {
  const { modelo, emitente, destinatario } = pedido;
  const variante = variantePorCrt(emitente.crt);
  const internaOuInterestadual = destinatario && destinatario.uf !== emitente.uf ? 2 : 1;

  const documento: Record<string, unknown> = {
    ide: {
      mod: modelo,
      natOp: 'VENDA',
      tpNF: 1, // saída
      idDest: modelo === 65 ? 1 : internaOuInterestadual,
      tpImp: modelo === 65 ? 4 : 1, // 4 = DANFE NFC-e; 1 = DANFE retrato
      finNFe: 1, // normal
      indFinal: 1, // consumidor final
      indPres: 1, // operação presencial
    },
    itens: pedido.itens.map((item) => montarItem(item, variante)),
    pag: pedido.pagamentos.map((p) => ({ tPag: p.tPag, vPag: p.vPag })),
    transp: { modFrete: 9 }, // sem frete
  };
  if (pedido.vTroco > 0) documento.vTroco = pedido.vTroco;
  if (destinatario) documento.dest = montarDestinatario(destinatario);
  return documento;
}

function montarDestinatario(d: Destinatario): Record<string, unknown> {
  return {
    ...(d.documento.length === 14 ? { CNPJ: d.documento } : { CPF: d.documento }),
    xNome: d.nome,
    endereco: { uf: d.uf, cMun: d.codMunicipio, xLgr: d.logradouro, nro: d.numero, xBairro: d.bairro, xMun: d.municipio, CEP: d.cep },
    indIEDest: '9', // não contribuinte
  };
}

function montarItem({ produto, quantidade }: ItemPedido, variante: 'simples' | 'normal'): Record<string, unknown> {
  const vProd = arred(quantidade * produto.valorUnitario);
  return {
    prod: {
      cProd: produto.codigo,
      cEAN: 'SEM GTIN',
      xProd: produto.descricao,
      NCM: produto.ncm,
      CFOP: produto.cfop,
      uCom: produto.unidade,
      qCom: quantidade,
      vUnCom: produto.valorUnitario,
      vProd,
      cEANTrib: 'SEM GTIN',
      uTrib: produto.unidade,
      qTrib: quantidade,
      vUnTrib: produto.valorUnitario,
      indTot: 1,
    },
    imposto: variante === 'simples' ? impostoSimples(produto) : impostoNormal(produto, vProd),
  };
}

/** Simples: o ICMS vai pelo CSOSN sem destaque; PIS e COFINS com CST 49 zerados (recolhidos no DAS, mas o grupo é obrigatório). */
function impostoSimples(p: Produto): Record<string, unknown> {
  return {
    ICMS: { orig: '0', csosn: p.csosn },
    PIS: { cst: '49', vBC: 0, pPIS: 0, vPIS: 0 },
    COFINS: { cst: '49', vBC: 0, pCOFINS: 0, vCOFINS: 0 },
  };
}

/** Regime Normal: CST com o ICMS destacado em `proprio`; PIS e COFINS no regime cumulativo (0,65% e 3%). */
function impostoNormal(p: Produto, vProd: number): Record<string, unknown> {
  return {
    ICMS: { orig: '0', cst: p.cst, proprio: { modBC: '3', vBC: vProd, pICMS: p.aliquotaIcms, vICMS: arred((vProd * p.aliquotaIcms) / 100) } },
    PIS: { cst: '01', vBC: vProd, pPIS: 0.65, vPIS: arred(vProd * 0.0065) },
    COFINS: { cst: '01', vBC: vProd, pCOFINS: 3, vCOFINS: arred(vProd * 0.03) },
  };
}

/** Formas de pagamento oferecidas pela tela. A tabela completa (`tPag`) está na Referência. */
export const FORMAS_PAGAMENTO: [codigo: string, nome: string][] = [
  ['01', 'Dinheiro'],
  ['03', 'Cartão de crédito'],
  ['04', 'Cartão de débito'],
  ['17', 'PIX'],
];
