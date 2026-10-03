// Uma API do Flex DFe de mentira, em processo, para os testes dirigirem a tela sem credencial
// nem SEFAZ. Responde os contratos do OpenAPI publicado (tag v0.5.0) só no que este exemplo
// consome: os dois envelopes de erro, os escopos, o secret que aparece uma vez, as operações
// sobre a nota emitida e o 429 da borda.
//
// Escrita à mão a partir da Referência. Se o contrato mudar, é aqui que a divergência aparece.

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

type Cred = { clientId: string; secret: string; escopo: 'integrador' | 'emitente'; emitenteId?: string };

export type Requisicao = { metodo: string; caminho: string; clientId: string | null; corpo: unknown; cabecalhos: IncomingHttpHeaders };

/** Um comando de emissão, do jeito que a API o representa. */
export type Comando = {
  id: string;
  emitenteId: string;
  status: string;
  outcome: 'authorized' | 'rejected' | null;
  modelo: 55 | 65;
  serie: number;
  numero: number;
  chave: string;
  situacao: string;
  result: Record<string, unknown> | null;
  documento: unknown;
  canceladaEm: string | null;
  protocoloCancelamento: string | null;
  justificativaCancelamento: string | null;
  /** O que a SEFAZ sabe e a plataforma ainda não: um cancelamento feito por fora. A consulta traz para `situacao`. */
  verdadeSefaz: string | null;
  criadoEm: string;
};

/** Um comando de ciclo de vida (`nfe.cancel`, `nfe.cce`, `nfe.inutiliza`), do jeito que a API o representa. */
export type OperacaoFalsa = {
  id: string;
  tipo: 'nfe.cancel' | 'nfe.cce' | 'nfe.inutiliza' | 'nfse.cancel';
  emitenteId: string;
  /** O comando da nota, quando a operação é sobre uma nota. */
  notaId: string | null;
  status: string;
  outcome: 'authorized' | 'rejected' | null;
  /** A situação própria: da tentativa de cancelamento ou da carta. */
  situacao: string;
  corpo: Record<string, unknown>;
  protocolo: string | null;
  motivo: string | null;
  nSeq: number | null;
  criadaEm: string;
  concluidaEm: string | null;
};

/**
 * Uma DPS e a NFS-e que ela vira, do jeito que a API a representa. É outra família: o `id` de uma NFS-e responde
 * `404` nas rotas da NF-e, e o de uma NF-e responde `404` nas da NFS-e.
 */
export type DpsFalsa = {
  id: string;
  emitenteId: string;
  status: string;
  outcome: 'authorized' | 'rejected' | null;
  serie: number;
  numeroDps: number;
  numeroNfse: number | null;
  chave: string | null;
  situacao: string;
  result: Record<string, unknown> | null;
  documento: Record<string, any>;
  criadoEm: string;
  autorizadaEm: string | null;
  canceladaEm: string | null;
  origemCancelamento: 'pedido' | 'analise-fiscal' | 'oficio' | null;
  justificativaCancelamento: string | null;
  substituidaEm: string | null;
  substituidaPor: { id: string | null; chave: string } | null;
  /** O pedido de substituição, quando esta NFS-e é a substituta. */
  substituicao: { original: string; chaveOriginal: string | null; codigoJustificativa: string; justificativa: string | null } | null;
  /** O que a SEFIN sabe e a plataforma ainda não: um cancelamento feito por fora. A consulta traz para a NFS-e. */
  verdadeSefin: { origem: 'pedido' | 'analise-fiscal' | 'oficio'; justificativa: string } | null;
};

export type EventoFalso = { seq: number; commandId: string; type: string; status: string; outcome: 'authorized' | 'rejected' | null; criadoEm: string };

type RespostaFalsa = { status: number; tipo: string; corpo: unknown; texto?: string; disposicao?: string; cabecalhos?: Record<string, string> };

const PATTERN_TEXTO_SEFAZ = /^(?:[!-ÿ][ -ÿ]*[!-ÿ]|[!-ÿ])$/;

/** O documento que uma série numera: `dps` é a declaração da NFS-e. */
export type TipoDocumento = 'nfe' | 'nfce' | 'dps';

const MODELO_DO_TIPO: Record<TipoDocumento, 55 | 65 | undefined> = { nfe: 55, nfce: 65, dps: undefined };

/** CNPJ alfanumérico: as 12 primeiras posições podem ser letras, as 2 últimas são dígitos. */
const PATTERN_CNPJ = /^[A-Za-z0-9]{12}[0-9]{2}$/;

export class ApiFalsa {
  readonly servidor: Server;
  readonly requisicoes: Requisicao[] = [];
  readonly credenciais: Cred[] = [{ clientId: 'gestao', secret: 'segredo-gestao', escopo: 'integrador' }];
  readonly emitentes = new Map<string, Record<string, unknown>>();
  /**
   * A série é por ambiente e por documento: a chave é emitente + ambiente + `tipoDocumento` + série. O `modelo`
   * só existe na NF-e (55) e na NFC-e (65); a DPS não tem.
   */
  readonly series: { emitenteId: string; ambiente: string; tipoDocumento: TipoDocumento; modelo?: 55 | 65; serie: number; nextNumber: number }[] = [];
  readonly webhooks = new Map<string, { url: string; ativo: boolean; secret: string }>();
  /**
   * O que o ADN responde à consulta de convênio: `indisponivel` é o `503` (ele não respondeu), e os municípios em
   * `semParametrizacao` voltam `200` com o veredito `sem-parametrizacao`. Os demais voltam `parametrizado`.
   */
  readonly convenio = { indisponivel: false, lenta: false, semParametrizacao: new Set<string>() };
  /**
   * Chamado a cada requisição que chega, antes de ela ser tratada. É como um teste olha o estado da aplicação NO
   * MOMENTO da chamada, e prova a ORDEM (a chave e o corpo gravados antes), que a igualdade depois dela não prova.
   */
  aoReceber: ((requisicao: Requisicao) => void) | null = null;
  /** A senha que "abre" o .pfx de teste, e o conteúdo cujo titular "bate" com o CNPJ. */
  senhaCerta = 'senha-certa';
  conteudoPfxDoTitular = 'PFX-DO-TITULAR';
  enderecoBase = '';

  // ---- Emissão, feed e leitura. ----
  readonly comandos = new Map<string, Comando>();
  /** `Idempotency-Key` → impressão do corpo e id do comando. Mesma chave, mesmo corpo: replay. */
  readonly chaves = new Map<string, { impressao: string; id: string }>();
  readonly feed: EventoFalso[] = [];
  /** `sincrono`: o `wait` resolve autorizado na hora (200). `assincrono`: fica pendente (202) até `concluir`. */
  modoEmissao: 'sincrono' | 'assincrono' = 'sincrono';
  /** O `seq` avança de 2 em 2 de propósito: o feed real tem buracos, e o consumidor não pode contá-los. */
  private proximoSeq = 1;

  // ---- NFS-e: a família `/v1/nfse`, com os comandos `nfse.*` no mesmo feed numerado. ----
  readonly dps = new Map<string, DpsFalsa>();
  private proximaNfse = 1;

  // ---- Operações sobre a nota emitida. ----
  readonly operacoes = new Map<string, OperacaoFalsa>();
  /** `sincrono`: cancelamento, carta e inutilização concluem na hora. `assincrono`: ficam pendentes até `concluirOperacao`. */
  modoOperacoes: 'sincrono' | 'assincrono' = 'sincrono';

  // ---- A borda. ----
  /** Enquanto `vezes` > 0, a requisição (que case com `caminho`, se dado) volta 429 com `Retry-After` e desconta uma. É a borda limitando taxa. */
  limitar: { vezes: number; retryAfter: string | null; caminho?: RegExp } = { vezes: 0, retryAfter: '0' };

  /** Publica um evento no feed. É o que a plataforma faz a cada transição. */
  publicar(commandId: string, type: string, status: string, outcome: 'authorized' | 'rejected' | null): EventoFalso {
    const e = { seq: this.proximoSeq, commandId, type, status, outcome, criadoEm: new Date().toISOString() };
    this.proximoSeq += 2;
    this.feed.push(e);
    return e;
  }

  /** Fecha um comando pendente com o desfecho dado, e publica no feed. */
  concluir(commandId: string, desfecho: 'authorized' | 'rejected' | 'failed' | 'blocked'): EventoFalso {
    const c = this.comandos.get(commandId)!;
    if (desfecho === 'authorized' || desfecho === 'rejected') {
      c.status = 'completed';
      c.outcome = desfecho;
      c.situacao = desfecho === 'authorized' ? 'autorizada' : 'rejeitada';
      c.result = desfecho === 'authorized' ? { chave: c.chave, protocolo: '135' + String(c.numero).padStart(12, '0') } : { motivo: '539 Rejeicao: Duplicidade de NF-e' };
    } else {
      c.status = desfecho;
      c.outcome = null;
      // A API diz `bloqueada` para os dois terminais: quem os distingue é o `status`.
      c.situacao = 'bloqueada';
      // O motivo de uma recusa antecipada traz o caminho do campo: a plataforma validou antes da SEFAZ.
      // O do bloqueio diz a causa na numeração e o ajuste; este é o da série inativada depois do aceite.
      c.result = { motivo: desfecho === 'failed' ? 'PIS_COFINS_AUSENTE em /det[1]/imposto/PIS' : 'a série está inativa e não aceita número novo; reative-a ou envie a nota por outra série', ...(desfecho === 'failed' ? { situacao: 'inexistente', origem: 'local', classe: 'permanent' } : {}) };
    }
    return this.publicar(commandId, 'nfe.emit', c.status, c.outcome);
  }

  /** Fecha uma DPS pendente com o desfecho dado, e publica o `nfse.emit` no feed. A autorizada vira NFS-e, com número e chave. */
  concluirDps(id: string, desfecho: 'authorized' | 'rejected' | 'failed' | 'blocked'): EventoFalso {
    const d = this.dps.get(id)!;
    if (desfecho === 'authorized') {
      d.status = 'completed';
      d.outcome = 'authorized';
      d.situacao = 'autorizada';
      d.numeroNfse = this.proximaNfse++;
      // A chave da NFS-e tem 50 posições.
      d.chave = '4106902' + String(d.numeroNfse).padStart(43, '0');
      d.autorizadaEm = new Date().toISOString();
      d.result = { chave: d.chave };
      // A SEFIN gera a substituta e cancela a original no mesmo envio: a original vira `substituida`.
      const original = d.substituicao ? this.dps.get(d.substituicao.original) : undefined;
      if (original) {
        original.situacao = 'substituida';
        original.substituidaEm = d.autorizadaEm;
        original.substituidaPor = { id: d.id, chave: d.chave };
      }
    } else if (desfecho === 'rejected') {
      d.status = 'completed';
      d.outcome = 'rejected';
      d.situacao = 'rejeitada';
      d.result = { motivo: 'E0116: Inscrição municipal do prestador ausente ou inválida' };
    } else {
      d.status = desfecho;
      d.outcome = null;
      d.situacao = 'bloqueada';
      d.result = { motivo: desfecho === 'failed' ? 'IM_AUSENTE em /prest/IM' : 'a série está inativa e não aceita número novo' };
    }
    return this.publicar(id, 'nfse.emit', d.status, d.outcome);
  }

  /**
   * A SEFAZ autorizou e um erro interno abortou a gravação do desfecho: o comando segue `processing`, com o
   * marcador no `result`, e a `situacao` diz `reconciliando` até a plataforma refazer a gravação. Sem evento no feed.
   */
  reconciliar(commandId: string): void {
    const c = this.comandos.get(commandId)!;
    c.status = 'processing';
    c.situacao = 'reconciliando';
    c.result = { reconciliacao: { desfecho: 'autorizada', especie: 'reconciliavel', protocolo: '135' + String(c.numero).padStart(12, '0'), cStat: '100', motivo: 'Autorizado o uso da NF-e', chave: c.chave, nSeqEvento: null, marcado_em: new Date().toISOString(), prox_tentativa_em: new Date().toISOString(), tentativas: 0 } };
  }

  /**
   * Cancela a NFS-e POR FORA da plataforma (o Emissor Nacional, a análise fiscal, o município). A plataforma não fica
   * sabendo: `GET /v1/nfse/{id}` segue dizendo `autorizada` até uma consulta trazer o cancelamento. Sem evento no feed.
   */
  cancelarNfsePorFora(id: string, origem: 'pedido' | 'analise-fiscal' | 'oficio' = 'analise-fiscal', justificativa = 'Cancelamento deferido pelo município'): void {
    this.dps.get(id)!.verdadeSefin = { origem, justificativa };
  }

  /**
   * Cancela a nota POR FORA da plataforma (outro sistema, o portal da SEFAZ). A plataforma não fica sabendo:
   * `GET /v1/nfe/{id}` segue dizendo `autorizada` até uma consulta reconciliar. Sem evento no feed.
   */
  cancelarPorFora(commandId: string): void {
    this.comandos.get(commandId)!.verdadeSefaz = 'cancelada';
  }

  /** Fecha uma operação pendente com o desfecho dado, aplica o efeito na nota e publica no feed. */
  concluirOperacao(operacaoId: string, desfecho: 'authorized' | 'rejected' | 'failed'): EventoFalso {
    const o = this.operacoes.get(operacaoId)!;
    // Na NFS-e o `notaId` é o id da DPS, que mora em outra tabela: o id de uma família responde 404 na outra.
    const ehNfse = o.tipo === 'nfse.cancel';
    const nota = o.notaId && !ehNfse ? this.comandos.get(o.notaId)! : null;
    const dps = o.notaId && ehNfse ? this.dps.get(o.notaId)! : null;
    o.concluidaEm = new Date().toISOString();
    if (desfecho === 'failed') {
      o.status = 'failed';
      o.outcome = null;
      o.situacao = 'falha';
      o.motivo = 'falha definitiva no processamento';
    } else {
      o.status = 'completed';
      o.outcome = desfecho;
      if (desfecho === 'authorized') {
        o.situacao = 'registrada';
        // O evento de cancelamento da NFS-e não tem protocolo.
        o.protocolo = ehNfse ? null : '135' + String(this.operacoes.size).padStart(12, '0');
        if (dps) {
          dps.situacao = 'cancelada';
          dps.canceladaEm = o.concluidaEm;
          dps.origemCancelamento = 'pedido';
          dps.justificativaCancelamento = String(o.corpo.justificativa);
        }
        if (o.tipo === 'nfe.cancel' && nota) {
          nota.situacao = 'cancelada';
          nota.canceladaEm = o.concluidaEm;
          nota.protocoloCancelamento = o.protocolo;
          nota.justificativaCancelamento = String(o.corpo.justificativa);
        }
      } else {
        o.situacao = 'rejeitada';
        o.motivo = o.tipo === 'nfe.inutiliza' ? '563 Rejeicao: Numero inicial da faixa maior que o final' : o.tipo === 'nfe.cancel' ? '501 Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao' : ehNfse ? 'E0822: Cancelamento fora do prazo definido pelo município' : '594 Rejeicao: O numero do evento nao e compativel';
      }
    }
    // O item do feed do cancelamento da NFS-e sai sem `outcome`: quem diz como a tentativa terminou é a leitura dela.
    return this.publicar(o.id, o.tipo, o.status, ehNfse ? null : o.outcome);
  }

  constructor() {
    this.servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (p: Buffer) => partes.push(p));
      req.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        const corpo = texto ? JSON.parse(texto) : undefined;
        const r = this.tratar(req.method ?? 'GET', req.url ?? '/', req.headers, corpo);
        res.writeHead(r.status, { 'Content-Type': r.tipo, ...(r.disposicao ? { 'Content-Disposition': r.disposicao } : {}), ...(r.cabecalhos ?? {}) });
        res.end(r.texto ?? (r.corpo === undefined ? '' : JSON.stringify(r.corpo)));
      });
    });
  }

  async iniciar(): Promise<string> {
    await new Promise<void>((ok) => this.servidor.listen(0, '127.0.0.1', ok));
    this.enderecoBase = `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}`;
    return this.enderecoBase;
  }

  parar(): Promise<void> {
    return new Promise((ok) => this.servidor.close(() => ok()));
  }

  private tratar(metodo: string, caminho: string, cabecalhos: IncomingHttpHeaders, corpo: unknown): RespostaFalsa {
    const cred = this.autenticar(cabecalhos.authorization);
    const requisicao: Requisicao = { metodo, caminho, clientId: cred?.clientId ?? null, corpo, cabecalhos };
    this.requisicoes.push(requisicao);
    this.aoReceber?.(requisicao);

    // A borda vem antes de tudo: 429 sem envelope, com Retry-After, antes mesmo de autenticar.
    if (this.limitar.vezes > 0 && (!this.limitar.caminho || this.limitar.caminho.test(caminho))) {
      this.limitar.vezes--;
      return { status: 429, tipo: 'text/plain', corpo: undefined, texto: 'Too Many Requests', cabecalhos: this.limitar.retryAfter === null ? {} : { 'Retry-After': this.limitar.retryAfter } };
    }

    // Envelope de autenticação: { erro }, application/json, sem type.
    if (!cred) return json(401, { erro: 'credencial inválida' });
    // A credencial de um emitente INATIVO não autentica: um emitente novo nasce rascunho, e só emite depois do certificado e da ativação.
    if (cred.escopo === 'emitente' && this.emitentes.get(cred.emitenteId!)?.ativo === false) {
      return json(403, { erro: 'emitente inativo: um emitente novo nasce rascunho; envie o certificado A1 e ative-o' });
    }

    // O `title` é humano e muda sem aviso. Aqui ele muda a CADA resposta, de propósito: um cliente que
    // ramificasse por ele quebraria no teste, antes de quebrar em produção.
    const problema = (status: number, type: string, detail?: string) =>
      ({ status, tipo: 'application/problem+json', corpo: { type, title: `Título humano ${randomUUID().slice(0, 8)}`, status, detail, instance: caminho } });

    const partes = caminho.split('?')[0].split('/').filter(Boolean); // ['v1','emitentes',id,...]
    const query = new URLSearchParams(caminho.split('?')[1] ?? '');

    if (metodo === 'GET' && caminho === '/v1/contexto') {
      if (cred.escopo === 'integrador')
        return json(200, { escopo: 'integrador', integradorId: 'int-1', emitentes: [...this.emitentes.values()].map((e) => ({ id: e.id, cnpj: e.cnpj, razao_social: e.razao_social })) });
      const e = this.emitentes.get(cred.emitenteId!)!;
      return json(200, { escopo: 'emitente', emitente: { id: e.id, cnpj: e.cnpj, razao_social: e.razao_social, ambiente: e.ambiente, tipos_documento: this.tiposDocumento(e) } });
    }

    if (partes[1] === 'emitentes') {
      if (metodo === 'POST' && partes.length === 2) {
        if (cred.escopo !== 'integrador') return problema(403, 'integrador-scope-required');
        const c = corpo as Record<string, unknown>;
        for (const campo of ['cnpj', 'razao_social', 'inscricao_estadual', 'crt', 'ambiente', 'logradouro', 'numero', 'bairro', 'cod_municipio', 'municipio', 'uf', 'cep'])
          if (c[campo] === undefined || c[campo] === '') return problema(422, 'invalid-request-body', `campo ${campo} obrigatório`);
        if (!PATTERN_CNPJ.test(String(c.cnpj))) return problema(422, 'invalid-request-body', 'cnpj deve ter 14 caracteres (12 alfanuméricos + 2 dígitos), sem máscara');
        // A minúscula é aceita e gravada em maiúscula.
        const cnpj = String(c.cnpj).toUpperCase();
        if ([...this.emitentes.values()].some((e) => e.cnpj === cnpj)) return problema(409, 'emitente-cnpj-already-exists');
        const im = inscricaoMunicipal(c.inscricao_municipal);
        if (im === 'longa') return problema(422, 'invalid-request-body', 'inscricao_municipal deve ter até 15 letras e dígitos');
        const e = { id: randomUUID(), ...c, cnpj, inscricao_municipal: im, nome_fantasia: c.nome_fantasia ?? null, ativo: false, certificado: null, webhook: null, contingencia: [], suspenso_em: null, suspensao_motivo: null };
        this.emitentes.set(e.id, e);
        return json(201, this.comWebhook(e));
      }
      const e = this.emitentes.get(partes[2]);
      if (!e) return problema(404, 'emitente-not-found');
      const sub = partes[3];

      if (metodo === 'GET' && !sub) return json(200, this.comWebhook(e));
      if (metodo === 'PATCH' && !sub) {
        if (cred.escopo !== 'integrador') return problema(403, 'integrador-scope-required');
        const c = { ...(corpo as Record<string, unknown>) };
        if (c.ativo === true && !e.certificado) return problema(409, 'certificate-required-to-activate');
        if ('inscricao_municipal' in c) {
          const im = inscricaoMunicipal(c.inscricao_municipal);
          if (im === 'longa') return problema(422, 'invalid-request-body', 'inscricao_municipal deve ter até 15 letras e dígitos');
          c.inscricao_municipal = im;
        }
        Object.assign(e, c);
        return json(200, this.comWebhook(e));
      }
      if (metodo === 'PUT' && sub === 'certificado') {
        if (cred.escopo !== 'integrador') return problema(403, 'integrador-scope-required');
        const c = corpo as { pfx_base64?: string; senha?: string };
        if (!c.pfx_base64 || c.senha === undefined) return problema(422, 'invalid-request-body');
        if (c.senha !== this.senhaCerta) return problema(422, 'certificate-unreadable', 'senha incorreta ou arquivo não é um A1');
        if (Buffer.from(c.pfx_base64, 'base64').toString('utf8') !== this.conteudoPfxDoTitular) return problema(422, 'certificate-holder-mismatch');
        e.certificado = { titular: e.cnpj, valido_de: '2026-01-01', valido_ate: '2027-01-01', situacao: 'vigente', dias_para_expirar: 200 };
        return json(200, this.comWebhook(e));
      }
      // A consulta de convênio é síncrona e é leitura: não exige `Idempotency-Key` e não olha o `ativo` do emitente.
      // O certificado dele é o que abre o mTLS com o ADN, e sem ele a consulta é recusada antes de sair (422).
      if (metodo === 'POST' && sub === 'consultas-convenio') {
        const codigo = (corpo as { codigoMunicipio?: unknown }).codigoMunicipio;
        if (typeof codigo !== 'string' || !/^\d{7}$/.test(codigo)) return problema(422, 'invalid-request-body', 'codigoMunicipio deve ter sete dígitos (código do IBGE)');
        if (!e.certificado) return problema(422, 'invalid-request-body', 'o emitente não tem certificado: o ADN exige mTLS em todas as rotas');
        if (this.convenio.indisponivel) return problema(503, 'municipal-agreement-lookup-unavailable', 'o Ambiente de Dados Nacional não respondeu');
        if (this.convenio.lenta) return problema(504, 'municipal-agreement-lookup-unavailable', 'a consulta não concluiu dentro da janela');
        const sem = this.convenio.semParametrizacao.has(codigo);
        return json(200, {
          id: randomUUID(),
          consultadoEm: new Date().toISOString(),
          codigoMunicipio: codigo,
          veredito: sem ? 'sem-parametrizacao' : 'parametrizado',
          httpStatus: sem ? 404 : 200,
          mensagem: sem ? 'Município sem parametrização de convênio publicada.' : 'Parâmetros do convênio recuperados com sucesso.',
          parametros: sem ? null : { aderenteAmbienteNacional: '1', aderenteEmissorNacional: '1', situacaoEmissaoPadraoContribuintesRFB: '1', aderenteMAN: '0', permiteAproveitamentoDeCreditos: 'true' },
        });
      }
      if (metodo === 'GET' && sub === 'config')
        return json(200, { ambiente: { procedencia: 'emitente', valor: e.ambiente }, nfce: { procedencia: 'resolvido', versao_qrcode: '3.0', url_consulta_qrcode: 'https://x', url_consulta_chave: 'https://y' } });
      if (sub === 'webhook') {
        if (metodo === 'PUT') {
          const c = corpo as { url?: string; ativo?: boolean };
          if (!c.url || !/^https:\/\//.test(c.url) || /localhost/.test(c.url)) return problema(422, 'webhook-url-invalid');
          const existente = this.webhooks.get(e.id as string);
          if (existente) {
            Object.assign(existente, { url: c.url, ativo: c.ativo ?? true });
            return json(200, { url: existente.url, ativo: existente.ativo, criado_em: 'x', atualizado_em: 'y', tem_segredo: true });
          }
          const novo = { url: c.url, ativo: c.ativo ?? true, secret: 'whsec-' + randomUUID() };
          this.webhooks.set(e.id as string, novo);
          return json(200, { url: novo.url, ativo: novo.ativo, criado_em: 'x', atualizado_em: 'x', tem_segredo: true, secret: novo.secret });
        }
      }
    }

    if (metodo === 'POST' && caminho === '/v1/credenciais') {
      if (cred.escopo !== 'integrador') return problema(403, 'credencial-management-scope');
      const c = corpo as { descricao?: string; emitente_id?: string };
      if (!c.descricao?.trim()) return problema(422, 'invalid-request-body');
      if (c.emitente_id && !this.emitentes.has(c.emitente_id)) return problema(404, 'emitente-not-found');
      const nova: Cred = c.emitente_id
        ? { clientId: 'op-' + randomUUID().slice(0, 8), secret: 'sec-' + randomUUID(), escopo: 'emitente', emitenteId: c.emitente_id }
        : { clientId: 'g-' + randomUUID().slice(0, 8), secret: 'sec-' + randomUUID(), escopo: 'integrador' };
      this.credenciais.push(nova);
      return json(201, { id: randomUUID(), descricao: c.descricao, client_id: nova.clientId, escopo: nova.escopo, emitente_id: c.emitente_id ?? null, emitente_nome: null, criado_em: 'x', ultimo_uso: null, ativo: true, secret: nova.secret });
    }

    if (caminho === '/v1/series') {
      if (cred.escopo !== 'emitente') return problema(403, 'emitente-scope-required');
      // O exemplo não informa `ambiente`, e sem ele as rotas de série operam no ambiente atual do emitente.
      const atual = String(this.emitentes.get(cred.emitenteId!)!.ambiente);
      if (metodo === 'GET') {
        const doAmbiente = this.series.filter((s) => s.emitenteId === cred.emitenteId && s.ambiente === atual);
        return json(200, { ambiente: atual, series: doAmbiente.map((s) => ({ ...representacaoSerie(s), mode: 'managed', active: true, nextNumber: s.nextNumber })) });
      }
      if (metodo === 'POST') {
        const c = corpo as { modelo?: number; tipoDocumento?: string; serie?: number; mode?: string; nextNumber?: number };
        if (!Number.isInteger(c.serie) || !['managed', 'external'].includes(c.mode!)) return problema(422, 'invalid-request-body');
        // O documento vem pelo `modelo` (55, 65) ou pelo `tipoDocumento`; a DPS só se pede pelo segundo, e os dois em desacordo são 422.
        const doModelo = c.modelo === undefined ? undefined : c.modelo === 55 ? 'nfe' : c.modelo === 65 ? 'nfce' : null;
        const doTipo = c.tipoDocumento === undefined ? undefined : (['nfe', 'nfce', 'dps'] as const).find((t) => t === c.tipoDocumento) ?? null;
        if (doModelo === null || doTipo === null || (doModelo === undefined && doTipo === undefined)) return problema(422, 'invalid-request-body', 'informe o modelo (55 ou 65) ou o tipoDocumento (nfe, nfce ou dps)');
        if (doModelo && doTipo && doModelo !== doTipo) return problema(422, 'invalid-request-body', 'modelo e tipoDocumento em desacordo');
        const tipoDocumento = (doTipo ?? doModelo)!;
        // Cada documento tem a sua faixa de série, conferida na provisão: 0–999 na NF-e e na NFC-e, 1–49999 na DPS.
        const [minimo, maximo] = tipoDocumento === 'dps' ? [1, 49999] : [0, 999];
        if (c.serie! < minimo || c.serie! > maximo) return problema(422, 'invalid-request-body', `serie deve ser um inteiro entre ${minimo} e ${maximo} para ${tipoDocumento}`);
        if (this.series.some((s) => s.emitenteId === cred.emitenteId && s.ambiente === atual && s.tipoDocumento === tipoDocumento && s.serie === c.serie)) return problema(409, 'series-already-exists', `série ${tipoDocumento} serie=${c.serie} já provisionada no ambiente ${atual}`);
        const s = { emitenteId: cred.emitenteId!, ambiente: atual, tipoDocumento, modelo: MODELO_DO_TIPO[tipoDocumento], serie: c.serie!, nextNumber: c.nextNumber ?? 1 };
        this.series.push(s);
        return json(201, { ...representacaoSerie(s), mode: c.mode, active: true, nextNumber: s.nextNumber });
      }
    }

    // ---- Inutilização: sobre a faixa, escopo de emitente, mesmo molde da emissão. ----
    if (metodo === 'POST' && partes[1] === 'inutilizacoes' && partes.length === 2) {
      if (cred.escopo !== 'emitente') return problema(403, 'emitente-scope-required');
      const chave = cabecalhos['idempotency-key'];
      if (!chave) return problema(422, 'idempotency-key-required', 'informe o header Idempotency-Key');
      const c = corpo as Record<string, unknown>;
      // Só a FORMA. `nNFIni ≤ nNFFin` e a procedência da faixa são da SEFAZ.
      const inteiroEntre = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
      if (![55, 65].includes(c.modelo as number) || !inteiroEntre(c.serie, 0, 999) || !inteiroEntre(c.nNFIni, 1, 999_999_999) || !inteiroEntre(c.nNFFin, 1, 999_999_999) || typeof c.xJust !== 'string' || c.xJust.length < 15 || c.xJust.length > 255 || !PATTERN_TEXTO_SEFAZ.test(c.xJust))
        return problema(422, 'invalid-request-body', 'forma inválida: modelo 55|65, serie 0–999, nNFIni/nNFFin 1–999999999, xJust 15–255');
      const replay = this.replay(String(chave), corpo);
      if (replay) return replay;
      const o = this.criarOperacao('nfe.inutiliza', cred.emitenteId!, null, c, String(chave));
      if (this.modoOperacoes === 'sincrono' && Number(query.get('wait') ?? 0) > 0) {
        this.concluirOperacao(o.id, (c.nNFIni as number) <= (c.nNFFin as number) ? 'authorized' : 'rejected');
        return json(200, representacaoOperacao(o));
      }
      return json(202, aceiteOperacao(o, `/v1/inutilizacoes/${o.id}`));
    }

    // ---- NFS-e: o intake da DPS, o feed da família e o detalhe. Escopo de emitente, como na NF-e. ----
    if (partes[1] === 'nfse') {
      if (cred.escopo !== 'emitente') return problema(403, 'emitente-scope-required');

      if (metodo === 'POST' && partes.length === 2) {
        if (!cabecalhos['idempotency-key']) return problema(422, 'idempotency-key-required', 'informe o header Idempotency-Key');
        const chave = String(cabecalhos['idempotency-key']);
        const c = corpo as { serie?: number; numeroDps?: number; documento?: Record<string, any>; substituicao?: { nfse?: string; codigoJustificativa?: string; justificativa?: string } };
        if (!Number.isInteger(c.serie) || c.serie! < 1 || c.serie! > 49999 || typeof c.documento !== 'object' || c.documento === null) return problema(422, 'invalid-request-body', 'serie é um inteiro de 1 a 49999 e documento é obrigatório');
        // A forma da substituição: o código é do conjunto fechado, e a justificativa (15–255, no envelope da SEFAZ) é obrigatória com o 99.
        if (c.substituicao) {
          const { codigoJustificativa: codigo, justificativa: texto } = c.substituicao;
          if (!['01', '02', '03', '04', '05', '99'].includes(String(codigo))) return problema(422, 'cancellation-reason-invalid', 'codigoJustificativa deve ser 01, 02, 03, 04, 05 ou 99');
          if ((codigo === '99' && texto === undefined) || (texto !== undefined && (texto.length < 15 || texto.length > 255 || !PATTERN_TEXTO_SEFAZ.test(texto)))) return problema(422, 'cancellation-reason-invalid', 'justificativa: 15 a 255 caracteres no envelope da SEFAZ, obrigatória com o código 99');
        }
        const replay = this.replay(chave, corpo);
        if (replay) return replay;
        const emitente = this.emitentes.get(cred.emitenteId!)!;
        // A original, pelo id que a plataforma devolveu: a que a credencial não enxerga responde 404, e a que não está autorizada, 409.
        const original = c.substituicao ? this.dps.get(String(c.substituicao.nfse)) : undefined;
        if (c.substituicao && (!original || original.emitenteId !== cred.emitenteId)) return problema(404, 'nfse-original-not-found', 'a NFS-e a substituir não foi encontrada');
        if (original && original.situacao !== 'autorizada') return problema(409, 'nfse-not-substitutable', `a NFS-e está '${original.situacao}'; só uma NFS-e autorizada se substitui`);
        const serie = this.series.find((s) => s.emitenteId === cred.emitenteId && s.ambiente === emitente.ambiente && s.tipoDocumento === 'dps' && s.serie === c.serie);
        if (!serie) return problema(404, 'series-not-provisioned', `série dps serie=${c.serie} não provisionada no ambiente ${emitente.ambiente}`);
        const nova: DpsFalsa = {
          id: randomUUID(),
          emitenteId: cred.emitenteId!,
          status: 'pending',
          outcome: null,
          serie: c.serie!,
          numeroDps: serie.nextNumber++,
          numeroNfse: null,
          chave: null,
          situacao: 'pendente',
          result: null,
          documento: c.documento,
          criadoEm: new Date().toISOString(),
          autorizadaEm: null,
          canceladaEm: null,
          origemCancelamento: null,
          justificativaCancelamento: null,
          substituidaEm: null,
          substituidaPor: null,
          substituicao: original ? { original: original.id, chaveOriginal: original.chave, codigoJustificativa: String(c.substituicao!.codigoJustificativa), justificativa: c.substituicao!.justificativa ?? null } : null,
          verdadeSefin: null,
        };
        this.dps.set(nova.id, nova);
        this.chaves.set(chave, { impressao: canonico(corpo), id: nova.id });
        if (this.modoEmissao === 'sincrono' && Number(query.get('wait') ?? 0) > 0) {
          this.concluirDps(nova.id, 'authorized');
          return json(200, detalheDps(nova));
        }
        return json(202, aceiteDps(nova));
      }

      if (metodo === 'GET' && partes[2] === 'events') return json(200, this.lerFeed('nfse', query));

      const dps = this.dps.get(partes[2]);
      if (!dps || dps.emitenteId !== cred.emitenteId) return problema(404, 'command-not-found', `comando ${partes[2]} não encontrado`);
      if (metodo === 'GET' && partes.length === 3) return json(200, detalheDps(dps));

      const sub = partes[3];
      // O XML e o DANFSe existem para a DPS que a SEFIN transformou em NFS-e: a autorizada, a cancelada e a substituída.
      const temNfse = ['autorizada', 'cancelada', 'substituida'].includes(dps.situacao);
      if (metodo === 'GET' && sub === 'xml') {
        if (!temNfse) return problema(409, 'nfse-xml-unavailable', 'a DPS ainda não virou NFS-e; não há XML para baixar');
        return { status: 200, tipo: 'application/xml', corpo: undefined, texto: `<NFSe><infNFSe Id="NFS${dps.chave}"/></NFSe>`, disposicao: `attachment; filename="${dps.chave}.xml"` };
      }
      if (metodo === 'GET' && sub === 'danfse') {
        if (!temNfse) return problema(409, 'nfse-danfse-unavailable', 'sem o XML da NFS-e não há DANFSe para gerar');
        return { status: 200, tipo: 'application/pdf', corpo: undefined, texto: `%PDF-1.4 DANFSE ${dps.chave} ${dps.situacao}`, disposicao: `inline; filename="${dps.chave}.pdf"` };
      }

      // A consulta traz o que a SEFIN sabe: o cancelamento feito por fora. Sem evento no feed; a releitura mostra o resultado.
      if (metodo === 'POST' && sub === 'consulta') {
        if (dps.verdadeSefin && dps.situacao === 'autorizada') {
          dps.situacao = 'cancelada';
          dps.canceladaEm = new Date().toISOString();
          dps.origemCancelamento = dps.verdadeSefin.origem;
          dps.justificativaCancelamento = dps.verdadeSefin.justificativa;
          dps.verdadeSefin = null;
        }
        return json(202, { id: randomUUID(), status: 'pending', links: { nota: `/v1/nfse/${dps.id}` } });
      }

      if (sub === 'cancelamento') {
        const tentativas = [...this.operacoes.values()].filter((o) => o.tipo === 'nfse.cancel' && o.notaId === dps.id);
        if (metodo === 'GET') {
          const tentativa = tentativas.at(-1);
          if (!tentativa) return problema(404, 'command-not-found', 'nenhuma tentativa de cancelamento para esta NFS-e');
          return json(200, { situacao: tentativa.situacao, codigoJustificativa: tentativa.corpo.codigoJustificativa, justificativa: tentativa.corpo.justificativa, motivo: tentativa.motivo, criadaEm: tentativa.criadaEm, concluidaEm: tentativa.concluidaEm });
        }
        if (metodo === 'POST') {
          const chaveCancelamento = cabecalhos['idempotency-key'];
          if (!chaveCancelamento) return problema(422, 'idempotency-key-required', 'informe o header Idempotency-Key');
          const c = corpo as { codigoJustificativa?: unknown; justificativa?: unknown };
          if (!['1', '2', '9'].includes(String(c.codigoJustificativa)) || typeof c.justificativa !== 'string' || c.justificativa.length < 15 || c.justificativa.length > 255 || !PATTERN_TEXTO_SEFAZ.test(c.justificativa))
            return problema(422, 'cancellation-reason-invalid', 'codigoJustificativa deve ser 1, 2 ou 9, e a justificativa de 15 a 255 caracteres, no envelope da SEFAZ');
          // O prazo é do município e a plataforma não o confere: a recusa por prazo vem da SEFIN, na tentativa.
          if (dps.situacao !== 'autorizada') return problema(409, 'nfse-not-cancelable', `a NFS-e está '${dps.situacao}'; só uma NFS-e autorizada pode ser cancelada`);
          const replay = this.replay(String(chaveCancelamento), corpo);
          if (replay) return replay;
          const o = this.criarOperacao('nfse.cancel', cred.emitenteId!, dps.id, c as Record<string, unknown>, String(chaveCancelamento));
          if (this.modoOperacoes === 'sincrono') this.concluirOperacao(o.id, 'authorized');
          return json(202, aceiteOperacao(o, `/v1/nfse/${dps.id}/cancelamento`, `/v1/nfse/${dps.id}`));
        }
      }
    }

    // ---- Emissão e acompanhamento: escopo de emitente. ----
    if (partes[1] === 'nfe') {
      if (cred.escopo !== 'emitente') return problema(403, 'emitente-scope-required');

      if (metodo === 'POST' && partes.length === 2) {
        if (!cabecalhos['idempotency-key']) return problema(422, 'idempotency-key-required', 'informe o header Idempotency-Key');
        const chave = String(cabecalhos['idempotency-key']);
        const c = corpo as { modelo?: number; serie?: number; numero?: number; documento?: unknown };
        if (![55, 65].includes(c.modelo!) || !Number.isInteger(c.serie) || typeof c.documento !== 'object') return problema(422, 'invalid-request-body', 'modelo deve ser 55 (NF-e) ou 65 (NFC-e)');
        const replay = this.replay(chave, corpo);
        if (replay) return replay;
        // A nota numera na série do ambiente atual do emitente.
        const emitente = this.emitentes.get(cred.emitenteId!)!;
        const serie = this.series.find((s) => s.emitenteId === cred.emitenteId && s.ambiente === emitente.ambiente && s.modelo === c.modelo && s.serie === c.serie);
        if (!serie) return problema(404, 'series-not-provisioned', `série modelo=${c.modelo} serie=${c.serie} não provisionada no ambiente ${emitente.ambiente}`);
        if (c.numero !== undefined) return problema(422, 'number-not-allowed-managed', 'série managed: a plataforma aloca o número; não informe numero');
        const numero = serie.nextNumber++;
        const novo: Comando = {
          id: randomUUID(),
          emitenteId: cred.emitenteId!,
          status: 'pending',
          outcome: null,
          modelo: c.modelo as 55 | 65,
          serie: c.serie!,
          numero,
          chave: `43${new Date().toISOString().slice(2, 4)}09${emitente.cnpj}${c.modelo}${String(c.serie).padStart(3, '0')}${String(numero).padStart(9, '0')}1${String(numero).padStart(8, '0')}0`,
          situacao: 'pendente',
          result: null,
          documento: c.documento,
          canceladaEm: null,
          protocoloCancelamento: null,
          justificativaCancelamento: null,
          verdadeSefaz: null,
          criadoEm: new Date().toISOString(),
        };
        this.comandos.set(novo.id, novo);
        this.chaves.set(chave, { impressao: canonico(corpo), id: novo.id });
        if (this.modoEmissao === 'sincrono' && Number(query.get('wait') ?? 0) > 0) {
          this.concluir(novo.id, 'authorized');
          return json(200, representacao(novo));
        }
        return json(202, aceite(novo));
      }

      if (metodo === 'GET' && partes[2] === 'events') return json(200, this.lerFeed('nfe', query));

      const comando = this.comandos.get(partes[2]);
      if (!comando || comando.emitenteId !== cred.emitenteId) return problema(404, 'command-not-found', `comando ${partes[2]} não encontrado`);
      const sub = partes[3];
      const cartas = () => [...this.operacoes.values()].filter((o) => o.tipo === 'nfe.cce' && o.notaId === comando.id);

      if (metodo === 'GET' && !sub) {
        const vigente = cartas().filter((o) => o.situacao === 'registrada').at(-1);
        return json(200, {
          ...representacao(comando),
          situacao: comando.situacao,
          resumo: null,
          chave: comando.chave,
          protocolo: comando.result?.protocolo ?? null,
          recebidaEm: comando.criadoEm,
          autorizadaEm: null,
          canceladaEm: comando.canceladaEm,
          protocoloCancelamento: comando.protocoloCancelamento,
          justificativaCancelamento: comando.justificativaCancelamento,
          correcaoVigente: vigente ? { texto: vigente.corpo.xCorrecao, nSeq: vigente.nSeq, registradaEm: vigente.concluidaEm } : null,
        });
      }
      if (metodo === 'GET' && sub === 'xml') {
        if (comando.situacao !== 'autorizada') return problema(409, 'nfe-xml-unavailable', 'a nota ainda não foi autorizada; não há XML para baixar');
        return { status: 200, tipo: 'application/xml', corpo: undefined, texto: `<nfeProc><NFe><infNFe Id="NFe${comando.chave}"/></NFe></nfeProc>`, disposicao: `attachment; filename="${comando.chave}.xml"` };
      }
      if (metodo === 'GET' && sub === 'danfe') {
        if (!['autorizada', 'cancelada'].includes(comando.situacao)) return problema(409, 'nfe-danfe-unavailable', 'não há XML assinado desta nota para gerar o DANFE');
        return { status: 200, tipo: 'application/pdf', corpo: undefined, texto: `%PDF-1.4 DANFE ${comando.chave} ${comando.situacao}`, disposicao: `inline; filename="${comando.chave}.pdf"` };
      }

      // ---- As operações sobre a nota. ----
      if (metodo === 'POST' && sub === 'consulta') {
        // Reconcilia com a SEFAZ: o que ela sabe passa a valer. Sem evento no feed; a releitura traz o resultado.
        if (comando.verdadeSefaz) {
          comando.situacao = comando.verdadeSefaz;
          if (comando.verdadeSefaz === 'cancelada') comando.canceladaEm = new Date().toISOString();
          comando.verdadeSefaz = null;
        }
        return json(202, { id: randomUUID(), status: 'pending', links: { nota: `/v1/nfe/${comando.id}` } });
      }

      if (sub === 'cancelamento') {
        if (metodo === 'GET') {
          const tentativa = [...this.operacoes.values()].filter((o) => o.tipo === 'nfe.cancel' && o.notaId === comando.id).at(-1);
          if (!tentativa) return problema(404, 'command-not-found', 'nenhuma tentativa de cancelamento para esta nota');
          return json(200, { situacao: tentativa.situacao, justificativa: tentativa.corpo.justificativa, protocolo: tentativa.protocolo, motivo: tentativa.motivo, criadaEm: tentativa.criadaEm, concluidaEm: tentativa.concluidaEm });
        }
        if (metodo === 'POST') {
          const chave = cabecalhos['idempotency-key'];
          if (!chave) return problema(422, 'idempotency-key-required', 'informe o header Idempotency-Key');
          const c = corpo as { justificativa?: unknown };
          if (typeof c.justificativa !== 'string' || c.justificativa.length < 15 || c.justificativa.length > 255 || !PATTERN_TEXTO_SEFAZ.test(c.justificativa))
            return problema(422, 'cancellation-reason-invalid', 'justificativa deve ter entre 15 e 255 caracteres, no envelope da SEFAZ');
          if (comando.situacao !== 'autorizada') return problema(409, 'nfe-not-cancelable', `a nota está '${comando.situacao}'; só uma nota autorizada pode ser cancelada`);
          const replay = this.replay(String(chave), corpo);
          if (replay) return replay;
          const o = this.criarOperacao('nfe.cancel', cred.emitenteId!, comando.id, c as Record<string, unknown>, String(chave));
          if (this.modoOperacoes === 'sincrono') this.concluirOperacao(o.id, 'authorized');
          return json(202, aceiteOperacao(o, `/v1/nfe/${comando.id}/cancelamento`, `/v1/nfe/${comando.id}`));
        }
      }

      if (metodo === 'GET' && sub === 'cce' && partes[5] === 'dacce' && partes.length === 6) {
        const carta = cartas().find((o) => o.id === partes[4]);
        if (!carta) return problema(404, 'command-not-found', `carta ${partes[4]} não encontrada`);
        if (carta.situacao !== 'registrada') return problema(409, 'nfe-dacce-unavailable', `a carta de correção está ${carta.situacao} — só uma carta registrada na SEFAZ tem documento para imprimir`);
        return { status: 200, tipo: 'application/pdf', corpo: undefined, texto: `%PDF-1.4 DACCE ${comando.chave} nSeq ${carta.nSeq}`, disposicao: `inline; filename="${comando.chave}-cce-${carta.nSeq}.pdf"` };
      }

      if (sub === 'cce') {
        if (metodo === 'GET') {
          return json(200, { dados: cartas().map((o) => ({ id: o.id, situacao: o.situacao, nSeq: o.nSeq, texto: o.corpo.xCorrecao, protocolo: o.protocolo, motivo: o.motivo, criadaEm: o.criadaEm, registradaEm: o.situacao === 'registrada' ? o.concluidaEm : null })) });
        }
        if (metodo === 'POST') {
          const chave = cabecalhos['idempotency-key'];
          if (!chave) return problema(422, 'idempotency-key-required', 'informe o header Idempotency-Key');
          const c = corpo as { xCorrecao?: unknown };
          if (typeof c.xCorrecao !== 'string' || c.xCorrecao.length < 15 || c.xCorrecao.length > 1000 || !PATTERN_TEXTO_SEFAZ.test(c.xCorrecao))
            return problema(422, 'correction-text-invalid', 'xCorrecao deve ter entre 15 e 1000 caracteres, no envelope da SEFAZ');
          if (comando.modelo === 65) return problema(409, 'nfe-cce-model-not-allowed', 'a NFC-e (modelo 65) não aceita Carta de Correção');
          if (comando.situacao !== 'autorizada') return problema(409, 'nfe-not-correctable', `a nota está '${comando.situacao}'; só uma nota autorizada aceita carta`);
          if (cartas().length >= 20) return problema(409, 'nfe-cce-limit-reached', 'a nota já tem vinte cartas');
          const replay = this.replay(String(chave), corpo);
          if (replay) return replay;
          const o = this.criarOperacao('nfe.cce', cred.emitenteId!, comando.id, c as Record<string, unknown>, String(chave));
          o.nSeq = cartas().length; // já inclui esta
          if (this.modoOperacoes === 'sincrono') this.concluirOperacao(o.id, 'authorized');
          return json(202, aceiteOperacao(o, `/v1/nfe/${comando.id}/cce`, `/v1/nfe/${comando.id}`));
        }
      }
    }

    return problema(404, 'not-found', `a API falsa não conhece ${metodo} ${caminho}`);
  }

  /** Mesma chave, mesmo corpo: replay (o mesmo `id`). Mesma chave, corpo diferente: 422. Chave nova: `null`. */
  private replay(chave: string, corpo: unknown): RespostaFalsa | null {
    const vista = this.chaves.get(chave);
    if (!vista) return null;
    if (vista.impressao !== canonico(corpo)) return { status: 422, tipo: 'application/problem+json', corpo: { type: 'idempotency-key-conflict', title: 'idempotency-key-conflict', status: 422, detail: 'mesma Idempotency-Key com corpo diferente', instance: '' } };
    const comando = this.comandos.get(vista.id);
    if (comando) return json(ehTerminal(comando.status) ? 200 : 202, aceite(comando));
    const dps = this.dps.get(vista.id);
    if (dps) return json(ehTerminal(dps.status) ? 200 : 202, aceiteDps(dps));
    const o = this.operacoes.get(vista.id)!;
    return json(ehTerminal(o.status) ? 200 : 202, aceiteOperacao(o, ''));
  }

  private criarOperacao(tipo: OperacaoFalsa['tipo'], emitenteId: string, notaId: string | null, corpo: Record<string, unknown>, chave: string): OperacaoFalsa {
    const o: OperacaoFalsa = { id: randomUUID(), tipo, emitenteId, notaId, status: 'pending', outcome: null, situacao: 'processando', corpo, protocolo: null, motivo: null, nSeq: null, criadaEm: new Date().toISOString(), concluidaEm: null };
    this.operacoes.set(o.id, o);
    this.chaves.set(chave, { impressao: canonico(corpo), id: o.id });
    this.publicar(o.id, tipo, 'pending', null);
    return o;
  }

  /**
   * O feed da família: `GET /v1/nfe/events` entrega só `nfe.*`, e `GET /v1/nfse/events`, só `nfse.*`. As duas
   * dividem a numeração do `seq`, então cada leitura enxerga buracos que são eventos da outra.
   */
  private lerFeed(familia: 'nfe' | 'nfse', query: URLSearchParams) {
    const since = Number(query.get('since') ?? 0);
    const limit = Math.min(Number(query.get('limit') ?? 100), 1000);
    const events = this.feed.filter((e) => e.seq > since && e.type.startsWith(`${familia}.`)).slice(0, limit);
    return { events, nextCursor: events.length ? events[events.length - 1].seq : since };
  }

  /** Os documentos habilitados são derivados das séries ativas do ambiente atual: não são um campo editável. */
  private tiposDocumento(e: Record<string, unknown>): TipoDocumento[] {
    const doAmbiente = this.series.filter((s) => s.emitenteId === e.id && s.ambiente === e.ambiente);
    return (['nfe', 'nfce', 'dps'] as const).filter((t) => doAmbiente.some((s) => s.tipoDocumento === t));
  }

  /** A representação do emitente: os `modelos` e os `tipos_documento` saem das séries, e o webhook, do cadastro dele. */
  private comWebhook(e: Record<string, unknown>) {
    const w = this.webhooks.get(e.id as string);
    const tipos = this.tiposDocumento(e);
    const modelos = tipos.map((t) => MODELO_DO_TIPO[t]).filter((m) => m !== undefined);
    return { ...e, modelos, tipos_documento: tipos, webhook: w ? { url: w.url, ativo: w.ativo } : null };
  }

  private autenticar(auth: string | undefined): Cred | null {
    if (!auth?.startsWith('Basic ')) return null;
    const [clientId, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
    return this.credenciais.find((c) => c.clientId === clientId && c.secret === secret) ?? null;
  }
}

const json = (status: number, corpo: unknown): RespostaFalsa => ({ status, tipo: 'application/json', corpo });

/** A série como a API a devolve: o `tipoDocumento` sempre, e o `modelo` só na NF-e e na NFC-e. */
const representacaoSerie = (s: { ambiente: string; tipoDocumento: TipoDocumento; modelo?: 55 | 65; serie: number }) => ({
  ambiente: s.ambiente,
  tipoDocumento: s.tipoDocumento,
  ...(s.modelo === undefined ? {} : { modelo: s.modelo }),
  serie: s.serie,
});

/**
 * A inscrição municipal como a API a grava: sem espaço nem pontuação, e `null` quando não sobra letra nem dígito.
 * Acima de 15 letras e dígitos, é 422.
 */
function inscricaoMunicipal(valor: unknown): string | null | 'longa' {
  const limpa = typeof valor === 'string' ? valor.replace(/[^A-Za-z0-9]/g, '') : '';
  if (limpa.length > 15) return 'longa';
  return limpa === '' ? null : limpa;
}

const ehTerminal = (status: string): boolean => ['completed', 'failed', 'blocked'].includes(status);

/** Impressão do corpo com as chaves ordenadas: reordenar chaves não muda a identidade; mudar conteúdo muda. */
function canonico(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canonico((v as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(v);
}

const aceite = (c: Comando) => ({ id: c.id, status: c.status, links: { self: `/v1/nfe/${c.id}`, events: '/v1/nfe/events?since=0' } });

const representacao = (c: Comando) => ({ id: c.id, status: c.status, outcome: c.outcome, modelo: c.modelo, serie: c.serie, numero: c.numero, result: c.result, attempts: 1, retentativa: null, criadoEm: c.criadoEm, atualizadoEm: new Date().toISOString() });

const aceiteDps = (d: DpsFalsa) => ({ id: d.id, status: d.status, links: { self: `/v1/nfse/${d.id}`, events: '/v1/nfse/events?since=0' } });

/**
 * O detalhe da NFS-e: a representação do comando mais a `situacao`, o número da DPS, a NFS-e gerada e o `resumo`,
 * com o que o `documento` informou e o que só a SEFIN calcula (nulo antes da `autorizada`).
 */
function detalheDps(d: DpsFalsa) {
  const { toma, serv, valores } = d.documento;
  const autorizada = d.situacao === 'autorizada';
  return {
    id: d.id,
    status: d.status,
    outcome: d.outcome,
    serie: d.serie,
    numeroDps: d.numeroDps,
    result: d.result,
    attempts: 1,
    retentativa: null,
    criadoEm: d.criadoEm,
    atualizadoEm: new Date().toISOString(),
    situacao: d.situacao,
    numeroNfse: d.numeroNfse,
    chave: d.chave,
    recebidaEm: d.criadoEm,
    emitidaEm: null,
    autorizadaEm: d.autorizadaEm,
    canceladaEm: d.canceladaEm,
    origemCancelamento: d.origemCancelamento,
    justificativaCancelamento: d.justificativaCancelamento,
    substituidaEm: d.substituidaEm,
    substituidaPor: d.substituidaPor,
    substituicao: d.substituicao ? { nfse: { id: d.substituicao.original, chave: d.substituicao.chaveOriginal }, codigoJustificativa: d.substituicao.codigoJustificativa, justificativa: d.substituicao.justificativa } : null,
    resumo: {
      tomadorNome: toma?.razaoSocial ?? null,
      tomadorDoc: toma?.cnpj ?? toma?.cpf ?? null,
      competencia: d.documento.dCompet ?? null,
      valorServico: valores?.vServ ?? null,
      codigoTributacaoNacional: serv?.cTribNac ?? null,
      descricaoServico: serv?.xDescServ ?? null,
      municipioIncidencia: autorizada ? serv?.cLocPrestacao ?? null : null,
      nomeMunicipioIncidencia: autorizada ? 'CURITIBA' : null,
      descricaoTributacaoNacional: autorizada ? 'Serviço de tecnologia da informação' : null,
      valorIssqn: autorizada ? Math.round(valores.vServ * 2) / 100 : null,
      valorRetido: autorizada ? 0 : null,
      valorLiquido: autorizada ? valores.vServ : null,
    },
  };
}

/** O aceite de uma operação: o `id` é do comando NOVO; `links.nota` aponta a nota. */
const aceiteOperacao = (o: OperacaoFalsa, self: string, nota?: string) => ({ id: o.id, status: o.status, links: { self, ...(nota ? { nota } : { events: '/v1/nfe/events?since=0' }) } });

/** A representação completa de uma inutilização resolvida no `wait`. */
const representacaoOperacao = (o: OperacaoFalsa) => ({
  id: o.id,
  status: o.status,
  outcome: o.outcome,
  modelo: o.corpo.modelo,
  serie: o.corpo.serie,
  numero: null,
  result: o.outcome === 'authorized' ? { protocolo: o.protocolo } : { motivo: o.motivo },
  attempts: 1,
  retentativa: null,
  criadoEm: o.criadaEm,
  atualizadoEm: new Date().toISOString(),
});
