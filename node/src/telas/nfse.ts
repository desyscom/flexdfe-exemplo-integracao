// Tela NFS-e: a lista com o status local e as ações que a situação permite, e o detalhe de uma NFS-e, onde ficam
// o resumo que a SEFIN calculou, os formulários das operações e o histórico do que já foi feito com ela. É a tela
// Notas da NFS-e.
//
//   POST /v1/nfse?wait=                 operacional  reenviar (mesma Idempotency-Key, mesmo corpo: replay)
//                                                    substituir (outra emissão, com `substituicao` no corpo)
//   GET  /v1/nfse/{id}                  operacional  a ficha: situação, DPS, NFS-e e o resumo
//   GET  /v1/nfse/{id}/xml              operacional  depois da autorizada; antes é 409 nfse-xml-unavailable
//   GET  /v1/nfse/{id}/danfse           operacional  autorizada, cancelada e substituída; antes é 409 nfse-danfse-unavailable
//   POST /v1/nfse/{id}/consulta         operacional  pede a verdade à SEFIN; o resultado vem ao reler a NFS-e
//   POST /v1/nfse/{id}/cancelamento     operacional  só na autorizada; código 1, 2 ou 9; justificativa 15–255; Idempotency-Key
//   GET  /v1/nfse/{id}/cancelamento     operacional  a tentativa, lida quando o feed anuncia o `nfse.cancel`
//
// O status desta tela é o LOCAL, e diz quem o pôs ali: a resposta da emissão (o `wait`), o feed ou o webhook. A
// resposta da emissão grava só o `id` e o status inicial, e o desfecho quando o `wait` o traz; a confirmação é
// sempre do feed ou do webhook.
//
// A NFS-e é outra família na API, não uma nota com outro modelo: o `id` de uma NF-e responde `404` aqui, e o de
// uma NFS-e responde `404` em `GET /v1/nfe/{id}`. Por isso há tabela, tela e feed próprios.

import { randomUUID } from 'node:crypto';
import type { Banco, Nfse, Operacao } from '../banco.ts';
import type { AceiteComando, DetalheNfse, Emitente } from '../cliente-api.ts';
import type { Contexto, Resposta, Rota } from '../app.ts';
import { bruto, dinheiro, html, pagina, resultado, resultadoDeErro, vazio, type Html, type Resultado } from '../html.ts';
import { ehTerminal, situacaoOperacao } from '../eventos.ts';
import { exigePercentualSimples } from '../documento-nfse.ts';
import { LIMITES, motivoTextoInvalido } from '../texto-sefaz.ts';
import { camposNfse, montarCorpoNfse, valoresDoCorpo } from './nova-nfse.ts';
import { WAIT_MS } from './nova-nota.ts';

export const telaNfses: Rota = (ctx) => renderizarLista(ctx, null);

/** `GET /nfse/:id`: a ficha, os formulários das operações e o histórico. */
export const telaNfse: Rota = (ctx) => renderizarDetalhe(ctx, null);

/** `GET /nfse/:id/<nome>`: devolvem o arquivo, ou a tela com o erro da API tal como veio. */
export const leiturasNfse: Record<string, Rota> = {
  xml: (ctx) => baixar(ctx, 'xml'),
  danfse: (ctx) => baixar(ctx, 'danfse'),
};

/** `POST /nfse/:id/<nome>`. A da emissão volta à lista; as operações voltam ao detalhe. */
export const acoesNfse: Record<string, Rota> = {
  reenviar: async (ctx) => renderizarLista(ctx, await reenviar(ctx)),
  consultar: async (ctx) => renderizarDetalhe(ctx, await consultar(ctx)),
  cancelar: async (ctx) => renderizarDetalhe(ctx, await cancelar(ctx)),
  substituir: async (ctx) => renderizarDetalhe(ctx, await substituir(ctx)),
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

async function baixar({ params, banco, cliente, chamadas }: Contexto, tipo: 'xml' | 'danfse'): Promise<Resposta> {
  const nfse = banco.lerNfse(Number(params.id));
  const operacional = banco.credencialOperacional();
  if (!nfse?.commandId || !operacional) return { status: 404, texto: 'NFS-e sem comando na API, ou credencial ausente.' };
  const base = nfse.chave ?? nfse.commandId;
  try {
    const arquivo = tipo === 'xml' ? await cliente.baixarXmlNfse(operacional, nfse.commandId) : await cliente.baixarDanfse(operacional, nfse.commandId);
    return { arquivo: { bytes: arquivo.bytes, contentType: arquivo.contentType, nome: arquivo.nome ?? `${base}.${tipo === 'xml' ? 'xml' : 'pdf'}`, inline: tipo === 'danfse' } };
  } catch (erro) {
    // A API disse por que não há arquivo: 409 com o type. A tela mostra o envelope, não o esconde.
    const r = resultadoDeErro(`${tipo === 'xml' ? 'XML' : 'DANFSe'} da NFS-e ${nfse.id} indisponível`, erro);
    return { status: 409, html: pagina('NFS-e', '/nfse', html`<h1>NFS-e</h1>${resultado(r)}<p><a href="/nfse">Voltar</a></p>`, chamadas) };
  }
}

// ---------------------------------------------------------------- operações sobre a NFS-e

type Alvo = { nfse: Nfse & { commandId: string }; operacional: NonNullable<ReturnType<Banco['credencialOperacional']>> };

function alvo({ params, banco }: Contexto): Alvo | Resultado {
  const nfse = banco.lerNfse(Number(params.id));
  const operacional = banco.credencialOperacional();
  if (!nfse || !operacional) return { ok: false, titulo: 'NFS-e não encontrada ou credencial ausente' };
  if (!nfse.commandId) return { ok: false, titulo: `A NFS-e ${nfse.id} não tem comando na API: a emissão não voltou`, detalhe: 'Reenvie-a na lista com a mesma chave.' };
  return { nfse: nfse as Alvo['nfse'], operacional };
}

const ehResultado = (a: Alvo | Resultado): a is Resultado => a === null || 'ok' in a;

/**
 * A consulta é assíncrona e não gera evento: o `202` só diz que a SEFIN vai ser perguntada. O resultado aparece ao
 * reler a NFS-e, e é a releitura que a tela grava. Numa NFS-e já gerada ela traz os cancelamentos feitos fora da
 * plataforma. Se a SEFIN ainda não respondeu, a releitura mostra o de antes; consultar de novo em instantes é o caminho.
 */
async function consultar(ctx: Contexto): Promise<Resultado> {
  const a = alvo(ctx);
  if (ehResultado(a)) return a;
  const { banco, cliente } = ctx;
  const { nfse, operacional } = a;
  const operacaoId = banco.criarOperacao({ notaId: null, nfseId: nfse.id, tipo: 'consulta', idempotencyKey: null, corpoEnviado: null });
  try {
    const aceite = await cliente.consultarNfse(operacional, nfse.commandId);
    banco.gravarAceiteOperacao(operacaoId, aceite.corpo.id, aceite.corpo.status, JSON.stringify(aceite.corpo));
    const detalhe = (await cliente.lerNfse(operacional, nfse.commandId)).corpo;
    banco.gravarDesfechoNfse(nfse.id, {
      status: detalhe.status,
      outcome: detalhe.outcome,
      numeroDps: detalhe.numeroDps,
      numeroNfse: detalhe.numeroNfse,
      chave: detalhe.chave,
      situacao: detalhe.situacao,
      ultimoResultado: JSON.stringify(detalhe),
    });
    banco.gravarDesfechoOperacao(operacaoId, { situacao: 'concluída', ultimoResultado: JSON.stringify(detalhe) });
    return {
      ok: true,
      titulo: `HTTP ${aceite.status}: consulta aceita (comando ${aceite.corpo.id}); a releitura diz ${detalhe.situacao}`,
      detalhe: `A consulta não gera evento no feed: o resultado vem de GET /v1/nfse/{id}, e ela não leva Idempotency-Key, porque não cria nada. Se a SEFIN ainda não respondeu, a releitura mostra o de antes; consulte de novo em instantes.${nfse.situacao && nfse.situacao !== detalhe.situacao ? ` A situação local mudou de ${nfse.situacao} para ${detalhe.situacao}.` : ''}`,
      corpo: { aceite: aceite.corpo, releitura: detalhe },
    };
  } catch (erro) {
    return resultadoDeErro('Consulta recusada', erro);
  }
}

const CODIGOS_CANCELAMENTO: [string, string][] = [['1', 'erro na emissão'], ['2', 'serviço não prestado'], ['9', 'outros']];

async function cancelar(ctx: Contexto): Promise<Resultado> {
  const a = alvo(ctx);
  if (ehResultado(a)) return a;
  const { banco, cliente, form } = ctx;
  const { nfse, operacional } = a;

  // ---- Conferido na tela, antes de gastar a chamada. A API diria o mesmo, com 409 e 422. ----
  if (!permiteCancelarNfse(nfse)) return { ok: false, titulo: `Cancelamento recusado na tela: a NFS-e ${nfse.id} está ${situacaoLocalNfse(nfse)}; só a autorizada cancela`, detalhe: 'A API responderia 409 nfse-not-cancelable. Uma NFS-e cancelada, substituída, rejeitada ou ainda processando não tem o que cancelar.' };
  const codigo = form.get('codigo_justificativa') ?? '';
  if (!CODIGOS_CANCELAMENTO.some(([c]) => c === codigo)) return { ok: false, titulo: 'Código do cancelamento: 1 (erro na emissão), 2 (serviço não prestado) ou 9 (outros)', detalhe: 'A API responderia 422 cancellation-reason-invalid.' };
  const justificativa = form.get('justificativa') ?? '';
  const invalida = motivoTextoInvalido(justificativa, 'A justificativa', LIMITES.justificativa.minimo, LIMITES.justificativa.maximo);
  if (invalida) return { ok: false, titulo: `Justificativa recusada na tela, nada foi enviado: ${invalida}`, detalhe: 'A API responderia 422 cancellation-reason-invalid. É a restrição do leiaute da SEFAZ, conferida na borda para não virar rejeição depois.' };

  // ---- A chave e o corpo ficam gravados ANTES da chamada, como na emissão. ----
  const idempotencyKey = randomUUID();
  const corpo = { codigoJustificativa: codigo, justificativa };
  const operacaoId = banco.criarOperacao({ notaId: null, nfseId: nfse.id, tipo: 'cancelamento', idempotencyKey, corpoEnviado: JSON.stringify(corpo) });
  try {
    const aceite = await cliente.cancelarNfse(operacional, nfse.commandId, codigo, justificativa, idempotencyKey);
    banco.gravarAceiteOperacao(operacaoId, aceite.corpo.id, aceite.corpo.status, JSON.stringify(aceite.corpo));
    return {
      ok: true,
      titulo: `HTTP ${aceite.status}: cancelamento aceito; o comando NOVO ${aceite.corpo.id} está ${aceite.corpo.status}`,
      detalhe: 'A NFS-e segue autorizada até o feed trazer o nfse.cancel desse comando (tela Eventos). O prazo é do município e a plataforma não o confere: a SEFIN decide, e a recusa dela chega como tentativa rejeitada.',
      corpo: { enviado: corpo, aceite: aceite.corpo },
    };
  } catch (erro) {
    return resultadoDeErro('Cancelamento recusado pela API', erro);
  }
}

const CODIGOS_SUBSTITUICAO: [string, string][] = [
  ['01', 'desenquadramento do Simples Nacional'],
  ['02', 'enquadramento no Simples Nacional'],
  ['03', 'inclusão retroativa de imunidade ou isenção'],
  ['04', 'exclusão retroativa de imunidade ou isenção'],
  ['05', 'rejeição da NFS-e pelo tomador ou intermediário'],
  ['99', 'outros'],
];

/**
 * Substituir é emitir outra DPS com o pedido de substituição, e não uma operação sobre a original: a SEFIN gera a
 * substituta e cancela a original no mesmo envio. A original só muda de situação quando a substituta é autorizada, e
 * quem fica sabendo é o feed. Fica gravada a NFS-e local que esta substitui, e o pedido leva o `id` que a plataforma
 * devolveu no aceite da original.
 */
async function substituir(ctx: Contexto): Promise<Resultado> {
  const a = alvo(ctx);
  if (ehResultado(a)) return a;
  const { banco, cliente, form } = ctx;
  const { nfse, operacional } = a;
  const { emitenteId } = banco.configuracao();
  if (!emitenteId) return { ok: false, titulo: 'Substituir exige o emitente cadastrado' };

  if (!permiteSubstituirNfse(nfse)) return { ok: false, titulo: `Substituição recusada na tela: a NFS-e ${nfse.id} está ${situacaoLocalNfse(nfse)}; só a autorizada se substitui`, detalhe: 'A API responderia 409 nfse-not-substitutable. A substituta também tem de ser do mesmo ambiente da original.' };
  const codigo = form.get('codigo_justificativa') ?? '';
  if (!CODIGOS_SUBSTITUICAO.some(([c]) => c === codigo)) return { ok: false, titulo: 'Código da substituição: 01, 02, 03, 04, 05 ou 99', detalhe: 'A API responderia 422 cancellation-reason-invalid.' };
  // A justificativa é opcional, salvo com o 99; quando vai, obedece ao envelope da SEFAZ.
  const justificativa = form.get('justificativa') ?? '';
  if (codigo === '99' && justificativa === '') return { ok: false, titulo: 'Com o código 99 a justificativa é obrigatória', detalhe: 'A API responderia 422 cancellation-reason-invalid.' };
  if (justificativa !== '') {
    const invalida = motivoTextoInvalido(justificativa, 'A justificativa', LIMITES.justificativa.minimo, LIMITES.justificativa.maximo);
    if (invalida) return { ok: false, titulo: `Justificativa recusada na tela, nada foi enviado: ${invalida}`, detalhe: 'A API responderia 422 cancellation-reason-invalid.' };
  }

  const montado = await montarCorpoNfse(ctx, operacional, emitenteId);
  if ('recusa' in montado) return montado.recusa;
  const corpo = { ...montado.corpo, substituicao: { nfse: nfse.commandId, codigoJustificativa: codigo, ...(justificativa === '' ? {} : { justificativa }) } };

  // ---- Grava e só então chama, como na emissão. ----
  const idempotencyKey = randomUUID();
  const novaId = banco.criarNfsePendente({ serie: corpo.serie, idempotencyKey, corpoEnviado: JSON.stringify(corpo), substitui: nfse.id });
  try {
    const resposta = await cliente.emitirNfse(operacional, corpo as typeof montado.corpo, idempotencyKey, WAIT_MS);
    const r = gravarRespostaDaEmissaoNfse(banco, novaId, resposta.status, resposta.corpo, corpo.documento);
    return { ...r!, titulo: `Substituição da NFS-e ${nfse.id} pela NFS-e ${novaId}. ${r!.titulo}` };
  } catch (erro) {
    return resultadoDeErro(`Substituição recusada; a NFS-e local ${novaId} fica gravada com a chave ${idempotencyKey}`, erro);
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
/** O XML e o DANFSe existem para a DPS que a SEFIN transformou em NFS-e: a autorizada, a cancelada e a substituída. */
export const permiteArquivoNfse = (n: Nfse): boolean => ['autorizada', 'cancelada', 'substituida'].includes(situacaoLocalNfse(n));
/** Consultar vale para qualquer NFS-e que a API conhece: é não-destrutivo. */
export const permiteConsultarNfse = (n: Nfse): boolean => n.commandId !== null;
export const permiteCancelarNfse = (n: Nfse): boolean => situacaoLocalNfse(n) === 'autorizada';
export const permiteSubstituirNfse = (n: Nfse): boolean => situacaoLocalNfse(n) === 'autorizada';

// ---------------------------------------------------------------- render: lista

async function renderizarLista({ banco, chamadas }: Contexto, ultimo: Resultado): Promise<Resposta> {
  const nfses = banco.listarNfses();
  const corpo: Html = html`
<h1>NFS-e</h1>
<p>Status <b>local</b>. "do wait" é o que a resposta da emissão disse; "feed" e "webhook" são quem confirmou. As ações aparecem só na situação que as permite; a rota que cada uma consome está no cabeçalho de <code>src/telas/nfse.ts</code>. Cancelar e substituir ficam no detalhe da NFS-e.</p>
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
  <td><a href="/nfse/${n.id}">${n.id}</a>${n.substitui ? html`<br><small>substitui a ${n.substitui}</small>` : vazio}</td><td>${n.serie}/${n.numeroDps ?? '-'}</td><td>${n.numeroNfse ?? '-'}</td>
  <td><b>${situacaoLocalNfse(n)}</b></td>
  <td>${n.confirmadoPor ?? (n.status ? 'do wait, aguardando o feed' : 'ninguém: a chamada não voltou')}</td>
  <td><code>${n.commandId ?? '-'}</code></td><td><code>${n.chave ?? '-'}</code></td>
  <td>
    ${motivo ? html`<p class="motivo"><b>motivo:</b> ${motivo}</p>` : vazio}
    ${permiteArquivoNfse(n) ? html`<a href="/nfse/${n.id}/xml">XML</a> <a href="/nfse/${n.id}/danfse">DANFSe</a> ` : vazio}
    ${permiteCancelarNfse(n) ? html`<a href="/nfse/${n.id}#cancelar">Cancelar</a> <a href="/nfse/${n.id}#substituir">Substituir</a> ` : vazio}
    ${permiteConsultarNfse(n) ? html`<form method="post" action="/nfse/${n.id}/consultar" style="display:inline"><button>Consultar na SEFIN</button></form> ` : vazio}
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
  const { emitenteId } = banco.configuracao();

  // A ficha ao vivo: é dela que saem o resumo que a SEFIN calculou, a situação de agora e os vínculos da substituição.
  let detalhe: DetalheNfse | null = null;
  let emitente: Emitente | null = null;
  let erroLeitura: Resultado = null;
  if (nfse.commandId && operacional) {
    try {
      detalhe = (await cliente.lerNfse(operacional, nfse.commandId)).corpo;
      // O CRT decide se o ME/EPP está sujeito ao E0063 na substituta, e só importa a quem pode substituir.
      if (permiteSubstituirNfse(nfse) && emitenteId) emitente = (await cliente.lerEmitente(operacional, emitenteId)).corpo;
    } catch (erro) {
      erroLeitura = resultadoDeErro('Não consegui ler a NFS-e na API', erro);
    }
  }
  const operacoes = banco.listarOperacoesNfse(nfse.id);
  const situacao = situacaoLocalNfse(nfse);
  const motivo = motivoDaNfse(nfse);
  const resumo = detalhe?.resumo;
  const substituta = detalhe?.substituidaPor?.id ? banco.lerNfsePorComando(detalhe.substituidaPor.id) : null;
  const original = nfse.substitui === null ? null : banco.lerNfse(nfse.substitui);

  const corpo: Html = html`
<h1>NFS-e local ${nfse.id} · série ${nfse.serie} · DPS ${nfse.numeroDps ?? '-'} · NFS-e ${nfse.numeroNfse ?? '-'}</h1>
<p><a href="/nfse">← NFS-e</a></p>
${resultado(ultimo)}
${resultado(erroLeitura)}
<section>
  <h2>Situação local: <b>${situacao}</b> <small>(${nfse.confirmadoPor ? `confirmada por ${nfse.confirmadoPor}` : nfse.status ? 'do wait, aguardando o feed' : 'a chamada não voltou'})</small></h2>
  <p>Comando <code>${nfse.commandId ?? '-'}</code> · chave <code>${nfse.chave ?? '-'}</code> · Idempotency-Key <code>${nfse.idempotencyKey}</code></p>
  ${detalhe ? html`<p>Na API agora: <b>${detalhe.situacao}</b> (status ${detalhe.status}${detalhe.outcome ? ' / ' + detalhe.outcome : ''}, ${detalhe.attempts} tentativa(s))${detalhe.canceladaEm ? html`; cancelada em ${detalhe.canceladaEm}, origem ${detalhe.origemCancelamento ?? '-'}, justificativa "${detalhe.justificativaCancelamento ?? ''}"` : vazio}.</p>` : vazio}
  ${original ? html`<p>Esta NFS-e substitui a NFS-e local ${original.id} (<a href="/nfse/${original.id}">abrir</a>).</p>` : vazio}
  ${detalhe?.substituidaPor ? html`<p>Esta NFS-e foi substituída pela NFS-e ${substituta ? html`local ${substituta.id} (<a href="/nfse/${substituta.id}">abrir</a>)` : html`de chave <code>${detalhe.substituidaPor.chave}</code>`}, gerada em ${detalhe.substituidaEm ?? '-'}.</p>` : vazio}
  ${motivo ? html`<p class="motivo"><b>motivo:</b> ${motivo}</p>` : vazio}
  ${resumo ? html`<p>Tomador ${resumo.tomadorNome ?? '-'} (${resumo.tomadorDoc ?? '-'}) · competência ${resumo.competencia ?? '-'} · serviço ${resumo.codigoTributacaoNacional ?? '-'} · valor ${dinheiroOuTraco(resumo.valorServico)}${resumo.valorIssqn === null ? vazio : html` · ISSQN ${dinheiroOuTraco(resumo.valorIssqn)} · retido ${dinheiroOuTraco(resumo.valorRetido)} · líquido ${dinheiroOuTraco(resumo.valorLiquido)} · incidência ${resumo.municipioIncidencia ?? '-'} ${resumo.nomeMunicipioIncidencia ?? ''}`}</p>
  <p><small>O resumo traz o que o documento informou e o que só a SEFIN calcula: o município de incidência, o ISSQN, o total retido e o valor líquido ficam nulos antes da autorizada.</small></p>` : vazio}
  ${permiteArquivoNfse(nfse) ? html`<p><a href="/nfse/${nfse.id}/xml">XML</a> · <a href="/nfse/${nfse.id}/danfse">DANFSe</a></p>` : vazio}
</section>

<section id="consultar">
  <h2>Consultar na SEFIN <span class="rota">POST /v1/nfse/{id}/consulta</span> → <span class="rota">GET /v1/nfse/{id}</span></h2>
  <p>Assíncrona e não-destrutiva: a resposta é só o aceite, e o resultado vem ao reler a NFS-e. Numa NFS-e já gerada ela traz os cancelamentos feitos fora da plataforma (pelo Emissor Nacional, por análise fiscal, de ofício pelo município ou por substituição); numa DPS que não virou NFS-e, procura a nota que a SEFIN gerou.</p>
  ${permiteConsultarNfse(nfse) ? html`<form method="post" action="/nfse/${nfse.id}/consultar"><button>Consultar e reler</button></form>` : html`<p>Sem comando na API: nada a consultar.</p>`}
</section>

<section id="cancelar">
  <h2>Cancelar <span class="rota">POST /v1/nfse/{id}/cancelamento</span> · <span class="rota">GET /v1/nfse/{id}/cancelamento</span></h2>
  ${permiteCancelarNfse(nfse)
    ? html`<p>Só a NFS-e autorizada cancela. Vão o código e a justificativa, de ${LIMITES.justificativa.minimo} a ${LIMITES.justificativa.maximo} caracteres no envelope da SEFAZ; a tela confere antes de chamar. O prazo é do município, e a plataforma não o confere: a recusa por prazo vem da SEFIN, na tentativa rejeitada, e a tela a mostra abaixo.</p>
  <form method="post" action="/nfse/${nfse.id}/cancelar">
    <label>Código (<code>codigoJustificativa</code>)<br><select name="codigo_justificativa">${CODIGOS_CANCELAMENTO.map(([c, nome]) => html`<option value="${c}">${c} · ${nome}</option>`)}</select></label>
    <label>Justificativa<br><input name="justificativa" size="80" value="Cancelamento por erro de digitacao no valor do servico"></label>
    <button>Cancelar a NFS-e</button>
  </form>`
    : html`<p>Não oferecido: a NFS-e está <b>${situacao}</b>, e só a autorizada cancela (a API responderia 409 nfse-not-cancelable).</p>`}
</section>

<section id="substituir">
  <h2>Substituir <span class="rota">POST /v1/nfse</span> com <code>substituicao</code></h2>
  ${permiteSubstituirNfse(nfse)
    ? html`<p>É uma emissão nova, com o mesmo documento e o pedido de substituição: a SEFIN gera a substituta e cancela a original no mesmo envio. O pedido leva o <code>id</code> desta NFS-e, o que a plataforma devolveu no aceite dela, e o motivo. A original só vira substituída quando a substituta é autorizada, e o feed (tela Eventos) é quem avisa. A substituta conta na franquia como qualquer emissão.</p>
  ${emitente && exigePercentualSimples(emitente.crt) ? html`<p><b>ME/EPP:</b> a SEFIN recusa com E0063 a substituta que muda a competência, o valor do serviço ou o tomador identificado na original, e a plataforma não confere isso antes do envio. A substituta rejeitada também conta na franquia. O formulário vem preenchido com o que a original informou.</p>` : vazio}
  <form method="post" action="/nfse/${nfse.id}/substituir">
    <div class="grid">
      <label>Código (<code>codigoJustificativa</code>)<br><select name="codigo_justificativa">${CODIGOS_SUBSTITUICAO.map(([c, nome]) => html`<option value="${c}">${c} · ${nome}</option>`)}</select></label>
      <label>Justificativa (obrigatória com o 99)<br><input name="justificativa" size="50"></label>
    </div>
    ${camposNfse(valoresDoCorpo(JSON.parse(nfse.corpoEnviado)), Boolean(emitente && exigePercentualSimples(emitente.crt)))}
    <button>Emitir a substituta</button>
  </form>`
    : html`<p>Não oferecido: a NFS-e está <b>${situacao}</b>, e só a autorizada se substitui (a API responderia 409 nfse-not-substitutable).</p>`}
</section>

<section>
  <h2>Operações desta NFS-e</h2>
  ${operacoes.length === 0 ? html`<p>Nenhuma ainda.</p>` : tabelaOperacoes(operacoes)}
</section>

<section>
  <details><summary>corpo enviado na emissão</summary><pre>${JSON.stringify(JSON.parse(nfse.corpoEnviado), null, 2)}</pre></details>
  ${nfse.ultimoResultado ? html`<details><summary>último corpo devolvido pela API</summary><pre>${JSON.stringify(JSON.parse(nfse.ultimoResultado), null, 2)}</pre></details>` : vazio}
</section>`;
  return { html: pagina('NFS-e', '/nfse', corpo, chamadas) };
}

/** O motivo da última leitura da operação: o da tentativa de cancelamento rejeitada ou falha. */
function motivoDaOperacao(o: Operacao): string | null {
  if (!o.ultimoResultado) return null;
  try {
    const m = (JSON.parse(o.ultimoResultado) as { motivo?: unknown }).motivo;
    return typeof m === 'string' ? m : null;
  } catch {
    return null;
  }
}

function tabelaOperacoes(operacoes: Operacao[]): Html {
  return html`<table><tr><th>#</th><th>operação</th><th>situação</th><th>comando</th><th>confirmada por</th><th>motivo</th></tr>
${operacoes.map((o) => html`<tr><td>${o.id}</td><td>${o.tipo}</td><td><b>${situacaoOperacao(o)}</b></td><td><code>${o.commandId ?? '-'}</code></td><td>${o.confirmadoPor ?? '-'}</td><td>${motivoDaOperacao(o) ?? '-'}</td></tr>`)}</table>`;
}

const dinheiroOuTraco = (n: number | null): string => (n === null ? '-' : dinheiro(n));
