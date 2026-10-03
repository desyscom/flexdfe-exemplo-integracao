// A emissão da NFS-e: a tela Nova NFS-e monta o `documento` da DPS, grava a chave e o corpo ANTES da chamada e
// só então chama `POST /v1/nfse?wait=`. A lista e o detalhe mostram o status local e a SEFIN que calculou.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { ateSeries, ateSerieDps, EMITENTE_NFSE, pedidoNfse, subir, type Cenario } from './apoio.ts';

/** O último `POST /v1/nfse` que saiu. A tela faz outras leituras depois dele. */
const ultimoEnvio = (c: Cenario) => c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfse?')).at(-1)!;
const envios = (c: Cenario) => c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfse')).length;

test('NFS-e resolvida no wait: chave e corpo gravados antes da chamada, e o corpo é o do contrato', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    // O que o banco local tinha NO MOMENTO em que a emissão chegou à API: igualdade depois da chamada não prova a ordem.
    const naChamada: { chave: string | undefined; corpo: string | undefined; commandId: string | null | undefined }[] = [];
    c.api.aoReceber = (q) => {
      if (q.metodo !== 'POST' || !q.caminho.startsWith('/v1/nfse?')) return;
      const [n] = c.banco.listarNfses();
      naChamada.push({ chave: n?.idempotencyKey, corpo: n?.corpoEnviado, commandId: n?.commandId });
    };
    const r = await c.post('/nova-nfse/emitir', pedidoNfse());
    assert.match(r.html, /HTTP 200: o wait resolveu, completed \/ authorized, DPS 1, NFS-e nº 1/);

    const envio = ultimoEnvio(c);
    assert.match(envio.caminho, /wait=8000/);
    assert.equal(envio.clientId, c.banco.configuracao().credencialClientId, 'a emissão usa a credencial operacional');
    const [nfse] = c.banco.listarNfses();
    // A chave gravada é a que foi para o header; o corpo gravado é o que saiu.
    assert.equal(envio.cabecalhos['idempotency-key'], nfse.idempotencyKey);
    assert.deepEqual(envio.corpo, JSON.parse(nfse.corpoEnviado));
    // E foram gravados ANTES: quando a chamada chegou, a linha já estava lá, com a chave e o corpo, e sem o comando que a resposta devolve.
    assert.equal(naChamada.length, 1);
    assert.equal(naChamada[0].chave, nfse.idempotencyKey);
    assert.deepEqual(JSON.parse(naChamada[0].corpo!), envio.corpo);
    assert.equal(naChamada[0].commandId, null);

    // O envelope é { serie, documento }, sem numeroDps (a série é managed). O prestador, o dhEmi, o número e o
    // ambiente são da plataforma: o que vier deles no documento é ignorado, então a aplicação nem os manda.
    assert.deepEqual(envio.corpo, {
      serie: 1,
      documento: {
        dCompet: '2026-09-01',
        toma: { cnpj: '11444777000161', razaoSocial: 'Cliente Exemplo Ltda' },
        serv: { cLocPrestacao: '4106902', cTribNac: '010701', xDescServ: 'Suporte técnico em sistemas - setembro/2026' },
        valores: { vServ: 1500, tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } },
      },
    });

    // O desfecho do wait está gravado, mas ninguém confirmou.
    assert.equal(nfse.status, 'completed');
    assert.equal(nfse.outcome, 'authorized');
    assert.equal(nfse.numeroDps, 1);
    assert.equal(nfse.numeroNfse, 1);
    assert.equal(nfse.chave?.length, 50);
    assert.equal(nfse.confirmadoPor, null);
    const lista = await c.get('/nfse');
    assert.match(lista.html, /do wait, aguardando o feed/);
    assert.match(lista.html, /<b>autorizada<\/b>/);

    // O detalhe lê a NFS-e na API: o resumo traz o que o documento informou e o que só a SEFIN calcula.
    const detalhe = await c.get(`/nfse/${nfse.id}`);
    assert.match(detalhe.texto, /DPS 1 · NFS-e 1/);
    assert.match(detalhe.texto, /Cliente Exemplo Ltda/);
    assert.match(detalhe.texto, /ISSQN 30,00/);
    assert.match(detalhe.texto, /líquido 1500,00/);
    assert.match(detalhe.texto, /GET \/v1\/nfse\//);
  } finally {
    await c.encerrar();
  }
});

test('o totTrib segue o regime: ME/EPP leva o percentual do Simples, e quem não é ME/EPP leva "sem informação"', async () => {
  for (const [crt, totTrib] of [
    ['1', { pTotTribSN: 6 }],
    ['2', { pTotTribSN: 6 }],
    ['3', { indTotTrib: '0' }],
    ['4', { indTotTrib: '0' }],
  ] as const) {
    const c = await subir();
    try {
      await ateSerieDps(c, { ...EMITENTE_NFSE, crt });
      const tela = await c.get('/nova-nfse');
      // A tela diz por que: o indTotTrib é vedado ao ME/EPP (E0712), e o regime vem do CRT do cadastro.
      assert.match(tela.texto, new RegExp(`CRT ${crt}`));
      assert.match(tela.texto, crt === '1' || crt === '2' ? /pTotTribSN/ : /indTotTrib/);
      assert.match(tela.texto, /E0712/);

      await c.post('/nova-nfse/emitir', pedidoNfse());
      const corpo = ultimoEnvio(c).corpo as { documento: { valores: { totTrib: unknown } } };
      assert.deepEqual(corpo.documento.valores.totTrib, totTrib, `CRT ${crt}`);
    } finally {
      await c.encerrar();
    }
  }
});

test('o tomador sai por cpf, por cnpj ou por cnpj alfanumérico, conforme o documento, sem a pontuação', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    await c.post('/nova-nfse/emitir', pedidoNfse({ toma_documento: '529.982.247-25', toma_nome: 'Maria Cliente' }));
    assert.deepEqual((ultimoEnvio(c).corpo as { documento: { toma: unknown } }).documento.toma, { cpf: '52998224725', razaoSocial: 'Maria Cliente' });

    await c.post('/nova-nfse/emitir', pedidoNfse({ toma_documento: '12.abc.345/0001-88' }));
    assert.deepEqual((ultimoEnvio(c).corpo as { documento: { toma: unknown } }).documento.toma, { cnpj: '12ABC345000188', razaoSocial: 'Cliente Exemplo Ltda' });
  } finally {
    await c.encerrar();
  }
});

test('o valor: 1.500,00 e 1.500 são mil e quinhentos, e 1500.5 é um real e meio', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    for (const [texto, esperado] of [['1.500,00', 1500], ['1.500', 1500], ['1500', 1500], ['1500,5', 1500.5], ['1500.5', 1500.5], ['2.500.000,75', 2500000.75], ['0,5', 0.5]] as const) {
      await c.post('/nova-nfse/emitir', pedidoNfse({ vserv: texto }));
      const corpo = ultimoEnvio(c).corpo as { documento: { valores: { vServ: number } } };
      assert.equal(corpo.documento.valores.vServ, esperado, texto);
    }
  } finally {
    await c.encerrar();
  }
});

test('a competência padrão é o primeiro dia do mês de hoje em Brasília, e não o do mês seguinte em UTC', async () => {
  const c = await subir();
  try {
    // 01/11 01:00 UTC é 31/10 22:00 em Brasília: em UTC o mês já virou, em Brasília ainda não.
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T01:00:00Z') });
    const tela = await c.get('/nova-nfse');
    assert.match(tela.html, /name="dcompet" value="2026-10-01"/);
  } finally {
    mock.timers.reset();
    await c.encerrar();
  }
});

test('o pedido é conferido na tela antes de chamar a emissão: nenhum POST /v1/nfse sai', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    const recusas: [Record<string, string>, RegExp][] = [
      [{ vserv: '0' }, /Valor do serviço: maior que zero/],
      [{ ctribnac: '0107' }, /Código de tributação nacional: seis dígitos/],
      [{ xdescserv: '' }, /Descrição do serviço: obrigatória/],
      [{ dcompet: '09/2026' }, /Competência: AAAA-MM-DD, um dia que exista/],
      // O `Date.parse` aceita 30 de fevereiro e o empurra para março: o dia tem de existir no calendário.
      [{ dcompet: '2026-02-30' }, /Competência: AAAA-MM-DD, um dia que exista/],
      [{ dcompet: '2999-01-01' }, /Competência: não pode ser posterior à data de emissão/],
      [{ toma_documento: '123' }, /Tomador: CPF \(11 dígitos\) ou CNPJ \(14 caracteres\)/],
      [{ toma_nome: '' }, /Tomador: informe o nome ou a razão social/],
      [{ clocprestacao: '41' }, /Município da prestação: sete dígitos do IBGE/],
      [{ serie: '0' }, /Série de DPS: de 1 a 49999/],
      [{ serie: '70000' }, /Série de DPS: de 1 a 49999/],
      [{ ptottribsn: 'abc' }, /Percentual do Simples \(pTotTribSN\): um número de 0 a 100/],
    ];
    for (const [alteracao, esperado] of recusas) {
      assert.match((await c.post('/nova-nfse/emitir', pedidoNfse(alteracao))).texto, esperado, JSON.stringify(alteracao));
    }
    assert.equal(envios(c), 0, 'a forma se confere antes de chamar a emissão (só a leitura do emitente, para o CRT, sai antes)');
    assert.equal(c.banco.listarNfses().length, 0, 'e nada é gravado');
  } finally {
    await c.encerrar();
  }
});

test('sem série de DPS a emissão volta 404, e a NFS-e local fica gravada com a chave', async () => {
  const c = await subir();
  try {
    await ateSeries(c, EMITENTE_NFSE); // só as séries 55 e 65
    const r = await c.post('/nova-nfse/emitir', pedidoNfse());
    assert.match(r.texto, /HTTP 404/);
    assert.match(r.texto, /type = series-not-provisioned/);
    assert.match(r.texto, /série dps serie=1 não provisionada no ambiente homologacao/);

    const [nfse] = c.banco.listarNfses();
    assert.equal(nfse.commandId, null, 'a chamada não voltou com comando');
    assert.equal(nfse.idempotencyKey, ultimoEnvio(c).cabecalhos['idempotency-key']);
  } finally {
    await c.encerrar();
  }
});

test('reenviar é replay: mesma Idempotency-Key, mesmo corpo, uma única DPS na API', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    c.api.modoEmissao = 'assincrono';
    const r = await c.post('/nova-nfse/emitir', pedidoNfse());
    assert.match(r.texto, /HTTP 202: aceite, comando .* está pending/);
    const [nfse] = c.banco.listarNfses();
    assert.equal(nfse.status, 'pending');

    // Ainda em voo: o reenvio devolve o mesmo comando, e o corpo é o gravado.
    const reenvio = await c.post(`/nfse/${nfse.id}/reenviar`);
    assert.match(reenvio.texto, /Reenvio com a mesma Idempotency-Key/);
    assert.equal(c.api.dps.size, 1);
    const [primeiro, segundo] = c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfse?'));
    assert.equal(primeiro.cabecalhos['idempotency-key'], segundo.cabecalhos['idempotency-key']);
    assert.deepEqual(primeiro.corpo, segundo.corpo);

    // Terminal: o replay volta como aceite, sem o desfecho, e ainda é a mesma DPS.
    c.api.concluirDps(nfse.commandId!, 'authorized');
    const replay = await c.post(`/nfse/${nfse.id}/reenviar`);
    assert.match(replay.texto, /Replay de um comando já terminal/);
    assert.equal(c.api.dps.size, 1);
    assert.equal(c.banco.listarNfses().length, 1);
  } finally {
    await c.encerrar();
  }
});

test('o município da prestação e o do convênio vêm do cadastro do emitente', async () => {
  const c = await subir();
  try {
    await c.post('/emitente/cadastrar', EMITENTE_NFSE);
    assert.match((await c.get('/nova-nfse')).html, /name="clocprestacao"[^>]*value="4106902"/);
    assert.match((await c.get('/emitente')).html, /name="codigo_municipio"[^>]*value="4106902"/);
  } finally {
    await c.encerrar();
  }
});

test('emitir antes da credencial operacional é recusado na tela, sem chamar a API', async () => {
  const c = await subir();
  try {
    assert.match((await c.get('/nova-nfse')).texto, /Antes, complete a tela Emitente/);
    const r = await c.post('/nova-nfse/emitir', pedidoNfse());
    assert.match(r.texto, /Emitir exige a credencial operacional/);
    assert.equal(envios(c), 0);
    assert.equal(c.banco.listarNfses().length, 0);
  } finally {
    await c.encerrar();
  }
});
