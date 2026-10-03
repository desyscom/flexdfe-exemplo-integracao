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
// O que o `documento` não leva: o prestador, o `dhEmi`, a série, o número e o ambiente são da plataforma, e o que vier
// deles dentro do `documento` é ignorado. A série de DPS vai no envelope, ao lado do `documento`, e é a única coisa
// destas que a tela pede; em série managed o `numeroDps` não vai. O regime do prestador deriva do CRT do cadastro,
// porque a tela não manda `prest.regTrib`, que prevaleceria sobre ele campo a campo.
//
// A leitura e a conferência do formulário (`montarCorpoNfse`) e os campos dele (`camposNfse`) são exportados porque a
// substituição, no detalhe da NFS-e, é uma emissão com o mesmo documento e mais o pedido de substituição.

import { randomUUID } from 'node:crypto';
import type { Contexto, Resposta, Rota } from '../app.ts';
import type { Credencial } from '../config.ts';
import type { Emitente, IntakeNfse } from '../cliente-api.ts';
import { dinheiro, html, pagina, resultado, resultadoDeErro, vazio, type Html, type Resultado } from '../html.ts';
import { ehCnpj, ehCpf, exigePercentualSimples, montarDps } from '../documento-nfse.ts';
import { gravarRespostaDaEmissaoNfse } from './nfse.ts';
import { WAIT_MS } from './nova-nota.ts';

export const telaNovaNfse: Rota = (ctx) => renderizar(ctx, null);

export const acoesNovaNfse: Record<string, Rota> = {
  emitir: async (ctx) => renderizar(ctx, await emitir(ctx)),
};

/**
 * `1.500,00` e `1500,5` são reais, e `1500.5` é um número com ponto decimal: a vírgula diz qual dos dois chegou. Sem
 * vírgula, o ponto seguido de exatamente três dígitos é separador de milhar (`1.500` é mil e quinhentos, e não um
 * real e meio), porque é como quem digita em português o escreve.
 */
export function numeroBr(texto: string): number {
  if (texto.includes(',')) return Number(texto.replaceAll('.', '').replace(',', '.'));
  return /^\d{1,3}(\.\d{3})+$/.test(texto) ? Number(texto.replaceAll('.', '')) : Number(texto);
}

/** A data de hoje em Brasília, `AAAA-MM-DD`: é a da `dhEmi`, contra a qual a competência não pode ser futura. */
const hojeEmBrasilia = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/** `AAAA-MM-DD` de um dia que existe no calendário: `2026-02-30` passa no `Date.parse`, que o empurra para março. */
function dataExiste(texto: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!m) return false;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

const recusa = (titulo: string, detalhe?: string): { recusa: Resultado } => ({ recusa: { ok: false, titulo, detalhe } });

/**
 * O pedido, lido do formulário e conferido antes de chamar a emissão: a API diria o mesmo, com 422 ou com a rejeição, e
 * conferir antes é mais barato. A única chamada que sai antes é a leitura do emitente, para saber o CRT. Devolve o corpo do `POST /v1/nfse`, ou o resultado com o que está errado.
 */
export async function montarCorpoNfse({ form, cliente }: Contexto, operacional: Credencial, emitenteId: string): Promise<{ corpo: IntakeNfse } | { recusa: Resultado }> {
  const campo = (nome: string) => form.get(nome)?.trim() ?? '';
  const serie = Number(campo('serie'));
  if (!Number.isInteger(serie) || serie < 1 || serie > 49999) return recusa('Série de DPS: de 1 a 49999');

  const tomadorDocumento = campo('toma_documento').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (!ehCpf(tomadorDocumento) && !ehCnpj(tomadorDocumento)) return recusa('Tomador: CPF (11 dígitos) ou CNPJ (14 caracteres)', 'O CNPJ pode ser alfanumérico: as 12 primeiras posições podem ser letras. A pontuação sai sozinha.');
  const tomadorNome = campo('toma_nome');
  if (!tomadorNome) return recusa('Tomador: informe o nome ou a razão social');

  const competencia = campo('dcompet');
  if (!dataExiste(competencia)) return recusa('Competência: AAAA-MM-DD, um dia que exista', 'É por ela que o ISSQN se apura.');
  if (competencia > hojeEmBrasilia()) return recusa('Competência: não pode ser posterior à data de emissão', 'A regra é da DPS (a competência não pode passar da data de emissão, que é a de hoje em Brasília), e a SEFIN a compara com a data dela.');
  const municipioPrestacao = campo('clocprestacao');
  if (!/^\d{7}$/.test(municipioPrestacao)) return recusa('Município da prestação: sete dígitos do IBGE, sem separador');
  const codigoTributacaoNacional = campo('ctribnac');
  if (!/^\d{6}$/.test(codigoTributacaoNacional)) return recusa('Código de tributação nacional: seis dígitos');
  const descricaoServico = campo('xdescserv');
  if (!descricaoServico) return recusa('Descrição do serviço: obrigatória');
  const valorServico = numeroBr(campo('vserv'));
  if (!(valorServico > 0)) return recusa('Valor do serviço: maior que zero');

  // O CRT do emitente escolhe o ramo do `totTrib`. Lido pela credencial OPERACIONAL: um emitente vinculado pelo atalho
  // da tela Emitente pode estar fora da carteira da de gestão, e a operacional lê o próprio emitente.
  let emitente: Emitente;
  try {
    emitente = (await cliente.lerEmitente(operacional, emitenteId)).corpo;
  } catch (erro) {
    return { recusa: resultadoDeErro('Não consegui ler o emitente para saber o CRT', erro) };
  }
  let percentualSimples: number | null = null;
  if (exigePercentualSimples(emitente.crt)) {
    percentualSimples = campo('ptottribsn') === '' ? NaN : numeroBr(campo('ptottribsn'));
    if (!(percentualSimples >= 0 && percentualSimples <= 100)) return recusa('Percentual do Simples (pTotTribSN): um número de 0 a 100', `Com o CRT ${emitente.crt} o emitente é ME/EPP, e o ramo indTotTrib lhe é vedado (E0712): esta tela manda o percentual do Simples, o pTotTribSN.`);
  }

  return { corpo: { serie, documento: montarDps({ competencia, tomadorDocumento, tomadorNome, municipioPrestacao, codigoTributacaoNacional, descricaoServico, valorServico, percentualSimples }, emitente.crt) } };
}

async function emitir(ctx: Contexto): Promise<Resultado> {
  const { banco, cliente } = ctx;
  const operacional = banco.credencialOperacional();
  const { emitenteId } = banco.configuracao();
  if (!operacional || !emitenteId) return { ok: false, titulo: 'Emitir exige a credencial operacional', detalhe: 'Complete a tela Emitente antes.' };

  const montado = await montarCorpoNfse(ctx, operacional, emitenteId);
  if ('recusa' in montado) return montado.recusa;
  const { corpo } = montado;

  // Grava e só então chama.
  const idempotencyKey = randomUUID();
  const nfseId = banco.criarNfsePendente({ serie: corpo.serie, idempotencyKey, corpoEnviado: JSON.stringify(corpo) });
  try {
    const resposta = await cliente.emitirNfse(operacional, corpo, idempotencyKey, WAIT_MS);
    return gravarRespostaDaEmissaoNfse(banco, nfseId, resposta.status, resposta.corpo, corpo.documento);
  } catch (erro) {
    // A NFS-e fica gravada com a chave. Na tela NFS-e, "Reenviar" manda o mesmo corpo com a mesma chave.
    return resultadoDeErro(`Emissão recusada; a NFS-e local ${nfseId} fica gravada com a chave ${idempotencyKey}`, erro);
  }
}

/** Os valores dos campos do formulário, como o navegador os manda. */
export type ValoresNfse = { serie: string; dcompet: string; clocprestacao: string; toma_documento: string; toma_nome: string; ctribnac: string; vserv: string; xdescserv: string; ptottribsn: string };

/** Os valores de um pedido já enviado, para a substituição partir do que a original informou. */
export function valoresDoCorpo(corpo: IntakeNfse): ValoresNfse {
  const d = corpo.documento as { dCompet: string; toma: { cnpj?: string; cpf?: string; razaoSocial: string }; serv: { cLocPrestacao: string; cTribNac: string; xDescServ: string }; valores: { vServ: number; totTrib: { pTotTribSN?: number } } };
  return {
    serie: String(corpo.serie),
    dcompet: d.dCompet,
    clocprestacao: d.serv.cLocPrestacao,
    toma_documento: d.toma.cnpj ?? d.toma.cpf ?? '',
    toma_nome: d.toma.razaoSocial,
    ctribnac: d.serv.cTribNac,
    vserv: dinheiro(d.valores.vServ),
    xdescserv: d.serv.xDescServ,
    ptottribsn: d.valores.totTrib.pTotTribSN === undefined ? '' : String(d.valores.totTrib.pTotTribSN),
  };
}

/** Os campos da DPS: o mesmo formulário na emissão e na substituição. O percentual do Simples só aparece para o ME/EPP. */
export function camposNfse(v: ValoresNfse, mePequena: boolean): Html {
  return html`<div class="grid">
      <label>Série de DPS<br><input name="serie" value="${v.serie}" size="5"></label>
      <label>Competência (<code>dCompet</code>)<br><input name="dcompet" value="${v.dcompet}" size="10"></label>
      <label>Município da prestação (<code>cLocPrestacao</code>, IBGE)<br><input name="clocprestacao" size="9" maxlength="7" value="${v.clocprestacao}"></label>
    </div>
    <h2>Tomador</h2>
    <div class="grid">
      <label>CPF ou CNPJ<br><input name="toma_documento" value="${v.toma_documento}"></label>
      <label>Nome ou razão social (<code>razaoSocial</code>)<br><input name="toma_nome" value="${v.toma_nome}" size="30"></label>
    </div>
    <h2>Serviço</h2>
    <p>O código de tributação nacional e a descrição abaixo são plausíveis, e não uma recomendação: o enquadramento do seu serviço é o que o seu contador define, e é ele que o município parametriza.</p>
    <div class="grid">
      <label>Código de tributação nacional (<code>cTribNac</code>, 6 dígitos)<br><input name="ctribnac" value="${v.ctribnac}" size="7"></label>
      <label>Valor do serviço (<code>vServ</code>)<br><input name="vserv" value="${v.vserv}" size="10"></label>
      ${mePequena ? html`<label>Percentual do Simples (<code>pTotTribSN</code>, %)<br><input name="ptottribsn" value="${v.ptottribsn}" size="5"></label>` : vazio}
    </div>
    <label>Descrição do serviço (<code>xDescServ</code>)<br><input name="xdescserv" value="${v.xdescserv}" size="70"></label>`;
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
  const padrao: ValoresNfse = {
    serie: '1',
    // O primeiro dia do mês de hoje em Brasília: em UTC, depois das 21h do último dia do mês viraria o mês seguinte, futuro.
    dcompet: hojeEmBrasilia().slice(0, 8) + '01',
    clocprestacao: cfg.codMunicipio ?? '',
    toma_documento: '11.444.777/0001-61',
    toma_nome: 'Cliente Exemplo Ltda',
    ctribnac: '010701',
    vserv: '1.500,00',
    xdescserv: 'Suporte técnico em sistemas - setembro/2026',
    ptottribsn: '6',
  };

  const corpo = html`
<h1>Nova NFS-e</h1>
<p>Monta o <code>documento</code> da DPS, gera a <code>Idempotency-Key</code>, grava a NFS-e como pendente e só então chama <span class="rota">POST /v1/nfse?wait=${WAIT_MS}</span> com a credencial <b>operacional</b>. O prestador, o <code>dhEmi</code>, a série, o número e o ambiente são da plataforma: o que vier deles dentro do documento é ignorado, então o documento não os leva. A série de DPS vai no envelope, ao lado do documento.</p>
${resultado(ultimo)}
${!operacional || !emitente ? html`<section class="erro"><h2>Antes, complete a tela Emitente</h2><p>A emissão exige a credencial operacional, uma série de DPS e, para escolher o ramo do <code>totTrib</code>, o CRT do emitente. A inscrição municipal do cadastro tem de ser a do CNC NFS-e.</p></section>` : vazio}
${emitente ? html`<section><h2>O totTrib pelo CRT do emitente</h2><p>CRT ${emitente.crt}: ${mePequena
    ? html`o emitente é ME/EPP, e o <code>totTrib</code> leva <code>pTotTribSN</code>, o percentual aproximado dos tributos da alíquota do Simples Nacional. O ramo <code>indTotTrib</code> ("sem informação de tributos") é vedado ao ME/EPP: a SEFIN recusa com E0712.`
    : html`o <code>totTrib</code> leva <code>indTotTrib: "0"</code> ("sem informação de tributos"). A regra veda esse ramo ao ME/EPP (E0712), que não é o caso deste emitente.`} O regime do prestador (<code>opSimpNac</code>, <code>regApTribSN</code>) a plataforma deriva do CRT do cadastro.</p></section>` : vazio}
<section>
  <form method="post" action="/nova-nfse/emitir">
    ${camposNfse(padrao, mePequena)}
    <button ${operacional && emitente ? vazio : html`disabled`}>Emitir em homologação</button>
  </form>
</section>`;
  return { html: pagina('Nova NFS-e', '/nova-nfse', corpo, chamadas) };
}
