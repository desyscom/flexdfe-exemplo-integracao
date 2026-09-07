import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOME_DESTINATARIO_HOMOLOGACAO } from '../src/banco.ts';
import { ateSeries, EMITENTE_VALIDO, pedido55, subir, type Cenario } from './apoio.ts';

/** O último POST /v1/nfe que saiu. A tela faz outras leituras depois dele. */
const ultimoEnvio = (c: Cenario) => c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfe?')).at(-1)!;

test('o seed carrega na primeira execução: produtos nas duas variantes e o destinatário de homologação', async () => {
  const c = await subir();
  try {
    const produtos = c.banco.listarProdutos();
    assert.equal(produtos.length, 3);
    for (const p of produtos) {
      assert.match(p.csosn, /^\d{3}$/, 'variante Simples');
      assert.match(p.cst, /^\d{2}$/, 'variante Regime Normal');
      assert.ok(p.aliquotaIcms > 0);
    }
    const [dest] = c.banco.listarDestinatarios();
    assert.equal(dest.nome, NOME_DESTINATARIO_HOMOLOGACAO);
    assert.equal(dest.semente, 1);

    const tela = await c.get('/produtos');
    assert.match(tela.html, /P001/);
    assert.match(tela.html, /não uma recomendação/);

    // O cadastro do emitente move o destinatário semeado para o município dele.
    await c.post('/emitente/cadastrar', EMITENTE_VALIDO);
    const [alinhado] = c.banco.listarDestinatarios();
    assert.equal(alinhado.uf, 'RS');
    assert.equal(alinhado.codMunicipio, '4314100');
  } finally {
    await c.encerrar();
  }
});

test('NF-e 55 resolvida no wait: chave e corpo gravados antes da chamada, desfecho gravado, feed confirma depois', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    const r = await c.post('/nova-nota/emitir', pedido55(c));
    assert.match(r.html, /HTTP 200: o wait resolveu, completed \/ authorized, número 1/);

    const [nota] = c.banco.listarNotas();
    const envio = c.api.requisicoes.find((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfe?'))!;
    // A chave gravada é a que foi para o header; o corpo gravado é o que saiu.
    assert.equal(envio.cabecalhos['idempotency-key'], nota.idempotencyKey);
    assert.deepEqual(envio.corpo, JSON.parse(nota.corpoEnviado));
    assert.match(envio.caminho, /wait=8000/);
    assert.equal(envio.clientId, c.banco.configuracao().credencialClientId, 'a emissão usa a credencial operacional');

    // O documento: sem numero (managed), sem totais, dest em homologação, Simples (CRT 1 → csosn).
    const corpo = envio.corpo as { modelo: number; serie: number; numero?: number; documento: Record<string, any> };
    assert.equal(corpo.modelo, 55);
    assert.equal(corpo.numero, undefined);
    assert.equal(corpo.documento.total, undefined);
    assert.equal(corpo.documento.dest.xNome, NOME_DESTINATARIO_HOMOLOGACAO);
    assert.equal(corpo.documento.ide.idDest, 1, 'destinatário alinhado ao emitente: venda interna');
    assert.deepEqual(corpo.documento.itens[0].imposto.ICMS, { orig: '0', csosn: '102' });
    assert.equal(corpo.documento.itens[0].imposto.PIS.cst, '49');
    assert.deepEqual(corpo.documento.pag, [{ tPag: '01', vPag: 5 }]);
    assert.equal(corpo.documento.itens[0].prod.vProd, 5);

    // O desfecho do wait está gravado, mas ninguém confirmou.
    assert.equal(nota.status, 'completed');
    assert.equal(nota.outcome, 'authorized');
    assert.equal(nota.numero, 1);
    assert.ok(nota.chave);
    assert.equal(nota.confirmadoPor, null);
    let notas = await c.get('/notas');
    assert.match(notas.html, /do wait, aguardando o feed/);
    assert.match(notas.html, /<b>autorizada<\/b>/);

    // O feed confirma.
    const feed = await c.post('/eventos/puxar');
    assert.match(feed.html, /Feed lido: 1 evento/);
    const depois = c.banco.lerNota(nota.id)!;
    assert.equal(depois.confirmadoPor, 'feed');
    assert.equal(depois.situacao, 'autorizada');
    notas = await c.get('/notas');
    assert.match(notas.html, /<td>feed<\/td>/);
  } finally {
    await c.encerrar();
  }
});

test('Regime Normal (CRT 3): os itens saem com cst e ICMS destacado, PIS e COFINS cumulativos', async () => {
  const c = await subir();
  try {
    await ateSeries(c, { ...EMITENTE_VALIDO, crt: '3' });
    const tela = await c.get('/nova-nota');
    assert.match(tela.html, /Regime Normal \(cst \+ ICMS destacado\)/);
    await c.post('/nova-nota/emitir', pedido55(c));
    const envio = c.api.requisicoes.find((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfe?'))!;
    const item = (envio.corpo as any).documento.itens[0];
    assert.deepEqual(item.imposto.ICMS, { orig: '0', cst: '00', proprio: { modBC: '3', vBC: 5, pICMS: 18, vICMS: 0.9 } });
    assert.deepEqual(item.imposto.PIS, { cst: '01', vBC: 5, pPIS: 0.65, vPIS: 0.03 });
    assert.deepEqual(item.imposto.COFINS, { cst: '01', vBC: 5, pCOFINS: 3, vCOFINS: 0.15 });
    assert.equal(item.imposto.ICMS.csosn, undefined, 'os eixos são exclusivos');
  } finally {
    await c.encerrar();
  }
});

test('divergência de pagamento é apontada antes do envio: nenhum POST /v1/nfe sai', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    const antes = c.api.requisicoes.length;
    const r = await c.post('/nova-nota/emitir', pedido55(c, { vpag_1: '4,00' }));
    assert.match(r.html, /Pagamento divergente, nada foi enviado/);
    assert.match(r.texto, /pagamentos \(4.00\) não fecham com o total dos itens \(5.00\)/);
    assert.equal(c.api.requisicoes.slice(antes).filter((q) => q.caminho.startsWith('/v1/nfe')).length, 0);
    assert.equal(c.banco.listarNotas().length, 0, 'nada foi gravado');

    // Com troco fecha: 10 em dinheiro, 5 de troco.
    const ok = await c.post('/nova-nota/emitir', pedido55(c, { vpag_1: '10', vtroco: '5' }));
    assert.match(ok.html, /HTTP 200/);
    const corpo = (ultimoEnvio(c).corpo as any).documento;
    assert.equal(corpo.vTroco, 5, 'vTroco no nível do documento');
    assert.deepEqual(corpo.pag, [{ tPag: '01', vPag: 10 }]);
  } finally {
    await c.encerrar();
  }
});

test('a NF-e exige destinatário; a NFC-e sai sem ele, com pagamento, e sem grupo dest no corpo', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    const semDest = await c.post('/nova-nota/emitir', pedido55(c, { destinatario: '' }));
    assert.match(semDest.html, /A NF-e \(55\) exige destinatário/);

    const r = await c.post('/nova-nota/emitir', pedido55(c, { modelo: '65', destinatario: '' }));
    assert.match(r.html, /HTTP 200/);
    const corpo = ultimoEnvio(c).corpo as any;
    assert.equal(corpo.modelo, 65);
    assert.equal(corpo.documento.dest, undefined);
    assert.equal(corpo.documento.ide.mod, 65);
    assert.equal(corpo.documento.ide.tpImp, 4);
    assert.deepEqual(corpo.documento.pag, [{ tPag: '01', vPag: 5 }]);
  } finally {
    await c.encerrar();
  }
});

test('reenviar a mesma nota é replay: mesma Idempotency-Key, mesmo id, uma única emissão na API', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    c.api.modoEmissao = 'assincrono'; // fica pendente, e a tela oferece reenviar
    await c.post('/nova-nota/emitir', pedido55(c));
    const [nota] = c.banco.listarNotas();
    assert.equal(nota.status, 'pending');
    const tela = await c.get('/notas');
    assert.match(tela.html, /Reenviar \(mesma chave\)/);

    const r = await c.post(`/notas/${nota.id}/reenviar`);
    assert.match(r.html, /Reenvio com a mesma Idempotency-Key/);
    const envios = c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfe?'));
    assert.equal(envios.length, 2);
    assert.equal(envios[0].cabecalhos['idempotency-key'], envios[1].cabecalhos['idempotency-key']);
    assert.equal(c.api.comandos.size, 1, 'a API criou um comando só');
    assert.equal(c.banco.lerNota(nota.id)!.commandId, nota.commandId);
  } finally {
    await c.encerrar();
  }
});

test('XML só na autorizada (409 nfe-xml-unavailable antes); DANFE na autorizada e na cancelada', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nota/emitir', pedido55(c));
    const [nota] = c.banco.listarNotas();

    // Processando: a tela não oferece XML nem DANFE, e a rota direta mostra o 409 tal como veio.
    let tela = await c.get('/notas');
    assert.doesNotMatch(tela.html, new RegExp(`/notas/${nota.id}/xml`));
    assert.doesNotMatch(tela.html, new RegExp(`/notas/${nota.id}/danfe`));
    const xml409 = await c.get(`/notas/${nota.id}/xml`);
    assert.equal(xml409.status, 409);
    assert.match(xml409.html, /type = nfe-xml-unavailable/);
    const danfe409 = await c.get(`/notas/${nota.id}/danfe`);
    assert.equal(danfe409.status, 409);
    assert.match(danfe409.html, /type = nfe-danfe-unavailable/);

    // Autorizada pelo feed: as duas ações aparecem e baixam.
    c.api.concluir(nota.commandId!, 'authorized');
    await c.post('/eventos/puxar');
    tela = await c.get('/notas');
    assert.match(tela.html, new RegExp(`/notas/${nota.id}/xml`));
    assert.match(tela.html, new RegExp(`/notas/${nota.id}/danfe`));
    const xml = await fetch(`${c.base}/notas/${nota.id}/xml`);
    assert.equal(xml.status, 200);
    assert.match(xml.headers.get('content-type')!, /application\/xml/);
    assert.match(xml.headers.get('content-disposition')!, /attachment; filename=".*\.xml"/);
    assert.match(await xml.text(), /<nfeProc>/);
    const danfe = await fetch(`${c.base}/notas/${nota.id}/danfe`);
    assert.equal(danfe.status, 200);
    assert.match(danfe.headers.get('content-type')!, /application\/pdf/);
    assert.match(danfe.headers.get('content-disposition')!, /inline/);
    assert.match(await danfe.text(), /^%PDF/);

    // Cancelada: o DANFE continua (com tarja); o XML autorizado some da tela.
    c.api.cancelar(nota.commandId!);
    c.banco.db.prepare('UPDATE nota SET situacao = ? WHERE id = ?').run('cancelada', nota.id);
    tela = await c.get('/notas');
    assert.match(tela.html, /<b>cancelada<\/b>/);
    assert.doesNotMatch(tela.html, new RegExp(`/notas/${nota.id}/xml`));
    assert.match(tela.html, new RegExp(`/notas/${nota.id}/danfe`));
    const danfeCancelada = await fetch(`${c.base}/notas/${nota.id}/danfe`);
    assert.equal(danfeCancelada.status, 200);
    assert.match(await danfeCancelada.text(), /cancelada/);
  } finally {
    await c.encerrar();
  }
});

test('emitir antes da credencial operacional é recusado na tela, sem chamar a API', async () => {
  const c = await subir();
  try {
    const r = await c.post('/nova-nota/emitir', pedido55(c));
    assert.match(r.html, /Emitir exige a credencial operacional/);
    assert.equal(c.api.requisicoes.filter((q) => q.caminho.startsWith('/v1/nfe')).length, 0);
    const tela = await c.get('/nova-nota');
    assert.match(tela.html, /Antes, complete a tela Emitente/);
  } finally {
    await c.encerrar();
  }
});
