// Tela Destinatários: cadastro local mínimo. Nenhuma rota da API. Em homologação, a SEFAZ exige o
// nome fixo no destinatário; o semeado já o traz, e o formulário o preenche por padrão.

import { NOME_DESTINATARIO_HOMOLOGACAO } from '../banco.ts';
import type { Contexto, Resposta, Rota } from '../app.ts';
import { html, pagina, resultado, type Resultado } from '../html.ts';

export const telaDestinatarios: Rota = (ctx) => renderizar(ctx, null);

export const acoesDestinatarios: Record<string, Rota> = {
  criar: async (ctx) => renderizar(ctx, criar(ctx)),
  apagar: async (ctx) => {
    ctx.banco.apagarDestinatario(Number(ctx.form.get('id')));
    return { redirecionar: '/destinatarios' };
  },
};

function criar({ form, banco }: Contexto): Resultado {
  const campo = (nome: string) => form.get(nome)?.trim() ?? '';
  const d = {
    documento: campo('documento').replace(/\D/g, ''),
    nome: campo('nome').toUpperCase(),
    logradouro: campo('logradouro').toUpperCase(),
    numero: campo('numero'),
    bairro: campo('bairro').toUpperCase(),
    codMunicipio: campo('cod_municipio').replace(/\D/g, ''),
    municipio: campo('municipio').toUpperCase(),
    uf: campo('uf').toUpperCase(),
    cep: campo('cep').replace(/\D/g, ''),
  };
  if (![11, 14].includes(d.documento.length) || !d.nome || !d.logradouro || !d.numero || !d.bairro || d.codMunicipio.length !== 7 || !d.municipio || d.uf.length !== 2 || d.cep.length !== 8)
    return { ok: false, titulo: 'Destinatário incompleto', detalhe: 'CPF (11) ou CNPJ (14 dígitos), nome, endereço completo, código IBGE de 7 dígitos, UF e CEP de 8 dígitos.' };
  banco.criarDestinatario(d);
  return { ok: true, titulo: `Destinatário ${d.nome} cadastrado` };
}

async function renderizar({ banco, chamadas }: Contexto, ultimo: Resultado): Promise<Resposta> {
  const lista = banco.listarDestinatarios();
  const corpo = html`
<h1>Destinatários</h1>
<p>Cadastro local. Obrigatório na NF-e (55); opcional na NFC-e (65), onde o consumidor não identificado é o caso comum.</p>
${resultado(ultimo)}
<section>
  <h2>Cadastrados</h2>
  <table><tr><th>Documento</th><th>Nome</th><th>Município/UF</th><th></th></tr>
  ${lista.map(
    (d) => html`<tr><td>${d.documento}</td><td>${d.nome}</td><td>${d.municipio}/${d.uf} (${d.codMunicipio})</td><td><form method="post" action="/destinatarios/apagar"><input type="hidden" name="id" value="${d.id}"><button>Apagar</button></form></td></tr>`,
  )}
  </table>
  <p>Em homologação o nome tem de ser exatamente <code>${NOME_DESTINATARIO_HOMOLOGACAO}</code>. O destinatário semeado é movido para o município do emitente quando ele é cadastrado, para a venda ser interna.</p>
</section>
<section>
  <h2>Novo destinatário</h2>
  <form method="post" action="/destinatarios/criar"><div class="grid">
    <label>CPF ou CNPJ<br><input name="documento" required></label>
    <label>Nome<br><input name="nome" value="${NOME_DESTINATARIO_HOMOLOGACAO}" size="60" required></label>
    <label>Logradouro<br><input name="logradouro" required></label>
    <label>Número<br><input name="numero" required></label>
    <label>Bairro<br><input name="bairro" required></label>
    <label>Código IBGE do município<br><input name="cod_municipio" required></label>
    <label>Município<br><input name="municipio" required></label>
    <label>UF<br><input name="uf" size="2" maxlength="2" required></label>
    <label>CEP<br><input name="cep" required></label>
  </div><button>Cadastrar</button></form>
</section>`;
  return { html: pagina('Destinatários', '/destinatarios', corpo, chamadas) };
}
