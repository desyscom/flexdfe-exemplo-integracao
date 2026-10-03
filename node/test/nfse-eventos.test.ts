// O desfecho da NFS-e chega pelo feed da família (`GET /v1/nfse/events`) e pelo webhook, que é um só e leva as duas.
// A NF-e e a NFS-e dividem a numeração do `seq`, e cada feed tem o seu cursor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ateSeries, ateSerieDps, pedido55, pedidoNfse, subir, type Cenario } from './apoio.ts';

/** Emite uma NFS-e com a emissão assíncrona, e devolve a linha local. */
async function emitirPendente(c: Cenario) {
  c.api.modoEmissao = 'assincrono';
  await c.post('/nova-nfse/emitir', pedidoNfse());
  return c.banco.listarNfses()[0];
}

test('DPS que estoura o wait fica processando e é fechada pelo feed da NFS-e, sem intervenção', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    c.api.modoEmissao = 'assincrono';
    const r = await c.post('/nova-nfse/emitir', pedidoNfse());
    assert.match(r.html, /HTTP 202: aceite, comando .* está pending/);
    assert.match(r.html, /O wait estourou/);

    const [nfse] = c.banco.listarNfses();
    assert.equal(nfse.status, 'pending');
    assert.equal(nfse.numeroNfse, null, 'a resposta da emissão só gravou id e status');
    assert.match((await c.get('/nfse')).html, /<b>processando<\/b>/);

    // Nada novo ainda: o cursor não anda. E o feed da NF-e não vê a DPS: é outra família.
    let feed = await c.post('/eventos/puxar-nfse');
    assert.match(feed.html, /Feed da NFS-e lido: 0 evento/);
    assert.equal(c.banco.configuracao().cursorFeedNfse, 0);

    // A plataforma conclui; o feed fecha a NFS-e, e a leitura dela traz o número, a chave e a situação.
    const evento = c.api.concluirDps(nfse.commandId!, 'authorized');
    assert.match((await c.post('/eventos/puxar')).html, /Feed lido: 0 evento/, 'o feed da NF-e só tem nfe.*');
    assert.equal(c.banco.configuracao().cursorFeed, 0);

    feed = await c.post('/eventos/puxar-nfse');
    assert.match(feed.html, /Feed da NFS-e lido: 1 evento/);
    assert.match(feed.texto, new RegExp(`seq ${evento.seq} · nfse.emit completed/authorized → aplicado: NFS-e ${nfse.id} autorizada`));
    const fechada = c.banco.lerNfse(nfse.id)!;
    assert.equal(fechada.situacao, 'autorizada');
    assert.equal(fechada.numeroDps, 1);
    assert.equal(fechada.numeroNfse, 1);
    assert.equal(fechada.chave?.length, 50);
    assert.equal(fechada.confirmadoPor, 'feed');
    assert.equal(c.banco.configuracao().cursorFeedNfse, evento.seq);
    assert.equal(c.banco.configuracao().cursorFeed, 0, 'o cursor da NF-e não andou');
    // A leitura da NFS-e aconteceu pelo feed, com a credencial operacional.
    const leitura = c.api.requisicoes.find((q) => q.metodo === 'GET' && q.caminho === `/v1/nfse/${nfse.commandId}`)!;
    assert.equal(leitura.clientId, c.banco.configuracao().credencialClientId);

    assert.match((await c.get('/nfse')).html, /<b>autorizada<\/b>/);
    assert.match((await c.get('/eventos')).html, new RegExp(`<td>${evento.seq}</td><td>nfse.emit</td><td>completed</td><td>authorized</td>.*<td><b>feed</b></td>`));
  } finally {
    await c.encerrar();
  }
});

test('as duas famílias dividem o seq, e cada feed tem o seu cursor: reler de um cursor antigo não duplica', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    await c.post('/emitente/serie', { documento: 'dps', serie: '1' });
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nota/emitir', pedido55(c));
    await c.post('/nova-nfse/emitir', pedidoNfse());
    const [nota] = c.banco.listarNotas();
    const [nfse] = c.banco.listarNfses();

    // A NFS-e conclui primeiro, e fica com o seq menor. É a ordem que um cursor só perderia: o da NF-e passa dela.
    const eventoNfse = c.api.concluirDps(nfse.commandId!, 'authorized');
    const eventoNfe = c.api.concluir(nota.commandId!, 'authorized');
    assert.ok(eventoNfse.seq < eventoNfe.seq, 'a numeração é uma só: a NFS-e concluiu antes');

    // Cada feed entrega só a sua família, e o seq do outro vira um buraco na numeração dele.
    const feedNfe = await c.post('/eventos/puxar');
    assert.match(feedNfe.html, /Feed lido: 1 evento/);
    assert.equal(c.banco.configuracao().cursorFeed, eventoNfe.seq);
    assert.equal(c.banco.configuracao().cursorFeedNfse, 0, 'ler o feed da NF-e não move o cursor da NFS-e');
    // O cursor da NF-e já passou do seq da NFS-e, e a NFS-e aparece mesmo assim: o feed dela lê do cursor dela.
    const feedNfse = await c.post('/eventos/puxar-nfse');
    assert.match(feedNfse.html, /Feed da NFS-e lido: 1 evento/);
    assert.equal(c.banco.configuracao().cursorFeedNfse, eventoNfse.seq);
    assert.equal(c.banco.configuracao().cursorFeed, eventoNfe.seq, 'e o da NF-e fica onde estava');
    assert.deepEqual(c.banco.listarEventos().map((e) => e.seq).sort((a, b) => a - b), [eventoNfse.seq, eventoNfe.seq], 'o seq é único entre as famílias: uma tabela de eventos basta');

    // Como se o processo tivesse caído antes de gravar o cursor: a releitura repete a página, e o seq já visto não tem efeito.
    c.banco.gravarCursorFeedNfse(0);
    const releitura = await c.post('/eventos/puxar-nfse');
    assert.match(releitura.texto, /repetido: já aplicado, sem efeito/);
    assert.equal(c.banco.listarEventos().length, 2);
    assert.equal(c.banco.configuracao().cursorFeedNfse, eventoNfse.seq);
  } finally {
    await c.encerrar();
  }
});

test('rejeitada, falha e bloqueio: o feed fecha com o motivo, e a tela distingue pelo status', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    for (const [desfecho, situacao, motivo] of [
      ['rejected', 'rejeitada', /E0116/],
      ['failed', 'falhou', /IM_AUSENTE em \/prest\/IM/],
      ['blocked', 'bloqueada', /a série está inativa/],
    ] as const) {
      const nfse = await emitirPendente(c);
      c.api.concluirDps(nfse.commandId!, desfecho);
      await c.post('/eventos/puxar-nfse');
      const fechada = c.banco.lerNfse(nfse.id)!;
      assert.equal(fechada.confirmadoPor, 'feed', desfecho);
      const lista = await c.get('/nfse');
      assert.match(lista.html, new RegExp(`<b>${situacao}</b>`), desfecho);
      assert.match(lista.texto, motivo, desfecho);
      assert.match((await c.get(`/nfse/${nfse.id}`)).texto, motivo, desfecho);
    }
    // A rejeitada tem desfecho e não tem NFS-e: não há número nem chave para mostrar.
    const [bloqueada, falhada, rejeitada] = c.banco.listarNfses();
    assert.equal(rejeitada.numeroNfse, null);
    assert.equal(rejeitada.chave, null);
    assert.equal(falhada.outcome, null);
    assert.equal(bloqueada.outcome, null);
  } finally {
    await c.encerrar();
  }
});

test('o feed da NFS-e exige a credencial operacional', async () => {
  const c = await subir();
  try {
    assert.match((await c.post('/eventos/puxar-nfse')).texto, /O feed exige a credencial operacional/);
    assert.equal(c.api.requisicoes.filter((r) => r.caminho.startsWith('/v1/nfse/events')).length, 0);
  } finally {
    await c.encerrar();
  }
});
