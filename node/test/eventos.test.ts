import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ateSeries, pedido55, subir } from './apoio.ts';

test('NFC-e que estoura o wait fica processando e é fechada pela tela Eventos, sem intervenção', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    c.api.modoEmissao = 'assincrono';
    const r = await c.post('/nova-nota/emitir', pedido55(c, { modelo: '65', destinatario: '' }));
    assert.match(r.html, /HTTP 202: aceite, comando .* está pending/);
    assert.match(r.html, /O wait estourou/);

    const [nota] = c.banco.listarNotas();
    assert.equal(nota.status, 'pending');
    assert.equal(nota.numero, null, 'a resposta da emissão só gravou id e status');
    let tela = await c.get('/notas');
    assert.match(tela.html, /<b>processando<\/b>/);

    // Nada novo ainda: o cursor não anda.
    let feed = await c.post('/eventos/puxar');
    assert.match(feed.html, /Feed lido: 0 evento/);
    assert.equal(c.banco.configuracao().cursorFeed, 0);

    // A plataforma conclui; o feed fecha a nota, e a leitura da nota traz número e chave.
    const evento = c.api.concluir(nota.commandId!, 'authorized');
    feed = await c.post('/eventos/puxar');
    assert.match(feed.html, /Feed lido: 1 evento/);
    assert.match(feed.texto, new RegExp(`seq ${evento.seq} · nfe.emit completed/authorized → aplicado: nota ${nota.id} autorizada`));
    const fechada = c.banco.lerNota(nota.id)!;
    assert.equal(fechada.situacao, 'autorizada');
    assert.equal(fechada.numero, 1);
    assert.ok(fechada.chave);
    assert.equal(fechada.confirmadoPor, 'feed');
    assert.equal(c.banco.configuracao().cursorFeed, evento.seq);
    // A leitura da nota aconteceu pelo feed, com a credencial operacional.
    const leitura = c.api.requisicoes.find((q) => q.metodo === 'GET' && q.caminho === `/v1/nfe/${nota.commandId}`)!;
    assert.equal(leitura.clientId, c.banco.configuracao().credencialClientId);

    tela = await c.get('/notas');
    assert.match(tela.html, /<b>autorizada<\/b>/);
    tela = await c.get('/eventos');
    assert.match(tela.html, new RegExp(`<td>${evento.seq}</td><td>nfe.emit</td><td>completed</td><td>authorized</td>.*<td><b>feed</b></td>`));
  } finally {
    await c.encerrar();
  }
});

test('feed reentrante: reler de um cursor antigo não duplica, buracos no seq não atrapalham, cursor gravado por último', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nota/emitir', pedido55(c));
    await c.post('/nova-nota/emitir', pedido55(c, { modelo: '65', destinatario: '' }));
    const [b, a] = c.banco.listarNotas(); // a lista vem em ordem decrescente
    const e1 = c.api.concluir(a.commandId!, 'authorized');
    const e2 = c.api.concluir(b.commandId!, 'rejected');
    assert.equal(e2.seq - e1.seq, 2, 'a API falsa deixa buracos no seq');

    await c.post('/eventos/puxar');
    const pedidoFeed = c.api.requisicoes.filter((q) => q.caminho.startsWith('/v1/nfe/events'));
    assert.equal(pedidoFeed[0].caminho, '/v1/nfe/events?since=0&limit=100');
    assert.equal(c.banco.configuracao().cursorFeed, e2.seq);
    assert.equal(c.banco.listarEventos().length, 2);
    assert.equal(c.banco.lerNota(a.id)!.situacao, 'autorizada');
    assert.equal(c.banco.lerNota(b.id)!.situacao, 'rejeitada');

    // Volta o cursor a zero, como se o processo tivesse caído antes de gravá-lo.
    c.banco.gravarCursorFeed(0);
    const leiturasAntes = c.api.requisicoes.filter((q) => q.metodo === 'GET' && /^\/v1\/nfe\/[0-9a-f-]{36}$/.test(q.caminho)).length;
    const feed = await c.post('/eventos/puxar');
    assert.match(feed.html, /Feed lido: 2 evento/);
    assert.match(feed.texto, /repetido: já aplicado, sem efeito/);
    assert.equal(c.banco.listarEventos().length, 2, 'nenhum evento duplicado');
    assert.equal(c.api.requisicoes.filter((q) => q.metodo === 'GET' && /^\/v1\/nfe\/[0-9a-f-]{36}$/.test(q.caminho)).length, leiturasAntes, 'repetido não relê a nota');
    assert.equal(c.banco.configuracao().cursorFeed, e2.seq);

    // A próxima leitura parte do cursor: since exclusivo.
    await c.post('/eventos/puxar');
    assert.equal(c.api.requisicoes.at(-1)!.caminho, `/v1/nfe/events?since=${e2.seq}&limit=100`);
  } finally {
    await c.encerrar();
  }
});

test('tipo desconhecido é gravado e ignorado; tipo conhecido de outro comando também não muda nota nenhuma', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    await c.post('/nova-nota/emitir', pedido55(c));
    const [nota] = c.banco.listarNotas();
    await c.post('/eventos/puxar'); // confirma a autorização
    assert.equal(c.banco.lerNota(nota.id)!.situacao, 'autorizada');

    const desconhecido = c.api.publicar(nota.commandId!, 'nfe.novidade', 'completed', 'authorized');
    const cancel = c.api.publicar(nota.commandId!, 'nfe.cancel', 'completed', 'authorized'); // um cancelamento que NÃO passou por esta aplicação
    const feed = await c.post('/eventos/puxar');
    assert.match(feed.html, /Feed lido: 2 evento/);
    const eventos = c.banco.listarEventos();
    assert.equal(eventos.find((e) => e.seq === desconhecido.seq)!.efeito, 'ignorado: tipo nfe.novidade não é tratado por esta tela');
    assert.equal(eventos.find((e) => e.seq === cancel.seq)!.efeito, 'ignorado: comando não é de uma operação deste banco local');
    assert.equal(c.banco.configuracao().cursorFeed, cancel.seq, 'o cursor passou pelos ignorados');
    // A nota local segue autorizada: o nfe.cancel cita o comando do cancelamento, não a nota, e este não é nosso.
    assert.equal(c.banco.lerNota(nota.id)!.situacao, 'autorizada', 'os eventos ignorados não mexeram na nota');
  } finally {
    await c.encerrar();
  }
});

test('o feed exige a credencial operacional', async () => {
  const c = await subir();
  try {
    const r = await c.post('/eventos/puxar');
    assert.match(r.html, /O feed exige a credencial operacional/);
  } finally {
    await c.encerrar();
  }
});
