// O cliente da API do Flex DFe. Uma função por rota, nada além de montar a requisição e ler a
// resposta. É o arquivo para portar quando o seu ERP fala outra linguagem.
//
// Três coisas que todas as rotas compartilham:
//
// 1. Autenticação é HTTP Basic sobre TLS: `Authorization: Basic base64(client_id:secret)`.
//    Não há parâmetro de ambiente: a credencial é de um emitente, e o emitente é de um ambiente.
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
  | { escopo: 'emitente'; emitente: { id: string; cnpj: string; razao_social: string; ambiente: string } }
  | { escopo: 'integrador'; integradorId: string; emitentes: { id: string; cnpj: string; razao_social: string }[] }
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
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  inscricao_estadual: string;
  crt: 1 | 2 | 3 | 4;
  uf: string;
  municipio: string;
  cod_municipio?: string;
  ambiente: 'homologacao' | 'producao';
  ativo: boolean;
  modelos: number[];
  certificado: Certificado | null;
  webhook: { url: string; ativo: boolean } | null;
};

export type CriacaoEmitente = {
  cnpj: string;
  razao_social: string;
  nome_fantasia?: string | null;
  inscricao_estadual: string;
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

export type Serie = { modelo: 55 | 65; serie: number; mode: 'managed' | 'external'; active: boolean; nextNumber?: number };

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

/** `GET /v1/nfe/{id}/cancelamento`: a tentativa. Um cancelamento que falha também aparece aqui. */
export type TentativaCancelamento = {
  situacao: 'processando' | 'registrada' | 'rejeitada' | 'falha';
  justificativa: string;
  protocolo: string | null;
  motivo: string | null;
  criadaEm: string;
  concluidaEm: string | null;
};

/** Uma carta do histórico `GET /v1/nfe/{id}/cce`. Só a `registrada` corrige; a vigente é a última delas. */
export type CartaCorrecao = {
  id: string;
  situacao: 'processando' | 'registrada' | 'rejeitada' | 'indeterminada' | 'falha';
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

    // ---- Operação: escopo de EMITENTE (credencial operacional). ----

    /** Série `managed`: a plataforma numera, e a emissão não manda `numero`. Uma por emitente, modelo e série. */
    provisionarSerie: (cred: Credencial, modelo: 55 | 65, serie: number) =>
      chamar<Serie>(cred, 'POST', '/v1/series', { modelo, serie, mode: 'managed' }),

    listarSeries: (cred: Credencial) => chamar<{ series: Serie[] }>(cred, 'GET', '/v1/series'),

    /**
     * Enfileira a emissão. `Idempotency-Key` é obrigatória: gere UMA por intenção de emissão e grave-a antes
     * de chamar; reenviar com a mesma chave e o mesmo corpo é replay (mesmo `id`), nunca uma segunda nota.
     * `wait` é a janela síncrona em ms (teto 15000): desfecho dentro dela vem como `200` com a representação
     * completa; fora dela, `202` com o aceite. Distinga pela presença de `outcome`, não pelo status.
     */
    emitirNfe: (cred: Credencial, corpo: IntakeNfe, idempotencyKey: string, waitMs: number) =>
      chamar<RepresentacaoComando | AceiteComando>(cred, 'POST', `/v1/nfe?wait=${waitMs}`, corpo, { 'Idempotency-Key': idempotencyKey }),

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
