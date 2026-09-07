// Uma API do Flex DFe de mentira, em processo, para os testes dirigirem a tela sem credencial
// nem SEFAZ. Responde os contratos do OpenAPI publicado (tag v0.1.0) só no que este exemplo
// consome: os dois envelopes de erro, os escopos, o secret que aparece uma vez.
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
  criadoEm: string;
};

export type EventoFalso = { seq: number; commandId: string; type: string; status: string; outcome: 'authorized' | 'rejected' | null; criadoEm: string };

type RespostaFalsa = { status: number; tipo: string; corpo: unknown; texto?: string; disposicao?: string };

export class ApiFalsa {
  readonly servidor: Server;
  readonly requisicoes: Requisicao[] = [];
  readonly credenciais: Cred[] = [{ clientId: 'gestao', secret: 'segredo-gestao', escopo: 'integrador' }];
  readonly emitentes = new Map<string, Record<string, unknown>>();
  readonly series: { emitenteId: string; modelo: number; serie: number; nextNumber: number }[] = [];
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
      c.situacao = desfecho === 'blocked' ? 'bloqueada' : 'pendente';
      c.result = { motivo: desfecho === 'failed' ? 'PIS_COFINS_AUSENTE em /det[1]/imposto/PIS' : 'número tomado por outra chave na SEFAZ', ...(desfecho === 'failed' ? { situacao: 'inexistente', origem: 'local' } : {}) };
    }
    return this.publicar(commandId, 'nfe.emit', c.status, c.outcome);
  }

  /** Cancela uma nota autorizada: a situação muda, e o feed ganha um `nfe.cancel` de OUTRO comando. */
  cancelar(commandId: string): EventoFalso {
    const c = this.comandos.get(commandId)!;
    c.situacao = 'cancelada';
    c.canceladaEm = new Date().toISOString();
    return this.publicar(randomUUID(), 'nfe.cancel', 'completed', 'authorized');
  }

  constructor() {
    this.servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (p: Buffer) => partes.push(p));
      req.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        const corpo = texto ? JSON.parse(texto) : undefined;
        const r = this.tratar(req.method ?? 'GET', req.url ?? '/', req.headers, corpo);
        res.writeHead(r.status, { 'Content-Type': r.tipo, ...(r.disposicao ? { 'Content-Disposition': r.disposicao } : {}) });
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

    // Envelope de autenticação: { erro }, application/json, sem type.
    if (!cred) return json(401, { erro: 'credencial inválida' });

    const problema = (status: number, type: string, detail?: string) =>
      ({ status, tipo: 'application/problem+json', corpo: { type, title: type, status, detail, instance: caminho } });

    const partes = caminho.split('?')[0].split('/').filter(Boolean); // ['v1','emitentes',id,...]

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
      const minhas = this.series.filter((s) => s.emitenteId === cred.emitenteId);
      if (metodo === 'GET') return json(200, { series: minhas.map((s) => ({ modelo: s.modelo, serie: s.serie, mode: 'managed', active: true, nextNumber: s.nextNumber })) });
      if (metodo === 'POST') {
        const c = corpo as { modelo?: number; serie?: number; mode?: string; nextNumber?: number };
        if (![55, 65].includes(c.modelo!) || !Number.isInteger(c.serie) || !['managed', 'external'].includes(c.mode!)) return problema(422, 'invalid-request-body');
        if (minhas.some((s) => s.modelo === c.modelo && s.serie === c.serie)) return problema(409, 'series-already-exists');
        const s = { emitenteId: cred.emitenteId!, modelo: c.modelo!, serie: c.serie!, nextNumber: c.nextNumber ?? 1 };
        this.series.push(s);
        return json(201, { modelo: s.modelo, serie: s.serie, mode: c.mode, active: true, nextNumber: s.nextNumber });
      }
    }

    // ---- Emissão e acompanhamento: escopo de emitente. ----
    if (partes[1] === 'nfe') {
      if (cred.escopo !== 'emitente') return problema(403, 'emitente-scope-required');
      const query = new URLSearchParams(caminho.split('?')[1] ?? '');

      if (metodo === 'POST' && partes.length === 2) {
        if (!cabecalhos['idempotency-key']) return problema(422, 'idempotency-key-required', 'informe o header Idempotency-Key');
        const chave = String(cabecalhos['idempotency-key']);
        const c = corpo as { modelo?: number; serie?: number; numero?: number; documento?: unknown };
        if (![55, 65].includes(c.modelo!) || !Number.isInteger(c.serie) || typeof c.documento !== 'object') return problema(422, 'invalid-request-body', 'modelo deve ser 55 (NF-e) ou 65 (NFC-e)');
        const impressao = canonico(corpo);
        const vista = this.chaves.get(chave);
        if (vista) {
          if (vista.impressao !== impressao) return problema(422, 'idempotency-key-conflict', 'mesma Idempotency-Key com corpo diferente');
          const replay = this.comandos.get(vista.id)!;
          return json(ehTerminal(replay.status) ? 200 : 202, aceite(replay));
        }
        const serie = this.series.find((s) => s.emitenteId === cred.emitenteId && s.modelo === c.modelo && s.serie === c.serie);
        if (!serie) return problema(404, 'series-not-provisioned', `série modelo=${c.modelo} serie=${c.serie} não provisionada`);
        if (c.numero !== undefined) return problema(422, 'number-not-allowed-managed', 'série managed: a plataforma aloca o número; não informe numero');
        const numero = serie.nextNumber++;
        const emitente = this.emitentes.get(cred.emitenteId!)!;
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
          criadoEm: new Date().toISOString(),
        };
        this.comandos.set(novo.id, novo);
        this.chaves.set(chave, { impressao, id: novo.id });
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
      if (metodo === 'GET' && !sub) return json(200, { ...representacao(comando), situacao: comando.situacao, resumo: null, chave: comando.chave, protocolo: comando.result?.protocolo ?? null, recebidaEm: comando.criadoEm, autorizadaEm: null, canceladaEm: comando.canceladaEm, protocoloCancelamento: null, justificativaCancelamento: null, correcaoVigente: null });
      if (metodo === 'GET' && sub === 'xml') {
        if (comando.situacao !== 'autorizada') return problema(409, 'nfe-xml-unavailable', 'a nota ainda não foi autorizada; não há XML para baixar');
        return { status: 200, tipo: 'application/xml', corpo: undefined, texto: `<nfeProc><NFe><infNFe Id="NFe${comando.chave}"/></NFe></nfeProc>`, disposicao: `attachment; filename="${comando.chave}.xml"` };
      }
      if (metodo === 'GET' && sub === 'danfe') {
        if (!['autorizada', 'cancelada'].includes(comando.situacao)) return problema(409, 'nfe-danfe-unavailable', 'não há XML assinado desta nota para gerar o DANFE');
        return { status: 200, tipo: 'application/pdf', corpo: undefined, texto: `%PDF-1.4 DANFE ${comando.chave} ${comando.situacao}`, disposicao: `inline; filename="${comando.chave}.pdf"` };
      }
    }

    return problema(404, 'not-found', `a API falsa não conhece ${metodo} ${caminho}`);
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
