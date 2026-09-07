// O único caminho que muda o status local de uma nota depois da emissão. O feed e o webhook entram
// pela mesma porta, `aplicarEvento`, por isso o que um faz o outro faz igual.
//
// Três regras que o feed exige de quem o consome:
//   1. Aplicar é idempotente por `seq`: o mesmo evento visto duas vezes não tem efeito na segunda.
//      É o que torna seguro reler de um cursor antigo, e receber o webhook em duplicidade.
//   2. O cursor é gravado DEPOIS de aplicar a página inteira. Se o processo cair no meio, a próxima
//      leitura repete a página, e a regra 1 absorve a repetição.
//   3. Tipo desconhecido é gravado e ignorado. A lista de tipos é aberta; um consumidor que quebra
//      num tipo novo para de receber os que conhece.

import type { Banco, Evento } from './banco.ts';
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
export async function aplicarEvento({ banco, cliente, operacional }: Aplicador, evento: EventoFeed, origem: Evento['origem']): Promise<string> {
  if (banco.temEvento(evento.seq)) return 'repetido: já aplicado, sem efeito';

  let efeito: string;
  if (evento.type !== 'nfe.emit') {
    efeito = `ignorado: tipo ${evento.type} não é tratado por esta tela`;
  } else {
    const nota = banco.lerNotaPorComando(evento.commandId);
    if (!nota) {
      efeito = 'ignorado: comando não é de uma nota deste banco local';
    } else if (!ehTerminal(evento.status)) {
      banco.gravarDesfecho(nota.id, { status: evento.status, outcome: evento.outcome, confirmadoPor: origem });
      efeito = `aplicado: nota ${nota.id} segue ${evento.status}`;
    } else {
      // O evento diz COMO terminou (status, outcome). O número, a chave e a situação de nível-nota vêm da
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
      efeito = `aplicado: nota ${nota.id} ${detalhe.situacao} (${evento.status}${evento.outcome ? '/' + evento.outcome : ''})`;
    }
  }

  banco.gravarEvento({ seq: evento.seq, commandId: evento.commandId, type: evento.type, status: evento.status, outcome: evento.outcome, origem, efeito });
  return efeito;
}

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
