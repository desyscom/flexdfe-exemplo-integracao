// O banco local. SQLite pelo módulo nativo do Node: nada para compilar, nada para instalar.
//
// Guarda o que a aplicação aprende conversando com a API e o que ela precisa lembrar entre
// uma requisição e outra. Nada aqui é fonte de verdade sobre a nota: a API é. O status local
// existe para a tela, e é o feed de eventos que o mantém honesto.
//
// Tabelas:
//   configuracao   uma linha: emitente, credencial operacional, segredo do webhook, cursor do feed
//   produto        cadastro local mínimo, semeado nas duas variantes tributárias
//   destinatario   cadastro local mínimo, semeado com o destinatário de homologação
//   nota           uma linha por emissão: a Idempotency-Key e o corpo enviado ficam gravados ANTES
//                  da chamada; o desfecho chega pelo feed ou pelo webhook
//   evento         o histórico bruto do que o feed e o webhook entregaram, com a origem de cada um

import { DatabaseSync } from 'node:sqlite';
import type { Credencial } from './config.ts';

export type Configuracao = {
  /** O `id` que a API devolveu ao cadastrar o emitente. */
  emitenteId: string | null;
  /** Credencial OPERACIONAL (escopo de emitente), cunhada pela aplicação. É ela que emite. */
  credencialClientId: string | null;
  credencialSecret: string | null;
  /** Segredo que assina cada entrega do webhook. Aparece uma vez, ao criar ou rotacionar. */
  webhookSecret: string | null;
  /** Último `seq` do feed já aplicado. O feed é exclusivo: pede-se `since` igual a ele. */
  cursorFeed: number;
};

/**
 * Um produto local, tributado nas DUAS variantes. Qual delas vai para a nota é decidido pelo CRT do
 * emitente na hora de montar o `documento`: Simples Nacional (CRT 1 e 4) usa `csosn`; Regime Normal e
 * Simples com excesso de sublimite (CRT 3 e 2) usam `cst` com o ICMS destacado em `aliquotaIcms`.
 */
export type Produto = {
  id: number;
  codigo: string;
  descricao: string;
  ncm: string;
  cfop: string;
  unidade: string;
  valorUnitario: number;
  /** Variante Simples Nacional. */
  csosn: string;
  /** Variante Regime Normal. */
  cst: string;
  aliquotaIcms: number;
};

export type Destinatario = {
  id: number;
  /** CNPJ ou CPF, só dígitos. */
  documento: string;
  nome: string;
  logradouro: string;
  numero: string;
  bairro: string;
  codMunicipio: string;
  municipio: string;
  uf: string;
  cep: string;
  /** `1` se veio do seed e ainda não foi editado. */
  semente: number;
};

export type Nota = {
  id: number;
  /** O `id` do comando, devolvido pela API. `null` enquanto a chamada não voltou. */
  commandId: string | null;
  modelo: 55 | 65;
  serie: number;
  numero: number | null;
  chave: string | null;
  protocolo: string | null;
  /** `status` do comando, como a API o chama: pending, processing, completed, failed, blocked. */
  status: string | null;
  outcome: string | null;
  /** A `situacao` de nível-nota lida da API (`GET /v1/nfe/{id}`), quando já foi lida. */
  situacao: string | null;
  /** Quem confirmou o desfecho: `feed` ou `webhook`. `null` enquanto só a resposta da emissão falou. */
  confirmadoPor: string | null;
  idempotencyKey: string;
  /** O corpo exato do `POST /v1/nfe`, para comparar com o que a Referência descreve. */
  corpoEnviado: string;
  /** O último corpo que a API devolveu sobre esta nota, tal como veio. */
  ultimoResultado: string | null;
  criadoEm: string;
};

export type Evento = {
  seq: number;
  commandId: string;
  type: string;
  status: string;
  outcome: string | null;
  origem: 'feed' | 'webhook';
  recebidoEm: string;
  /** O que a aplicação fez com ele: `aplicado`, `ignorado: tipo desconhecido`, `ignorado: nota não é deste banco`... */
  efeito: string;
};

export class Banco {
  readonly db: DatabaseSync;

  constructor(caminho: string) {
    this.db = new DatabaseSync(caminho);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS configuracao (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        emitente_id TEXT,
        credencial_client_id TEXT,
        credencial_secret TEXT,
        webhook_secret TEXT,
        cursor_feed INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO configuracao (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS produto (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT NOT NULL UNIQUE,
        descricao TEXT NOT NULL,
        ncm TEXT NOT NULL,
        cfop TEXT NOT NULL,
        unidade TEXT NOT NULL,
        valor_unitario REAL NOT NULL,
        csosn TEXT NOT NULL,
        cst TEXT NOT NULL,
        aliquota_icms REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS destinatario (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documento TEXT NOT NULL,
        nome TEXT NOT NULL,
        logradouro TEXT NOT NULL,
        numero TEXT NOT NULL,
        bairro TEXT NOT NULL,
        cod_municipio TEXT NOT NULL,
        municipio TEXT NOT NULL,
        uf TEXT NOT NULL,
        cep TEXT NOT NULL,
        semente INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS nota (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT UNIQUE,
        modelo INTEGER NOT NULL,
        serie INTEGER NOT NULL,
        numero INTEGER,
        chave TEXT,
        protocolo TEXT,
        status TEXT,
        outcome TEXT,
        situacao TEXT,
        confirmado_por TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        corpo_enviado TEXT NOT NULL,
        ultimo_resultado TEXT,
        criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS evento (
        seq INTEGER PRIMARY KEY,
        command_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        origem TEXT NOT NULL,
        recebido_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        efeito TEXT NOT NULL
      );
    `);
    this.semear();
  }

  // ---------------------------------------------------------------- seed

  /**
   * Dados de exemplo, só na primeira execução. Códigos, NCMs e alíquotas são plausíveis, não uma
   * recomendação: a classificação fiscal de cada item é sua, e é o que o seu contador define.
   * O destinatário leva o nome que a SEFAZ exige em homologação; o endereço é alinhado ao do emitente
   * quando ele é cadastrado (venda interna: interestadual a consumidor final pede o DIFAL, fora deste exemplo).
   */
  private semear(): void {
    if (this.contar('produto') === 0) {
      const inserir = this.db.prepare(
        'INSERT INTO produto (codigo, descricao, ncm, cfop, unidade, valor_unitario, csosn, cst, aliquota_icms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      // csosn 102: tributada pelo Simples sem crédito. cst 00: tributação integral, ICMS destacado.
      inserir.run('P001', 'CANETA ESFEROGRAFICA AZUL', '96081000', '5102', 'UN', 2.5, '102', '00', 18);
      inserir.run('P002', 'CADERNO 96 FOLHAS', '48201000', '5102', 'UN', 12.9, '102', '00', 18);
      inserir.run('P003', 'MOCHILA ESCOLAR', '42029200', '5102', 'UN', 89.9, '102', '00', 18);
    }
    if (this.contar('destinatario') === 0) {
      this.db
        .prepare(
          'INSERT INTO destinatario (documento, nome, logradouro, numero, bairro, cod_municipio, municipio, uf, cep, semente) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        )
        .run('11444777000161', NOME_DESTINATARIO_HOMOLOGACAO, 'AV DO CLIENTE', '200', 'CENTRO', '3550308', 'SAO PAULO', 'SP', '01310000');
    }
  }

  private contar(tabela: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get() as { n: number }).n);
  }

  // ---------------------------------------------------------------- configuracao

  configuracao(): Configuracao {
    const linha = this.db.prepare('SELECT * FROM configuracao WHERE id = 1').get() as Record<string, unknown>;
    return {
      emitenteId: (linha.emitente_id as string | null) ?? null,
      credencialClientId: (linha.credencial_client_id as string | null) ?? null,
      credencialSecret: (linha.credencial_secret as string | null) ?? null,
      webhookSecret: (linha.webhook_secret as string | null) ?? null,
      cursorFeed: Number(linha.cursor_feed),
    };
  }

  /** A credencial que emite, ou `null` enquanto a tela Emitente não a cunhou. */
  credencialOperacional(): Credencial | null {
    const cfg = this.configuracao();
    return cfg.credencialClientId && cfg.credencialSecret ? { clientId: cfg.credencialClientId, secret: cfg.credencialSecret } : null;
  }

  gravarEmitenteId(id: string): void {
    this.db.prepare('UPDATE configuracao SET emitente_id = ? WHERE id = 1').run(id);
  }

  gravarCredencialOperacional(clientId: string, secret: string): void {
    this.db
      .prepare('UPDATE configuracao SET credencial_client_id = ?, credencial_secret = ? WHERE id = 1')
      .run(clientId, secret);
  }

  gravarWebhookSecret(secret: string): void {
    this.db.prepare('UPDATE configuracao SET webhook_secret = ? WHERE id = 1').run(secret);
  }

  /** Grava o cursor. Chame DEPOIS de aplicar os eventos da página: é isso que torna a leitura reentrante. */
  gravarCursorFeed(cursor: number): void {
    this.db.prepare('UPDATE configuracao SET cursor_feed = ? WHERE id = 1').run(cursor);
  }

  // ---------------------------------------------------------------- produto

  listarProdutos(): Produto[] {
    return (this.db.prepare('SELECT * FROM produto ORDER BY codigo').all() as Record<string, unknown>[]).map(produtoDaLinha);
  }

  lerProduto(id: number): Produto | null {
    const l = this.db.prepare('SELECT * FROM produto WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return l ? produtoDaLinha(l) : null;
  }

  criarProduto(p: Omit<Produto, 'id'>): void {
    this.db
      .prepare('INSERT INTO produto (codigo, descricao, ncm, cfop, unidade, valor_unitario, csosn, cst, aliquota_icms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.codigo, p.descricao, p.ncm, p.cfop, p.unidade, p.valorUnitario, p.csosn, p.cst, p.aliquotaIcms);
  }

  apagarProduto(id: number): void {
    this.db.prepare('DELETE FROM produto WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------- destinatario

  listarDestinatarios(): Destinatario[] {
    return (this.db.prepare('SELECT * FROM destinatario ORDER BY id').all() as Record<string, unknown>[]).map(destinatarioDaLinha);
  }

  lerDestinatario(id: number): Destinatario | null {
    const l = this.db.prepare('SELECT * FROM destinatario WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return l ? destinatarioDaLinha(l) : null;
  }

  criarDestinatario(d: Omit<Destinatario, 'id' | 'semente'>): void {
    this.db
      .prepare('INSERT INTO destinatario (documento, nome, logradouro, numero, bairro, cod_municipio, municipio, uf, cep) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.documento, d.nome, d.logradouro, d.numero, d.bairro, d.codMunicipio, d.municipio, d.uf, d.cep);
  }

  apagarDestinatario(id: number): void {
    this.db.prepare('DELETE FROM destinatario WHERE id = ?').run(id);
  }

  /** Move o destinatário semeado para o município do emitente, para a primeira nota ser uma venda interna. */
  alinharDestinatarioSemente(endereco: { codMunicipio: string; municipio: string; uf: string }): void {
    this.db
      .prepare('UPDATE destinatario SET cod_municipio = ?, municipio = ?, uf = ? WHERE semente = 1')
      .run(endereco.codMunicipio, endereco.municipio, endereco.uf);
  }

  // ---------------------------------------------------------------- nota

  listarNotas(): Nota[] {
    return (this.db.prepare('SELECT * FROM nota ORDER BY id DESC').all() as Record<string, unknown>[]).map(notaDaLinha);
  }

  lerNota(id: number): Nota | null {
    const l = this.db.prepare('SELECT * FROM nota WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return l ? notaDaLinha(l) : null;
  }

  lerNotaPorComando(commandId: string): Nota | null {
    const l = this.db.prepare('SELECT * FROM nota WHERE command_id = ?').get(commandId) as Record<string, unknown> | undefined;
    return l ? notaDaLinha(l) : null;
  }

  /** A nota nasce aqui, ANTES do `POST /v1/nfe`: com a chave e o corpo, sem `command_id`. */
  criarNotaPendente(n: { modelo: 55 | 65; serie: number; idempotencyKey: string; corpoEnviado: string }): number {
    const r = this.db
      .prepare('INSERT INTO nota (modelo, serie, idempotency_key, corpo_enviado) VALUES (?, ?, ?, ?)')
      .run(n.modelo, n.serie, n.idempotencyKey, n.corpoEnviado);
    return Number(r.lastInsertRowid);
  }

  /** O que a RESPOSTA da emissão pode gravar: o id do comando e o status inicial. */
  gravarAceite(id: number, commandId: string, status: string, ultimoResultado: string): void {
    this.db
      .prepare('UPDATE nota SET command_id = ?, status = ?, ultimo_resultado = ? WHERE id = ?')
      .run(commandId, status, ultimoResultado, id);
  }

  /** Um desfecho, venha do `wait`, do feed ou do webhook. `confirmadoPor` só é preenchido pelos dois últimos. */
  gravarDesfecho(
    id: number,
    d: {
      status: string;
      outcome: string | null;
      numero?: number | null;
      chave?: string | null;
      protocolo?: string | null;
      situacao?: string | null;
      confirmadoPor?: string | null;
      ultimoResultado?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE nota SET status = ?, outcome = ?,
           numero = COALESCE(?, numero), chave = COALESCE(?, chave), protocolo = COALESCE(?, protocolo),
           situacao = COALESCE(?, situacao), confirmado_por = COALESCE(?, confirmado_por),
           ultimo_resultado = COALESCE(?, ultimo_resultado)
         WHERE id = ?`,
      )
      .run(d.status, d.outcome, d.numero ?? null, d.chave ?? null, d.protocolo ?? null, d.situacao ?? null, d.confirmadoPor ?? null, d.ultimoResultado ?? null, id);
  }

  // ---------------------------------------------------------------- evento

  listarEventos(): Evento[] {
    return (this.db.prepare('SELECT * FROM evento ORDER BY seq DESC').all() as Record<string, unknown>[]).map(eventoDaLinha);
  }

  temEvento(seq: number): boolean {
    return this.db.prepare('SELECT 1 FROM evento WHERE seq = ?').get(seq) !== undefined;
  }

  gravarEvento(e: Omit<Evento, 'recebidoEm'>): void {
    this.db
      .prepare('INSERT INTO evento (seq, command_id, type, status, outcome, origem, efeito) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.seq, e.commandId, e.type, e.status, e.outcome, e.origem, e.efeito);
  }

  fechar(): void {
    this.db.close();
  }
}

/** O nome que a SEFAZ exige no destinatário de toda nota de homologação. */
export const NOME_DESTINATARIO_HOMOLOGACAO = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

const produtoDaLinha = (l: Record<string, unknown>): Produto => ({
  id: Number(l.id),
  codigo: String(l.codigo),
  descricao: String(l.descricao),
  ncm: String(l.ncm),
  cfop: String(l.cfop),
  unidade: String(l.unidade),
  valorUnitario: Number(l.valor_unitario),
  csosn: String(l.csosn),
  cst: String(l.cst),
  aliquotaIcms: Number(l.aliquota_icms),
});

const destinatarioDaLinha = (l: Record<string, unknown>): Destinatario => ({
  id: Number(l.id),
  documento: String(l.documento),
  nome: String(l.nome),
  logradouro: String(l.logradouro),
  numero: String(l.numero),
  bairro: String(l.bairro),
  codMunicipio: String(l.cod_municipio),
  municipio: String(l.municipio),
  uf: String(l.uf),
  cep: String(l.cep),
  semente: Number(l.semente),
});

const notaDaLinha = (l: Record<string, unknown>): Nota => ({
  id: Number(l.id),
  commandId: (l.command_id as string | null) ?? null,
  modelo: Number(l.modelo) as 55 | 65,
  serie: Number(l.serie),
  numero: l.numero == null ? null : Number(l.numero),
  chave: (l.chave as string | null) ?? null,
  protocolo: (l.protocolo as string | null) ?? null,
  status: (l.status as string | null) ?? null,
  outcome: (l.outcome as string | null) ?? null,
  situacao: (l.situacao as string | null) ?? null,
  confirmadoPor: (l.confirmado_por as string | null) ?? null,
  idempotencyKey: String(l.idempotency_key),
  corpoEnviado: String(l.corpo_enviado),
  ultimoResultado: (l.ultimo_resultado as string | null) ?? null,
  criadoEm: String(l.criado_em),
});

const eventoDaLinha = (l: Record<string, unknown>): Evento => ({
  seq: Number(l.seq),
  commandId: String(l.command_id),
  type: String(l.type),
  status: String(l.status),
  outcome: (l.outcome as string | null) ?? null,
  origem: l.origem as 'feed' | 'webhook',
  recebidoEm: String(l.recebido_em),
  efeito: String(l.efeito),
});
