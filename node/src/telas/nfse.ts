// Tela NFS-e: a lista com o status local e as ações que a situação permite, e o detalhe de uma NFS-e, onde ficam
// o resumo que a SEFIN calculou e o histórico do que já foi feito com ela. É a tela Notas da NFS-e.
//
//   POST /v1/nfse?wait=                 operacional  reenviar (mesma Idempotency-Key, mesmo corpo: replay)
//   GET  /v1/nfse/{id}                  operacional  a ficha: situação, DPS, NFS-e e o resumo
//
// O status desta tela é o LOCAL, e diz quem o pôs ali: a resposta da emissão (o `wait`), o feed ou o webhook. A
// resposta da emissão grava só o `id` e o status inicial, e o desfecho quando o `wait` o traz; a confirmação é
// sempre do feed ou do webhook.
//
// A NFS-e é outra família na API, não uma nota com outro modelo: o `id` de uma NF-e responde `404` aqui, e o de
// uma NFS-e responde `404` em `GET /v1/nfe/{id}`. Por isso há tabela, tela e feed próprios.

import type { Banco, Nfse } from '../banco.ts';
import type { AceiteComando, DetalheNfse } from '../cliente-api.ts';
import type { Contexto, Resposta, Rota } from '../app.ts';
import { bruto, dinheiro, html, pagina, resultado, resultadoDeErro, vazio, type Html, type Resultado } from '../html.ts';
import { ehTerminal } from '../eventos.ts';
import { WAIT_MS } from './nova-nota.ts';

export const telaNfses: Rota = (ctx) => renderizarLista(ctx, null);

/** `GET /nfse/:id`: a ficha e o histórico. */
export const telaNfse: Rota = (ctx) => renderizarDetalhe(ctx, null);

/** `POST /nfse/:id/<nome>`. As da emissão voltam à lista. */
export const acoesNfse: Record<string, Rota> = {
  reenviar: async (ctx) => renderizarLista(ctx, await reenviar(ctx)),
};

/**
 * O que a resposta da emissão pode gravar. `202`: o aceite, `id` e status inicial. `200` com `outcome`: o `wait`
 * resolveu, e o desfecho é gravado, com a situação, os números e a chave que o detalhe já traz; mas `confirmadoPor`
 * fica vazio até o feed ou o webhook passarem por ele. `200` sem `outcome`: replay de um comando já terminal, que
 * também só traz o aceite.
 */
export function gravarRespostaDaEmissaoNfse(banco: Banco, nfseId: number, status: number, corpo: DetalheNfse | AceiteComando, documento?: unknown): Resultado {
  banco.gravarAceiteNfse(nfseId, corpo.id, corpo.status, JSON.stringify(corpo));
  if ('outcome' in corpo) {
    banco.gravarDesfechoNfse(nfseId, {
      status: corpo.status,
      outcome: corpo.outcome,
      numeroDps: corpo.numeroDps,
      numeroNfse: corpo.numeroNfse,
      chave: corpo.chave,
      situacao: corpo.situacao,
      ultimoResultado: JSON.stringify(corpo),
    });
    const numeros = [corpo.numeroDps ? `DPS ${corpo.numeroDps}` : null, corpo.numeroNfse ? `NFS-e nº ${corpo.numeroNfse}` : null].filter(Boolean).join(', ');
    return {
      ok: corpo.status === 'completed' && corpo.outcome === 'authorized',
      titulo: `HTTP ${status}: o wait resolveu, ${corpo.status}${corpo.outcome ? ' / ' + corpo.outcome : ''}${numeros ? ', ' + numeros : ''}`,
      detalhe: 'Desfecho gravado a partir da resposta. Na tela NFS-e ele aparece como "do wait" até o feed ou o webhook confirmarem: é o feed a fonte de verdade.',
      corpo: documento ? { resposta: corpo, documentoEnviado: documento } : corpo,
    };
  }
  return {
    ok: true,
    titulo: `HTTP ${status}: aceite, comando ${corpo.id} está ${corpo.status}`,
    detalhe: status === 202 ? 'O wait estourou. A NFS-e fica "processando"; a tela Eventos fecha o desfecho pelo feed, sem intervenção.' : 'Replay de um comando já terminal: só o aceite volta. O desfecho está no feed e em GET /v1/nfse/{id}.',
    corpo: documento ? { resposta: corpo, documentoEnviado: documento } : corpo,
  };
}

// ---------------------------------------------------------------- ações da emissão

async function reenviar({ params, banco, cliente }: Contexto): Promise<Resultado> {
  const nfse = banco.lerNfse(Number(params.id));
  const operacional = banco.credencialOperacional();
  if (!nfse || !operacional) return { ok: false, titulo: 'NFS-e não encontrada ou credencial ausente' };
  try {
    const resposta = await cliente.emitirNfse(operacional, JSON.parse(nfse.corpoEnviado), nfse.idempotencyKey, WAIT_MS);
    const r = gravarRespostaDaEmissaoNfse(banco, nfse.id, resposta.status, resposta.corpo);
    return { ...r!, titulo: `Reenvio com a mesma Idempotency-Key. ${r!.titulo}` };
  } catch (erro) {
    return resultadoDeErro('Reenvio recusado', erro);
  }
}

// ---------------------------------------------------------------- situação local e o que ela permite

/**
 * A situação que a tela mostra. `failed` e `blocked` vêm primeiro, porque é o `status` que os distingue: a `situacao`
 * da API diz `bloqueada` para os dois. Fora deles, vale a `situacao` lida da API; antes de ela ser lida, o par
 * (status, outcome) da resposta da emissão, com os mesmos nomes que a API usa. Um `completed` sem `outcome` é o replay,
 * que só traz o aceite: o desfecho ainda não foi lido, e a tela não o chuta.
 */
export function situacaoLocalNfse(n: Nfse): string {
  if (n.status === 'failed') return 'falhou';
  if (n.status === 'blocked') return 'bloqueada';
  if (n.situacao) return n.situacao;
  if (!n.status) return 'não enviada';
  if (n.status === 'pending' || n.status === 'processing') return 'processando';
  if (n.status === 'completed') return n.outcome === 'authorized' ? 'autorizada' : n.outcome === 'rejected' ? 'rejeitada' : 'concluída (desfecho não lido)';
  return n.status;
}

/** O `result.motivo` do último corpo que a API devolveu: a rejeição da SEFIN, a recusa antecipada, o bloqueio. */
export function motivoDaNfse(n: Nfse): string | null {
  if (!n.ultimoResultado) return null;
  try {
    const r = (JSON.parse(n.ultimoResultado) as { result?: { motivo?: unknown } }).result;
    return typeof r?.motivo === 'string' ? r.motivo : null;
  } catch {
    return null;
  }
}

/** Reenviar (mesma chave) só faz sentido enquanto a DPS não tem desfecho: sem resposta, ou ainda em voo. */
export const permiteReenviarNfse = (n: Nfse): boolean => !n.status || !ehTerminal(n.status);

// ---------------------------------------------------------------- render: lista

async function renderizarLista({ banco, chamadas }: Contexto, ultimo: Resultado): Promise<Resposta> {
  const nfses = banco.listarNfses();
  const corpo: Html = html`
<h1>NFS-e</h1>
<p>Status <b>local</b>. "do wait" é o que a resposta da emissão disse; "feed" e "webhook" são quem confirmou. As ações aparecem só na situação que as permite; a rota que cada uma consome está no cabeçalho de <code>src/telas/nfse.ts</code>.</p>
${resultado(ultimo)}
<section>
${nfses.length === 0 ? bruto('<p>Nenhuma NFS-e ainda. Emita uma na tela Nova NFS-e.</p>') : html`<table><tr><th>#</th><th>Série/DPS</th><th>NFS-e nº</th><th>Situação</th><th>Quem disse</th><th>Comando</th><th>Chave</th><th>Ações</th></tr>
${nfses.map((n) => linha(n))}</table>`}
</section>`;
  return { html: pagina('NFS-e', '/nfse', corpo, chamadas) };
}

function linha(n: Nfse): Html {
  const motivo = motivoDaNfse(n);
  return html`<tr>
  <td><a href="/nfse/${n.id}">${n.id}</a></td><td>${n.serie}/${n.numeroDps ?? '-'}</td><td>${n.numeroNfse ?? '-'}</td>
  <td><b>${situacaoLocalNfse(n)}</b></td>
  <td>${n.confirmadoPor ?? (n.status ? 'do wait, aguardando o feed' : 'ninguém: a chamada não voltou')}</td>
  <td><code>${n.commandId ?? '-'}</code></td><td><code>${n.chave ?? '-'}</code></td>
  <td>
    ${motivo ? html`<p class="motivo"><b>motivo:</b> ${motivo}</p>` : vazio}
    ${permiteReenviarNfse(n) ? html`<form method="post" action="/nfse/${n.id}/reenviar" style="display:inline"><button>Reenviar (mesma chave)</button></form> ` : vazio}
    <a href="/nfse/${n.id}">detalhe</a>
  </td></tr>`;
}

// ---------------------------------------------------------------- render: detalhe

async function renderizarDetalhe(ctx: Contexto, ultimo: Resultado): Promise<Resposta> {
  const { params, banco, cliente, chamadas } = ctx;
  const nfse = banco.lerNfse(Number(params.id));
  if (!nfse) return { status: 404, texto: `Não há NFS-e ${params.id} neste banco local.` };
  const operacional = banco.credencialOperacional();

  // A ficha ao vivo: é dela que saem o resumo que a SEFIN calculou e a situação de agora.
  let detalhe: DetalheNfse | null = null;
  let erroLeitura: Resultado = null;
  if (nfse.commandId && operacional) {
    try {
      detalhe = (await cliente.lerNfse(operacional, nfse.commandId)).corpo;
    } catch (erro) {
      erroLeitura = resultadoDeErro('Não consegui ler a NFS-e na API', erro);
    }
  }
  const situacao = situacaoLocalNfse(nfse);
  const motivo = motivoDaNfse(nfse);
  const resumo = detalhe?.resumo;

  const corpo: Html = html`
<h1>NFS-e local ${nfse.id} · série ${nfse.serie} · DPS ${nfse.numeroDps ?? '-'} · NFS-e ${nfse.numeroNfse ?? '-'}</h1>
<p><a href="/nfse">← NFS-e</a></p>
${resultado(ultimo)}
${resultado(erroLeitura)}
<section>
  <h2>Situação local: <b>${situacao}</b> <small>(${nfse.confirmadoPor ? `confirmada por ${nfse.confirmadoPor}` : nfse.status ? 'do wait, aguardando o feed' : 'a chamada não voltou'})</small></h2>
  <p>Comando <code>${nfse.commandId ?? '-'}</code> · chave <code>${nfse.chave ?? '-'}</code> · Idempotency-Key <code>${nfse.idempotencyKey}</code></p>
  ${detalhe ? html`<p>Na API agora: <b>${detalhe.situacao}</b> (status ${detalhe.status}${detalhe.outcome ? ' / ' + detalhe.outcome : ''}, ${detalhe.attempts} tentativa(s)).</p>` : vazio}
  ${motivo ? html`<p class="motivo"><b>motivo:</b> ${motivo}</p>` : vazio}
  ${resumo ? html`<p>Tomador ${resumo.tomadorNome ?? '-'} (${resumo.tomadorDoc ?? '-'}) · competência ${resumo.competencia ?? '-'} · serviço ${resumo.codigoTributacaoNacional ?? '-'} · valor ${dinheiroOuTraco(resumo.valorServico)}${resumo.valorIssqn === null ? vazio : html` · ISSQN ${dinheiroOuTraco(resumo.valorIssqn)} · retido ${dinheiroOuTraco(resumo.valorRetido)} · líquido ${dinheiroOuTraco(resumo.valorLiquido)} · incidência ${resumo.municipioIncidencia ?? '-'} ${resumo.nomeMunicipioIncidencia ?? ''}`}</p>
  <p><small>O resumo traz o que o documento informou e o que só a SEFIN calcula: o município de incidência, o ISSQN, o total retido e o valor líquido ficam nulos antes da autorizada.</small></p>` : vazio}
</section>

<section>
  <details><summary>corpo enviado na emissão</summary><pre>${JSON.stringify(JSON.parse(nfse.corpoEnviado), null, 2)}</pre></details>
  ${nfse.ultimoResultado ? html`<details><summary>último corpo devolvido pela API</summary><pre>${JSON.stringify(JSON.parse(nfse.ultimoResultado), null, 2)}</pre></details>` : vazio}
</section>`;
  return { html: pagina('NFS-e', '/nfse', corpo, chamadas) };
}

const dinheiroOuTraco = (n: number | null): string => (n === null ? '-' : dinheiro(n));
