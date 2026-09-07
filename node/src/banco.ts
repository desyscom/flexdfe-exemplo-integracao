// O banco local. SQLite pelo módulo nativo do Node: nada para compilar, nada para instalar.
//
// Guarda o que a aplicação aprende conversando com a API e o que ela precisa lembrar entre
// uma requisição e outra. Nada aqui é fonte de verdade sobre a nota: a API é. O status local
// existe para a tela, e é o feed de eventos que o mantém honesto.

import { DatabaseSync } from 'node:sqlite';

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
    `);
  }

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

  fechar(): void {
    this.db.close();
  }
}
