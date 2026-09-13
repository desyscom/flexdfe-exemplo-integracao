// Tela Notas: a lista com o status local e as ações que a situação permite, e o detalhe de uma nota,
// onde ficam os formulários das operações e o histórico do que já foi feito com ela.
//
//   POST /v1/nfe?wait=                 operacional  reenviar (mesma Idempotency-Key, mesmo corpo: replay)
//                                                   reemitir (chave NOVA, mesmo corpo: só depois de `failed`)
//   GET  /v1/nfe/{id}                  operacional  a ficha da nota, com `correcaoVigente` e os marcos
//   GET  /v1/nfe/{id}/xml              operacional  só na autorizada; antes é 409 nfe-xml-unavailable
//   GET  /v1/nfe/{id}/danfe            operacional  na autorizada e na cancelada; fora disso 409 nfe-danfe-unavailable
//   POST /v1/nfe/{id}/consulta         operacional  pede a verdade à SEFAZ; o resultado vem ao reler a nota
//   POST /v1/nfe/{id}/cancelamento     operacional  só na autorizada; justificativa 15–255; Idempotency-Key
//   POST /v1/nfe/{id}/cce              operacional  só 55 autorizada; texto cumulativo 15–1000; Idempotency-Key
//   GET  /v1/nfe/{id}/cce              operacional  o histórico das cartas
//   GET  /v1/nfe/{id}/cce/{cartaId}/dacce  operacional  o DACCE: só da carta registrada; fora dela 409 nfe-dacce-unavailable
//
// O status desta tela é o LOCAL, e diz quem o pôs ali: a resposta da emissão (o `wait`), o feed ou o
// webhook. A resposta da emissão grava só o `id` e o status inicial, e o desfecho quando o `wait` o traz;
// a confirmação é sempre do feed ou do webhook.
//
// Dois terminais que se parecem e se consertam em lugares diferentes:
//   `failed`  a plataforma parou ANTES da SEFAZ (recusa antecipada, com o caminho do campo no motivo) ou
//             esgotou as tentativas. O número segue livre: reemita com uma chave NOVA.
//   `blocked` a NUMERAÇÃO não deixou a nota sair: a SEFAZ acusou duplicidade, ou a série foi inativada,
//             esgotou ou trocou de modo depois do aceite. O motivo diz o ajuste, que é na série ou na
//             numeração, fora da nota; feito o ajuste, a nota se emite de novo, em Nova nota.
// A tela distingue os dois pelo `status`, nunca pelo texto do motivo.

import { randomUUID } from 'node:crypto';
import type { Banco, Nota, Operacao } from '../banco.ts';
import type { AceiteComando, CartaCorrecao, NotaDetalhe, RepresentacaoComando } from '../cliente-api.ts';
import type { Contexto, Resposta, Rota } from '../app.ts';
import { bruto, html, pagina, resultado, resultadoDeErro, vazio, type Html, type Resultado } from '../html.ts';
import { ehTerminal, situacaoOperacao } from '../eventos.ts';
import { LIMITES, motivoTextoInvalido } from '../texto-sefaz.ts';
import { WAIT_MS } from './nova-nota.ts';

export const telaNotas: Rota = (ctx) => renderizarLista(ctx, null);

/** `GET /notas/:id`: a ficha, os formulários das operações e o histórico. */
export const telaNota: Rota = (ctx) => renderizarDetalhe(ctx, null);

/** `GET /notas/:id/<nome>`: devolvem o arquivo, ou a tela com o erro da API tal como veio. */
export const leiturasNotas: Record<string, Rota> = {
  xml: (ctx) => baixar(ctx, 'xml'),
  danfe: (ctx) => baixar(ctx, 'danfe'),
};

/** `GET /notas/:id/cce/:cartaId/dacce`: o DACCE de uma carta do histórico, pelo mesmo caminho do XML e do DANFE. */
export const leituraDacce: Rota = (ctx) => baixar(ctx, 'dacce');

/** `POST /notas/:id/<nome>`. As da emissão voltam à lista; as operações voltam ao detalhe. */
export const acoesNotas: Record<string, Rota> = {
  reenviar: async (ctx) => renderizarLista(ctx, await reenviar(ctx)),
  reemitir: async (ctx) => renderizarLista(ctx, await reemitir(ctx)),
  consultar: async (ctx) => renderizarDetalhe(ctx, await consultar(ctx)),
  cancelar: async (ctx) => renderizarDetalhe(ctx, await cancelar(ctx)),
  carta: async (ctx) => renderizarDetalhe(ctx, await carta(ctx)),
};

/**
 * O que a resposta da emissão pode gravar. `202`: o aceite, `id` e status inicial. `200` com `outcome`:
 * o `wait` resolveu, e o desfecho é gravado; mas `confirmadoPor` fica vazio até o feed ou o webhook
 * passarem por ele. `200` sem `outcome`: replay de um comando já terminal, que também só traz o aceite.
 */
export function gravarRespostaDaEmissao(banco: Banco, notaId: number, status: number, corpo: RepresentacaoComando | AceiteComando, documento?: unknown): Resultado {
  banco.gravarAceite(notaId, corpo.id, corpo.status, JSON.stringify(corpo));
  if ('outcome' in corpo) {
    const r = corpo.result ?? {};
    banco.gravarDesfecho(notaId, {
      status: corpo.status,
      outcome: corpo.outcome,
      numero: corpo.numero,
      chave: typeof r.chave === 'string' ? r.chave : null,
      protocolo: typeof r.protocolo === 'string' ? r.protocolo : null,
      ultimoResultado: JSON.stringify(corpo),
    });
    return {
      ok: corpo.status === 'completed' && corpo.outcome === 'authorized',
      titulo: `HTTP ${status}: o wait resolveu, ${corpo.status}${corpo.outcome ? ' / ' + corpo.outcome : ''}${corpo.numero ? `, número ${corpo.numero}` : ''}`,
      detalhe: 'Desfecho gravado a partir da resposta. Na tela Notas ele aparece como "do wait" até o feed ou o webhook confirmarem: é o feed a fonte de verdade.',
      corpo: documento ? { resposta: corpo, documentoEnviado: documento } : corpo,
    };
  }
  return {
    ok: true,
    titulo: `HTTP ${status}: aceite, comando ${corpo.id} está ${corpo.status}`,
    detalhe: status === 202 ? 'O wait estourou. A nota fica "processando"; a tela Eventos fecha o desfecho pelo feed, sem intervenção.' : 'Replay de um comando já terminal: só o aceite volta. O desfecho está no feed e em GET /v1/nfe/{id}.',
    corpo: documento ? { resposta: corpo, documentoEnviado: documento } : corpo,
  };
}

// ---------------------------------------------------------------- ações da emissão

async function reenviar({ params, banco, cliente }: Contexto): Promise<Resultado> {
  const nota = banco.lerNota(Number(params.id));
  const operacional = banco.credencialOperacional();
  if (!nota || !operacional) return { ok: false, titulo: 'Nota não encontrada ou credencial ausente' };
  try {
    const resposta = await cliente.emitirNfe(operacional, JSON.parse(nota.corpoEnviado), nota.idempotencyKey, WAIT_MS);
    const r = gravarRespostaDaEmissao(banco, nota.id, resposta.status, resposta.corpo);
    return { ...r!, titulo: `Reenvio com a mesma Idempotency-Key. ${r!.titulo}` };
  } catch (erro) {
    return resultadoDeErro('Reenvio recusado', erro);
  }
}

/**
 * Reemitir é o caminho do `failed`: o mesmo corpo com uma chave NOVA, que a API trata como outra emissão.
 * A nota local que falhou fica no histórico; a nova nasce apontando para ela. Num `blocked` isso não é
 * oferecido: o que barrou a nota foi a numeração, o ajuste acontece fora dela, e só quem opera sabe quando
 * foi feito. Feito o ajuste, a nota se emite de novo em Nova nota.
 */
async function reemitir({ params, banco, cliente }: Contexto): Promise<Resultado> {
  const nota = banco.lerNota(Number(params.id));
  const operacional = banco.credencialOperacional();
  if (!nota || !operacional) return { ok: false, titulo: 'Nota não encontrada ou credencial ausente' };
  if (nota.status !== 'failed') return { ok: false, titulo: `Reemitir só depois de failed; a nota ${nota.id} está ${situacaoLocal(nota)}`, detalhe: nota.status === 'blocked' ? 'blocked não se reemite por aqui: a numeração não deixou a nota sair. Faça o ajuste que o motivo diz e emita a nota de novo em Nova nota.' : undefined };

  const idempotencyKey = randomUUID();
  const novaId = banco.criarNotaPendente({ modelo: nota.modelo, serie: nota.serie, idempotencyKey, corpoEnviado: nota.corpoEnviado, reemitidaDe: nota.id });
  try {
    const resposta = await cliente.emitirNfe(operacional, JSON.parse(nota.corpoEnviado), idempotencyKey, WAIT_MS);
    const r = gravarRespostaDaEmissao(banco, novaId, resposta.status, resposta.corpo);
    return { ...r!, titulo: `Reemissão da nota ${nota.id} como nota ${novaId}, com a chave nova ${idempotencyKey}. ${r!.titulo}` };
  } catch (erro) {
    return resultadoDeErro(`Reemissão recusada; a nota local ${novaId} fica gravada com a chave ${idempotencyKey}`, erro);
  }
}

async function baixar({ params, banco, cliente, chamadas }: Contexto, tipo: 'xml' | 'danfe' | 'dacce'): Promise<Resposta> {
  const nota = banco.lerNota(Number(params.id));
  const operacional = banco.credencialOperacional();
  if (!nota?.commandId || !operacional) return { status: 404, texto: 'Nota sem comando na API, ou credencial ausente.' };
  const base = nota.chave ?? nota.commandId;
  try {
    const arquivo =
      tipo === 'xml' ? await cliente.baixarXml(operacional, nota.commandId)
      : tipo === 'danfe' ? await cliente.baixarDanfe(operacional, nota.commandId)
      : await cliente.baixarDacce(operacional, nota.commandId, params.cartaId);
    const nomePadrao = tipo === 'xml' ? `${base}.xml` : tipo === 'danfe' ? `${base}.pdf` : `${base}-cce-${params.cartaId}.pdf`;
    return { arquivo: { bytes: arquivo.bytes, contentType: arquivo.contentType, nome: arquivo.nome ?? nomePadrao, inline: tipo !== 'xml' } };
  } catch (erro) {
    // A API disse por que não há arquivo: 409 com o type. A tela mostra o envelope, não o esconde.
    const r = resultadoDeErro(`${{ xml: 'XML', danfe: 'DANFE', dacce: 'DACCE' }[tipo]} da nota ${nota.id} indisponível`, erro);
    return { status: 409, html: pagina('Notas', '/notas', html`<h1>Notas</h1>${resultado(r)}<p><a href="/notas">Voltar</a></p>`, chamadas) };
  }
}

// ---------------------------------------------------------------- operações sobre a nota

type Alvo = { nota: Nota & { commandId: string }; operacional: NonNullable<ReturnType<Banco['credencialOperacional']>> };

function alvo({ params, banco }: Contexto): Alvo | Resultado {
  const nota = banco.lerNota(Number(params.id));
  const operacional = banco.credencialOperacional();
  if (!nota || !operacional) return { ok: false, titulo: 'Nota não encontrada ou credencial ausente' };
  if (!nota.commandId) return { ok: false, titulo: `A nota ${nota.id} não tem comando na API: a emissão não voltou`, detalhe: 'Reenvie-a na lista com a mesma chave.' };
  return { nota: nota as Alvo['nota'], operacional };
}

const ehResultado = (a: Alvo | Resultado): a is Resultado => a === null || 'ok' in a;

/**
 * A consulta é assíncrona e não gera evento: o `202` só diz que a SEFAZ vai ser perguntada. O resultado
 * aparece ao reler a nota, e é a releitura que a tela grava. Se a SEFAZ ainda não respondeu, a releitura
 * mostra o de antes; consultar de novo em instantes é o caminho.
 */
async function consultar(ctx: Contexto): Promise<Resultado> {
  const a = alvo(ctx);
  if (ehResultado(a)) return a;
  const { banco, cliente } = ctx;
  const { nota, operacional } = a;
  const operacaoId = banco.criarOperacao({ notaId: nota.id, tipo: 'consulta', idempotencyKey: null, corpoEnviado: null });
  try {
    const aceite = await cliente.consultarNfe(operacional, nota.commandId);
    banco.gravarAceiteOperacao(operacaoId, aceite.corpo.id, aceite.corpo.status, JSON.stringify(aceite.corpo));
    const detalhe = (await cliente.lerNota(operacional, nota.commandId)).corpo;
    gravarLeitura(banco, nota, detalhe);
    banco.gravarDesfechoOperacao(operacaoId, { situacao: 'concluída', ultimoResultado: JSON.stringify(detalhe) });
    return {
      ok: true,
      titulo: `HTTP ${aceite.status}: consulta aceita (comando ${aceite.corpo.id}); a releitura diz ${detalhe.situacao}`,
      detalhe: `A consulta não gera evento no feed: o resultado vem de GET /v1/nfe/{id}. Se a SEFAZ ainda não respondeu, a releitura mostra o de antes; consulte de novo em instantes.${nota.situacao && nota.situacao !== detalhe.situacao ? ` A situação local mudou de ${nota.situacao} para ${detalhe.situacao}.` : ''}`,
      corpo: { aceite: aceite.corpo, releitura: detalhe },
    };
  } catch (erro) {
    return resultadoDeErro('Consulta recusada', erro);
  }
}

/** O que uma releitura de `GET /v1/nfe/{id}` grava na nota. Não é confirmação do feed: `confirmadoPor` fica como está. */
function gravarLeitura(banco: Banco, nota: Nota, detalhe: NotaDetalhe): void {
  banco.gravarDesfecho(nota.id, {
    status: detalhe.status,
    outcome: detalhe.outcome,
    numero: detalhe.numero,
    chave: detalhe.chave,
    protocolo: detalhe.protocolo,
    situacao: detalhe.situacao,
    ultimoResultado: JSON.stringify(detalhe),
  });
}

async function cancelar(ctx: Contexto): Promise<Resultado> {
  const a = alvo(ctx);
  if (ehResultado(a)) return a;
  const { banco, cliente, form } = ctx;
  const { nota, operacional } = a;

  // ---- Conferido na tela, antes de gastar a chamada. A API diria o mesmo, com 409 e 422. ----
  if (!permiteCancelar(nota)) return { ok: false, titulo: `Cancelamento recusado na tela: a nota ${nota.id} está ${situacaoLocal(nota)}; só a autorizada cancela`, detalhe: 'A API responderia 409 nfe-not-cancelable. Uma nota cancelada, rejeitada ou ainda processando não tem o que cancelar.' };
  const justificativa = form.get('justificativa') ?? '';
  const invalida = motivoTextoInvalido(justificativa, 'A justificativa', LIMITES.justificativa.minimo, LIMITES.justificativa.maximo);
  if (invalida) return { ok: false, titulo: `Justificativa recusada na tela, nada foi enviado: ${invalida}`, detalhe: 'A API responderia 422 cancellation-reason-invalid. É a restrição do leiaute da SEFAZ, conferida na borda para não virar rejeição depois.' };

  // ---- A chave e o corpo ficam gravados ANTES da chamada, como na emissão. ----
  const idempotencyKey = randomUUID();
  const corpo = { justificativa };
  const operacaoId = banco.criarOperacao({ notaId: nota.id, tipo: 'cancelamento', idempotencyKey, corpoEnviado: JSON.stringify(corpo) });
  try {
    const aceite = await cliente.cancelarNfe(operacional, nota.commandId, justificativa, idempotencyKey);
    banco.gravarAceiteOperacao(operacaoId, aceite.corpo.id, aceite.corpo.status, JSON.stringify(aceite.corpo));
    return {
      ok: true,
      titulo: `HTTP ${aceite.status}: cancelamento aceito; o comando NOVO ${aceite.corpo.id} está ${aceite.corpo.status}`,
      detalhe: 'A nota segue autorizada até o feed trazer o nfe.cancel desse comando (tela Eventos). A janela de 24h não é conferida aqui: a SEFAZ decide, e a recusa dela chega como desfecho rejeitado.',
      corpo: { enviado: corpo, aceite: aceite.corpo },
    };
  } catch (erro) {
    return resultadoDeErro('Cancelamento recusado pela API', erro);
  }
}

async function carta(ctx: Contexto): Promise<Resultado> {
  const a = alvo(ctx);
  if (ehResultado(a)) return a;
  const { banco, cliente, form } = ctx;
  const { nota, operacional } = a;

  if (nota.modelo === 65) return { ok: false, titulo: 'A NFC-e (65) não aceita carta de correção', detalhe: 'A API responderia 409 nfe-cce-model-not-allowed. O instrumento só existe para a NF-e (55).' };
  if (!permiteCarta(nota)) return { ok: false, titulo: `Carta recusada na tela: a nota ${nota.id} está ${situacaoLocal(nota)}; só a autorizada corrige`, detalhe: 'A API responderia 409 nfe-not-correctable. A cancelada cai aqui também: cancelada não é autorizada.' };
  const xCorrecao = form.get('xCorrecao') ?? '';
  const invalida = motivoTextoInvalido(xCorrecao, 'O texto da correção', LIMITES.correcao.minimo, LIMITES.correcao.maximo);
  if (invalida) return { ok: false, titulo: `Texto recusado na tela, nada foi enviado: ${invalida}`, detalhe: 'A API responderia 422 correction-text-invalid.' };

  const idempotencyKey = randomUUID();
  const corpo = { xCorrecao };
  const operacaoId = banco.criarOperacao({ notaId: nota.id, tipo: 'carta', idempotencyKey, corpoEnviado: JSON.stringify(corpo) });
  try {
    const aceite = await cliente.emitirCce(operacional, nota.commandId, xCorrecao, idempotencyKey);
    banco.gravarAceiteOperacao(operacaoId, aceite.corpo.id, aceite.corpo.status, JSON.stringify(aceite.corpo));
    return {
      ok: true,
      titulo: `HTTP ${aceite.status}: carta aceita; o comando NOVO ${aceite.corpo.id} está ${aceite.corpo.status}`,
      detalhe: 'O texto enviado substitui a correção anterior por inteiro. A nota segue autorizada; o desfecho da carta chega pelo feed como nfe.cce, e o histórico abaixo passa a listá-la.',
      corpo: { enviado: corpo, aceite: aceite.corpo },
    };
  } catch (erro) {
    return resultadoDeErro('Carta recusada pela API', erro);
  }
}

// ---------------------------------------------------------------- situação local e o que ela permite

/**
 * A situação que a tela mostra. `failed` e `blocked` vêm primeiro, porque é o `status` que os distingue:
 * a `situacao` da API diz `bloqueada` para os dois, e o primeiro precisa aparecer como o que é, uma falha
 * que se reemite. Fora deles, vale a `situacao` lida da API; antes de ela ser lida,
 * o par (status, outcome) da resposta da emissão, com os mesmos nomes que a API usa.
 */
export function situacaoLocal(n: Nota): string {
  if (n.status === 'failed') return 'falhou';
  if (n.status === 'blocked') return 'bloqueada';
  if (n.situacao) return n.situacao;
  if (!n.status) return 'não enviada';
  if (n.status === 'pending' || n.status === 'processing') return 'processando';
  if (n.status === 'completed') return n.outcome === 'authorized' ? 'autorizada' : 'rejeitada';
  return n.status === 'sealed' ? 'lacrada' : n.status;
}

/** O `result.motivo` do último corpo que a API devolveu: a recusa antecipada com o caminho do campo, o bloqueio, a rejeição. */
export function motivoDaNota(n: Nota): string | null {
  if (!n.ultimoResultado) return null;
  try {
    const r = (JSON.parse(n.ultimoResultado) as { result?: { motivo?: unknown } }).result;
    return typeof r?.motivo === 'string' ? r.motivo : null;
  } catch {
    return null;
  }
}

export const permiteXml = (n: Nota): boolean => situacaoLocal(n) === 'autorizada';
export const permiteDanfe = (n: Nota): boolean => ['autorizada', 'cancelada'].includes(situacaoLocal(n));
/** Reenviar (mesma chave) só faz sentido enquanto a nota não tem desfecho: sem resposta, ou ainda em voo. */
export const permiteReenviar = (n: Nota): boolean => !n.status || !ehTerminal(n.status);
/** Reemitir (chave nova) é só para `failed`. `blocked` não: o ajuste é na série ou na numeração, fora da nota. */
export const permiteReemitir = (n: Nota): boolean => n.status === 'failed';
/** Consultar vale para qualquer nota que a API conhece: é não-destrutivo. */
export const permiteConsultar = (n: Nota): boolean => n.commandId !== null;
export const permiteCancelar = (n: Nota): boolean => situacaoLocal(n) === 'autorizada';
/** Carta só na NF-e (55) autorizada. A NFC-e (65) não tem o instrumento. */
export const permiteCarta = (n: Nota): boolean => n.modelo === 55 && situacaoLocal(n) === 'autorizada';

// ---------------------------------------------------------------- render: lista

async function renderizarLista({ banco, chamadas }: Contexto, ultimo: Resultado): Promise<Resposta> {
  const notas = banco.listarNotas();
  const corpo: Html = html`
<h1>Notas</h1>
<p>Status <b>local</b>. "do wait" é o que a resposta da emissão disse; "feed" e "webhook" são quem confirmou. As ações aparecem só na situação que as permite; a rota que cada uma consome está no cabeçalho de <code>src/telas/notas.ts</code>. Cancelar e corrigir ficam no detalhe da nota.</p>
${resultado(ultimo)}
<section>
${notas.length === 0 ? bruto('<p>Nenhuma nota ainda. Emita uma na tela Nova nota.</p>') : html`<table><tr><th>#</th><th>Modelo</th><th>Série/Nº</th><th>Situação</th><th>Quem disse</th><th>Comando</th><th>Chave</th><th>Ações</th></tr>
${notas.map((n) => linha(n))}</table>`}
</section>`;
  return { html: pagina('Notas', '/notas', corpo, chamadas) };
}

function linha(n: Nota): Html {
  const motivo = motivoDaNota(n);
  return html`<tr>
  <td><a href="/notas/${n.id}">${n.id}</a>${n.reemitidaDe ? html`<br><small>reemissão da ${n.reemitidaDe}</small>` : vazio}</td><td>${n.modelo}</td><td>${n.serie}/${n.numero ?? '-'}</td>
  <td><b>${situacaoLocal(n)}</b></td>
  <td>${n.confirmadoPor ?? (n.status ? 'do wait, aguardando o feed' : 'ninguém: a chamada não voltou')}</td>
  <td><code>${n.commandId ?? '-'}</code></td><td><code>${n.chave ?? '-'}</code></td>
  <td>
    ${(n.status === 'failed' || n.status === 'blocked') && motivo ? html`<p class="motivo"><b>motivo:</b> ${motivo}</p>` : vazio}
    ${n.status === 'failed' ? html`<p><small>failed: a plataforma parou antes da SEFAZ ou esgotou as tentativas. O número segue livre; reemita com chave nova.</small></p>` : vazio}
    ${n.status === 'blocked' ? html`<p><small>blocked: a numeração não deixou a nota sair. Faça o ajuste que o motivo diz e emita a nota de novo em Nova nota.</small></p>` : vazio}
    ${permiteXml(n) ? html`<a href="/notas/${n.id}/xml">XML</a> ` : vazio}
    ${permiteDanfe(n) ? html`<a href="/notas/${n.id}/danfe">DANFE</a> ` : vazio}
    ${permiteCancelar(n) ? html`<a href="/notas/${n.id}#cancelar">Cancelar</a> ` : vazio}
    ${permiteCarta(n) ? html`<a href="/notas/${n.id}#carta">Carta de correção</a> ` : vazio}
    ${permiteConsultar(n) ? html`<form method="post" action="/notas/${n.id}/consultar" style="display:inline"><button>Consultar na SEFAZ</button></form> ` : vazio}
    ${permiteReenviar(n) ? html`<form method="post" action="/notas/${n.id}/reenviar" style="display:inline"><button>Reenviar (mesma chave)</button></form>` : vazio}
    ${permiteReemitir(n) ? html`<form method="post" action="/notas/${n.id}/reemitir" style="display:inline"><button>Reemitir (chave nova)</button></form>` : vazio}
    <a href="/notas/${n.id}">detalhe</a>
  </td></tr>`;
}

// ---------------------------------------------------------------- render: detalhe

async function renderizarDetalhe(ctx: Contexto, ultimo: Resultado): Promise<Resposta> {
  const { params, banco, cliente, chamadas } = ctx;
  const nota = banco.lerNota(Number(params.id));
  if (!nota) return { status: 404, texto: `Não há nota ${params.id} neste banco local.` };
  const operacional = banco.credencialOperacional();

  // A ficha ao vivo: é dela que sai a correção vigente sobre a qual a próxima carta é montada.
  let detalhe: NotaDetalhe | null = null;
  let cartas: CartaCorrecao[] = [];
  let erroLeitura: Resultado = null;
  if (nota.commandId && operacional) {
    try {
      detalhe = (await cliente.lerNota(operacional, nota.commandId)).corpo;
      if (nota.modelo === 55) cartas = (await cliente.listarCce(operacional, nota.commandId)).corpo.dados;
    } catch (erro) {
      erroLeitura = resultadoDeErro('Não consegui ler a nota na API', erro);
    }
  }
  const operacoes = banco.listarOperacoes(nota.id);
  const situacao = situacaoLocal(nota);
  const motivo = motivoDaNota(nota);

  const corpo: Html = html`
<h1>Nota ${nota.id} · modelo ${nota.modelo} · série ${nota.serie}/${nota.numero ?? '-'}</h1>
<p><a href="/notas">← Notas</a></p>
${resultado(ultimo)}
${resultado(erroLeitura)}
<section>
  <h2>Situação local: <b>${situacao}</b> <small>(${nota.confirmadoPor ? `confirmada por ${nota.confirmadoPor}` : nota.status ? 'do wait, aguardando o feed' : 'a chamada não voltou'})</small></h2>
  <p>Comando <code>${nota.commandId ?? '-'}</code> · chave <code>${nota.chave ?? '-'}</code> · protocolo <code>${nota.protocolo ?? '-'}</code> · Idempotency-Key <code>${nota.idempotencyKey}</code>${nota.reemitidaDe ? html` · reemissão da <a href="/notas/${nota.reemitidaDe}">nota ${nota.reemitidaDe}</a>` : vazio}</p>
  ${detalhe ? html`<p>Na API agora: <b>${detalhe.situacao}</b> (status ${detalhe.status}${detalhe.outcome ? ' / ' + detalhe.outcome : ''}, ${detalhe.attempts} tentativa(s))${detalhe.canceladaEm ? html`; cancelada em ${detalhe.canceladaEm}, protocolo <code>${detalhe.protocoloCancelamento ?? '-'}</code>, justificativa "${detalhe.justificativaCancelamento ?? ''}"` : vazio}.</p>` : vazio}
  ${detalhe?.situacao === 'reconciliando' ? html`<p><b>reconciliando</b>: a SEFAZ já autorizou a nota, e um erro interno abortou a gravação do desfecho na plataforma. <b>Espere e releia</b>: a plataforma refaz a gravação sozinha, e a nota vira autorizada. Enquanto isso ela não cancela nem corrige, e emitir de novo, com chave nova, criaria uma segunda nota para a mesma venda. Parada assim por muito tempo, é caso de suporte.</p>` : vazio}
  ${motivo ? html`<p class="motivo"><b>motivo:</b> ${motivo}</p>` : vazio}
  ${nota.status === 'failed' ? html`<p><b>failed</b>: a plataforma parou antes da SEFAZ (recusa antecipada, e o motivo traz o caminho do campo) ou esgotou as tentativas. O número segue livre. O caminho é <b>reemitir com chave nova</b>: <form method="post" action="/notas/${nota.id}/reemitir" style="display:inline"><button>Reemitir (chave nova)</button></form></p>` : vazio}
  ${nota.status === 'blocked' ? html`<p><b>blocked</b>: a <b>numeração</b> não deixou a nota sair. A SEFAZ acusou duplicidade, ou a série foi inativada, esgotou ou trocou de modo depois do aceite, e o motivo diz qual e o que ajustar. O ajuste é na série ou na numeração, fora da nota; feito ele, emita a nota de novo em <a href="/nova-nota">Nova nota</a>. Esta tela não reemite um blocked, e reenviar com a mesma chave só devolveria a nota bloqueada.</p>` : vazio}
</section>

<section id="consultar">
  <h2>Consultar na SEFAZ <span class="rota">POST /v1/nfe/{id}/consulta</span> → <span class="rota">GET /v1/nfe/{id}</span></h2>
  <p>Assíncrona e não-destrutiva: a resposta é só o aceite, e o resultado vem ao reler a nota. Detecta um cancelamento feito por fora da plataforma e destrava uma nota presa em processando.</p>
  ${permiteConsultar(nota) ? html`<form method="post" action="/notas/${nota.id}/consultar"><button>Consultar e reler</button></form>` : html`<p>Sem comando na API: nada a consultar.</p>`}
</section>

<section id="cancelar">
  <h2>Cancelar <span class="rota">POST /v1/nfe/{id}/cancelamento</span></h2>
  ${permiteCancelar(nota)
    ? html`<p>Só a nota autorizada cancela. Vai só a justificativa, de ${LIMITES.justificativa.minimo} a ${LIMITES.justificativa.maximo} caracteres no envelope da SEFAZ; a tela confere antes de chamar. A janela de 24h é a SEFAZ quem confere.</p>
  <form method="post" action="/notas/${nota.id}/cancelar">
    <label>Justificativa<br><input name="justificativa" size="80" value="Cancelamento por erro de digitação no valor da mercadoria"></label>
    <button>Cancelar a nota</button>
  </form>`
    : html`<p>Não oferecido: a nota está <b>${situacao}</b>, e só a autorizada cancela (a API responderia 409 nfe-not-cancelable).</p>`}
</section>

<section id="carta">
  <h2>Carta de correção <span class="rota">POST /v1/nfe/{id}/cce</span> · <span class="rota">GET /v1/nfe/{id}/cce</span></h2>
  ${nota.modelo === 65
    ? html`<p>Não se aplica: a NFC-e (65) não aceita carta de correção (a API responderia 409 nfe-cce-model-not-allowed).</p>`
    : permiteCarta(nota)
      ? html`<p><b>A última carta substitui todas as anteriores.</b> O texto abaixo já vem com a correção vigente${detalhe?.correcaoVigente ? html` (nSeq ${detalhe.correcaoVigente.nSeq})` : vazio}: acrescente a correção nova ao fim, sem apagar o que já vale. De ${LIMITES.correcao.minimo} a ${LIMITES.correcao.maximo} caracteres; corrige o que não muda valor, imposto nem partes.</p>
  <form method="post" action="/notas/${nota.id}/carta">
    <label>Texto cumulativo (<code>xCorrecao</code>)<br><textarea name="xCorrecao" rows="4" cols="90">${detalhe?.correcaoVigente?.texto ?? ''}</textarea></label>
    <button>Enviar a carta</button>
  </form>`
      : html`<p>Não oferecido: a nota está <b>${situacao}</b>, e só a autorizada corrige (a API responderia 409 nfe-not-correctable).</p>`}
  ${cartas.length > 0 ? html`<h3>Histórico das cartas <span class="rota">GET /v1/nfe/{id}/cce/{cartaId}/dacce</span></h3><table><tr><th>nSeq</th><th>situação</th><th>texto</th><th>protocolo</th><th>motivo</th><th>registrada em</th><th>documento</th></tr>
  ${cartas.map((c) => html`<tr><td>${c.nSeq ?? '-'}</td><td><b>${c.situacao}</b></td><td>${c.texto}</td><td><code>${c.protocolo ?? '-'}</code></td><td>${c.motivo ?? '-'}</td><td>${c.registradaEm ?? '-'}</td><td>${c.situacao === 'registrada' ? html`<a href="/notas/${nota.id}/cce/${c.id}/dacce">DACCE</a>` : '-'}</td></tr>`)}</table>
  <p><small>A vigente é a última <b>registrada</b>, e só a registrada tem DACCE, o documento da carta que o emitente entrega ao destinatário; o DANFE da nota não muda com a correção. As rejeitadas, as falhas e as indeterminadas ficam no histórico para o desfecho não se perder. <b>reconciliando</b> e <b>pendente-registro</b> dizem que a SEFAZ já respondeu e um erro interno abortou a gravação: não envie a carta de novo, que o fato já existe no fisco; na primeira a plataforma busca o protocolo sozinha, na segunda é caso de suporte.</small></p>` : nota.modelo === 55 ? html`<p><small>Nenhuma carta ainda.</small></p>` : vazio}
</section>

<section>
  <h2>Operações desta nota</h2>
  ${operacoes.length === 0 ? html`<p>Nenhuma ainda.</p>` : tabelaOperacoes(operacoes)}
</section>

<section>
  <details><summary>corpo enviado na emissão</summary><pre>${JSON.stringify(JSON.parse(nota.corpoEnviado), null, 2)}</pre></details>
  ${nota.ultimoResultado ? html`<details><summary>último resultado da API sobre a nota</summary><pre>${JSON.stringify(JSON.parse(nota.ultimoResultado), null, 2)}</pre></details>` : vazio}
</section>`;
  return { html: pagina(`Nota ${nota.id}`, '/notas', corpo, chamadas) };
}

/** A tabela de operações, compartilhada com a tela Inutilização. */
export function tabelaOperacoes(operacoes: Operacao[]): Html {
  return html`<table><tr><th>#</th><th>tipo</th><th>comando</th><th>status</th><th>situação</th><th>quem disse</th><th>criada em</th><th></th></tr>
${operacoes.map(
  (o) => html`<tr><td>${o.id}</td><td>${o.tipo}</td><td><code>${o.commandId ?? '-'}</code></td><td>${o.status ?? '-'}${o.outcome ? ' / ' + o.outcome : ''}</td><td><b>${situacaoOperacao(o)}</b></td><td>${o.confirmadoPor ?? (o.status ? 'o aceite; aguardando o feed' : 'a chamada não voltou')}</td><td>${o.criadoEm}</td>
  <td>${o.corpoEnviado ? html`<details><summary>enviado</summary><p>Idempotency-Key <code>${o.idempotencyKey}</code></p><pre>${JSON.stringify(JSON.parse(o.corpoEnviado), null, 2)}</pre></details>` : vazio}${o.ultimoResultado ? html`<details><summary>último resultado</summary><pre>${JSON.stringify(JSON.parse(o.ultimoResultado), null, 2)}</pre></details>` : vazio}</td></tr>`,
)}</table>`;
}
