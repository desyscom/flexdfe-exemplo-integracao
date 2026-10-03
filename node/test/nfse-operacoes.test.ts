// O que se faz com a NFS-e depois de emitida: baixar o XML e o DANFSe, consultar, cancelar e substituir. Todas são
// operações de escopo de emitente, e as que mudam algo (cancelar, substituir) fecham pelo feed, como a emissão.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ateSerieDps, EMITENTE_NFSE, pedidoNfse, subir, type Cenario } from './apoio.ts';

/** A NFS-e emitida e autorizada pela resposta do `wait`: a primeira linha local, já com comando. */
async function emitirAutorizada(c: Cenario) {
  await ateSerieDps(c);
  await c.post('/nova-nfse/emitir', pedidoNfse());
  return c.banco.listarNfses()[0];
}

const JUSTIFICATIVA = 'Contrato rescindido antes do inicio do servico';

test('XML e DANFSe: só depois de a DPS virar NFS-e (409 antes); a cancelada ainda tem os dois', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nfse/emitir', pedidoNfse());
    const [nfse] = c.banco.listarNfses();

    // Processando: a tela não oferece XML nem DANFSe, e a rota direta mostra o 409 tal como veio.
    let tela = await c.get('/nfse');
    assert.doesNotMatch(tela.html, new RegExp(`/nfse/${nfse.id}/xml`));
    assert.doesNotMatch(tela.html, new RegExp(`/nfse/${nfse.id}/danfse`));
    const xml409 = await c.get(`/nfse/${nfse.id}/xml`);
    assert.equal(xml409.status, 409);
    assert.match(xml409.html, /type = nfse-xml-unavailable/);
    const danfse409 = await c.get(`/nfse/${nfse.id}/danfse`);
    assert.equal(danfse409.status, 409);
    assert.match(danfse409.html, /type = nfse-danfse-unavailable/);

    // Autorizada pelo feed: as duas ações aparecem e baixam.
    c.api.concluirDps(nfse.commandId!, 'authorized');
    await c.post('/eventos/puxar-nfse');
    tela = await c.get('/nfse');
    assert.match(tela.html, new RegExp(`/nfse/${nfse.id}/xml`));
    assert.match(tela.html, new RegExp(`/nfse/${nfse.id}/danfse`));
    const xml = await fetch(`${c.base}/nfse/${nfse.id}/xml`);
    assert.equal(xml.status, 200);
    assert.match(xml.headers.get('content-type')!, /application\/xml/);
    assert.match(xml.headers.get('content-disposition')!, /attachment; filename=".*\.xml"/);
    assert.match(await xml.text(), /<NFSe>/);
    const danfse = await fetch(`${c.base}/nfse/${nfse.id}/danfse`);
    assert.equal(danfse.status, 200);
    assert.match(danfse.headers.get('content-type')!, /application\/pdf/);
    assert.match(danfse.headers.get('content-disposition')!, /inline/);
    assert.match(await danfse.text(), /^%PDF/);

    // Cancelada: a SEFIN gerou a nota, e o XML e o DANFSe seguem existindo. O DANFSe sai com a marca da situação atual.
    await c.post(`/nfse/${nfse.id}/cancelar`, { codigo_justificativa: '2', justificativa: JUSTIFICATIVA });
    await c.post('/eventos/puxar-nfse');
    tela = await c.get('/nfse');
    assert.match(tela.html, /<b>cancelada<\/b>/);
    assert.match(tela.html, new RegExp(`/nfse/${nfse.id}/xml`));
    assert.match(tela.html, new RegExp(`/nfse/${nfse.id}/danfse`));
    assert.match(await (await fetch(`${c.base}/nfse/${nfse.id}/danfse`)).text(), /cancelada/);
  } finally {
    await c.encerrar();
  }
});

test('consulta: assíncrona e sem Idempotency-Key, sem evento no feed; a releitura traz o cancelamento feito por fora', async () => {
  const c = await subir();
  try {
    const nfse = await emitirAutorizada(c);
    const eventosAntes = c.api.feed.filter((e) => e.type.startsWith('nfse.')).length;
    c.api.cancelarNfsePorFora(nfse.commandId!);

    // A plataforma não sabe: a NFS-e segue autorizada até a consulta.
    assert.match((await c.get(`/nfse/${nfse.id}`)).html, /Na API agora: <b>autorizada<\/b>/);
    const r = await c.post(`/nfse/${nfse.id}/consultar`);
    assert.match(r.texto, /HTTP 202: consulta aceita .*; a releitura diz cancelada/);
    assert.match(r.texto, /não gera evento no feed/);
    const consulta = c.api.requisicoes.find((q) => q.metodo === 'POST' && q.caminho.endsWith('/consulta'))!;
    assert.equal(consulta.clientId, c.banco.configuracao().credencialClientId);
    assert.equal(consulta.cabecalhos['idempotency-key'], undefined, 'a consulta não cria nada: não leva Idempotency-Key');

    assert.equal(c.banco.lerNfse(nfse.id)!.situacao, 'cancelada');
    assert.equal(c.api.feed.filter((e) => e.type.startsWith('nfse.')).length, eventosAntes, 'a consulta não publicou evento');
    const [operacao] = c.banco.listarOperacoesNfse(nfse.id);
    assert.equal(operacao.tipo, 'consulta');
    assert.equal(operacao.nfseId, nfse.id);
    assert.equal(operacao.notaId, null);

    // O detalhe diz de onde veio o cancelamento e o que o texto dele diz.
    const detalhe = await c.get(`/nfse/${nfse.id}`);
    assert.match(detalhe.texto, /cancelada em .*, origem analise-fiscal, justificativa "Cancelamento deferido pelo município"/);
  } finally {
    await c.encerrar();
  }
});

test('cancelamento: recusado na tela fora da autorizada, com código ou justificativa inválidos, sem chamar a API', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nfse/emitir', pedidoNfse());
    const [processando] = c.banco.listarNfses();
    const cancelamentos = () => c.api.requisicoes.filter((q) => q.caminho.endsWith('/cancelamento')).length;

    const recusada = await c.post(`/nfse/${processando.id}/cancelar`, { codigo_justificativa: '2', justificativa: JUSTIFICATIVA });
    assert.match(recusada.texto, /Cancelamento recusado na tela: a NFS-e \d+ está processando; só a autorizada cancela/);
    assert.match(recusada.texto, /nfse-not-cancelable/);

    c.api.concluirDps(processando.commandId!, 'authorized');
    await c.post('/eventos/puxar-nfse');
    const recusas: [Record<string, string>, RegExp][] = [
      [{ codigo_justificativa: '3', justificativa: JUSTIFICATIVA }, /Código do cancelamento: 1 \(erro na emissão\), 2 \(serviço não prestado\) ou 9 \(outros\)/],
      [{ codigo_justificativa: '2', justificativa: 'curta demais' }, /Justificativa recusada na tela, nada foi enviado: A justificativa tem 12 caracteres; a SEFAZ exige de 15 a 255/],
      [{ codigo_justificativa: '2', justificativa: 'Contrato rescindido – antes do início' }, /fora do envelope da SEFAZ/],
    ];
    for (const [corpo, esperado] of recusas) {
      assert.match((await c.post(`/nfse/${processando.id}/cancelar`, corpo)).texto, esperado, JSON.stringify(corpo));
    }
    assert.equal(cancelamentos(), 0, 'a forma se confere antes de chamar a API');
    assert.deepEqual(c.banco.listarOperacoesNfse(processando.id), []);
  } finally {
    await c.encerrar();
  }
});

test('cancelamento: chave e corpo gravados antes; a NFS-e segue autorizada até o feed trazer o nfse.cancel do comando novo', async () => {
  const c = await subir();
  try {
    const nfse = await emitirAutorizada(c);
    c.api.modoOperacoes = 'assincrono';
    // O que o banco local tinha NO MOMENTO em que o cancelamento chegou à API: igualdade depois da chamada não prova a ordem.
    const naChamada: { chave: string | null; corpo: string | null; commandId: string | null }[] = [];
    c.api.aoReceber = (q) => {
      if (q.metodo !== 'POST' || !q.caminho.endsWith('/cancelamento')) return;
      const [op] = c.banco.listarOperacoesNfse(nfse.id);
      naChamada.push({ chave: op?.idempotencyKey ?? null, corpo: op?.corpoEnviado ?? null, commandId: op?.commandId ?? null });
    };

    const r = await c.post(`/nfse/${nfse.id}/cancelar`, { codigo_justificativa: '2', justificativa: JUSTIFICATIVA });
    assert.match(r.texto, /HTTP 202: cancelamento aceito; o comando NOVO .* está pending/);
    const [operacao] = c.banco.listarOperacoesNfse(nfse.id);
    const envio = c.api.requisicoes.find((q) => q.metodo === 'POST' && q.caminho.endsWith('/cancelamento'))!;
    assert.equal(envio.cabecalhos['idempotency-key'], operacao.idempotencyKey, 'a chave gravada é a que foi para o header');
    assert.deepEqual(envio.corpo, { codigoJustificativa: '2', justificativa: JUSTIFICATIVA });
    assert.deepEqual(JSON.parse(operacao.corpoEnviado!), envio.corpo);
    // Gravados ANTES: quando a chamada chegou, a operação já estava lá com a chave e o corpo, e ainda sem o comando que o aceite devolve.
    assert.equal(naChamada.length, 1);
    assert.equal(naChamada[0].chave, operacao.idempotencyKey);
    assert.deepEqual(JSON.parse(naChamada[0].corpo!), envio.corpo);
    assert.equal(naChamada[0].commandId, null);
    assert.equal(envio.clientId, c.banco.configuracao().credencialClientId);

    // O comando é NOVO: o `id` do aceite não é o da NFS-e, e a NFS-e segue autorizada.
    assert.notEqual(operacao.commandId, nfse.commandId);
    assert.equal(c.banco.lerNfse(nfse.id)!.situacao, 'autorizada');

    // A tentativa conclui; o item do feed (`nfse.cancel`) sai sem outcome, e quem diz como terminou é a leitura da tentativa.
    const opApi = [...c.api.operacoes.values()][0];
    c.api.concluirOperacao(opApi.id, 'authorized');
    const feed = await c.post('/eventos/puxar-nfse');
    assert.match(feed.texto, /nfse\.cancel completed → aplicado: cancelamento \d+ registrada; NFS-e \d+ cancelada/);
    const fechada = c.banco.lerNfse(nfse.id)!;
    assert.equal(fechada.situacao, 'cancelada');
    const [cancelamento] = c.banco.listarOperacoesNfse(nfse.id);
    assert.equal(cancelamento.situacao, 'registrada');
    assert.equal(cancelamento.confirmadoPor, 'feed');
    assert.equal(cancelamento.outcome, null, 'o item do feed do cancelamento da NFS-e não traz outcome');
    assert.match((await c.get('/nfse')).html, /<b>cancelada<\/b>/);
    const detalhe = await c.get(`/nfse/${nfse.id}`);
    assert.match(detalhe.texto, /origem pedido, justificativa "Contrato rescindido antes do inicio do servico"/);
    assert.match(detalhe.texto, /registrada/);
  } finally {
    await c.encerrar();
  }
});

test('cancelamento recusado pela SEFIN (prazo do município): a tentativa fica rejeitada com o motivo e a NFS-e segue autorizada', async () => {
  const c = await subir();
  try {
    const nfse = await emitirAutorizada(c);
    c.api.modoOperacoes = 'assincrono';
    await c.post(`/nfse/${nfse.id}/cancelar`, { codigo_justificativa: '1', justificativa: JUSTIFICATIVA });
    c.api.concluirOperacao([...c.api.operacoes.values()][0].id, 'rejected');

    await c.post('/eventos/puxar-nfse');
    const [cancelamento] = c.banco.listarOperacoesNfse(nfse.id);
    assert.equal(cancelamento.situacao, 'rejeitada', 'o item do feed não tem outcome: é a leitura da tentativa que diz');
    assert.match(cancelamento.ultimoResultado!, /E0822: Cancelamento fora do prazo definido pelo município/);
    assert.equal(c.banco.lerNfse(nfse.id)!.situacao, 'autorizada');

    const detalhe = await c.get(`/nfse/${nfse.id}`);
    assert.match(detalhe.texto, /rejeitada/);
    // O prazo é do município, e a plataforma não o confere: a tela não o promete.
    assert.match(detalhe.texto, /O prazo é do município, e a plataforma não o confere: a recusa por prazo vem da SEFIN, na tentativa/);
  } finally {
    await c.encerrar();
  }
});

test('substituição: a substituta leva o id da original; a original só vira substituída quando o feed fecha a substituta', async () => {
  const c = await subir();
  try {
    const original = await emitirAutorizada(c);
    c.api.modoEmissao = 'assincrono';

    // O formulário vem preenchido com o que a original informou: o ME/EPP não pode mudar competência, valor nem tomador (E0063).
    const detalhe = await c.get(`/nfse/${original.id}`);
    assert.match(detalhe.texto, /E0063/);
    assert.match(detalhe.html, /name="vserv"[^>]*value="1500,00"/);
    assert.match(detalhe.html, /name="toma_nome"[^>]*value="Cliente Exemplo Ltda"/);

    const r = await c.post(`/nfse/${original.id}/substituir`, { ...pedidoNfse({ xdescserv: 'Suporte técnico em sistemas - setembro/2026 (corrigido)' }), codigo_justificativa: '99', justificativa: 'Descricao do servico corrigida' });
    assert.match(r.texto, /HTTP 202: aceite, comando .* está pending/);

    const [substituta] = c.banco.listarNfses();
    assert.notEqual(substituta.id, original.id);
    assert.equal(substituta.substitui, original.id);
    const envio = c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfse?')).at(-1)!;
    assert.deepEqual(envio.corpo, JSON.parse(substituta.corpoEnviado));
    // O pedido de substituição leva o id que a plataforma devolveu no aceite da original, e o motivo. A chave da original não vai.
    const corpo = envio.corpo as { serie: number; substituicao: unknown; documento: { serv: { xDescServ: string } } };
    assert.deepEqual(corpo.substituicao, { nfse: original.commandId, codigoJustificativa: '99', justificativa: 'Descricao do servico corrigida' });
    assert.equal(corpo.documento.serv.xDescServ, 'Suporte técnico em sistemas - setembro/2026 (corrigido)');
    assert.equal(corpo.serie, 1);
    assert.equal(c.banco.lerNfse(original.id)!.situacao, 'autorizada', 'a original só muda quando a SEFIN gerar a substituta');

    // A SEFIN gera a substituta e cancela a original no mesmo envio; o feed fecha a substituta e a tela relê a original.
    c.api.concluirDps(substituta.commandId!, 'authorized');
    const feed = await c.post('/eventos/puxar-nfse');
    assert.match(feed.texto, new RegExp(`aplicado: NFS-e ${substituta.id} autorizada \\(completed/authorized\\); NFS-e ${original.id} substituida`));
    assert.equal(c.banco.lerNfse(original.id)!.situacao, 'substituida');
    assert.equal(c.banco.lerNfse(substituta.id)!.situacao, 'autorizada');

    // O vínculo aparece nos dois detalhes.
    assert.match((await c.get(`/nfse/${original.id}`)).texto, new RegExp(`substituída pela NFS-e local ${substituta.id}`));
    assert.match((await c.get(`/nfse/${substituta.id}`)).texto, new RegExp(`substitui a NFS-e local ${original.id}`));
    assert.match((await c.get('/nfse')).html, /<b>substituida<\/b>/);
    // A substituída ainda tem DANFSe, com a marca dela; mas não se cancela nem se substitui de novo.
    assert.match(await (await fetch(`${c.base}/nfse/${original.id}/danfse`)).text(), /substituida/);
    assert.match((await c.post(`/nfse/${original.id}/cancelar`, { codigo_justificativa: '2', justificativa: JUSTIFICATIVA })).texto, /a NFS-e \d+ está substituida; só a autorizada cancela/);
    const intakes = c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfse?')).length;
    assert.match((await c.post(`/nfse/${original.id}/substituir`, { ...pedidoNfse(), codigo_justificativa: '01', justificativa: '' })).texto, /a NFS-e \d+ está substituida; só a autorizada se substitui/);
    assert.equal(c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfse?')).length, intakes, 'recusada na tela: nenhuma emissão nova sai');
  } finally {
    await c.encerrar();
  }
});

test('substituição: recusada na tela fora da autorizada, com código inválido ou sem a justificativa que o 99 exige', async () => {
  const c = await subir();
  try {
    await ateSerieDps(c);
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nfse/emitir', pedidoNfse());
    const [processando] = c.banco.listarNfses();
    const intakes = () => c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfse?')).length;
    const antes = intakes();

    assert.match((await c.post(`/nfse/${processando.id}/substituir`, { ...pedidoNfse(), codigo_justificativa: '01', justificativa: '' })).texto, /Substituição recusada na tela: a NFS-e \d+ está processando; só a autorizada se substitui/);

    c.api.concluirDps(processando.commandId!, 'authorized');
    await c.post('/eventos/puxar-nfse');
    const recusas: [Record<string, string>, RegExp][] = [
      [{ codigo_justificativa: '06', justificativa: '' }, /Código da substituição: 01, 02, 03, 04, 05 ou 99/],
      [{ codigo_justificativa: '99', justificativa: '' }, /Com o código 99 a justificativa é obrigatória/],
      [{ codigo_justificativa: '01', justificativa: 'curta' }, /Justificativa recusada na tela, nada foi enviado/],
      [{ codigo_justificativa: '01', justificativa: '', vserv: '0' }, /Valor do serviço: maior que zero/],
    ];
    for (const [alteracao, esperado] of recusas) {
      assert.match((await c.post(`/nfse/${processando.id}/substituir`, { ...pedidoNfse(), ...alteracao })).texto, esperado, JSON.stringify(alteracao));
    }
    assert.equal(intakes(), antes, 'a forma se confere antes de chamar a API');
    assert.equal(c.banco.listarNfses().length, 1);

    // Os códigos de 01 a 05 dispensam a justificativa: ela é opcional, e vazia não vai no corpo.
    await c.post(`/nfse/${processando.id}/substituir`, { ...pedidoNfse(), codigo_justificativa: '02', justificativa: '' });
    const corpo = c.api.requisicoes.filter((q) => q.metodo === 'POST' && q.caminho.startsWith('/v1/nfse?')).at(-1)!.corpo as { substituicao: unknown };
    assert.deepEqual(corpo.substituicao, { nfse: processando.commandId, codigoJustificativa: '02' });
  } finally {
    await c.encerrar();
  }
});

test('o aviso do E0063 aparece quando a substituta é de ME/EPP ou de MEI, e não no Regime Normal', async () => {
  // O E0063 vale se o prestador era ME/EPP na original e, na competência da substituta, continua ME/EPP ou passa a MEI.
  // Pelo CRT de hoje, é a substituta dos CRT 1, 2 e 4 que pode cair nele; a do CRT 3 não. O regime da original a tela não sabe.
  for (const [crt, aparece] of [['1', true], ['2', true], ['3', false], ['4', true]] as const) {
    const c = await subir();
    try {
      await ateSerieDps(c, { ...EMITENTE_NFSE, crt });
      await c.post('/nova-nfse/emitir', pedidoNfse());
      const [nfse] = c.banco.listarNfses();
      const detalhe = await c.get(`/nfse/${nfse.id}`);
      assert.equal(/E0063/.test(detalhe.texto), aparece, `CRT ${crt}`);
      if (aparece) assert.match(detalhe.texto, /O regime da original a tela não sabe, e por isso o aviso é condicional/);
    } finally {
      await c.encerrar();
    }
  }
});
