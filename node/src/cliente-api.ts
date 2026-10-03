// O cliente da API do Flex DFe. Uma função por rota, nada além de montar a requisição e ler a
// resposta. É o arquivo para portar quando o seu ERP fala outra linguagem.
//
// Quatro coisas que todas as rotas compartilham:
//
// 1. Autenticação é HTTP Basic sobre TLS: `Authorization: Basic base64(client_id:secret)`.
//    A emissão não tem parâmetro de ambiente: a credencial é de um emitente, e a nota sai no ambiente dele,
//    que muda no `PATCH /v1/emitentes/{id}`. As rotas de série aceitam um `ambiente` opcional, e sem ele
//    operam no ambiente atual do emitente.
// 2. Cada função recebe a credencial explicitamente. Isso torna visível qual ESCOPO cada rota
//    exige: a de gestão (integrador) cadastra e cunha; a operacional (emitente) emite e provisiona série.
// 3. Erros vêm em dois envelopes, separados pelo Content-Type e não pelo status HTTP:
//    `application/problem+json` nas rotas de negócio (programe contra o `type`, nunca contra o `title`)
//    e `{ "erro": "..." }` na autenticação. `ErroApi` carrega os dois.
// 4. `429` é a borda pedindo recuo, não erro de negócio: não traz envelope nem `type`. O cliente espera o
//    `Retry-After` e repete a MESMA requisição, com a mesma `Idempotency-Key`. Como toda escrita é idempotente,
//    repetir é seguro; trocar a chave é que criaria uma segunda nota.

import type { Credencial } from './config.ts';

/** O que cada chamada deixou registrado, para a tela mostrar a rota que consumiu. */
export type Chamada = { metodo: string; caminho: string; status: number; ms: number };

export class ErroApi extends Error {
  readonly status: number;
  readonly contentType: string;
  /** Slug estável do `problem+json`. É contra ele que se programa. */
  readonly type: string | null;
  readonly title: string | null;
  readonly detail: string | null;
  /** Mensagem do envelope de autenticação `{ erro }`. Não tem `type`. */
  readonly erro: string | null;

  constructor(status: number, contentType: string, corpo: unknown) {
    const c = (corpo ?? {}) as Record<string, unknown>;
    const problem = contentType.includes('problem+json');
    const mensagem = problem
      ? `${c.type ?? 'erro'}: ${c.detail ?? c.title ?? ''}`.trim()
      : typeof c.erro === 'string'
        ? c.erro
        : `HTTP ${status}`;
    super(mensagem);
    this.status = status;
    this.contentType = contentType;
    this.type = problem && typeof c.type === 'string' ? c.type : null;
    this.title = problem && typeof c.title === 'string' ? c.title : null;
    this.detail = problem && typeof c.detail === 'string' ? c.detail : null;
    this.erro = !problem && typeof c.erro === 'string' ? c.erro : null;
  }
}

export type Opcoes = {
  enderecoBase: string;
  /** Recebe cada chamada feita. A tela usa para listar as rotas consumidas. */
  aoChamar?: (chamada: Chamada) => void;
  /** Quantas vezes repetir uma requisição que voltou `429` antes de desistir. */
  tentativasNo429?: number;
};

// ---- Tipos das respostas que este exemplo lê. Só os campos usados; a Referência tem todos. ----

export type Contexto =
  | { escopo: 'emitente'; emitente: { id: string; cnpj: string; razao_social: string; ambiente: string; tipos_documento: TipoDocumento[] } }
  | { escopo: 'integrador'; integradorId: string; emitentes: { id: string; cnpj: string; razao_social: string; tipos_documento: TipoDocumento[] }[] }
  | { escopo: string; [k: string]: unknown };

export type Certificado = {
  titular: string | null;
  valido_de: string;
  valido_ate: string;
  situacao: string;
  dias_para_expirar: number;
};

export type Emitente = {
  id: string;
  /** 14 caracteres: as 12 primeiras podem ser letras maiúsculas (CNPJ alfanumérico), as 2 últimas são dígitos. */
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  inscricao_estadual: string;
  /** A IM do CNPJ no município (`prest.im` da DPS). Só a NFS-e a usa; `null` quando não informada. */
  inscricao_municipal: string | null;
  crt: 1 | 2 | 3 | 4;
  uf: string;
  municipio: string;
  cod_municipio?: string;
  ambiente: 'homologacao' | 'producao';
  ativo: boolean;
  modelos: number[];
  /** Os documentos habilitados, derivados das séries ativas do ambiente atual: não é um campo editável. */
  tipos_documento: TipoDocumento[];
  certificado: Certificado | null;
  webhook: { url: string; ativo: boolean } | null;
};

export type CriacaoEmitente = {
  cnpj: string;
  razao_social: string;
  nome_fantasia?: string | null;
  inscricao_estadual: string;
  /** Opcional: quem só emite NF-e não a preenche. A API tira espaço e pontuação antes de gravar. */
  inscricao_municipal?: string | null;
  crt: 1 | 2 | 3 | 4;
  ambiente: 'homologacao' | 'producao';
  logradouro: string;
  numero: string;
  bairro: string;
  cod_municipio: string;
  municipio: string;
  uf: string;
  cep: string;
  telefone?: string | null;
};

export type CredencialCunhada = {
  id: string;
  descricao: string;
  client_id: string;
  escopo: string;
  emitente_id: string | null;
  /** Só existe neste corpo. Guarde: nunca mais é recuperável. */
  secret: string;
};

/** O documento que uma série numera: `dps` é a declaração da NFS-e, e a plataforma numera a DPS, não o número da NFS-e. */
export type TipoDocumento = 'nfe' | 'nfce' | 'dps';

/**
 * A série é por ambiente e por documento: a série 1 de homologação e a de produção são duas, e a série 1 de NF-e
 * e a série 1 de DPS também, cada uma com o seu próximo número. O `modelo` só existe na NF-e (55) e na NFC-e (65):
 * a DPS não tem modelo, e vem sem o campo.
 */
export type Serie = {
  ambiente: 'homologacao' | 'producao';
  tipoDocumento: TipoDocumento;
  modelo?: 55 | 65;
  serie: number;
  mode: 'managed' | 'external';
  active: boolean;
  nextNumber?: number;
};

/**
 * O que o ADN respondeu sobre o convênio de um município, sem veredito nosso por cima. O `veredito` diz se a
 * parametrização veio, e não se o município aderiu ao Sistema Nacional: nenhum dos dois valores é "o município
 * está fora". `parametros` é o grupo que o ADN publicou, verbatim, e é `null` em `sem-parametrizacao`.
 */
export type ConsultaConvenio = {
  id: string;
  consultadoEm: string;
  codigoMunicipio: string;
  veredito: 'parametrizado' | 'sem-parametrizacao';
  httpStatus: number | null;
  mensagem: string | null;
  parametros: Record<string, string> | null;
};

export type Webhook = {
  url: string;
  ativo: boolean;
  tem_segredo: boolean;
  /** Presente só quando o PUT CRIOU o webhook, ou na rotação. Ausente quando editou. */
  secret?: string;
};

/** Corpo do `POST /v1/nfe`: o roteamento no topo, a nota em `documento`. Em série managed não vai `numero`. */
export type IntakeNfe = { modelo: 55 | 65; serie: number; documento: Record<string, unknown> };

/** Corpo de aceite: o `202`, e o `200` de um replay já terminal. Não tem `outcome`. */
export type AceiteComando = { id: string; status: string; links: { self: string; events: string } };

/** Representação completa: o `200` de um `wait` resolvido e a base do `GET /v1/nfe/{id}`. Tem `outcome`. */
export type RepresentacaoComando = {
  id: string;
  status: string;
  outcome: 'authorized' | 'rejected' | null;
  modelo: 55 | 65;
  serie: number;
  numero: number | null;
  /** `chave`/`protocolo` na autorização; `motivo` na rejeição, na falha e no bloqueio. */
  result: Record<string, unknown> | null;
  attempts: number;
  criadoEm: string;
  atualizadoEm: string;
};

/**
 * Corpo do `POST /v1/nfse`, no molde do da NF-e: o roteamento no topo, a DPS em `documento`. Em série managed não
 * vai `numeroDps`. O prestador, o `dhEmi`, o número e o ambiente são da plataforma, e o que vier deles no `documento`
 * é ignorado.
 */
export type IntakeNfse = { serie: number; numeroDps?: number; substituicao?: PedidoSubstituicao; documento: Record<string, unknown> };

/**
 * O pedido de substituição: a NFS-e original, pelo `id` que a plataforma devolveu no aceite dela, e o motivo. A
 * plataforma monta o grupo `subst` da DPS com a chave da original. Só se substitui NFS-e emitida pela plataforma, e
 * autorizada no ambiente atual do emitente. O código é `01` desenquadramento do Simples Nacional, `02` enquadramento no
 * Simples Nacional, `03` inclusão retroativa de imunidade ou isenção, `04` exclusão retroativa de imunidade ou isenção,
 * `05` rejeição da NFS-e pelo tomador ou intermediário, `99` outros. A justificativa (15 a 255 caracteres, no envelope
 * da SEFAZ) é obrigatória com o `99`.
 */
export type PedidoSubstituicao = { nfse: string; codigoJustificativa: '01' | '02' | '03' | '04' | '05' | '99'; justificativa?: string };

/**
 * `GET /v1/nfse/{id}/cancelamento`: a última tentativa. Não há `protocolo`: o evento da NFS-e não tem. O cancelamento
 * feito fora da plataforma não gera tentativa: aparece no detalhe da NFS-e, depois de uma consulta.
 */
export type TentativaCancelamentoNfse = {
  situacao: 'processando' | 'registrada' | 'rejeitada' | 'falha' | 'reconciliando' | 'pendente-registro';
  /** `1` erro na emissão, `2` serviço não prestado, `9` outros. */
  codigoJustificativa: string;
  justificativa: string;
  motivo: string | null;
  criadaEm: string;
  concluidaEm: string | null;
};

/**
 * O que o documento informou e o que só a SEFIN calcula. Os campos calculados são nulos antes da `autorizada`, ou
 * quando a NFS-e não os traz.
 */
export type ResumoNfse = {
  tomadorNome: string | null;
  tomadorDoc: string | null;
  competencia: string | null;
  valorServico: number | null;
  codigoTributacaoNacional: string | null;
  descricaoServico: string | null;
  municipioIncidencia: string | null;
  nomeMunicipioIncidencia: string | null;
  descricaoTributacaoNacional: string | null;
  valorIssqn: number | null;
  valorRetido: number | null;
  valorLiquido: number | null;
};

/**
 * O `GET /v1/nfse/{id}`, e o `200` de um `wait` resolvido na emissão: a representação do comando mais a `situacao`
 * (com os nomes da NF-e), o número da DPS, a NFS-e gerada e o `resumo`. É outra família: o `id` de uma NF-e
 * responde `404` aqui.
 */
export type DetalheNfse = {
  id: string;
  status: string;
  outcome: 'authorized' | 'rejected' | null;
  serie: number;
  numeroDps: number | null;
  /** `chave` na autorização; `motivo` na rejeição, na falha e no bloqueio. */
  result: Record<string, unknown> | null;
  attempts: number;
  criadoEm: string;
  atualizadoEm: string;
  situacao: string;
  numeroNfse: number | null;
  /** Anulável também na `autorizada`: um provedor municipal pode não atribuí-la. */
  chave: string | null;
  recebidaEm: string;
  emitidaEm: string | null;
  autorizadaEm: string | null;
  canceladaEm: string | null;
  origemCancelamento: 'pedido' | 'analise-fiscal' | 'oficio' | null;
  justificativaCancelamento: string | null;
  substituidaEm: string | null;
  substituidaPor: { id: string | null; chave: string } | null;
  resumo: ResumoNfse;
};

/** A correção que o fisco considera hoje: a última carta registrada. A próxima carta é construída sobre ela. */
export type CorrecaoVigente = { texto: string; nSeq: number; registradaEm: string | null };

/** O `GET /v1/nfe/{id}`: a representação do comando mais a `situacao` de nível-nota, chave e marcos. */
export type NotaDetalhe = RepresentacaoComando & {
  situacao: string;
  chave: string | null;
  protocolo: string | null;
  canceladaEm: string | null;
  protocoloCancelamento: string | null;
  justificativaCancelamento: string | null;
  correcaoVigente: CorrecaoVigente | null;
};

/**
 * Aceite de uma operação sobre a nota (consulta, cancelamento, carta): o `id` é do comando NOVO, não o da
 * nota. É esse `id` que o feed vai citar no `nfe.cancel`/`nfe.cce`; `links.nota` continua apontando a nota.
 */
export type AceiteOperacao = { id: string; status: string; links: { self?: string; nota: string } };

/**
 * `GET /v1/nfe/{id}/cancelamento`: a tentativa. Um cancelamento que falha também aparece aqui. `reconciliando` e
 * `pendente-registro` dizem que a SEFAZ já respondeu e a gravação do veredito se perdeu: no primeiro a plataforma
 * o busca sozinha, no segundo não tem como, e é caso de suporte. Nos dois, não se reenvia.
 */
export type TentativaCancelamento = {
  situacao: 'processando' | 'registrada' | 'rejeitada' | 'falha' | 'reconciliando' | 'pendente-registro';
  justificativa: string;
  protocolo: string | null;
  motivo: string | null;
  criadaEm: string;
  concluidaEm: string | null;
};

/**
 * Uma carta do histórico `GET /v1/nfe/{id}/cce`. Só a `registrada` corrige, e só ela tem DACCE; a vigente é a
 * última delas. `reconciliando` e `pendente-registro` têm o mesmo sentido que na tentativa de cancelamento.
 */
export type CartaCorrecao = {
  id: string;
  situacao: 'processando' | 'registrada' | 'rejeitada' | 'indeterminada' | 'falha' | 'reconciliando' | 'pendente-registro';
  nSeq: number | null;
  texto: string;
  protocolo: string | null;
  motivo: string | null;
  criadaEm: string;
  registradaEm: string | null;
};

/** Corpo do `POST /v1/inutilizacoes`: a faixa de uma série e a justificativa. A borda só confere a forma. */
export type FaixaInutilizacao = { modelo: 55 | 65; serie: number; nNFIni: number; nNFFin: number; xJust: string };

export type EventoFeed = {
  seq: number;
  commandId: string;
  type: string;
  status: string;
  outcome: 'authorized' | 'rejected' | null;
  criadoEm: string;
};

export type FeedResposta = { events: EventoFeed[]; nextCursor: number };

/** Um arquivo baixado da API (XML ou PDF), com o nome que o `Content-Disposition` sugeriu. */
export type Arquivo = { bytes: Buffer; contentType: string; nome: string | null };

export function criarClienteApi(opcoes: Opcoes) {
  const basic = (cred: Credencial): string =>
    'Basic ' + Buffer.from(`${cred.clientId}:${cred.secret}`).toString('base64');

  /**
   * O único `fetch`. Um `429` não é resposta: é a borda pedindo para esperar. O cliente lê o `Retry-After`,
   * espera e repete a mesma requisição, cabeçalhos inclusive; a `Idempotency-Key` vai igual, e a API trata a
   * repetição como replay. Cada tentativa é registrada em `aoChamar`, para a tela mostrar o 429 e o que veio depois.
   */
  async function buscar(metodo: string, caminho: string, init: RequestInit): Promise<Response> {
    const tentativas = opcoes.tentativasNo429 ?? 3;
    for (let tentativa = 1; ; tentativa++) {
      const inicio = Date.now();
      const resposta = await fetch(opcoes.enderecoBase + caminho, { ...init, method: metodo });
      opcoes.aoChamar?.({ metodo, caminho, status: resposta.status, ms: Date.now() - inicio });
      if (resposta.status !== 429 || tentativa >= tentativas) return resposta;
      await resposta.arrayBuffer(); // descarta o corpo: um 429 da borda não tem envelope para ler
      await new Promise((ok) => setTimeout(ok, recuoMs(resposta.headers.get('retry-after'), tentativa)));
    }
  }

  /** O único lugar que fala HTTP em JSON. Tudo abaixo é uma linha por rota. */
  async function chamar<T>(
    cred: Credencial,
    metodo: string,
    caminho: string,
    corpo?: unknown,
    cabecalhos: Record<string, string> = {},
  ): Promise<{ status: number; corpo: T }> {
    const resposta = await buscar(metodo, caminho, {
      headers: {
        Authorization: basic(cred),
        Accept: 'application/json, application/problem+json',
        ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...cabecalhos,
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });

    const contentType = resposta.headers.get('content-type') ?? '';
    const texto = await resposta.text();
    const json = texto && contentType.includes('json') ? JSON.parse(texto) : null;

    if (!resposta.ok) throw new ErroApi(resposta.status, contentType, json ?? { erro: texto || `HTTP ${resposta.status}` });
    return { status: resposta.status, corpo: json as T };
  }

  /** Igual a `chamar`, mas devolve os bytes: XML e PDF não são JSON. O erro continua vindo em JSON. */
  async function baixar(cred: Credencial, caminho: string, aceitar: string): Promise<Arquivo> {
    const resposta = await buscar('GET', caminho, { headers: { Authorization: basic(cred), Accept: `${aceitar}, application/problem+json` } });
    const contentType = resposta.headers.get('content-type') ?? '';
    if (!resposta.ok) {
      const texto = await resposta.text();
      throw new ErroApi(resposta.status, contentType, contentType.includes('json') && texto ? JSON.parse(texto) : { erro: texto });
    }
    const nome = /filename="?([^";]+)"?/.exec(resposta.headers.get('content-disposition') ?? '')?.[1] ?? null;
    return { bytes: Buffer.from(await resposta.arrayBuffer()), contentType, nome };
  }

  return {
    /** Ecoa quem a credencial é. Serve para provar credencial e escopo antes de qualquer outra coisa. */
    contexto: (cred: Credencial) => chamar<Contexto>(cred, 'GET', '/v1/contexto'),

    // ---- Cadastro: escopo de INTEGRADOR (credencial de gestão). ----

    /** O emitente nasce rascunho (`ativo: false`). Ativar é o PATCH, que exige certificado. */
    criarEmitente: (cred: Credencial, dados: CriacaoEmitente) => chamar<Emitente>(cred, 'POST', '/v1/emitentes', dados),

    lerEmitente: (cred: Credencial, id: string) => chamar<Emitente>(cred, 'GET', `/v1/emitentes/${id}`),

    /** Ativar = `{ ativo: true }`. Recusa `409 certificate-required-to-activate` sem A1 vigente. */
    editarEmitente: (cred: Credencial, id: string, dados: Partial<CriacaoEmitente> & { ativo?: boolean }) =>
      chamar<Emitente>(cred, 'PATCH', `/v1/emitentes/${id}`, dados),

    /** O `.pfx` vai em base64 num JSON com a senha. A API extrai titular e validade; o arquivo nunca volta. */
    enviarCertificado: (cred: Credencial, id: string, pfx: Buffer, senha: string) =>
      chamar<Emitente>(cred, 'PUT', `/v1/emitentes/${id}/certificado`, { pfx_base64: pfx.toString('base64'), senha }),

    /** Com `emitente_id` cunha a OPERACIONAL, que emite para aquele emitente. O `secret` aparece uma vez. */
    cunharCredencial: (cred: Credencial, descricao: string, emitenteId: string) =>
      chamar<CredencialCunhada>(cred, 'POST', '/v1/credenciais', { descricao, emitente_id: emitenteId }),

    /** A ficha efetiva: ambiente, QR Code da NFC-e, responsável técnico, reforma. Somente leitura. */
    lerConfigEmitente: (cred: Credencial, id: string) =>
      chamar<Record<string, unknown>>(cred, 'GET', `/v1/emitentes/${id}/config`),

    /**
     * NFS-e: pergunta ao Ambiente de Dados Nacional (ADN) que parâmetros de convênio um município publicou. É por
     * código de município (qualquer um serve, não só o do emitente) e síncrona: a resposta vem no corpo do `200`.
     * O certificado do emitente abre o mTLS com o ADN, daí a consulta pender de um emitente; sem ele é `422`.
     * É leitura: não leva `Idempotency-Key`, e a rota aceita a credencial de integrador e a de emitente. Antes da
     * ativação só serve a de integrador (a do emitente é recusada com 403 até ele ser ativado). Não bloqueia emissão nenhuma.
     * Indisponibilidade não é negativa: o ADN sem resposta é `503`, e a consulta que não concluiu na janela é `504`;
     * os dois se repetem.
     */
    consultarConvenio: (cred: Credencial, emitenteId: string, codigoMunicipio: string) =>
      chamar<ConsultaConvenio>(cred, 'POST', `/v1/emitentes/${emitenteId}/consultas-convenio`, { codigoMunicipio }),

    // ---- Operação: escopo de EMITENTE (credencial operacional). ----

    /**
     * Série `managed`: a plataforma numera, e a emissão não manda `numero`. Uma por emitente, ambiente, documento e
     * série. Sem `ambiente` no corpo, ela nasce no ambiente atual do emitente, que neste exemplo é homologação.
     */
    provisionarSerie: (cred: Credencial, documento: 55 | 65 | 'dps', serie: number) =>
      chamar<Serie>(cred, 'POST', '/v1/series', { ...(documento === 'dps' ? { tipoDocumento: documento } : { modelo: documento }), serie, mode: 'managed' }),

    /** As séries de um ambiente: sem `?ambiente=`, as do ambiente atual. O corpo diz qual, mesmo com a lista vazia. */
    listarSeries: (cred: Credencial) => chamar<{ ambiente: Serie['ambiente']; series: Serie[] }>(cred, 'GET', '/v1/series'),

    /**
     * Enfileira a emissão. `Idempotency-Key` é obrigatória: gere UMA por intenção de emissão e grave-a antes
     * de chamar; reenviar com a mesma chave e o mesmo corpo é replay (mesmo `id`), nunca uma segunda nota.
     * `wait` é a janela síncrona em ms (teto 15000): desfecho dentro dela vem como `200` com a representação
     * completa; fora dela, `202` com o aceite. Distinga pela presença de `outcome`, não pelo status.
     */
    emitirNfe: (cred: Credencial, corpo: IntakeNfe, idempotencyKey: string, waitMs: number) =>
      chamar<RepresentacaoComando | AceiteComando>(cred, 'POST', `/v1/nfe?wait=${waitMs}`, corpo, { 'Idempotency-Key': idempotencyKey }),

    /**
     * NFS-e: enfileira a DPS. Mesmo molde da emissão da NF-e: `Idempotency-Key` obrigatória (uma por intenção de
     * emissão, gravada antes de chamar) e `wait` opcional, com teto de 15000. Desfecho dentro da janela vem como `200`
     * com o detalhe da NFS-e; fora dela, `202` com o aceite. Distinga pela presença de `outcome`, não pelo status.
     * A DPS rejeitada pode ser reaberta no mesmo `numeroDps` (`reabrir: true`, com chave nova); este exemplo não
     * usa isso: emitir de novo, sem o `reabrir`, toma o próximo número.
     */
    emitirNfse: (cred: Credencial, corpo: IntakeNfse, idempotencyKey: string, waitMs: number) =>
      chamar<DetalheNfse | AceiteComando>(cred, 'POST', `/v1/nfse?wait=${waitMs}`, corpo, { 'Idempotency-Key': idempotencyKey }),

    /** A NFS-e: `situacao`, número da DPS, número e chave da NFS-e e o `resumo` que a SEFIN calculou. */
    lerNfse: (cred: Credencial, id: string) => chamar<DetalheNfse>(cred, 'GET', `/v1/nfse/${id}`),

    /**
     * O feed da família: o mesmo protocolo de cursor do da NF-e, só com os comandos `nfse.*`. As duas famílias dividem a
     * numeração do `seq`, então cada feed enxerga buracos que são eventos do outro, e cada um tem o SEU cursor.
     */
    lerFeedNfse: (cred: Credencial, since: number, limit = 100) =>
      chamar<FeedResposta>(cred, 'GET', `/v1/nfse/events?since=${since}&limit=${limit}`),

    /** O XML como a SEFIN o devolveu, com a DPS dentro. Só existe depois da `autorizada`; antes é `409 nfse-xml-unavailable`. */
    baixarXmlNfse: (cred: Credencial, id: string) => baixar(cred, `/v1/nfse/${id}/xml`, 'application/xml'),

    /**
     * O DANFSe: a plataforma o gera a cada pedido, a partir do XML. Serve a autorizada, a cancelada e a substituída:
     * a cancelada leva a marca "CANCELADA", e a substituída, "SUBSTITUÍDA"; a de produção restrita (a homologação deste
     * exemplo) leva, no cabeçalho, "NFS-e SEM VALIDADE JURÍDICA". Antes de a DPS virar NFS-e é `409 nfse-danfse-unavailable`.
     */
    baixarDanfse: (cred: Credencial, id: string) => baixar(cred, `/v1/nfse/${id}/danfse`, 'application/pdf'),

    /**
     * Procura na SEFIN o que ela sabe da DPS ou da NFS-e: numa DPS que não virou NFS-e, a nota gerada por ela; numa
     * NFS-e, os cancelamentos feitos fora da plataforma (Emissor Nacional, análise fiscal, ofício, substituição).
     * Responde `202`; o resultado vem ao reler `GET /v1/nfse/{id}`. Não reenvia nada, não leva `Idempotency-Key` e não
     * gera evento no feed.
     */
    consultarNfse: (cred: Credencial, id: string) => chamar<AceiteOperacao>(cred, 'POST', `/v1/nfse/${id}/consulta`),

    /**
     * Só a NFS-e `autorizada` cancela (senão `409 nfse-not-cancelable`). Vão o código (`1` erro na emissão, `2` serviço
     * não prestado, `9` outros) e a justificativa (15–255, no envelope da SEFAZ; senão `422 cancellation-reason-invalid`).
     * O prazo é do município e a plataforma não o confere: a recusa por prazo vem da SEFIN, na tentativa `rejeitada`.
     * Exige `Idempotency-Key`. O item do feed (`nfse.cancel`) sai sem `outcome`.
     */
    cancelarNfse: (cred: Credencial, id: string, codigoJustificativa: string, justificativa: string, idempotencyKey: string) =>
      chamar<AceiteOperacao>(cred, 'POST', `/v1/nfse/${id}/cancelamento`, { codigoJustificativa, justificativa }, { 'Idempotency-Key': idempotencyKey }),

    /** A tentativa de cancelamento, registrada ou não. `404` enquanto nenhuma foi feita. */
    lerCancelamentoNfse: (cred: Credencial, id: string) => chamar<TentativaCancelamentoNfse>(cred, 'GET', `/v1/nfse/${id}/cancelamento`),

    /** A nota enriquecida: `situacao`, chave, protocolo, marcos. É a leitura que fecha o que o feed anunciou. */
    lerNota: (cred: Credencial, id: string) => chamar<NotaDetalhe>(cred, 'GET', `/v1/nfe/${id}`),

    /** O feed: a fonte de verdade dos desfechos. `since` é exclusivo; avance sempre pelo `nextCursor`. */
    lerFeed: (cred: Credencial, since: number, limit = 100) =>
      chamar<FeedResposta>(cred, 'GET', `/v1/nfe/events?since=${since}&limit=${limit}`),

    /** Só existe na nota AUTORIZADA; antes disso é `409 nfe-xml-unavailable`. */
    baixarXml: (cred: Credencial, id: string) => baixar(cred, `/v1/nfe/${id}/xml`, 'application/xml'),

    /** Sempre que há XML assinado: autorizada e cancelada (com tarja). Fora disso, `409 nfe-danfe-unavailable`. */
    baixarDanfe: (cred: Credencial, id: string) => baixar(cred, `/v1/nfe/${id}/danfe`, 'application/pdf'),

    // ---- Operações sobre a nota emitida: escopo de EMITENTE. Assíncronas: 202 com o id do comando NOVO. ----

    /** Pede à SEFAZ a situação real da nota. Não gera evento no feed: o resultado vem ao reler `GET /v1/nfe/{id}`. */
    consultarNfe: (cred: Credencial, id: string) => chamar<AceiteOperacao>(cred, 'POST', `/v1/nfe/${id}/consulta`),

    /**
     * Só a nota `autorizada` cancela (senão `409 nfe-not-cancelable`). Vai só a justificativa (15–255, no envelope da
     * SEFAZ; senão `422 cancellation-reason-invalid`); a plataforma deriva protocolo e data. Exige `Idempotency-Key`.
     * A janela de 24h não é conferida aqui: a SEFAZ decide, e o desfecho chega pelo feed como `nfe.cancel`.
     */
    cancelarNfe: (cred: Credencial, id: string, justificativa: string, idempotencyKey: string) =>
      chamar<AceiteOperacao>(cred, 'POST', `/v1/nfe/${id}/cancelamento`, { justificativa }, { 'Idempotency-Key': idempotencyKey }),

    /** A tentativa de cancelamento, registrada ou não. `404` enquanto nenhuma foi feita. */
    lerCancelamento: (cred: Credencial, id: string) => chamar<TentativaCancelamento>(cred, 'GET', `/v1/nfe/${id}/cancelamento`),

    /**
     * A carta de correção. O texto (15–1000) SUBSTITUI a correção anterior por inteiro: monte-o cumulativo, a
     * partir de `correcaoVigente`. Só no modelo 55 (`409 nfe-cce-model-not-allowed` no 65) e só na nota autorizada
     * (`409 nfe-not-correctable`). A situação da nota não muda; o desfecho da carta vem pelo feed como `nfe.cce`.
     */
    emitirCce: (cred: Credencial, id: string, xCorrecao: string, idempotencyKey: string) =>
      chamar<AceiteOperacao>(cred, 'POST', `/v1/nfe/${id}/cce`, { xCorrecao }, { 'Idempotency-Key': idempotencyKey }),

    /** O histórico das cartas, inclusive as que não corrigiram nada. Lista vazia quando não há nenhuma. */
    listarCce: (cred: Credencial, id: string) => chamar<{ dados: CartaCorrecao[] }>(cred, 'GET', `/v1/nfe/${id}/cce`),

    /**
     * O DACCE: o documento da carta, que o emitente entrega ao destinatário. É para a carta o que o DANFE é para a
     * nota, e o DANFE não muda com a correção. Só a carta `registrada` tem; as outras são `409 nfe-dacce-unavailable`.
     */
    baixarDacce: (cred: Credencial, id: string, cartaId: string) => baixar(cred, `/v1/nfe/${id}/cce/${cartaId}/dacce`, 'application/pdf'),

    /**
     * Declara à SEFAZ que a faixa `nNFIni`–`nNFFin` de uma série não será usada. É passthrough: a borda confere a
     * forma dos campos e nada mais; se a faixa procede é a SEFAZ que decide, e a recusa volta como desfecho
     * rejeitado, não como `422`. Mesmo molde da emissão: `Idempotency-Key`, `wait`, e o feed fecha como `nfe.inutiliza`.
     */
    inutilizarFaixa: (cred: Credencial, faixa: FaixaInutilizacao, idempotencyKey: string, waitMs: number) =>
      chamar<RepresentacaoComando | AceiteComando>(cred, 'POST', `/v1/inutilizacoes?wait=${waitMs}`, faixa, { 'Idempotency-Key': idempotencyKey }),

    // ---- Webhook: aceita os dois escopos. ----

    /** Upsert. O `secret` só vem quando o PUT cria; distinga pela presença dele, não pelo status. */
    definirWebhook: (cred: Credencial, emitenteId: string, url: string) =>
      chamar<Webhook>(cred, 'PUT', `/v1/emitentes/${emitenteId}/webhook`, { url, ativo: true }),
  };
}

export type ClienteApi = ReturnType<typeof criarClienteApi>;

/**
 * Quanto esperar antes de repetir. `Retry-After` pode vir em segundos ou como data HTTP; sem ele, recuo
 * exponencial. É o header que manda: a borda sabe quando vai aceitar de novo, o cliente não.
 */
export function recuoMs(retryAfter: string | null, tentativa: number): number {
  if (retryAfter !== null) {
    const segundos = Number(retryAfter);
    if (Number.isFinite(segundos)) return Math.max(0, segundos) * 1000;
    const data = Date.parse(retryAfter);
    if (Number.isFinite(data)) return Math.max(0, data - Date.now());
  }
  return 2 ** tentativa * 500;
}
