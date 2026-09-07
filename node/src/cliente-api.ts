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

export function criarClienteApi(opcoes: Opcoes) {
  const basic = (cred: Credencial): string =>
    'Basic ' + Buffer.from(`${cred.clientId}:${cred.secret}`).toString('base64');

  /** O único lugar que fala HTTP. Tudo abaixo é uma linha por rota. */
  async function chamar<T>(
    cred: Credencial,
    metodo: string,
    caminho: string,
    corpo?: unknown,
    cabecalhos: Record<string, string> = {},
  ): Promise<{ status: number; corpo: T }> {
    const inicio = Date.now();
    const resposta = await fetch(opcoes.enderecoBase + caminho, {
      method: metodo,
      headers: {
        Authorization: basic(cred),
        Accept: 'application/json, application/problem+json',
        ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...cabecalhos,
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    opcoes.aoChamar?.({ metodo, caminho, status: resposta.status, ms: Date.now() - inicio });

    const contentType = resposta.headers.get('content-type') ?? '';
    const texto = await resposta.text();
    const json = texto && contentType.includes('json') ? JSON.parse(texto) : null;

    if (!resposta.ok) throw new ErroApi(resposta.status, contentType, json ?? { erro: texto || `HTTP ${resposta.status}` });
    return { status: resposta.status, corpo: json as T };
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

    // ---- Webhook: aceita os dois escopos. ----

    /** Upsert. O `secret` só vem quando o PUT cria; distinga pela presença dele, não pelo status. */
    definirWebhook: (cred: Credencial, emitenteId: string, url: string) =>
      chamar<Webhook>(cred, 'PUT', `/v1/emitentes/${emitenteId}/webhook`, { url, ativo: true }),
  };
}

export type ClienteApi = ReturnType<typeof criarClienteApi>;
