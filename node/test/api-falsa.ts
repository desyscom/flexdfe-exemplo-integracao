// Uma API do Flex DFe de mentira, em processo, para os testes dirigirem a tela sem credencial
// nem SEFAZ. Responde os contratos do OpenAPI publicado (tag v0.3.1) só no que este exemplo
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
  tipo: 'nfe.cancel' | 'nfe.cce' | 'nfe.inutiliza';
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

export type EventoFalso = { seq: number; commandId: string; type: string; status: string; outcome: 'authorized' | 'rejected' | null; criadoEm: string };

type RespostaFalsa = { status: number; tipo: string; corpo: unknown; texto?: string; disposicao?: string; cabecalhos?: Record<string, string> };

const PATTERN_TEXTO_SEFAZ = /^(?:[!-ÿ][ -ÿ]*[!-ÿ]|[!-ÿ])$/;

export class ApiFalsa {
  readonly servidor: Server;
  readonly requisicoes: Requisicao[] = [];
  readonly credenciais: Cred[] = [{ clientId: 'gestao', secret: 'segredo-gestao', escopo: 'integrador' }];
  readonly emitentes = new Map<string, Record<string, unknown>>();
  /** A série é por ambiente: a chave é emitente + ambiente + modelo + série. */
  readonly series: { emitenteId: string; ambiente: string; modelo: number; serie: number; nextNumber: number }[] = [];
  readonly webhooks = new Map<string, { url: string; ativo: boolean; secret: string }>();
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
   * Cancela a nota POR FORA da plataforma (outro sistema, o portal da SEFAZ). A plataforma não fica sabendo:
   * `GET /v1/nfe/{id}` segue dizendo `autorizada` até uma consulta reconciliar. Sem evento no feed.
   */
  cancelarPorFora(commandId: string): void {
    this.comandos.get(commandId)!.verdadeSefaz = 'cancelada';
  }

  /** Fecha uma operação pendente com o desfecho dado, aplica o efeito na nota e publica no feed. */
  concluirOperacao(operacaoId: string, desfecho: 'authorized' | 'rejected' | 'failed'): EventoFalso {
    const o = this.operacoes.get(operacaoId)!;
    const nota = o.notaId ? this.comandos.get(o.notaId)! : null;
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
        o.protocolo = '135' + String(this.operacoes.size).padStart(12, '0');
        if (o.tipo === 'nfe.cancel' && nota) {
          nota.situacao = 'cancelada';
          nota.canceladaEm = o.concluidaEm;
          nota.protocoloCancelamento = o.protocolo;
          nota.justificativaCancelamento = String(o.corpo.justificativa);
        }
      } else {
        o.situacao = 'rejeitada';
        o.motivo = o.tipo === 'nfe.inutiliza' ? '563 Rejeicao: Numero inicial da faixa maior que o final' : o.tipo === 'nfe.cancel' ? '501 Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao' : '594 Rejeicao: O numero do evento nao e compativel';
      }
    }
    return this.publicar(o.id, o.tipo, o.status, o.outcome);
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
    this.requisicoes.push({ metodo, caminho, clientId: cred?.clientId ?? null, corpo, cabecalhos });

    // A borda vem antes de tudo: 429 sem envelope, com Retry-After, antes mesmo de autenticar.
    if (this.limitar.vezes > 0 && (!this.limitar.caminho || this.limitar.caminho.test(caminho))) {
      this.limitar.vezes--;
      return { status: 429, tipo: 'text/plain', corpo: undefined, texto: 'Too Many Requests', cabecalhos: this.limitar.retryAfter === null ? {} : { 'Retry-After': this.limitar.retryAfter } };
    }

    // Envelope de autenticação: { erro }, application/json, sem type.
    if (!cred) return json(401, { erro: 'credencial inválida' });

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
      return json(200, { escopo: 'emitente', emitente: { id: e.id, cnpj: e.cnpj, razao_social: e.razao_social, ambiente: e.ambiente } });
    }

    if (partes[1] === 'emitentes') {
      if (metodo === 'POST' && partes.length === 2) {
        if (cred.escopo !== 'integrador') return problema(403, 'integrador-scope-required');
        const c = corpo as Record<string, unknown>;
        for (const campo of ['cnpj', 'razao_social', 'inscricao_estadual', 'crt', 'ambiente', 'logradouro', 'numero', 'bairro', 'cod_municipio', 'municipio', 'uf', 'cep'])
          if (c[campo] === undefined || c[campo] === '') return problema(422, 'invalid-request-body', `campo ${campo} obrigatório`);
        if ([...this.emitentes.values()].some((e) => e.cnpj === c.cnpj)) return problema(409, 'emitente-cnpj-already-exists');
        const e = { id: randomUUID(), ...c, nome_fantasia: c.nome_fantasia ?? null, ativo: false, modelos: [], certificado: null, webhook: null, contingencia: [], suspenso_em: null, suspensao_motivo: null };
        this.emitentes.set(e.id, e);
        return json(201, e);
      }
      const e = this.emitentes.get(partes[2]);
      if (!e) return problema(404, 'emitente-not-found');
      const sub = partes[3];

      if (metodo === 'GET' && !sub) return json(200, this.comWebhook(e));
      if (metodo === 'PATCH' && !sub) {
        if (cred.escopo !== 'integrador') return problema(403, 'integrador-scope-required');
        const c = corpo as Record<string, unknown>;
        if (c.ativo === true && !e.certificado) return problema(409, 'certificate-required-to-activate');
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
        return json(200, { ambiente: atual, series: doAmbiente.map((s) => ({ ambiente: s.ambiente, modelo: s.modelo, serie: s.serie, mode: 'managed', active: true, nextNumber: s.nextNumber })) });
      }
      if (metodo === 'POST') {
        const c = corpo as { modelo?: number; serie?: number; mode?: string; nextNumber?: number };
        if (![55, 65].includes(c.modelo!) || !Number.isInteger(c.serie) || !['managed', 'external'].includes(c.mode!)) return problema(422, 'invalid-request-body');
        if (this.series.some((s) => s.emitenteId === cred.emitenteId && s.ambiente === atual && s.modelo === c.modelo && s.serie === c.serie)) return problema(409, 'series-already-exists');
        const s = { emitenteId: cred.emitenteId!, ambiente: atual, modelo: c.modelo!, serie: c.serie!, nextNumber: c.nextNumber ?? 1 };
        this.series.push(s);
        return json(201, { ambiente: s.ambiente, modelo: s.modelo, serie: s.serie, mode: c.mode, active: true, nextNumber: s.nextNumber });
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

      if (metodo === 'GET' && partes[2] === 'events') {
        const since = Number(query.get('since') ?? 0);
        const limit = Math.min(Number(query.get('limit') ?? 100), 1000);
        const events = this.feed.filter((e) => e.seq > since).slice(0, limit);
        return json(200, { events, nextCursor: events.length ? events[events.length - 1].seq : since });
      }

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

  private comWebhook(e: Record<string, unknown>) {
    const w = this.webhooks.get(e.id as string);
    return { ...e, webhook: w ? { url: w.url, ativo: w.ativo } : null };
  }

  private autenticar(auth: string | undefined): Cred | null {
    if (!auth?.startsWith('Basic ')) return null;
    const [clientId, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
    return this.credenciais.find((c) => c.clientId === clientId && c.secret === secret) ?? null;
  }
}

const json = (status: number, corpo: unknown): RespostaFalsa => ({ status, tipo: 'application/json', corpo });

const ehTerminal = (status: string): boolean => ['completed', 'failed', 'blocked'].includes(status);

/** Impressão do corpo com as chaves ordenadas: reordenar chaves não muda a identidade; mudar conteúdo muda. */
function canonico(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canonico((v as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(v);
}

const aceite = (c: Comando) => ({ id: c.id, status: c.status, links: { self: `/v1/nfe/${c.id}`, events: '/v1/nfe/events?since=0' } });

const representacao = (c: Comando) => ({ id: c.id, status: c.status, outcome: c.outcome, modelo: c.modelo, serie: c.serie, numero: c.numero, result: c.result, attempts: 1, retentativa: null, criadoEm: c.criadoEm, atualizadoEm: new Date().toISOString() });

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
