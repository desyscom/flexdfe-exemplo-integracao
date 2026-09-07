// Tela Inutilização: declara à SEFAZ que uma faixa de números de uma série não será usada.
//
//   POST /v1/inutilizacoes?wait=8000   operacional  a faixa e a justificativa; Idempotency-Key
//
// Opera sobre a FAIXA, não sobre uma nota: o uso típico é fechar uma lacuna de numeração, números que
// foram pulados e nunca viraram nota autorizada. É passthrough: a borda confere só a FORMA dos campos
// (modelo 55|65, série 0–999, números 1–999.999.999, justificativa 15–255). Se a faixa procede, se
// `nNFIni ≤ nNFFin`, é a SEFAZ que decide, e a recusa volta como desfecho rejeitado, não como 422.
// Esta tela confere a mesma forma que a borda, e nada mais, de propósito: para o programador ver que
// uma faixa invertida passa pela API e volta rejeitada pela SEFAZ.
//
// Mesmo molde da emissão: chave e corpo gravados antes, `wait`, e o feed fecha como `nfe.inutiliza`.

import { randomUUID } from 'node:crypto';
import type { Contexto, Resposta, Rota } from '../app.ts';
import type { FaixaInutilizacao } from '../cliente-api.ts';
import { html, pagina, resultado, resultadoDeErro, type Resultado } from '../html.ts';
import { situacaoPeloEvento } from '../eventos.ts';
import { LIMITES, motivoTextoInvalido } from '../texto-sefaz.ts';
import { WAIT_MS } from './nova-nota.ts';
import { tabelaOperacoes } from './notas.ts';

export const telaInutilizacao: Rota = (ctx) => renderizar(ctx, null);

export const acoesInutilizacao: Record<string, Rota> = {
  inutilizar: async (ctx) => renderizar(ctx, await inutilizar(ctx)),
};

/** A forma que a borda confere. Devolve a faixa pronta, ou o motivo pelo qual a API responderia 422. */
export function lerFaixa(form: URLSearchParams): FaixaInutilizacao | string {
  const inteiro = (nome: string): number => Number(form.get(nome) ?? '');
  const modelo = inteiro('modelo');
  const serie = inteiro('serie');
  const nNFIni = inteiro('nNFIni');
  const nNFFin = inteiro('nNFFin');
  const xJust = form.get('xJust') ?? '';
  if (modelo !== 55 && modelo !== 65) return 'modelo deve ser 55 ou 65';
  if (!Number.isInteger(serie) || serie < 0 || serie > 999) return 'série deve ser um inteiro de 0 a 999';
  for (const [nome, valor] of [['nNFIni', nNFIni], ['nNFFin', nNFFin]] as const)
    if (!Number.isInteger(valor) || valor < 1 || valor > 999_999_999) return `${nome} deve ser um inteiro de 1 a 999.999.999`;
  const invalida = motivoTextoInvalido(xJust, 'A justificativa', LIMITES.justificativa.minimo, LIMITES.justificativa.maximo);
  if (invalida) return invalida;
  // Sem conferir nNFIni ≤ nNFFin: a borda também não confere. A SEFAZ é a autoridade sobre a faixa.
  return { modelo, serie, nNFIni, nNFFin, xJust };
}

async function inutilizar({ form, banco, cliente }: Contexto): Promise<Resultado> {
  const operacional = banco.credencialOperacional();
  if (!operacional) return { ok: false, titulo: 'Inutilizar exige a credencial operacional', detalhe: 'Complete a tela Emitente antes.' };

  const faixa = lerFaixa(form);
  if (typeof faixa === 'string') return { ok: false, titulo: `Forma inválida, nada foi enviado: ${faixa}`, detalhe: 'É só isto que a borda confere; a API responderia 422 invalid-request-body.' };

  const idempotencyKey = randomUUID();
  const operacaoId = banco.criarOperacao({ notaId: null, tipo: 'inutilizacao', idempotencyKey, corpoEnviado: JSON.stringify(faixa) });
  try {
    const resposta = await cliente.inutilizarFaixa(operacional, faixa, idempotencyKey, WAIT_MS);
    const corpo = resposta.corpo;
    banco.gravarAceiteOperacao(operacaoId, corpo.id, corpo.status, JSON.stringify(corpo));
    if ('outcome' in corpo) {
      const situacao = situacaoPeloEvento(corpo);
      banco.gravarDesfechoOperacao(operacaoId, { status: corpo.status, outcome: corpo.outcome, situacao, ultimoResultado: JSON.stringify(corpo) });
      const motivo = typeof corpo.result?.motivo === 'string' ? corpo.result.motivo : null;
      return {
        ok: situacao === 'registrada',
        titulo: `HTTP ${resposta.status}: o wait resolveu, ${corpo.status}${corpo.outcome ? ' / ' + corpo.outcome : ''}: faixa ${situacao}`,
        detalhe: situacao === 'registrada'
          ? `Os números ${faixa.nNFIni}–${faixa.nNFFin} da série ${faixa.serie} passam à situação inutilizada na SEFAZ. O feed confirma como nfe.inutiliza.`
          : `A borda aceitou a forma; quem recusou foi a SEFAZ${motivo ? `: ${motivo}` : ''}. É assim que uma faixa que não procede volta: como desfecho, não como 422.`,
        corpo: { enviado: faixa, resposta: corpo },
      };
    }
    return {
      ok: true,
      titulo: `HTTP ${resposta.status}: aceite, comando ${corpo.id} está ${corpo.status}`,
      detalhe: 'O wait estourou ou é replay. A tela Eventos fecha o desfecho pelo feed (nfe.inutiliza).',
      corpo: { enviado: faixa, resposta: corpo },
    };
  } catch (erro) {
    return resultadoDeErro(`Inutilização recusada; a operação ${operacaoId} fica gravada com a chave ${idempotencyKey}`, erro);
  }
}

async function renderizar({ banco, chamadas }: Contexto, ultimo: Resultado): Promise<Resposta> {
  const operacional = banco.credencialOperacional();
  const operacoes = banco.listarOperacoes().filter((o) => o.tipo === 'inutilizacao');
  const corpo = html`
<h1>Inutilização</h1>
<p>Declara à SEFAZ que uma faixa de números de uma série não será usada: <span class="rota">POST /v1/inutilizacoes?wait=${WAIT_MS}</span> com a credencial <b>operacional</b> e <code>Idempotency-Key</code>. Opera sobre a faixa, não sobre uma nota.</p>
${resultado(ultimo)}
<section>
  <h2>A borda só confere a forma</h2>
  <p>Modelo 55 ou 65, série de 0 a 999, números de 1 a 999.999.999, justificativa de ${LIMITES.justificativa.minimo} a ${LIMITES.justificativa.maximo} caracteres. <b>Nem a API nem esta tela conferem se <code>nNFIni ≤ nNFFin</code> ou se a faixa procede</b>: é a SEFAZ que decide, e a recusa dela volta como desfecho <b>rejeitado</b>, não como 422. Experimente uma faixa invertida.</p>
  <form method="post" action="/inutilizacao/inutilizar">
    <div class="grid">
      <label>Modelo<br><select name="modelo"><option value="55">55 · NF-e</option><option value="65">65 · NFC-e</option></select></label>
      <label>Série<br><input name="serie" value="1" size="4"></label>
      <label>Número inicial (<code>nNFIni</code>)<br><input name="nNFIni" value="" size="10"></label>
      <label>Número final (<code>nNFFin</code>)<br><input name="nNFFin" value="" size="10"></label>
    </div>
    <label>Justificativa (<code>xJust</code>)<br><input name="xJust" size="80" value="Numeracao pulada por falha na transmissao ao SEFAZ"></label>
    <button ${operacional ? '' : 'disabled'}>Inutilizar a faixa em homologação</button>
  </form>
  ${operacional ? '' : html`<p class="erro">Antes, complete a tela Emitente: a inutilização exige a credencial operacional.</p>`}
</section>
<section>
  <h2>Inutilizações feitas por esta aplicação</h2>
  ${operacoes.length === 0 ? html`<p>Nenhuma ainda.</p>` : tabelaOperacoes(operacoes)}
</section>`;
  return { html: pagina('Inutilização', '/inutilizacao', corpo, chamadas) };
}
