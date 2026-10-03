// O único caminho que CONFIRMA o desfecho de uma nota depois da emissão (é ele que grava `confirmadoPor`), e o que
// fecha as operações sobre ela (cancelamento, carta, inutilização). A resposta da emissão e a releitura de uma
// consulta também gravam status e situação, mas não confirmam nada. O feed e o webhook entram pela mesma porta,
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
//
// A NFS-e é outra família, com os mesmos três cuidados e o mesmo caminho: `nfse.emit` aponta a NFS-e, e
// `nfse.cancel`, o comando novo do cancelamento. O webhook é um só e leva as duas famílias, e o `type` as
// distingue. Já os feeds são dois (`/v1/nfe/events` só com `nfe.*`, `/v1/nfse/events` só com `nfse.*`), e cada
// um tem o seu cursor: as duas famílias dividem a numeração do `seq`, então o feed de uma enxerga, como buracos,
// os `seq` da outra. Por dividirem a numeração, o `seq` é único entre elas, e a tabela de eventos é uma só.

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
  else if (evento.type === 'nfse.emit') efeito = await aplicarEmissaoNfse(aplicador, evento, origem);
  else if (evento.type === 'nfse.cancel') efeito = await aplicarOperacaoNfse(aplicador, evento, origem);
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
 * O mesmo da emissão da NF-e, para a NFS-e. O evento diz COMO terminou (status, outcome); a situação, os números e a
 * chave vêm da leitura da NFS-e, que traz o que a tela precisa mostrar e o que só a SEFIN calcula.
 */
async function aplicarEmissaoNfse({ banco, cliente, operacional }: Aplicador, evento: EventoFeed, origem: Evento['origem']): Promise<string> {
  const nfse = banco.lerNfsePorComando(evento.commandId);
  if (!nfse) return 'ignorado: comando não é de uma NFS-e deste banco local';
  if (!ehTerminal(evento.status)) {
    banco.gravarDesfechoNfse(nfse.id, { status: evento.status, outcome: evento.outcome, confirmadoPor: origem });
    return `aplicado: NFS-e ${nfse.id} segue ${evento.status}`;
  }
  const detalhe = (await cliente.lerNfse(operacional, evento.commandId)).corpo;
  banco.gravarDesfechoNfse(nfse.id, {
    status: evento.status,
    outcome: evento.outcome,
    numeroDps: detalhe.numeroDps,
    numeroNfse: detalhe.numeroNfse,
    chave: detalhe.chave,
    situacao: detalhe.situacao,
    confirmadoPor: origem,
    ultimoResultado: JSON.stringify(detalhe),
  });
  const efeito = `aplicado: NFS-e ${nfse.id} ${detalhe.situacao} (${evento.status}${evento.outcome ? '/' + evento.outcome : ''})`;

  // A substituta autorizada muda a ORIGINAL: a SEFIN gera a substituta e cancela a original no mesmo envio, e quem
  // a emitiu é esta aplicação, que só fica sabendo relendo-a. A original é de outro comando, sem evento próprio.
  const original = nfse.substitui === null ? null : banco.lerNfse(nfse.substitui);
  if (original?.commandId && detalhe.situacao === 'autorizada') {
    const relida = (await cliente.lerNfse(operacional, original.commandId)).corpo;
    banco.gravarDesfechoNfse(original.id, { status: original.status ?? relida.status, outcome: original.outcome, situacao: relida.situacao, ultimoResultado: JSON.stringify(relida) });
    return `${efeito}; NFS-e ${original.id} ${relida.situacao}`;
  }
  return efeito;
}

/**
 * Fecha uma operação sobre a NFS-e: o cancelamento. O item do feed (`nfse.cancel`) sai SEM `outcome`, então quem diz
 * como a tentativa terminou é a leitura dela (`registrada`, `rejeitada`, `falha`), e o efeito na NFS-e vem de reler
 * a NFS-e. A consulta não tem evento.
 */
async function aplicarOperacaoNfse({ banco, cliente, operacional }: Aplicador, evento: EventoFeed, origem: Evento['origem']): Promise<string> {
  const operacao = banco.lerOperacaoPorComando(evento.commandId);
  if (!operacao || operacao.nfseId === null) return 'ignorado: comando não é de uma operação de NFS-e deste banco local';
  if (!ehTerminal(evento.status)) {
    banco.gravarDesfechoOperacao(operacao.id, { status: evento.status, outcome: evento.outcome, confirmadoPor: origem });
    return `aplicado: ${operacao.tipo} ${operacao.id} segue ${evento.status}`;
  }
  const nfse = banco.lerNfse(operacao.nfseId);
  if (!nfse?.commandId) return `ignorado: a NFS-e ${operacao.nfseId} da operação não tem comando na API`;

  const tentativa = (await cliente.lerCancelamentoNfse(operacional, nfse.commandId)).corpo;
  banco.gravarDesfechoOperacao(operacao.id, { status: evento.status, outcome: evento.outcome, confirmadoPor: origem, situacao: tentativa.situacao, ultimoResultado: JSON.stringify(tentativa) });
  // O cancelamento registrado muda a SITUAÇÃO da NFS-e (autorizada → cancelada), não o comando de emissão.
  const detalhe = (await cliente.lerNfse(operacional, nfse.commandId)).corpo;
  banco.gravarDesfechoNfse(nfse.id, { status: nfse.status ?? detalhe.status, outcome: nfse.outcome, situacao: detalhe.situacao, ultimoResultado: JSON.stringify(detalhe) });
  return `aplicado: cancelamento ${operacao.id} ${tentativa.situacao}; NFS-e ${nfse.id} ${detalhe.situacao}`;
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
export async function puxarFeed(aplicador: Aplicador, familia: 'nfe' | 'nfse' = 'nfe', limitePaginas = 10): Promise<ResumoPuxada> {
  const { banco, cliente, operacional } = aplicador;
  // Cada família tem o seu feed e o seu cursor: os dois dividem o `seq`, e um cursor só pularia eventos do outro.
  const desde = familia === 'nfe' ? banco.configuracao().cursorFeed : banco.configuracao().cursorFeedNfse;
  const resumo: ResumoPuxada = { desde, ate: desde, paginas: 0, recebidos: 0, efeitos: [] };

  for (let pagina = 0; pagina < limitePaginas; pagina++) {
    const { corpo } = familia === 'nfe' ? await cliente.lerFeed(operacional, resumo.ate) : await cliente.lerFeedNfse(operacional, resumo.ate);
    resumo.paginas++;
    if (corpo.events.length === 0) break;
    for (const evento of corpo.events) {
      resumo.recebidos++;
      resumo.efeitos.push(`seq ${evento.seq} · ${evento.type} ${evento.status}${evento.outcome ? '/' + evento.outcome : ''} → ${await aplicarEvento(aplicador, evento, 'feed')}`);
    }
    // Só agora, com a página aplicada, o cursor avança.
    if (familia === 'nfe') banco.gravarCursorFeed(corpo.nextCursor);
    else banco.gravarCursorFeedNfse(corpo.nextCursor);
    resumo.ate = corpo.nextCursor;
  }
  return resumo;
}
