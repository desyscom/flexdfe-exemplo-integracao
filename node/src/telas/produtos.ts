// Tela Produtos: cadastro local mínimo. Nenhuma rota da API é consumida aqui: o produto só existe
// para montar o item da nota. Cada produto guarda as duas variantes tributárias; a que vai para a
// nota é escolhida pelo CRT do emitente na tela Nova nota.

import type { Contexto, Resposta, Rota } from '../app.ts';
import { dinheiro, html, pagina, resultado, type Resultado } from '../html.ts';

export const telaProdutos: Rota = (ctx) => renderizar(ctx, null);

export const acoesProdutos: Record<string, Rota> = {
  criar: async (ctx) => renderizar(ctx, criar(ctx)),
  apagar: async (ctx) => {
    ctx.banco.apagarProduto(Number(ctx.form.get('id')));
    return { redirecionar: '/produtos' };
  },
};

function criar({ form, banco }: Contexto): Resultado {
  const campo = (nome: string) => form.get(nome)?.trim() ?? '';
  const p = {
    codigo: campo('codigo'),
    descricao: campo('descricao').toUpperCase(),
    ncm: campo('ncm').replace(/\D/g, ''),
    cfop: campo('cfop').replace(/\D/g, ''),
    unidade: campo('unidade').toUpperCase() || 'UN',
    valorUnitario: Number(campo('valor_unitario').replace(',', '.')),
    csosn: campo('csosn') || '102',
    cst: campo('cst') || '00',
    aliquotaIcms: Number(campo('aliquota_icms').replace(',', '.') || 0),
  };
  if (!p.codigo || !p.descricao || p.ncm.length !== 8 || p.cfop.length !== 4 || !(p.valorUnitario > 0))
    return { ok: false, titulo: 'Produto incompleto', detalhe: 'Código, descrição, NCM de 8 dígitos, CFOP de 4 dígitos e valor maior que zero.' };
  try {
    banco.criarProduto(p);
  } catch (erro) {
    return { ok: false, titulo: 'Não gravou', detalhe: erro instanceof Error ? erro.message : String(erro) };
  }
  return { ok: true, titulo: `Produto ${p.codigo} cadastrado` };
}

async function renderizar({ banco, chamadas }: Contexto, ultimo: Resultado): Promise<Resposta> {
  const produtos = banco.listarProdutos();
  const corpo = html`
<h1>Produtos</h1>
<p>Cadastro local. Os produtos semeados são fictícios; os códigos e as alíquotas são plausíveis, não uma recomendação. A classificação fiscal de cada item é sua.</p>
${resultado(ultimo)}
<section>
  <h2>Cadastrados</h2>
  <table><tr><th>Código</th><th>Descrição</th><th>NCM</th><th>CFOP</th><th>Un</th><th>Valor</th><th>Simples: CSOSN</th><th>Normal: CST · ICMS %</th><th></th></tr>
  ${produtos.map(
    (p) => html`<tr><td>${p.codigo}</td><td>${p.descricao}</td><td>${p.ncm}</td><td>${p.cfop}</td><td>${p.unidade}</td><td>${dinheiro(p.valorUnitario)}</td><td>${p.csosn}</td><td>${p.cst} · ${p.aliquotaIcms}</td><td><form method="post" action="/produtos/apagar"><input type="hidden" name="id" value="${p.id}"><button>Apagar</button></form></td></tr>`,
  )}
  </table>
  <p>PIS e COFINS não são por produto neste exemplo: no Simples vão com CST 49 zerados; no Regime Normal, CST 01 a 0,65% e 3%. Veja <code>src/documento.ts</code>.</p>
</section>
<section>
  <h2>Novo produto</h2>
  <form method="post" action="/produtos/criar"><div class="grid">
    <label>Código<br><input name="codigo" required></label>
    <label>Descrição<br><input name="descricao" required></label>
    <label>NCM (8 dígitos)<br><input name="ncm" required></label>
    <label>CFOP<br><input name="cfop" value="5102" required></label>
    <label>Unidade<br><input name="unidade" value="UN"></label>
    <label>Valor unitário<br><input name="valor_unitario" required></label>
    <label>CSOSN (Simples)<br><input name="csosn" value="102"></label>
    <label>CST (Regime Normal)<br><input name="cst" value="00"></label>
    <label>Alíquota ICMS % (Regime Normal)<br><input name="aliquota_icms" value="18"></label>
  </div><button>Cadastrar</button></form>
</section>`;
  return { html: pagina('Produtos', '/produtos', corpo, chamadas) };
}
