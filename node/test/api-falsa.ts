// Uma API do Flex DFe de mentira, em processo, para os testes dirigirem a tela sem credencial
// nem SEFAZ. Responde os contratos do OpenAPI publicado (tag v0.1.0) só no que este exemplo
// consome: os dois envelopes de erro, os escopos, o secret que aparece uma vez.
//
// Escrita à mão a partir da Referência. Se o contrato mudar, é aqui que a divergência aparece.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

type Cred = { clientId: string; secret: string; escopo: 'integrador' | 'emitente'; emitenteId?: string };

export type Requisicao = { metodo: string; caminho: string; clientId: string | null; corpo: unknown };

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

  constructor() {
    this.servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (p: Buffer) => partes.push(p));
      req.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        const corpo = texto ? JSON.parse(texto) : undefined;
        const r = this.tratar(req.method ?? 'GET', req.url ?? '/', req.headers.authorization, corpo);
        res.writeHead(r.status, { 'Content-Type': r.tipo });
        res.end(r.corpo === undefined ? '' : JSON.stringify(r.corpo));
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

  private tratar(metodo: string, caminho: string, auth: string | undefined, corpo: unknown) {
    const cred = this.autenticar(auth);
    this.requisicoes.push({ metodo, caminho, clientId: cred?.clientId ?? null, corpo });

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

const json = (status: number, corpo: unknown) => ({ status, tipo: 'application/json', corpo });
