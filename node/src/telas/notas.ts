// Tela Notas: a lista com o status local e as ações que a situação permite.
//
//   POST /v1/nfe?wait=            operacional  reenviar (mesma Idempotency-Key, mesmo corpo: replay)
//   GET  /v1/nfe/{id}/xml         operacional  só na autorizada; antes é 409 nfe-xml-unavailable
//   GET  /v1/nfe/{id}/danfe       operacional  na autorizada e na cancelada; fora disso 409 nfe-danfe-unavailable
//
// O status desta tela é o LOCAL, e diz quem o pôs ali: a resposta da emissão (o `wait`), o feed ou o
// webhook. A resposta da emissão grava só o `id` e o status inicial, e o desfecho quando o `wait` o traz;
// a confirmação é sempre do feed ou do webhook.

import type { Banco, Nota } from '../banco.ts';
import type { AceiteComando, RepresentacaoComando } from '../cliente-api.ts';
import type { Contexto, Resposta, Rota } from '../app.ts';
import { bruto, html, pagina, resultado, resultadoDeErro, vazio, type Html, type Resultado } from '../html.ts';
import { ehTerminal } from '../eventos.ts';
import { WAIT_MS } from './nova-nota.ts';

export const telaNotas: Rota = (ctx) => renderizar(ctx, null);

/** `GET /notas/:id/<nome>`: devolvem o arquivo, ou a tela com o erro da API tal como veio. */
export const leiturasNotas: Record<string, Rota> = {
  xml: (ctx) => baixar(ctx, 'xml'),
  danfe: (ctx) => baixar(ctx, 'danfe'),
};

/** `POST /notas/:id/<nome>`. */
export const acoesNotas: Record<string, Rota> = {
  reenviar: async (ctx) => renderizar(ctx, await reenviar(ctx)),
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

async function baixar({ params, banco, cliente, chamadas }: Contexto, tipo: 'xml' | 'danfe'): Promise<Resposta> {
  const nota = banco.lerNota(Number(params.id));
  const operacional = banco.credencialOperacional();
  if (!nota?.commandId || !operacional) return { status: 404, texto: 'Nota sem comando na API, ou credencial ausente.' };
  try {
    const arquivo = tipo === 'xml' ? await cliente.baixarXml(operacional, nota.commandId) : await cliente.baixarDanfe(operacional, nota.commandId);
    return { arquivo: { bytes: arquivo.bytes, contentType: arquivo.contentType, nome: arquivo.nome ?? `${nota.chave ?? nota.commandId}.${tipo === 'xml' ? 'xml' : 'pdf'}`, inline: tipo === 'danfe' } };
  } catch (erro) {
    // A API disse por que não há arquivo: 409 com o type. A tela mostra o envelope, não o esconde.
    const r = resultadoDeErro(`${tipo === 'xml' ? 'XML' : 'DANFE'} da nota ${nota.id} indisponível`, erro);
    return { status: 409, html: pagina('Notas', '/notas', html`<h1>Notas</h1>${resultado(r)}<p><a href="/notas">Voltar</a></p>`, chamadas) };
  }
}

// ---------------------------------------------------------------- situação local

/**
 * A situação que a tela mostra. Quando a API já foi lida (`situacao`), é a dela. Antes disso, deriva do
 * par (status, outcome) da resposta da emissão, com os mesmos nomes que a API usa.
 */
export function situacaoLocal(n: Nota): string {
  if (n.situacao) return n.situacao;
  if (!n.status) return 'não enviada';
  if (n.status === 'pending' || n.status === 'processing') return 'processando';
  if (n.status === 'completed') return n.outcome === 'authorized' ? 'autorizada' : 'rejeitada';
  if (n.status === 'sealed') return 'lacrada';
  return n.status === 'blocked' ? 'bloqueada' : 'falhou';
}

export const permiteXml = (n: Nota): boolean => situacaoLocal(n) === 'autorizada';
export const permiteDanfe = (n: Nota): boolean => ['autorizada', 'cancelada'].includes(situacaoLocal(n));
/** Reenviar só faz sentido enquanto a nota não tem desfecho: sem resposta, ou ainda em voo. */
export const permiteReenviar = (n: Nota): boolean => !n.status || !ehTerminal(n.status);

async function renderizar({ banco, chamadas }: Contexto, ultimo: Resultado): Promise<Resposta> {
  const notas = banco.listarNotas();
  const corpo: Html = html`
<h1>Notas</h1>
<p>Status <b>local</b>. "do wait" é o que a resposta da emissão disse; "feed" e "webhook" são quem confirmou. As ações aparecem só na situação que as permite; a rota que cada uma consome está no cabeçalho de <code>src/telas/notas.ts</code>.</p>
${resultado(ultimo)}
<section>
${notas.length === 0 ? bruto('<p>Nenhuma nota ainda. Emita uma na tela Nova nota.</p>') : html`<table><tr><th>#</th><th>Modelo</th><th>Série/Nº</th><th>Situação</th><th>Quem disse</th><th>Comando</th><th>Chave</th><th>Ações</th></tr>
${notas.map(
  (n) => html`<tr>
  <td>${n.id}</td><td>${n.modelo}</td><td>${n.serie}/${n.numero ?? '-'}</td>
  <td><b>${situacaoLocal(n)}</b></td>
  <td>${n.confirmadoPor ?? (n.status ? 'do wait, aguardando o feed' : 'ninguém: a chamada não voltou')}</td>
  <td><code>${n.commandId ?? '-'}</code></td><td><code>${n.chave ?? '-'}</code></td>
  <td>
    ${permiteXml(n) ? html`<a href="/notas/${n.id}/xml">XML</a> ` : vazio}
    ${permiteDanfe(n) ? html`<a href="/notas/${n.id}/danfe">DANFE</a> ` : vazio}
    ${permiteReenviar(n) ? html`<form method="post" action="/notas/${n.id}/reenviar" style="display:inline"><button>Reenviar (mesma chave)</button></form>` : vazio}
    <details><summary>corpo enviado</summary><p>Idempotency-Key <code>${n.idempotencyKey}</code></p><pre>${JSON.stringify(JSON.parse(n.corpoEnviado), null, 2)}</pre></details>
    ${n.ultimoResultado ? html`<details><summary>último resultado da API</summary><pre>${JSON.stringify(JSON.parse(n.ultimoResultado), null, 2)}</pre></details>` : vazio}
  </td></tr>`,
)}</table>`}
</section>`;
  return { html: pagina('Notas', '/notas', corpo, chamadas) };
}
