import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ateSeries, pedido55, subir, type Cenario } from './apoio.ts';

/** Faz o que a plataforma faz: serializa uma vez, assina os mesmos bytes que viajam. */
async function entregar(c: Cenario, corpo: unknown, opcoes: { segredo?: string; assinatura?: string; bytes?: string } = {}) {
  const bytes = opcoes.bytes ?? JSON.stringify(corpo);
  const segredo = opcoes.segredo ?? c.banco.configuracao().webhookSecret!;
  const assinatura = opcoes.assinatura ?? 'sha256=' + createHmac('sha256', segredo).update(bytes).digest('hex');
  const r = await fetch(`${c.base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': assinatura }, body: bytes });
  return { status: r.status, texto: await r.text() };
}

test('webhook válido aplica o evento pelo mesmo caminho do feed; inválido é descartado; repetido não tem efeito', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nota/emitir', pedido55(c));
    const [nota] = c.banco.listarNotas();
    const evento = c.api.concluir(nota.commandId!, 'authorized');
    const push = { id: nota.commandId, type: 'nfe.emit', status: 'completed', outcome: 'authorized', seq: evento.seq };

    // Inválida: segredo errado, assinatura ausente, corpo alterado depois de assinado. Nada muda.
    assert.deepEqual(await entregar(c, push, { segredo: 'outro' }), { status: 401, texto: 'Assinatura inválida: descartado.' });
    assert.equal((await entregar(c, push, { assinatura: '' })).status, 401);
    assert.equal((await entregar(c, push, { assinatura: 'sha256=' + 'a'.repeat(64) })).status, 401);
    const assinada = JSON.stringify(push);
    const adulterada = assinada.replace('"authorized"', '"rejected"');
    const assinaturaOriginal = 'sha256=' + createHmac('sha256', c.banco.configuracao().webhookSecret!).update(assinada).digest('hex');
    assert.equal((await entregar(c, null, { bytes: adulterada, assinatura: assinaturaOriginal })).status, 401);
    assert.equal(c.banco.listarEventos().length, 0);
    assert.equal(c.banco.lerNota(nota.id)!.status, 'pending');

    // Válida: aplica, lê a nota, confirma por webhook.
    const ok = await entregar(c, push);
    assert.equal(ok.status, 200);
    assert.match(ok.texto, new RegExp(`aplicado: nota ${nota.id} autorizada`));
    const aplicada = c.banco.lerNota(nota.id)!;
    assert.equal(aplicada.situacao, 'autorizada');
    assert.equal(aplicada.confirmadoPor, 'webhook');
    assert.equal(aplicada.numero, 1);

    // Repetida: aceita (2xx, para a plataforma não retentar) e sem efeito.
    const repetida = await entregar(c, push);
    assert.equal(repetida.status, 200);
    assert.equal(repetida.texto, 'repetido: já aplicado, sem efeito');
    assert.equal(c.banco.listarEventos().length, 1);

    // As chaves em outra ordem são OUTROS bytes: a assinatura do corpo original não bate.
    const reordenado = JSON.stringify({ seq: push.seq, id: push.id, type: push.type, status: push.status, outcome: push.outcome });
    assert.equal((await entregar(c, null, { bytes: reordenado, assinatura: assinaturaOriginal })).status, 401);

    // A tela Eventos mostra a origem; o feed depois encontra o mesmo seq e não duplica.
    const tela = await c.get('/eventos');
    assert.match(tela.html, /<td><b>webhook<\/b><\/td>/);
    const feed = await c.post('/eventos/puxar');
    assert.match(feed.texto, /repetido: já aplicado, sem efeito/);
    assert.equal(c.banco.listarEventos().length, 1);
    assert.equal(c.banco.listarEventos()[0].origem, 'webhook');
  } finally {
    await c.encerrar();
  }
});

test('webhook sem segredo guardado é recusado, e corpo malformado é 400', async () => {
  const c = await subir();
  try {
    const semSegredo = await entregar(c, { id: 'x' }, { segredo: 'qualquer' });
    assert.equal(semSegredo.status, 401);
    assert.match(semSegredo.texto, /Sem segredo de webhook guardado/);

    await ateSeries(c);
    assert.equal((await entregar(c, null, { bytes: 'isso não é json' })).status, 400);
    assert.equal((await entregar(c, { id: 'x' })).status, 400);
  } finally {
    await c.encerrar();
  }
});
