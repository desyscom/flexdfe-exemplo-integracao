// Tela Nova nota: monta o `documento`, gera a `Idempotency-Key`, grava a nota como pendente e só
// então chama a emissão com `wait`.
//
//   GET  /v1/emitentes/{id}      gestão       o CRT decide a variante tributária dos itens
//   POST /v1/nfe?wait=8000       operacional  a emissão
//
// A ordem é a lição: a chave e o corpo ficam gravados ANTES da chamada. Se a rede cair depois do
// POST e antes da resposta, a nota continua no banco com a mesma chave, e reenviar é replay, não
// uma segunda nota. A resposta da emissão só grava o `id` e o status inicial; quando o `wait` traz o
// desfecho, ele é gravado também, mas é o feed (tela Eventos) que o confirma.

import { randomUUID } from 'node:crypto';
import type { Contexto, Resposta, Rota } from '../app.ts';
import type { Emitente } from '../cliente-api.ts';
import { dinheiro, html, pagina, resultado, resultadoDeErro, vazio, type Resultado } from '../html.ts';
import { divergenciaPagamento, FORMAS_PAGAMENTO, montarDocumento, variantePorCrt, type ItemPedido, type PagamentoPedido } from '../documento.ts';
import { gravarRespostaDaEmissao } from './notas.ts';

/** Janela síncrona. O teto da API é 15000; 8000 é o do Quickstart. */
export const WAIT_MS = 8000;

export const telaNovaNota: Rota = (ctx) => renderizar(ctx, null);

export const acoesNovaNota: Record<string, Rota> = {
  emitir: async (ctx) => renderizar(ctx, await emitir(ctx)),
};

async function emitir(ctx: Contexto): Promise<Resultado> {
  const { form, banco, cliente, config } = ctx;
  const operacional = banco.credencialOperacional();
  const { emitenteId } = banco.configuracao();
  if (!operacional || !emitenteId) return { ok: false, titulo: 'Emitir exige a credencial operacional', detalhe: 'Complete a tela Emitente antes.' };

  // ---- O pedido, lido do formulário e conferido antes de qualquer chamada. ----
  const modelo = Number(form.get('modelo')) as 55 | 65;
  const serie = Number(form.get('serie'));
  if (![55, 65].includes(modelo) || !Number.isInteger(serie)) return { ok: false, titulo: 'Modelo 55 ou 65 e série inteira' };

  const destinatario = form.get('destinatario') ? banco.lerDestinatario(Number(form.get('destinatario'))) : null;
  if (modelo === 55 && !destinatario) return { ok: false, titulo: 'A NF-e (55) exige destinatário', detalhe: 'Só a NFC-e (65) aceita consumidor não identificado.' };

  const itens: ItemPedido[] = [];
  for (const produto of banco.listarProdutos()) {
    const quantidade = Number(form.get(`qtd_${produto.id}`) || 0);
    if (quantidade > 0) itens.push({ produto, quantidade });
  }
  if (itens.length === 0) return { ok: false, titulo: 'Escolha ao menos um item' };

  const pagamentos: PagamentoPedido[] = [];
  for (const n of [1, 2]) {
    const vPag = Number((form.get(`vpag_${n}`) ?? '').replace(',', '.') || 0);
    if (vPag > 0) pagamentos.push({ tPag: form.get(`tpag_${n}`) ?? '01', vPag });
  }
  const vTroco = Number((form.get('vtroco') ?? '').replace(',', '.') || 0);
  if (pagamentos.length === 0) return { ok: false, titulo: 'Informe o pagamento', detalhe: 'O grupo pag é obrigatório nos dois modelos. Na NFC-e é o que a SEFAZ mais confere.' };

  const divergencia = divergenciaPagamento({ itens, pagamentos, vTroco });
  if (divergencia) return { ok: false, titulo: 'Pagamento divergente, nada foi enviado', detalhe: `${divergencia}. A API aceitaria e devolveria o alerta PAG_DIVERGENTE no resultado; conferir antes é mais barato.` };

  // ---- O CRT do emitente escolhe a variante tributária. ----
  let emitente: Emitente;
  try {
    emitente = (await cliente.lerEmitente(config.gestao, emitenteId)).corpo;
  } catch (erro) {
    return resultadoDeErro('Não consegui ler o emitente para saber o CRT', erro);
  }

  // ---- Monta, grava e só então chama. ----
  const corpo = { modelo, serie, documento: montarDocumento({ modelo, emitente, destinatario, itens, pagamentos, vTroco }) };
  const idempotencyKey = randomUUID();
  const corpoEnviado = JSON.stringify(corpo);
  const notaId = banco.criarNotaPendente({ modelo, serie, idempotencyKey, corpoEnviado });

  try {
    const resposta = await cliente.emitirNfe(operacional, corpo, idempotencyKey, WAIT_MS);
    return gravarRespostaDaEmissao(banco, notaId, resposta.status, resposta.corpo, corpo.documento);
  } catch (erro) {
    // A nota fica gravada com a chave. Na tela Notas, "Reenviar" manda o mesmo corpo com a mesma chave.
    return resultadoDeErro(`Emissão recusada; a nota local ${notaId} fica gravada com a chave ${idempotencyKey}`, erro);
  }
}

async function renderizar(ctx: Contexto, ultimo: Resultado): Promise<Resposta> {
  const { banco, chamadas, cliente, config } = ctx;
  const operacional = banco.credencialOperacional();
  const { emitenteId } = banco.configuracao();
  const produtos = banco.listarProdutos();
  const destinatarios = banco.listarDestinatarios();

  let emitente: Emitente | null = null;
  if (emitenteId) {
    try {
      emitente = (await cliente.lerEmitente(config.gestao, emitenteId)).corpo;
    } catch {
      // A tela abaixo explica que falta o emitente; o erro detalhado está na tela Emitente.
    }
  }
  const variante = emitente ? variantePorCrt(emitente.crt) : null;
  const foraDaUf = destinatarios.filter((d) => emitente && d.uf !== emitente.uf);

  const corpo = html`
<h1>Nova nota</h1>
<p>Monta o <code>documento</code>, gera a <code>Idempotency-Key</code>, grava a nota como pendente e só então chama <span class="rota">POST /v1/nfe?wait=${WAIT_MS}</span> com a credencial <b>operacional</b>.</p>
${resultado(ultimo)}
${!operacional || !emitente ? html`<section class="erro"><h2>Antes, complete a tela Emitente</h2><p>A emissão exige a credencial operacional e, para escolher a tributação, o CRT do emitente.</p></section>` : vazio}
${emitente ? html`<section><h2>Tributação pelo CRT do emitente</h2><p>CRT <b>${emitente.crt}</b>: os itens saem na variante <b>${variante === 'simples' ? 'Simples Nacional (csosn)' : 'Regime Normal (cst + ICMS destacado)'}</b>. Os dois eixos são exclusivos; o eixo trocado cai na recusa antecipada da plataforma, sem ir à SEFAZ.</p></section>` : vazio}
${foraDaUf.length ? html`<section class="erro"><h2>Destinatário fora da UF do emitente</h2><p>${foraDaUf.map((d) => d.nome).join(', ')}: a venda vira interestadual (<code>idDest = 2</code>) e, para consumidor final, a SEFAZ exige o grupo do DIFAL, que este exemplo não monta. Cadastre um destinatário em ${emitente!.uf}.</p></section>` : vazio}
<section>
  <form method="post" action="/nova-nota/emitir">
    <div class="grid">
      <label>Modelo<br><select name="modelo"><option value="55">55 · NF-e (destinatário obrigatório)</option><option value="65">65 · NFC-e (destinatário opcional)</option></select></label>
      <label>Série<br><input name="serie" value="1" size="4"></label>
      <label>Destinatário<br><select name="destinatario"><option value="">(nenhum: só no 65)</option>${destinatarios.map((d) => html`<option value="${d.id}">${d.nome} · ${d.documento}</option>`)}</select></label>
    </div>
    <h2>Itens</h2>
    <table><tr><th>Qtd</th><th>Código</th><th>Descrição</th><th>Un</th><th>Valor</th></tr>
    ${produtos.map((p) => html`<tr><td><input name="qtd_${p.id}" value="0" size="3"></td><td>${p.codigo}</td><td>${p.descricao}</td><td>${p.unidade}</td><td>${dinheiro(p.valorUnitario)}</td></tr>`)}
    </table>
    <h2>Pagamento</h2>
    <p>A soma dos pagamentos menos o troco tem de fechar com o total dos itens. A tela confere antes de enviar.</p>
    <div class="grid">
      ${[1, 2].map((n) => html`<label>Forma ${n}<br><select name="tpag_${n}">${FORMAS_PAGAMENTO.map(([c, nome]) => html`<option value="${c}">${c} · ${nome}</option>`)}</select></label><label>Valor ${n}<br><input name="vpag_${n}" value="${n === 1 ? '' : '0'}"></label>`)}
      <label>Troco (<code>vTroco</code>, nível do documento)<br><input name="vtroco" value="0"></label>
    </div>
    <button ${operacional && emitente ? vazio : html`disabled`}>Emitir em homologação</button>
  </form>
</section>`;
  return { html: pagina('Nova nota', '/nova-nota', corpo, chamadas) };
}
