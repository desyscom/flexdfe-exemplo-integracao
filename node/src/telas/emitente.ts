// Tela Emitente: do cadastro à série e ao webhook, em seis passos. Cada passo diz a rota que
// consome e com qual escopo de credencial.
//
//   1. Cadastrar        POST /v1/emitentes                    gestão (integrador)
//   2. Certificado      PUT  /v1/emitentes/{id}/certificado   gestão
//   3. Ativar           PATCH /v1/emitentes/{id}              gestão
//   4. Credencial       POST /v1/credenciais                  gestão  → cunha a OPERACIONAL
//   5. Série            POST /v1/series                       operacional (emitente)
//   6. Webhook          PUT  /v1/emitentes/{id}/webhook       operacional (aceita os dois)
//
// A ordem não é convenção da tela: é da API. Ativar sem certificado é 409; série com credencial
// de gestão é 403 emitente-scope-required. A tela só habilita o passo seguinte quando o anterior
// existe, para o programador ver a dependência antes de esbarrar nela.
//
// A NFS-e pede três coisas a mais, numa seção à parte no fim da tela, e cada uma tem o seu lugar na ordem:
//
//   A. Inscrição municipal   PATCH /v1/emitentes/{id}                       gestão  → no cadastro (passo 1) ou depois
//   B. Convênio              POST /v1/emitentes/{id}/consultas-convenio     gestão  → entre o certificado e a ativação
//   C. Série de DPS          POST /v1/series  { "tipoDocumento": "dps" }    operacional → o próprio passo 5
//
// O convênio só é leitura e não bloqueia emissão nenhuma. Antes da ativação ele vai com a credencial de gestão,
// porque a do emitente só autentica depois dela.
//
// Os passos 1 a 4 são o ONBOARDING de um emitente novo, e existem porque um integrador precisa
// fazê-lo pela API. Quem já tem o emitente pronto no painel — cadastrado, com certificado, ativo e
// com uma credencial operacional cunhada lá — não repete nada disso: informa a credencial no
// atalho do passo 1 e a aplicação descobre o resto sozinha, com duas leituras:
//
//   GET /v1/contexto           diz de QUEM é a credencial (escopo `emitente` ⇒ traz o `id`)
//   GET /v1/emitentes/{id}     traz a ficha: razão social, CRT, certificado, ambiente, webhook
//
// É o caminho mais curto para uma nota de teste, e é o que um ERP faz de verdade quando o cliente
// entrega uma credencial já pronta: a integração nunca cadastra ninguém, só se apresenta.

import { readFile } from 'node:fs/promises';
import type { Contexto, Resposta, Rota } from '../app.ts';
import type { Credencial } from '../config.ts';
import type { Contexto as ContextoApi, CriacaoEmitente, Emitente, Serie } from '../cliente-api.ts';
import { ErroApi } from '../cliente-api.ts';
import { bruto, html, pagina, resultado, resultadoDeErro, vazio, type Html, type Resultado } from '../html.ts';
import { motivoUrlWebhookInvalida } from '../webhook-url.ts';

export const telaEmitente: Rota = (ctx) => renderizar(ctx, null);

/** As ações POST /emitente/<nome>. Cada uma faz uma chamada e volta para a mesma tela com o resultado. */
export const acoesEmitente: Record<string, Rota> = {
  cadastrar: async (ctx) => renderizar(ctx, await cadastrar(ctx)),
  vincular: async (ctx) => renderizar(ctx, await vincular(ctx)),
  certificado: async (ctx) => renderizar(ctx, await enviarCertificado(ctx)),
  ativar: async (ctx) => renderizar(ctx, await ativar(ctx)),
  credencial: async (ctx) => renderizar(ctx, await cunharCredencial(ctx)),
  serie: async (ctx) => renderizar(ctx, await provisionarSerie(ctx)),
  webhook: async (ctx) => renderizar(ctx, await definirWebhook(ctx)),
  'inscricao-municipal': async (ctx) => renderizar(ctx, await gravarInscricaoMunicipal(ctx)),
  convenio: async (ctx) => renderizar(ctx, await consultarConvenio(ctx)),
};

// ---------------------------------------------------------------- ações

async function cadastrar({ form, config, banco, cliente }: Contexto): Promise<Resultado> {
  const campo = (nome: string) => form.get(nome)?.trim() ?? '';
  const dados: CriacaoEmitente = {
    // CNPJ alfanumérico: só a pontuação sai. Tirar tudo que não é dígito apagaria as letras.
    cnpj: campo('cnpj').replace(/[^0-9A-Za-z]/g, '').toUpperCase(),
    razao_social: campo('razao_social'),
    nome_fantasia: campo('nome_fantasia') || null,
    inscricao_estadual: campo('inscricao_estadual') || 'ISENTO',
    // Como foi digitada: a API tira o espaço e a pontuação antes de gravar.
    inscricao_municipal: campo('inscricao_municipal') || null,
    crt: Number(campo('crt')) as 1 | 2 | 3 | 4,
    // Este exemplo é de homologação. Promover a produção é ato do cliente, no painel.
    ambiente: 'homologacao',
    logradouro: campo('logradouro'),
    numero: campo('numero'),
    bairro: campo('bairro'),
    cod_municipio: campo('cod_municipio').replace(/\D/g, ''),
    municipio: campo('municipio'),
    uf: campo('uf').toUpperCase(),
    cep: campo('cep').replace(/\D/g, ''),
    telefone: campo('telefone') || null,
  };
  try {
    const { corpo } = await cliente.criarEmitente(config.gestao, dados);
    banco.gravarEmitenteId(corpo.id);
    // O destinatário semeado muda para o município do emitente: a primeira nota sai como venda interna.
    // Venda interestadual a consumidor final exige o grupo do DIFAL, que este exemplo não monta.
    banco.alinharDestinatarioSemente({ codMunicipio: dados.cod_municipio, municipio: dados.municipio, uf: dados.uf });
    return { ok: true, titulo: 'Emitente cadastrado (rascunho)', detalhe: `id ${corpo.id} guardado no banco local. Nasce inativo: o próximo passo é o certificado.`, corpo };
  } catch (erro) {
    return resultadoDeErro('Cadastro recusado', erro);
  }
}

/**
 * O atalho do passo 1: adotar um emitente que já existe na plataforma, a partir da credencial
 * OPERACIONAL dele. Duas leituras e nenhuma escrita na API — o que muda é só o banco local.
 *
 * O `GET /v1/contexto` é quem valida: uma credencial errada não passa da autenticação, e uma de
 * gestão volta com `escopo: "integrador"`, que a aplicação recusa aqui em vez de guardar uma
 * credencial que não emite. Com o `id` em mãos, o `GET /v1/emitentes/{id}` traz a ficha — e a
 * própria credencial operacional a lê, porque a RLS da API a confina ao emitente dela.
 */
async function vincular({ form, banco, cliente }: Contexto): Promise<Resultado> {
  const cfg = banco.configuracao();
  if (cfg.emitenteId) return { ok: false, titulo: 'Já há um emitente no banco local', detalhe: 'Trocar de emitente misturaria as notas já gravadas com as do novo. Para trocar, use Recomeçar do zero, na tela Configuração.' };

  const credencial: Credencial = { clientId: form.get('client_id')?.trim() ?? '', secret: form.get('secret')?.trim() ?? '' };
  if (!credencial.clientId || !credencial.secret) return { ok: false, titulo: 'Informe o client_id e o secret da credencial' };

  let contexto;
  try {
    contexto = (await cliente.contexto(credencial)).corpo;
  } catch (erro) {
    return resultadoDeErro('A API não aceitou a credencial', erro);
  }
  if (!ehDeEmitente(contexto)) {
    return {
      ok: false,
      titulo: `Esta credencial tem escopo "${contexto.escopo}", e o atalho precisa de uma operacional`,
      detalhe: 'No painel, em Credenciais & Webhooks, gere uma credencial do tipo Operacional, escolhendo o emitente. A de gestão cadastra e cunha, mas não emite nem provisiona série.',
      corpo: contexto,
    };
  }

  let emitente: Emitente;
  try {
    emitente = (await cliente.lerEmitente(credencial, contexto.emitente.id)).corpo;
  } catch (erro) {
    return resultadoDeErro('Credencial reconhecida, mas não consegui ler a ficha do emitente', erro);
  }

  banco.gravarEmitenteId(emitente.id);
  banco.gravarCredencialOperacional(credencial.clientId, credencial.secret);

  // O `GET /v1/emitentes/{id}` publica município e UF, mas não o código IBGE — então o alinhamento
  // que o cadastro faz sozinho não é possível aqui, e o destinatário semeado continua onde estava.
  const semente = banco.listarDestinatarios().find((d) => d.semente === 1);
  const foraDaUf = semente && semente.uf !== emitente.uf
    ? ` O destinatário semeado está em ${semente.municipio}/${semente.uf} e o emitente em ${emitente.municipio}/${emitente.uf}: ajuste-o na tela Destinatários antes da primeira nota, porque venda interestadual a consumidor final exige o grupo do DIFAL, que este exemplo não monta.`
    : '';
  const pendencias = [!emitente.certificado && 'sem certificado', !emitente.ativo && 'inativo'].filter(Boolean).join(' e ');

  return {
    ok: true,
    titulo: `Emitente ${emitente.razao_social} vinculado`,
    detalhe: `id e credencial guardados no banco local; nada foi criado na plataforma.${pendencias ? ` A ficha veio ${pendencias}: resolva no painel, ou pelos passos 2 e 3 com a credencial de gestão do .env.` : ' Certificado no cofre e emitente ativo: pode ir direto para a série, no passo 5.'}${foraDaUf}`,
    corpo: emitente,
  };
}

async function enviarCertificado({ config, banco, cliente }: Contexto): Promise<Resultado> {
  const { emitenteId } = banco.configuracao();
  if (!emitenteId) return { ok: false, titulo: 'Cadastre o emitente antes do certificado' };
  if (!config.certificado.caminho) return { ok: false, titulo: 'Não há certificado configurado', detalhe: 'Preencha CERTIFICADO_PFX no .env, ou suba o A1 pelo painel — quem vincula um emitente já pronto não precisa deste passo.' };
  let pfx: Buffer;
  try {
    pfx = await readFile(config.certificado.caminho);
  } catch {
    return { ok: false, titulo: 'Não achei o .pfx', detalhe: `CERTIFICADO_PFX aponta para ${config.certificado.caminho}.` };
  }
  try {
    const { corpo } = await cliente.enviarCertificado(config.gestao, emitenteId, pfx, config.certificado.senha);
    return { ok: true, titulo: 'Certificado no cofre', detalhe: 'Titular e validade extraídos pela API. O arquivo e a senha não voltam mais.', corpo: corpo.certificado };
  } catch (erro) {
    return resultadoDeErro('Certificado recusado', erro);
  }
}

async function ativar({ config, banco, cliente }: Contexto): Promise<Resultado> {
  const { emitenteId } = banco.configuracao();
  if (!emitenteId) return { ok: false, titulo: 'Cadastre o emitente antes de ativar' };
  try {
    const { corpo } = await cliente.editarEmitente(config.gestao, emitenteId, { ativo: true });
    return { ok: true, titulo: 'Emitente ativo', detalhe: 'A partir daqui a credencial operacional pode ser cunhada.', corpo: { ativo: corpo.ativo, ambiente: corpo.ambiente } };
  } catch (erro) {
    return resultadoDeErro('Ativação recusada', erro);
  }
}

async function cunharCredencial({ config, banco, cliente }: Contexto): Promise<Resultado> {
  const cfg = banco.configuracao();
  if (!cfg.emitenteId) return { ok: false, titulo: 'Cadastre o emitente antes de cunhar a credencial' };
  if (cfg.credencialClientId) return { ok: false, titulo: 'Já existe uma credencial operacional guardada', detalhe: 'Cunhar outra funcionaria, mas o segredo desta seria perdido. Para recomeçar, use Recomeçar do zero, na tela Configuração.' };
  try {
    const { corpo } = await cliente.cunharCredencial(config.gestao, 'Exemplo de integração', cfg.emitenteId);
    // O secret aparece só neste corpo. Guardar é agora ou nunca.
    banco.gravarCredencialOperacional(corpo.client_id, corpo.secret);
    return {
      ok: true,
      titulo: 'Credencial operacional cunhada e guardada',
      detalhe: 'Escopo de emitente: é ela que provisiona série e emite. A de gestão não faz nenhum dos dois. O secret veio uma única vez e já está no banco local.',
      corpo: { ...corpo, secret: '(guardado no banco local)' },
    };
  } catch (erro) {
    return resultadoDeErro('Cunhagem recusada', erro);
  }
}

async function provisionarSerie({ form, banco, cliente }: Contexto): Promise<Resultado> {
  const operacional = credencialOperacional(banco);
  if (!operacional) return { ok: false, titulo: 'Série exige a credencial operacional', detalhe: 'A de gestão recebe 403 emitente-scope-required aqui.' };
  const documento = form.get('documento') === 'dps' ? 'dps' : (Number(form.get('documento')) as 55 | 65);
  const serie = Number(form.get('serie'));
  if (documento !== 'dps' && ![55, 65].includes(documento)) return { ok: false, titulo: 'Documento: modelo 55, modelo 65 ou DPS' };
  // Cada documento tem a sua faixa, e a API a confere na provisão: 0–999 na NF-e e na NFC-e, 1–49999 na DPS (o canal de API na SEFIN).
  const [minimo, maximo] = documento === 'dps' ? [1, 49999] : [0, 999];
  if (!Number.isInteger(serie) || serie < minimo || serie > maximo) {
    return { ok: false, titulo: documento === 'dps' ? 'Série de DPS: de 1 a 49999' : 'Série de NF-e e de NFC-e: de 0 a 999', detalhe: documento === 'dps' ? 'A série 70000, a do Emissor Web, por exemplo, está fora: a API a recusa na provisão, uma vez, em vez de a SEFIN recusar toda declaração emitida por ela.' : undefined };
  }
  try {
    const { corpo } = await cliente.provisionarSerie(operacional, documento, serie);
    const nome = documento === 'dps' ? 'da DPS (NFS-e)' : `do modelo ${documento}`;
    return { ok: true, titulo: `Série ${serie} ${nome} provisionada (managed)`, detalhe: 'A plataforma numera a partir de nextNumber. Na emissão você não manda numero.', corpo };
  } catch (erro) {
    return resultadoDeErro('Série recusada', erro);
  }
}

/**
 * A IM do cadastro é a do CNC NFS-e, e vai no `prest.im` de toda DPS. Vazio limpa (o PATCH leva `null`, como o
 * telefone). Editar o cadastro é escopo de integrador, então um emitente vinculado pela credencial operacional,
 * fora da carteira de gestão do `.env`, acerta a IM no painel.
 */
async function gravarInscricaoMunicipal({ form, config, banco, cliente }: Contexto): Promise<Resultado> {
  const { emitenteId } = banco.configuracao();
  if (!emitenteId) return { ok: false, titulo: 'Cadastre o emitente antes da inscrição municipal' };
  const valor = form.get('inscricao_municipal')?.trim() ?? '';
  try {
    const { corpo } = await cliente.editarEmitente(config.gestao, emitenteId, { inscricao_municipal: valor || null });
    return valor
      ? { ok: true, titulo: 'Inscrição municipal gravada', detalhe: 'A API tirou o espaço e a pontuação antes de gravar: a ficha mostra a que ela guardou.', corpo: { inscricao_municipal: corpo.inscricao_municipal } }
      : { ok: true, titulo: 'Inscrição municipal removida', detalhe: 'Sem ela, a SEFIN recusa a DPS do prestador que não é MEI. Quem só emite NF-e não precisa dela.', corpo: { inscricao_municipal: corpo.inscricao_municipal } };
  } catch (erro) {
    return resultadoDeErro('Inscrição municipal recusada', erro);
  }
}

/**
 * Pergunta ao ADN o que o município publicou. A resposta diz se a parametrização veio, e não se o município
 * aderiu ao Sistema Nacional; e a consulta não bloqueia emissão nenhuma. Vai com a credencial de gestão: é leitura,
 * e antes da ativação a credencial do emitente não autentica.
 */
async function consultarConvenio({ form, config, banco, cliente }: Contexto): Promise<Resultado> {
  const { emitenteId } = banco.configuracao();
  if (!emitenteId) return { ok: false, titulo: 'Cadastre o emitente antes de consultar o convênio', detalhe: 'O certificado dele é o que abre o mTLS com o ADN, então a consulta pende de um emitente.' };
  const codigo = form.get('codigo_municipio')?.trim() ?? '';
  if (!/^\d{7}$/.test(codigo)) return { ok: false, titulo: 'Código do município: sete dígitos do IBGE, sem separador' };
  try {
    const { corpo } = await cliente.consultarConvenio(config.gestao, emitenteId, codigo);
    const comum = 'O veredito diz se a parametrização veio, não se o município aderiu ao Sistema Nacional, e a consulta não bloqueia a emissão: a plataforma não recusa nenhuma por causa dela. Convênio inativo ou não parametrizado só aparece como rejeição de uma DPS real (E0038, E0039).';
    const ausencia = corpo.veredito === 'sem-parametrizacao' ? ' Aqui o ADN respondeu em definitivo e o grupo de parâmetros não veio. Nenhum dos dois vereditos quer dizer "o município está fora".' : '';
    return { ok: true, titulo: `Convênio consultado: ${corpo.veredito}`, detalhe: comum + ausencia, corpo };
  } catch (erro) {
    const r = resultadoDeErro('Consulta de convênio recusada', erro);
    // O ADN fora do ar não é negativa: 503 e 504 pedem outra tentativa, e o retry se programa pelo status, nunca pela mensagem.
    if (r && erro instanceof ErroApi && (erro.status === 503 || erro.status === 504)) {
      return { ...r, detalhe: `${r.detalhe} Indisponibilidade não é negativa: o ADN não respondeu: repita; isto não é a resposta "o município não tem convênio". Repetir é inofensivo, porque a consulta não cria nada.` };
    }
    return r;
  }
}

async function definirWebhook({ form, banco, cliente }: Contexto): Promise<Resultado> {
  const cfg = banco.configuracao();
  const operacional = credencialOperacional(banco);
  if (!cfg.emitenteId || !operacional) return { ok: false, titulo: 'Webhook vem depois da credencial operacional' };
  const url = form.get('url')?.trim() ?? '';
  const motivo = motivoUrlWebhookInvalida(url);
  if (motivo) return { ok: false, titulo: 'URL recusada antes de chamar a API', detalhe: `${motivo}. A API devolveria 422 webhook-url-invalid pelo mesmo motivo. Para receber na sua máquina, exponha a porta com um túnel (cloudflared, ngrok) e use a URL pública dele.` };
  try {
    const { corpo } = await cliente.definirWebhook(operacional, cfg.emitenteId, url);
    if (corpo.secret) {
      banco.gravarWebhookSecret(corpo.secret);
      return { ok: true, titulo: 'Webhook criado; segredo guardado', detalhe: 'O secret veio porque o PUT criou. Numa edição ele não vem: a presença dele é o sinal, não o status HTTP.', corpo: { ...corpo, secret: '(guardado no banco local)' } };
    }
    return { ok: true, titulo: 'Webhook atualizado', detalhe: 'Sem secret no corpo: foi edição, e o segredo anterior continua valendo.', corpo };
  } catch (erro) {
    return resultadoDeErro('Webhook recusado', erro);
  }
}

/**
 * O `GET /v1/contexto` responde numa forma por escopo. Só a de emitente traz o `emitente`, e é a
 * única que serve ao atalho: é ela que prova que a credencial emite pelo emitente que ela cita.
 */
function ehDeEmitente(c: ContextoApi): c is Extract<ContextoApi, { escopo: 'emitente' }> {
  return c.escopo === 'emitente' && 'emitente' in c && typeof c.emitente === 'object' && c.emitente !== null;
}

function credencialOperacional(banco: Contexto['banco']): Credencial | null {
  const cfg = banco.configuracao();
  return cfg.credencialClientId && cfg.credencialSecret ? { clientId: cfg.credencialClientId, secret: cfg.credencialSecret } : null;
}

// ---------------------------------------------------------------- tela

async function renderizar(ctx: Contexto, ultimo: Resultado): Promise<Resposta> {
  const { config, banco, cliente, chamadas } = ctx;
  const cfg = banco.configuracao();
  const operacional = credencialOperacional(banco);

  // A ficha é lida pela credencial OPERACIONAL quando já há uma: um emitente vinculado pelo atalho
  // pode estar fora da carteira da credencial de gestão do `.env`, e aí a de gestão levaria 404. A
  // de gestão só entra antes disso, no onboarding, quando ainda não existe outra.
  const credencialDeLeitura = operacional ?? config.gestao;

  let emitente: Emitente | null = null;
  let leituraFalhou: Resultado = null;
  if (cfg.emitenteId) {
    try {
      emitente = (await cliente.lerEmitente(credencialDeLeitura, cfg.emitenteId)).corpo;
    } catch (erro) {
      leituraFalhou = resultadoDeErro('Não consegui ler o emitente guardado', erro);
      if (erro instanceof ErroApi && erro.status === 404) leituraFalhou = { ...leituraFalhou!, detalhe: 'O id no banco local não existe mais na API, ou está fora da carteira desta credencial. Use Recomeçar do zero, na tela Configuração.' };
    }
  }

  let series: Serie[] = [];
  let ambienteDasSeries: Serie['ambiente'] | null = null;
  if (operacional) {
    try {
      ({ series, ambiente: ambienteDasSeries } = (await cliente.listarSeries(operacional)).corpo);
    } catch (erro) {
      leituraFalhou ??= resultadoDeErro('Não consegui listar as séries', erro);
    }
  }

  const temCert = Boolean(emitente?.certificado);
  const ativo = Boolean(emitente?.ativo);

  const corpo: Html = html`
<h1>Emitente</h1>
<p>Seis passos, na ordem que a API exige. Os quatro primeiros usam a credencial de <b>gestão</b> do <code>.env</code>; os dois últimos, a <b>operacional</b> que o passo 4 cunha.</p>
<p>Se o emitente <b>já existe na plataforma</b> — cadastrado no painel, com certificado e com uma credencial operacional cunhada lá —, os passos de 1 a 4 já foram feitos: informe a credencial no <b>atalho do passo 1</b> e vá direto para a série.</p>
${resultado(ultimo)}
${resultado(leituraFalhou)}

${passo(1, 'Cadastrar o emitente', 'POST /v1/emitentes', 'de gestão', Boolean(emitente), emitente
  ? html`<p><b>${emitente.razao_social}</b> · CNPJ ${emitente.cnpj} · IM ${emitente.inscricao_municipal ?? 'não informada'} · CRT ${emitente.crt} · ${emitente.municipio}/${emitente.uf} · ambiente <b>${emitente.ambiente}</b> · ${emitente.ativo ? 'ativo' : 'inativo (rascunho)'}</p><p>documentos habilitados: ${emitente.tipos_documento.length ? emitente.tipos_documento.join(', ') : 'nenhum (sem série ativa no ambiente atual)'} · id <code>${emitente.id}</code></p>`
  : html`${formularioVinculo()}${formularioCadastro()}`)}

${passo(2, 'Subir o certificado A1', 'PUT /v1/emitentes/{id}/certificado', 'de gestão', temCert, emitente
  ? temCert
    ? html`<p>Titular ${emitente!.certificado!.titular ?? '(sem titular)'} · válido até ${emitente!.certificado!.valido_ate} · ${emitente!.certificado!.situacao} (${emitente!.certificado!.dias_para_expirar} dias)</p><form method="post" action="/emitente/certificado"><button>Substituir pelo .pfx do .env</button></form>`
    : config.certificado.caminho
      ? html`<p>Lê <code>${config.certificado.caminho}</code> e manda em base64 com a senha, num JSON. Limite perto de 64 KB.</p><form method="post" action="/emitente/certificado"><button>Enviar certificado</button></form>`
      : html`<p>Sem <code>CERTIFICADO_PFX</code> no <code>.env</code>, não há o que enviar. Preencha-o, ou suba o A1 pelo painel.</p>`
  : bloqueado('cadastre o emitente'))}

${passo(3, 'Ativar', 'PATCH /v1/emitentes/{id}  { "ativo": true }', 'de gestão', ativo, !emitente
  ? bloqueado('cadastre o emitente')
  : ativo
    ? html`<p>Ativo. Inativar é o mesmo PATCH com <code>false</code>, e nunca é recusado.</p>`
    : html`<p>${temCert ? 'Certificado no cofre: pode ativar.' : 'Sem certificado a API responde 409 certificate-required-to-activate. Tente, se quiser ver.'}</p><form method="post" action="/emitente/ativar"><button>Ativar emitente</button></form>`)}

${passo(4, 'Cunhar a credencial operacional', 'POST /v1/credenciais  { "descricao", "emitente_id" }', 'de gestão', Boolean(operacional), !emitente
  ? bloqueado('cadastre o emitente')
  : operacional
    ? html`<p><code>${operacional.clientId}</code> guardada no banco local. É ela que emite.</p>`
    : html`<p>Com <code>emitente_id</code> no corpo, a API cunha uma credencial de escopo de <b>emitente</b>. O <code>secret</code> vem uma única vez; a aplicação o guarda na hora.</p><form method="post" action="/emitente/credencial"><button>Cunhar e guardar</button></form>`)}

${passo(5, 'Provisionar séries', 'POST /v1/series  { "modelo" ou "tipoDocumento", "serie", "mode": "managed" }', 'operacional', series.length > 0, !operacional
  ? bloqueado('cunhe a credencial operacional; a de gestão recebe 403 emitente-scope-required')
  : html`<p>A série é <b>por ambiente</b>: homologação e produção numeram separado, e a promoção não cria a de produção: convém provisioná-la antes de promover o emitente. Sem <code>ambiente</code> no corpo, a série nasce no ambiente atual do emitente${ambienteDasSeries ? html`, e a lista abaixo é a de <b>${ambienteDasSeries}</b>` : vazio}.</p>
<p>E é <b>por documento</b>: a série 1 de NF-e e a série 1 de DPS (a declaração da NFS-e) são duas, cada uma com o seu próximo número. A NF-e e a NFC-e se pedem pelo <code>modelo</code>, na faixa de 0 a 999; a DPS não tem modelo, se pede só pelo <code>tipoDocumento</code>, e a faixa dela é de 1 a 49999.</p>
${series.length ? html`<table><tr><th>Ambiente</th><th>Documento</th><th>Modelo</th><th>Série</th><th>Modo</th><th>Próximo número</th><th>Ativa</th></tr>${series.map((s) => html`<tr><td>${s.ambiente}</td><td>${s.tipoDocumento}</td><td>${s.modelo ?? '-'}</td><td>${s.serie}</td><td>${s.mode}</td><td>${s.nextNumber ?? '-'}</td><td>${s.active ? 'sim' : 'não'}</td></tr>`)}</table>` : bruto('<p>Nenhuma série ainda. Sem série no ambiente atual, a emissão responde 404 series-not-provisioned.</p>')}
<form method="post" action="/emitente/serie"><label>Documento <select name="documento"><option value="55">55 · NF-e</option><option value="65">65 · NFC-e</option><option value="dps">dps · NFS-e (DPS)</option></select></label><label>Série <input name="serie" value="1" size="4"></label><button>Provisionar (managed)</button></form>`)}

${passo(6, 'Webhook (opcional)', 'PUT /v1/emitentes/{id}/webhook  { "url", "ativo": true }', 'operacional', Boolean(emitente?.webhook), !operacional
  ? bloqueado('cunhe a credencial operacional')
  : html`${emitente?.webhook ? html`<p>Configurado: <code>${emitente.webhook.url}</code> (${emitente.webhook.ativo ? 'ativo' : 'pausado'}) · segredo ${cfg.webhookSecret ? 'guardado no banco local' : 'não está no banco local: rotacione no painel se precisar dele'}</p>` : vazio}
<p>A API só aceita HTTPS num host público. Para receber na sua máquina, exponha a porta com um túnel e use a URL pública dele. O feed de eventos funciona sem webhook; ele é a fonte de verdade, o webhook é o aviso.</p>
<form method="post" action="/emitente/webhook"><label>URL <input name="url" placeholder="https://seu-tunel.exemplo.com/webhook" size="50" value="${emitente?.webhook?.url ?? ''}"></label><button>${emitente?.webhook ? 'Atualizar' : 'Criar'} webhook</button></form>`)}

<h1>NFS-e Padrão Nacional: o que ela pede a mais</h1>
<p>A ordem da NFS-e dentro dos passos acima: a inscrição municipal entra no cadastro (passo 1) ou aqui, depois; o convênio vem entre o certificado (passo 2) e a ativação (passo 3), e é opcional; e a série de DPS é o passo 5, escolhendo <b>dps</b> em Documento. A emissão vem depois, na tela Nova NFS-e.</p>

${passo('A', 'Inscrição municipal', 'PATCH /v1/emitentes/{id}  { "inscricao_municipal" }', 'de gestão', Boolean(emitente?.inscricao_municipal), !emitente
  ? bloqueado('cadastre o emitente')
  : html`<p>A IM do cadastro vai no <code>prest.im</code> de toda DPS, e a que vale é a do <b>CNC NFS-e</b>, que o Emissor Nacional mostra como "Indicador Municipal": pode não ser a do cartão nem a do alvará. A SEFIN recusa a DPS com a IM ausente ou errada (E0116, que dispensa o MEI) e com a IM que o CNC não registra para o CNPJ no município (E0120). Quem só emite NF-e não precisa dela.</p>
<form method="post" action="/emitente/inscricao-municipal"><label>Inscrição municipal <input name="inscricao_municipal" value="${emitente.inscricao_municipal ?? ''}"></label><button>${emitente.inscricao_municipal ? 'Atualizar' : 'Gravar'} inscrição municipal</button></form>
<p>Vazio limpa a IM. A API tira o espaço e a pontuação antes de gravar, e a ficha acima mostra a que ela guardou.</p>`)}

${passo('B', 'Consultar o convênio do município (opcional)', 'POST /v1/emitentes/{id}/consultas-convenio  { "codigoMunicipio" }', 'de gestão', false, !emitente
  ? bloqueado('cadastre o emitente')
  : html`<p>Pergunta ao Ambiente de Dados Nacional (ADN) que parâmetros de convênio o município publicou. É por código de município, e qualquer um serve, não só o do emitente; a resposta vem no corpo, sem comando a acompanhar. O certificado do emitente abre o mTLS com o ADN, e sem ele a consulta é recusada com 422. Pode ser feita antes da ativação, porque vai com a credencial de gestão, e a do emitente só autentica depois dela.</p>
<p><b>Não bloqueia a emissão</b>, e o veredito não diz se o município aderiu ao Sistema Nacional: diz se a parametrização veio.</p>
<form method="post" action="/emitente/convenio"><label>Código do município (IBGE, 7 dígitos) <input name="codigo_municipio" placeholder="4106902" size="9" maxlength="7"></label><button>Consultar convênio</button></form>`)}`;

  return { html: pagina('Emitente', '/emitente', corpo, chamadas) };
}

function passo(n: number | string, titulo: string, rota: string, escopo: string, feito: boolean, conteudo: Html): Html {
  return html`<section class="${feito ? 'ok' : 'pendente'}"><h2>${n}. ${titulo} ${feito ? '✓' : ''}</h2><p><span class="rota">${rota}</span> · credencial <b>${escopo}</b></p>${conteudo}</section>`;
}

const bloqueado = (motivo: string): Html => html`<p><i>Antes, ${motivo}.</i></p>`;

/** O atalho: a credencial operacional que o painel já cunhou, e a aplicação descobre o emitente. */
function formularioVinculo(): Html {
  return html`<h3>Já tenho o emitente cadastrado na plataforma</h3>
<p>Informe a credencial <b>operacional</b> dele (painel › Credenciais &amp; Webhooks › tipo <b>Operacional</b>). A aplicação chama <span class="rota">GET /v1/contexto</span> para descobrir de quem ela é e <span class="rota">GET /v1/emitentes/{id}</span> para trazer a ficha; nada é criado na plataforma. Com isso, os passos 2, 3 e 4 já estão feitos.</p>
<form method="post" action="/emitente/vincular"><div class="grid">
<label>client_id<br><input name="client_id" required autocomplete="off"></label>
<label>secret<br><input name="secret" type="password" required autocomplete="off"></label>
</div><button>Buscar emitente pela credencial</button></form>
<p>O <code>secret</code> fica em claro no banco local, como o da credencial cunhada no passo 4.</p>`;
}

/** O caminho longo: o emitente ainda não existe, e é a API que o cria. */
function formularioCadastro(): Html {
  const campo = (nome: string, rotulo: string, extra = '') => html`<label>${rotulo}<br><input name="${nome}" ${bruto(extra)}></label>`;
  return html`<h3>Ou cadastrar um emitente novo</h3>
<p>Só os campos obrigatórios do <span class="rota">POST /v1/emitentes</span>, mais fantasia, telefone e a inscrição municipal, que é a do CNC NFS-e (o "Indicador Municipal" do Emissor Nacional) e fica em branco para quem só emite NF-e. O ambiente vai fixo em <b>homologacao</b>.</p>
<form method="post" action="/emitente/cadastrar"><div class="grid">
${campo('cnpj', 'CNPJ (14 caracteres, as 12 primeiras podem ser letras)', 'required')}
${campo('razao_social', 'Razão social', 'required')}
${campo('nome_fantasia', 'Nome fantasia')}
${campo('inscricao_estadual', 'Inscrição estadual (ou ISENTO)', 'value="ISENTO"')}
${campo('inscricao_municipal', 'Inscrição municipal (NFS-e)')}
<label>Regime (CRT)<br><select name="crt"><option value="1">1 · Simples Nacional</option><option value="2">2 · Simples, excesso de sublimite</option><option value="3">3 · Regime Normal</option><option value="4">4 · MEI</option></select></label>
${campo('logradouro', 'Logradouro', 'required')}
${campo('numero', 'Número', 'required')}
${campo('bairro', 'Bairro', 'required')}
${campo('cod_municipio', 'Código IBGE do município (7 dígitos)', 'required')}
${campo('municipio', 'Município', 'required')}
${campo('uf', 'UF', 'required size="2" maxlength="2"')}
${campo('cep', 'CEP (8 dígitos)', 'required')}
${campo('telefone', 'Telefone')}
</div><button>Cadastrar em homologação</button></form>`;
}
