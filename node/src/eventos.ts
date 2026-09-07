// O único caminho que muda o status local de uma nota depois da emissão, e o que fecha as operações
// sobre ela (cancelamento, carta, inutilização). O feed e o webhook entram pela mesma porta,
// `aplicarEvento`, por isso o que um faz o outro faz igual.
//
// Três regras que o feed exige de quem o consome:
//   1. Aplicar é idempotente por `seq`: o mesmo evento visto duas vezes não tem efeito na segunda.
//      É o que torna seguro reler de um cursor antigo, e receber o webhook em duplicidade.
//   2. O cursor é gravado DEPOIS de aplicar a página inteira. Se o processo cair no meio, a próxima
//      leitura repete a página, e a regra 1 absorve a repetição.
//   3. Tipo desconhecido é gravado e ignorado. A lista de tipos é aberta; um consumidor que quebra
//      num tipo novo para de receber os que conhece.
//
// O `type` diz O QUE o comando era; `status` e `outcome` dizem COMO terminou. `nfe.emit` é a emissão e
// aponta a nota. `nfe.cancel`, `nfe.cce` e `nfe.inutiliza` apontam o comando NOVO que o aceite da
// operação devolveu, não a nota: é pela tabela `operacao` que se chega dela à nota. A consulta
// (`POST /v1/nfe/{id}/consulta`) não gera evento: o resultado dela vem ao reler a nota.

import type { Banco, Evento, Operacao } from './banco.ts';
import type { ClienteApi, EventoFeed } from './cliente-api.ts';
import type { Credencial } from './config.ts';

export type Aplicador = { banco: Banco; cliente: ClienteApi; operacional: Credencial };

/** Os status terminais do comando. `sealed` não é terminal: é a nota lacrada aguardando transmissão. */
export const ehTerminal = (status: string): boolean => status === 'completed' || status === 'failed' || status === 'blocked';

/**
 * Aplica um evento ao banco local e devolve o efeito, em texto, para o histórico. O evento entra na
 * tabela `evento` sempre, com o efeito que teve, para o programador ver o que chegou e o que a
 * aplicação fez com cada um.
 */
export async function aplicarEvento(aplicador: Aplicador, evento: EventoFeed, origem: Evento['origem']): Promise<string> {
  const { banco } = aplicador;
  if (banco.temEvento(evento.seq)) return 'repetido: já aplicado, sem efeito';

  let efeito: string;
  if (evento.type === 'nfe.emit') efeito = await aplicarEmissao(aplicador, evento, origem);
  else if (evento.type === 'nfe.cancel' || evento.type === 'nfe.cce' || evento.type === 'nfe.inutiliza') efeito = await aplicarOperacao(aplicador, evento, origem);
  else efeito = `ignorado: tipo ${evento.type} não é tratado por esta tela`;

  banco.gravarEvento({ seq: evento.seq, commandId: evento.commandId, type: evento.type, status: evento.status, outcome: evento.outcome, origem, efeito });
  return efeito;
}

async function aplicarEmissao({ banco, cliente, operacional }: Aplicador, evento: EventoFeed, origem: Evento['origem']): Promise<string> {
  const nota = banco.lerNotaPorComando(evento.commandId);
  if (!nota) return 'ignorado: comando não é de uma nota deste banco local';
  if (!ehTerminal(evento.status)) {
    banco.gravarDesfecho(nota.id, { status: evento.status, outcome: evento.outcome, confirmadoPor: origem });
    return `aplicado: nota ${nota.id} segue ${evento.status}`;
  }
  // O evento diz COMO terminou (status, outcome). O número, a chave, a situação e o motivo vêm da
  // leitura da nota. É uma chamada a mais, e é a que traz o que a tela precisa mostrar.
  const detalhe = (await cliente.lerNota(operacional, evento.commandId)).corpo;
  banco.gravarDesfecho(nota.id, {
    status: evento.status,
    outcome: evento.outcome,
    numero: detalhe.numero,
    chave: detalhe.chave,
    protocolo: detalhe.protocolo,
    situacao: detalhe.situacao,
    confirmadoPor: origem,
    ultimoResultado: JSON.stringify(detalhe),
  });
  return `aplicado: nota ${nota.id} ${detalhe.situacao} (${evento.status}${evento.outcome ? '/' + evento.outcome : ''})`;
}

/**
 * Fecha uma operação. O desfecho de nível-comando (status, outcome) vem no evento; a situação própria da
 * operação e o efeito na nota vêm de uma leitura: a tentativa de cancelamento, o histórico das cartas,
 * a própria nota. A inutilização não tem leitura própria; o evento basta.
 */
async function aplicarOperacao({ banco, cliente, operacional }: Aplicador, evento: EventoFeed, origem: Evento['origem']): Promise<string> {
  const operacao = banco.lerOperacaoPorComando(evento.commandId);
  if (!operacao) return 'ignorado: comando não é de uma operação deste banco local';
  if (!ehTerminal(evento.status)) {
    banco.gravarDesfechoOperacao(operacao.id, { status: evento.status, outcome: evento.outcome, confirmadoPor: origem });
    return `aplicado: ${operacao.tipo} ${operacao.id} segue ${evento.status}`;
  }

  const nota = operacao.notaId === null ? null : banco.lerNota(operacao.notaId);
  const comum = { status: evento.status, outcome: evento.outcome, confirmadoPor: origem };
  let situacao: string;

  if (operacao.tipo === 'cancelamento' && nota?.commandId) {
    const tentativa = (await cliente.lerCancelamento(operacional, nota.commandId)).corpo;
    situacao = tentativa.situacao;
    banco.gravarDesfechoOperacao(operacao.id, { ...comum, situacao, ultimoResultado: JSON.stringify(tentativa) });
    // O cancelamento registrado muda a SITUAÇÃO da nota (autorizada → cancelada), não o comando de emissão.
    const detalhe = (await cliente.lerNota(operacional, nota.commandId)).corpo;
    banco.gravarDesfecho(nota.id, { status: nota.status ?? detalhe.status, outcome: nota.outcome, situacao: detalhe.situacao, ultimoResultado: JSON.stringify(detalhe) });
    return `aplicado: cancelamento ${operacao.id} ${situacao}; nota ${nota.id} ${detalhe.situacao}`;
  }

  if (operacao.tipo === 'carta' && nota?.commandId) {
    const cartas = (await cliente.listarCce(operacional, nota.commandId)).corpo.dados;
    const carta = cartas.find((c) => c.id === operacao.commandId);
    situacao = carta?.situacao ?? situacaoPeloEvento(evento);
    banco.gravarDesfechoOperacao(operacao.id, { ...comum, situacao, ultimoResultado: JSON.stringify(carta ?? null) });
    // A nota segue autorizada: a carta é acessória. Nada a gravar nela.
    return `aplicado: carta ${operacao.id} ${situacao}${carta?.nSeq ? ` (nSeq ${carta.nSeq})` : ''}; nota ${nota.id} segue ${nota.situacao ?? 'como estava'}`;
  }

  situacao = situacaoPeloEvento(evento);
  banco.gravarDesfechoOperacao(operacao.id, { ...comum, situacao });
  return `aplicado: ${operacao.tipo} ${operacao.id} ${situacao}`;
}

/** Sem leitura própria, a situação sai do par (status, outcome), com os nomes que a API usa. */
export function situacaoPeloEvento(e: { status: string; outcome: string | null }): string {
  if (e.status === 'completed') return e.outcome === 'authorized' ? 'registrada' : 'rejeitada';
  if (e.status === 'blocked') return 'bloqueada';
  if (e.status === 'failed') return 'falha';
  return 'processando';
}

/** A situação que a tela mostra para uma operação ainda sem desfecho lido. */
export const situacaoOperacao = (o: Operacao): string => o.situacao ?? (o.status ? situacaoPeloEvento({ status: o.status, outcome: o.outcome }) : 'não enviada');

export type ResumoPuxada = { desde: number; ate: number; paginas: number; recebidos: number; efeitos: string[] };

/**
 * Lê o feed a partir do cursor guardado até esvaziar, aplicando cada página e só então gravando o
 * `nextCursor`. `since` é exclusivo: o cursor guardado é o último `seq` aplicado, e a próxima leitura
 * começa no seguinte. Buracos no `seq` são normais (é cursor opaco, não contador).
 */
export async function puxarFeed(aplicador: Aplicador, limitePaginas = 10): Promise<ResumoPuxada> {
  const { banco, cliente, operacional } = aplicador;
  const desde = banco.configuracao().cursorFeed;
  const resumo: ResumoPuxada = { desde, ate: desde, paginas: 0, recebidos: 0, efeitos: [] };

  for (let pagina = 0; pagina < limitePaginas; pagina++) {
    const { corpo } = await cliente.lerFeed(operacional, resumo.ate);
    resumo.paginas++;
    if (corpo.events.length === 0) break;
    for (const evento of corpo.events) {
      resumo.recebidos++;
      resumo.efeitos.push(`seq ${evento.seq} · ${evento.type} ${evento.status}${evento.outcome ? '/' + evento.outcome : ''} → ${await aplicarEvento(aplicador, evento, 'feed')}`);
    }
    // Só agora, com a página aplicada, o cursor avança.
    banco.gravarCursorFeed(corpo.nextCursor);
    resumo.ate = corpo.nextCursor;
  }
  return resumo;
}
