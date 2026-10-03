// Tela Nova NFS-e: monta o `documento` da DPS, gera a `Idempotency-Key`, grava a NFS-e como pendente e só então
// chama a emissão com `wait`. É a Nova nota da NF-e, com a mesma ordem e a mesma lição:
//
//   GET  /v1/emitentes/{id}      operacional  o CRT decide o ramo do `totTrib`
//   POST /v1/nfse?wait=8000      operacional  a emissão
//
// A chave e o corpo ficam gravados ANTES da chamada. Se a rede cair depois do POST e antes da resposta, a NFS-e
// continua no banco com a mesma chave, e reenviar é replay, não uma segunda DPS. A resposta da emissão grava o `id`
// e o status inicial, e o desfecho quando o `wait` o traz; é o feed (tela Eventos) que o confirma.
//
// O que a tela não pede: o prestador, o `dhEmi`, a série, o número e o ambiente são da plataforma, e o que vier
// deles no `documento` é ignorado. Em série managed o `numeroDps` não vai.

import { randomUUID } from 'node:crypto';
import type { Contexto, Resposta, Rota } from '../app.ts';
import type { Emitente } from '../cliente-api.ts';
import { html, pagina, resultado, resultadoDeErro, vazio, type Resultado } from '../html.ts';
import { ehCnpj, ehCpf, exigePercentualSimples, montarDps } from '../documento-nfse.ts';
import { gravarRespostaDaEmissaoNfse } from './nfse.ts';
import { WAIT_MS } from './nova-nota.ts';

export const telaNovaNfse: Rota = (ctx) => renderizar(ctx, null);

export const acoesNovaNfse: Record<string, Rota> = {
  emitir: async (ctx) => renderizar(ctx, await emitir(ctx)),
};

/** `1.500,00` e `1500,5` são reais; `1500.5` é um número com ponto decimal. A vírgula é o que diz qual dos dois chegou. */
const numeroBr = (texto: string): number => (texto.includes(',') ? Number(texto.replaceAll('.', '').replace(',', '.')) : Number(texto));

async function emitir(ctx: Contexto): Promise<Resultado> {
  const { form, banco, cliente } = ctx;
  const operacional = banco.credencialOperacional();
  const { emitenteId } = banco.configuracao();
  if (!operacional || !emitenteId) return { ok: false, titulo: 'Emitir exige a credencial operacional', detalhe: 'Complete a tela Emitente antes.' };

  // ---- O pedido, lido do formulário e conferido antes de qualquer chamada. A API diria o mesmo, com 422 ou com a rejeição. ----
  const campo = (nome: string) => form.get(nome)?.trim() ?? '';
  const serie = Number(campo('serie'));
  if (!Number.isInteger(serie) || serie < 1 || serie > 49999) return { ok: false, titulo: 'Série de DPS: de 1 a 49999' };

  const tomadorDocumento = campo('toma_documento').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (!ehCpf(tomadorDocumento) && !ehCnpj(tomadorDocumento)) return { ok: false, titulo: 'Tomador: CPF (11 dígitos) ou CNPJ (14 caracteres)', detalhe: 'O CNPJ pode ser alfanumérico: as 12 primeiras posições podem ser letras. A pontuação sai sozinha.' };
  const tomadorNome = campo('toma_nome');
  if (!tomadorNome) return { ok: false, titulo: 'Tomador: informe o nome ou a razão social' };

  const competencia = campo('dcompet');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(competencia) || Number.isNaN(Date.parse(competencia))) return { ok: false, titulo: 'Competência: AAAA-MM-DD', detalhe: 'É por ela que o ISSQN se apura.' };
  const municipioPrestacao = campo('clocprestacao');
  if (!/^\d{7}$/.test(municipioPrestacao)) return { ok: false, titulo: 'Município da prestação: sete dígitos do IBGE, sem separador' };
  const codigoTributacaoNacional = campo('ctribnac');
  if (!/^\d{6}$/.test(codigoTributacaoNacional)) return { ok: false, titulo: 'Código de tributação nacional: seis dígitos' };
  const descricaoServico = campo('xdescserv');
  if (!descricaoServico) return { ok: false, titulo: 'Descrição do serviço: obrigatória' };
  const valorServico = numeroBr(campo('vserv'));
  if (!(valorServico > 0)) return { ok: false, titulo: 'Valor do serviço: maior que zero' };

  // ---- O CRT do emitente escolhe o ramo do `totTrib`. ----
  // Lido pela credencial OPERACIONAL: um emitente vinculado pelo atalho da tela Emitente pode estar fora da carteira
  // da de gestão, e a operacional lê o próprio emitente.
  let emitente: Emitente;
  try {
    emitente = (await cliente.lerEmitente(operacional, emitenteId)).corpo;
  } catch (erro) {
    return resultadoDeErro('Não consegui ler o emitente para saber o CRT', erro);
  }
  let percentualSimples: number | null = null;
  if (exigePercentualSimples(emitente.crt)) {
    percentualSimples = campo('ptottribsn') === '' ? NaN : numeroBr(campo('ptottribsn'));
    if (!(percentualSimples >= 0 && percentualSimples <= 100)) return { ok: false, titulo: 'Percentual do Simples (pTotTribSN): um número de 0 a 100', detalhe: `Com o CRT ${emitente.crt} o emitente é ME/EPP, e a SEFIN exige o percentual no totTrib.` };
  }

  // ---- Monta, grava e só então chama. ----
  const corpo = {
    serie,
    documento: montarDps({ competencia, tomadorDocumento, tomadorNome, municipioPrestacao, codigoTributacaoNacional, descricaoServico, valorServico, percentualSimples }, emitente.crt),
  };
  const idempotencyKey = randomUUID();
  const nfseId = banco.criarNfsePendente({ serie, idempotencyKey, corpoEnviado: JSON.stringify(corpo) });

  try {
    const resposta = await cliente.emitirNfse(operacional, corpo, idempotencyKey, WAIT_MS);
    return gravarRespostaDaEmissaoNfse(banco, nfseId, resposta.status, resposta.corpo, corpo.documento);
  } catch (erro) {
    // A NFS-e fica gravada com a chave. Na tela NFS-e, "Reenviar" manda o mesmo corpo com a mesma chave.
    return resultadoDeErro(`Emissão recusada; a NFS-e local ${nfseId} fica gravada com a chave ${idempotencyKey}`, erro);
  }
}

async function renderizar(ctx: Contexto, ultimo: Resultado): Promise<Resposta> {
  const { banco, chamadas, cliente, config } = ctx;
  const operacional = banco.credencialOperacional();
  const cfg = banco.configuracao();

  let emitente: Emitente | null = null;
  if (cfg.emitenteId) {
    try {
      emitente = (await cliente.lerEmitente(operacional ?? config.gestao, cfg.emitenteId)).corpo;
    } catch {
      // A tela abaixo explica que falta o emitente; o erro detalhado está na tela Emitente.
    }
  }
  const mePequena = emitente ? exigePercentualSimples(emitente.crt) : false;
  const competenciaPadrao = new Date().toISOString().slice(0, 8) + '01';

  const corpo = html`
<h1>Nova NFS-e</h1>
<p>Monta o <code>documento</code> da DPS, gera a <code>Idempotency-Key</code>, grava a NFS-e como pendente e só então chama <span class="rota">POST /v1/nfse?wait=${WAIT_MS}</span> com a credencial <b>operacional</b>. O prestador, o <code>dhEmi</code>, a série, o número e o ambiente são da plataforma: o que vier deles no documento é ignorado, então a tela nem os pede.</p>
${resultado(ultimo)}
${!operacional || !emitente ? html`<section class="erro"><h2>Antes, complete a tela Emitente</h2><p>A emissão exige a credencial operacional, uma série de DPS e, para escolher o ramo do <code>totTrib</code>, o CRT do emitente. A inscrição municipal do cadastro tem de ser a do CNC NFS-e.</p></section>` : vazio}
${emitente ? html`<section><h2>O totTrib pelo CRT do emitente</h2><p>CRT ${emitente.crt}: ${mePequena
    ? html`o emitente é ME/EPP, e o <code>totTrib</code> leva <code>pTotTribSN</code>, o percentual aproximado dos tributos da alíquota do Simples Nacional. O ramo <code>indTotTrib</code> ("sem informação de tributos") é vedado ao ME/EPP: a SEFIN recusa com E0712.`
    : html`o <code>totTrib</code> leva <code>indTotTrib: "0"</code> ("sem informação de tributos"). A regra veda esse ramo ao ME/EPP (E0712), que não é o caso deste emitente.`} O regime do prestador (<code>opSimpNac</code>, <code>regApTribSN</code>) a plataforma deriva do CRT do cadastro.</p></section>` : vazio}
<section>
  <form method="post" action="/nova-nfse/emitir">
    <div class="grid">
      <label>Série de DPS<br><input name="serie" value="1" size="5"></label>
      <label>Competência (<code>dCompet</code>)<br><input name="dcompet" value="${competenciaPadrao}" size="10"></label>
      <label>Município da prestação (<code>cLocPrestacao</code>, IBGE)<br><input name="clocprestacao" size="9" maxlength="7" value="${cfg.codMunicipio ?? ''}"></label>
    </div>
    <h2>Tomador</h2>
    <div class="grid">
      <label>CPF ou CNPJ<br><input name="toma_documento" value="11.444.777/0001-61"></label>
      <label>Nome ou razão social (<code>razaoSocial</code>)<br><input name="toma_nome" value="Cliente Exemplo Ltda" size="30"></label>
    </div>
    <h2>Serviço</h2>
    <p>O código de tributação nacional e a descrição abaixo são plausíveis, e não uma recomendação: o enquadramento do seu serviço é o que o seu contador define, e é ele que o município parametriza.</p>
    <div class="grid">
      <label>Código de tributação nacional (<code>cTribNac</code>, 6 dígitos)<br><input name="ctribnac" value="010701" size="7"></label>
      <label>Valor do serviço (<code>vServ</code>)<br><input name="vserv" value="1.500,00" size="10"></label>
      ${mePequena ? html`<label>Percentual do Simples (<code>pTotTribSN</code>, %)<br><input name="ptottribsn" value="6" size="5"></label>` : vazio}
    </div>
    <label>Descrição do serviço (<code>xDescServ</code>)<br><input name="xdescserv" value="Suporte técnico em sistemas - setembro/2026" size="70"></label>
    <button ${operacional && emitente ? vazio : html`disabled`}>Emitir em homologação</button>
  </form>
</section>`;
  return { html: pagina('Nova NFS-e', '/nova-nfse', corpo, chamadas) };
}
