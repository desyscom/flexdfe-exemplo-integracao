// O receptor de webhook. A plataforma faz `POST` na URL cadastrada a cada transição terminal
// (`completed`, `failed`, `blocked`), com o corpo `{ id, type, status, outcome, seq }` e o header
// `X-Signature: sha256=<hmac-sha256 hex>`.
//
// Três cuidados, e cada um tem um teste:
//   1. O HMAC é conferido sobre os BYTES CRUS recebidos, nunca sobre o JSON re-serializado: reordenar
//      chaves mudaria os bytes e a assinatura não bateria.
//   2. A comparação é em tempo constante (`timingSafeEqual`): `===` vaza por tempo de resposta.
//   3. Entrega repetida não tem efeito: o evento entra pelo mesmo `aplicarEvento` do feed, idempotente
//      por `seq`. O webhook é o aviso; o feed é a fonte de verdade.
//
// Responde 2xx quando aceitou (mesmo sem efeito) e 401 quando descartou. Fora de 2xx a plataforma
// retenta algumas vezes e desiste; o desfecho continua no feed.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Rota } from '../app.ts';
import { aplicarEvento } from '../eventos.ts';

export function assinaturaConfere(corpoCru: Buffer, assinaturaRecebida: string | undefined, segredo: string): boolean {
  const esperada = Buffer.from('sha256=' + createHmac('sha256', segredo).update(corpoCru).digest('hex'));
  const recebida = Buffer.from(assinaturaRecebida ?? '');
  return recebida.length === esperada.length && timingSafeEqual(recebida, esperada);
}

export const receptorWebhook: Rota = async ({ banco, cliente, corpoCru, cabecalhos }) => {
  const { webhookSecret } = banco.configuracao();
  const operacional = banco.credencialOperacional();
  if (!webhookSecret || !operacional) return { status: 401, texto: 'Sem segredo de webhook guardado: nada a conferir. Cadastre o webhook na tela Emitente.' };

  const assinatura = cabecalhos['x-signature'];
  if (!assinaturaConfere(corpoCru, typeof assinatura === 'string' ? assinatura : undefined, webhookSecret)) {
    return { status: 401, texto: 'Assinatura inválida: descartado.' };
  }

  let corpo: { id?: unknown; type?: unknown; status?: unknown; outcome?: unknown; seq?: unknown };
  try {
    corpo = JSON.parse(corpoCru.toString('utf8'));
  } catch {
    return { status: 400, texto: 'Corpo não é JSON.' };
  }
  if (typeof corpo.id !== 'string' || typeof corpo.type !== 'string' || typeof corpo.status !== 'string' || typeof corpo.seq !== 'number') {
    return { status: 400, texto: 'Corpo sem id, type, status ou seq.' };
  }

  const efeito = await aplicarEvento(
    { banco, cliente, operacional },
    { seq: corpo.seq, commandId: corpo.id, type: corpo.type, status: corpo.status, outcome: (corpo.outcome as 'authorized' | 'rejected' | null) ?? null, criadoEm: new Date().toISOString() },
    'webhook',
  );
  return { status: 200, texto: efeito };
};
