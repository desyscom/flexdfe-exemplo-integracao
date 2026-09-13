// As operações sobre a nota emitida, dirigidas pela tela contra a API falsa: consulta, cancelamento,
// carta de correção e o DACCE, inutilização, os dois terminais que se parecem (`failed` e `blocked`), a nota
// `reconciliando` e o 429.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateSeries, pedido55, subir, type Cenario } from './apoio.ts';

const JUSTIFICATIVA = 'Cancelamento por erro de digitacao no valor da mercadoria';
const chamadas = (c: Cenario, metodo: string, caminho: RegExp) => c.api.requisicoes.filter((q) => q.metodo === metodo && caminho.test(q.caminho));

/** Emite uma NF-e 55 autorizada e confirmada pelo feed. */
async function notaAutorizada(c: Cenario, extra: Record<string, string> = {}) {
  await c.post('/nova-nota/emitir', pedido55(c, extra));
  await c.post('/eventos/puxar');
  const [nota] = c.banco.listarNotas();
  assert.equal(nota.situacao, 'autorizada');
  return nota;
}

test('consulta: assíncrona, sem evento no feed; a releitura da nota traz o cancelamento feito por fora', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    const nota = await notaAutorizada(c);
    c.api.cancelarPorFora(nota.commandId!);
    // A plataforma ainda não sabe: a tela segue autorizada.
    let tela = await c.get('/notas');
    assert.match(tela.html, /<b>autorizada<\/b>/);

    const r = await c.post(`/notas/${nota.id}/consultar`);
    assert.match(r.html, /HTTP 202: consulta aceita \(comando [0-9a-f-]{36}\); a releitura diz cancelada/);
    assert.match(r.texto, /A situação local mudou de autorizada para cancelada/);
    assert.equal(chamadas(c, 'POST', new RegExp(`^/v1/nfe/${nota.commandId}/consulta$`)).length, 1);
    assert.equal(chamadas(c, 'POST', /consulta$/)[0].cabecalhos['idempotency-key'], undefined, 'a consulta não exige chave');
    assert.match(r.html, /POST \/v1\/nfe\/[0-9a-f-]{36}\/consulta<\/span><\/td><td>202/, 'a rota consumida aparece no rodapé');

    const depois = c.banco.lerNota(nota.id)!;
    assert.equal(depois.situacao, 'cancelada');
    const [op] = c.banco.listarOperacoes(nota.id);
    assert.equal(op.tipo, 'consulta');
    assert.equal(op.situacao, 'concluída');
    assert.ok(op.commandId, 'o id do comando de consulta ficou gravado');
    assert.notEqual(op.commandId, nota.commandId, 'é o comando NOVO, não o da nota');
    assert.equal(c.api.feed.filter((e) => e.seq > c.banco.configuracao().cursorFeed).length, 0, 'a consulta não publicou evento');

    tela = await c.get('/notas');
    assert.match(tela.html, /<b>cancelada<\/b>/);
    assert.doesNotMatch(tela.html, new RegExp(`/notas/${nota.id}#cancelar`), 'cancelada não oferece cancelar');
  } finally {
    await c.encerrar();
  }
});

test('cancelamento: recusado na tela em nota não autorizada e com justificativa inválida, sem chamar a API', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nota/emitir', pedido55(c));
    const [nota] = c.banco.listarNotas();
    assert.equal(nota.status, 'pending');

    const tela = await c.get('/notas');
    assert.doesNotMatch(tela.html, new RegExp(`/notas/${nota.id}#cancelar`), 'processando não oferece cancelar');
    const detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.texto, /Não oferecido: a nota está <b>processando<\/b>, e só a autorizada cancela/);

    const r = await c.post(`/notas/${nota.id}/cancelar`, { justificativa: JUSTIFICATIVA });
    assert.match(r.texto, /Cancelamento recusado na tela: a nota 1 está processando; só a autorizada cancela/);
    assert.match(r.texto, /409 nfe-not-cancelable/);

    // Autoriza, e agora só a justificativa barra.
    c.api.concluir(nota.commandId!, 'authorized');
    await c.post('/eventos/puxar');
    const curta = await c.post(`/notas/${nota.id}/cancelar`, { justificativa: 'muito curta' });
    assert.match(curta.texto, /A justificativa tem 11 caracteres; a SEFAZ exige de 15 a 255/);
    const emoji = await c.post(`/notas/${nota.id}/cancelar`, { justificativa: 'Cancelamento por erro no valor 🙂 da mercadoria' });
    assert.match(emoji.texto, /caractere fora do envelope da SEFAZ na posição 32/);
    const espaco = await c.post(`/notas/${nota.id}/cancelar`, { justificativa: ' ' + JUSTIFICATIVA });
    assert.match(espaco.texto, /não pode começar nem terminar com espaço/);
    const longa = await c.post(`/notas/${nota.id}/cancelar`, { justificativa: 'x'.repeat(256) });
    assert.match(longa.texto, /tem 256 caracteres/);

    assert.equal(chamadas(c, 'POST', /cancelamento$/).length, 0, 'nenhuma chamada saiu');
    assert.equal(c.banco.listarOperacoes(nota.id).length, 0, 'nada foi gravado');
  } finally {
    await c.encerrar();
  }
});

test('cancelamento: chave e corpo gravados antes; a nota segue autorizada até o feed trazer o nfe.cancel do comando novo', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    const nota = await notaAutorizada(c);
    c.api.modoOperacoes = 'assincrono';

    const r = await c.post(`/notas/${nota.id}/cancelar`, { justificativa: JUSTIFICATIVA });
    assert.match(r.html, /HTTP 202: cancelamento aceito; o comando NOVO [0-9a-f-]{36} está pending/);
    const envio = chamadas(c, 'POST', /cancelamento$/)[0];
    assert.deepEqual(envio.corpo, { justificativa: JUSTIFICATIVA });
    assert.equal(envio.clientId, c.banco.configuracao().credencialClientId, 'credencial operacional');
    const [op] = c.banco.listarOperacoes(nota.id);
    assert.equal(op.tipo, 'cancelamento');
    assert.equal(envio.cabecalhos['idempotency-key'], op.idempotencyKey, 'a chave gravada é a que foi no header');
    assert.equal(op.status, 'pending');
    assert.notEqual(op.commandId, nota.commandId, 'o aceite devolve o id do comando NOVO');
    assert.equal(c.banco.lerNota(nota.id)!.situacao, 'autorizada', 'a resposta do cancelamento não muda a nota');

    // O feed traz o pending do comando novo; a nota segue.
    let feed = await c.post('/eventos/puxar');
    assert.match(feed.texto, /nfe.cancel pending → aplicado: cancelamento 1 segue pending/);
    assert.equal(c.banco.lerNota(nota.id)!.situacao, 'autorizada');

    // A SEFAZ registra: o feed fecha a operação, lê a tentativa e relê a nota.
    const evento = c.api.concluirOperacao(op.commandId!, 'authorized');
    feed = await c.post('/eventos/puxar');
    assert.match(feed.texto, new RegExp(`seq ${evento.seq} · nfe.cancel completed/authorized → aplicado: cancelamento 1 registrada; nota ${nota.id} cancelada`));
    const fechada = c.banco.lerOperacao(op.id)!;
    assert.equal(fechada.situacao, 'registrada');
    assert.equal(fechada.confirmadoPor, 'feed');
    assert.equal(c.banco.lerNota(nota.id)!.situacao, 'cancelada');
    assert.equal(chamadas(c, 'GET', new RegExp(`^/v1/nfe/${nota.commandId}/cancelamento$`)).length, 1, 'a tentativa foi lida');

    const detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.texto, /Na API agora: <b>cancelada<\/b>/);
    assert.match(detalhe.texto, new RegExp(`justificativa "${JUSTIFICATIVA}"`));
    assert.match(detalhe.html, /<td>cancelamento<\/td>.*<b>registrada<\/b>/);
    const lista = await c.get('/notas');
    assert.doesNotMatch(lista.html, new RegExp(`/notas/${nota.id}/xml`));
    assert.match(lista.html, new RegExp(`/notas/${nota.id}/danfe`));
  } finally {
    await c.encerrar();
  }
});

test('cancelamento recusado pela SEFAZ: a operação fica rejeitada com o motivo e a nota segue autorizada', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    const nota = await notaAutorizada(c);
    c.api.modoOperacoes = 'assincrono';
    await c.post(`/notas/${nota.id}/cancelar`, { justificativa: JUSTIFICATIVA });
    const [op] = c.banco.listarOperacoes(nota.id);
    c.api.concluirOperacao(op.commandId!, 'rejected');
    const feed = await c.post('/eventos/puxar');
    assert.match(feed.texto, /cancelamento 1 rejeitada; nota 1 autorizada/);
    assert.equal(c.banco.lerNota(nota.id)!.situacao, 'autorizada');
    const detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.texto, /501 Rejeicao: Prazo de cancelamento/);
    assert.match(detalhe.html, new RegExp(`action="/notas/${nota.id}/cancelar"`), 'segue autorizada: cancelar segue oferecido');
  } finally {
    await c.encerrar();
  }
});

test('carta de correção: cumulativa sobre a correção vigente, com histórico; recusada na tela no modelo 65', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    const nota = await notaAutorizada(c);

    let detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.html, /<textarea name="xCorrecao" rows="4" cols="90"><\/textarea>/, 'sem correção vigente, o texto começa vazio');
    assert.match(detalhe.texto, /Nenhuma carta ainda/);

    const texto1 = 'Onde se le 10 caixas, leia-se 10 fardos com 12 caixas cada';
    let r = await c.post(`/notas/${nota.id}/carta`, { xCorrecao: texto1 });
    assert.match(r.html, /HTTP 202: carta aceita; o comando NOVO [0-9a-f-]{36} está/);
    const envio = chamadas(c, 'POST', /cce$/)[0];
    assert.deepEqual(envio.corpo, { xCorrecao: texto1 });
    const [op1] = c.banco.listarOperacoes(nota.id);
    assert.equal(envio.cabecalhos['idempotency-key'], op1.idempotencyKey);
    await c.post('/eventos/puxar');
    assert.equal(c.banco.lerOperacao(op1.id)!.situacao, 'registrada');
    assert.equal(c.banco.lerNota(nota.id)!.situacao, 'autorizada', 'a carta é acessória: a situação da nota não muda');

    // A segunda carta nasce sobre a vigente: o formulário já vem com o texto da primeira.
    detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.texto, new RegExp(`<textarea name="xCorrecao" rows="4" cols="90">${texto1}</textarea>`));
    assert.match(detalhe.texto, /correção vigente \(nSeq 1\)/);
    assert.match(detalhe.html, /<td>1<\/td><td><b>registrada<\/b>/);
    const texto2 = `${texto1}; CFOP correto: 5102`;
    r = await c.post(`/notas/${nota.id}/carta`, { xCorrecao: texto2 });
    assert.match(r.html, /HTTP 202: carta aceita/);
    await c.post('/eventos/puxar');
    detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.texto, /correção vigente \(nSeq 2\)/);
    assert.match(detalhe.texto, new RegExp(`<textarea name="xCorrecao" rows="4" cols="90">${texto2}</textarea>`));
    assert.match(detalhe.html, /<td>2<\/td><td><b>registrada<\/b>/);
    assert.equal(chamadas(c, 'GET', /cce$/).length >= 2, true, 'o histórico é lido pela rota de cartas');
    const cartasDaApi = c.api.requisicoes.filter((q) => q.metodo === 'POST' && /cce$/.test(q.caminho)).length;
    assert.equal(cartasDaApi, 2);

    // Texto inválido: barrado na tela.
    const curta = await c.post(`/notas/${nota.id}/carta`, { xCorrecao: 'curta demais' });
    assert.match(curta.texto, /O texto da correção tem 12 caracteres; a SEFAZ exige de 15 a 1000/);
    assert.equal(c.api.requisicoes.filter((q) => q.metodo === 'POST' && /cce$/.test(q.caminho)).length, 2);

    // NFC-e: a lista não oferece, o detalhe explica, a ação é recusada sem chamar a API.
    await c.post('/nova-nota/emitir', pedido55(c, { modelo: '65', destinatario: '' }));
    const [nfce] = c.banco.listarNotas();
    assert.equal(nfce.modelo, 65);
    const lista = await c.get('/notas');
    assert.match(lista.html, new RegExp(`/notas/${nota.id}#carta`), 'a 55 oferece carta');
    assert.doesNotMatch(lista.html, new RegExp(`/notas/${nfce.id}#carta`), 'a 65 não oferece carta');
    assert.match(lista.html, new RegExp(`/notas/${nfce.id}#cancelar`), 'mas oferece cancelar');
    const detalhe65 = await c.get(`/notas/${nfce.id}`);
    assert.match(detalhe65.texto, /Não se aplica: a NFC-e \(65\) não aceita carta de correção/);
    const recusa = await c.post(`/notas/${nfce.id}/carta`, { xCorrecao: texto1 });
    assert.match(recusa.texto, /A NFC-e \(65\) não aceita carta de correção/);
    assert.match(recusa.texto, /409 nfe-cce-model-not-allowed/);
    assert.equal(c.api.requisicoes.filter((q) => q.metodo === 'POST' && /cce$/.test(q.caminho)).length, 2, 'nenhuma chamada saiu para a 65');
  } finally {
    await c.encerrar();
  }
});

test('inutilização: a tela e a borda só conferem a forma; a faixa invertida passa e volta rejeitada pela SEFAZ', async () => {
  const c = await subir();
  try {
    const semCredencial = await c.post('/inutilizacao/inutilizar', { modelo: '55', serie: '1', nNFIni: '10', nNFFin: '12', xJust: 'Numeracao pulada por falha na transmissao' });
    assert.match(semCredencial.texto, /Inutilizar exige a credencial operacional/);
    await ateSeries(c);

    // Forma inválida: nada sai.
    const serie = await c.post('/inutilizacao/inutilizar', { modelo: '55', serie: '1000', nNFIni: '10', nNFFin: '12', xJust: 'Numeracao pulada por falha na transmissao' });
    assert.match(serie.texto, /Forma inválida, nada foi enviado: série deve ser um inteiro de 0 a 999/);
    const just = await c.post('/inutilizacao/inutilizar', { modelo: '55', serie: '1', nNFIni: '10', nNFFin: '12', xJust: 'curta' });
    assert.match(just.texto, /A justificativa tem 5 caracteres/);
    assert.equal(chamadas(c, 'POST', /inutilizacoes/).length, 0);

    // Faixa válida: resolvida no wait, registrada.
    const ok = await c.post('/inutilizacao/inutilizar', { modelo: '55', serie: '1', nNFIni: '10', nNFFin: '12', xJust: 'Numeracao pulada por falha na transmissao' });
    assert.match(ok.html, /HTTP 200: o wait resolveu, completed \/ authorized: faixa registrada/);
    const envio = chamadas(c, 'POST', /inutilizacoes/)[0];
    assert.match(envio.caminho, /\?wait=8000$/);
    assert.deepEqual(envio.corpo, { modelo: 55, serie: 1, nNFIni: 10, nNFFin: 12, xJust: 'Numeracao pulada por falha na transmissao' });
    assert.equal(envio.clientId, c.banco.configuracao().credencialClientId);
    const [op] = c.banco.listarOperacoes();
    assert.equal(op.tipo, 'inutilizacao');
    assert.equal(op.notaId, null);
    assert.equal(op.idempotencyKey, envio.cabecalhos['idempotency-key']);
    assert.equal(op.situacao, 'registrada');

    // Faixa invertida: a tela e a borda deixam passar; quem recusa é a SEFAZ, como desfecho.
    const invertida = await c.post('/inutilizacao/inutilizar', { modelo: '55', serie: '1', nNFIni: '20', nNFFin: '15', xJust: 'Numeracao pulada por falha na transmissao' });
    assert.match(invertida.html, /HTTP 200: o wait resolveu, completed \/ rejected: faixa rejeitada/);
    assert.match(invertida.texto, /quem recusou foi a SEFAZ: 563 Rejeicao: Numero inicial da faixa maior que o final/);
    assert.equal(chamadas(c, 'POST', /inutilizacoes/).length, 2, 'a chamada saiu: a borda aceitou a forma');

    // Assíncrona: 202, fechada pelo feed como nfe.inutiliza.
    c.api.modoOperacoes = 'assincrono';
    const aceite = await c.post('/inutilizacao/inutilizar', { modelo: '65', serie: '1', nNFIni: '1', nNFFin: '1', xJust: 'Numeracao pulada por falha na transmissao' });
    assert.match(aceite.html, /HTTP 202: aceite, comando [0-9a-f-]{36} está pending/);
    const [pendente] = c.banco.listarOperacoes();
    assert.equal(pendente.status, 'pending');
    c.api.concluirOperacao(pendente.commandId!, 'authorized');
    const feed = await c.post('/eventos/puxar');
    assert.match(feed.texto, /nfe.inutiliza completed\/authorized → aplicado: inutilizacao 3 registrada/);
    assert.equal(c.banco.lerOperacao(pendente.id)!.confirmadoPor, 'feed');

    const tela = await c.get('/inutilizacao');
    assert.match(tela.texto, /Nem a API nem esta tela conferem se <code>nNFIni ≤ nNFFin<\/code>/);
    assert.equal((tela.html.match(/<td>inutilizacao<\/td>/g) ?? []).length, 3);
  } finally {
    await c.encerrar();
  }
});

test('failed: motivo com o caminho do campo, reemitir com chave NOVA; blocked: motivo e só consultar', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nota/emitir', pedido55(c));
    await c.post('/nova-nota/emitir', pedido55(c, { modelo: '65', destinatario: '' }));
    const [bloqueada, falhou] = c.banco.listarNotas();
    c.api.concluir(falhou.commandId!, 'failed');
    c.api.concluir(bloqueada.commandId!, 'blocked');
    await c.post('/eventos/puxar');

    const lista = await c.get('/notas');
    assert.match(lista.html, /<b>falhou<\/b>/);
    assert.match(lista.html, /<b>bloqueada<\/b>/);
    assert.match(lista.texto, /motivo:<\/b> PIS_COFINS_AUSENTE em \/det\[1\]\/imposto\/PIS/, 'a recusa antecipada aponta o caminho do campo');
    assert.match(lista.texto, /motivo:<\/b> a série está inativa e não aceita número novo; reative-a ou envie a nota por outra série/, 'o bloqueio diz a causa na numeração e o ajuste');
    assert.match(lista.texto, /blocked: a numeração não deixou a nota sair\. Revise a numeração, se foi duplicidade, ou faça na série o ajuste que o motivo diz, e emita a nota de novo em Nova nota\./);
    // failed: reemitir com chave nova (e consultar). Nunca reenviar com a mesma, nem cancelar.
    assert.match(lista.html, new RegExp(`action="/notas/${falhou.id}/reemitir"`));
    assert.match(lista.html, new RegExp(`action="/notas/${falhou.id}/consultar"`));
    assert.doesNotMatch(lista.html, new RegExp(`action="/notas/${falhou.id}/reenviar"`));
    assert.doesNotMatch(lista.html, new RegExp(`/notas/${falhou.id}#cancelar`));
    // blocked: só consultar.
    assert.match(lista.html, new RegExp(`action="/notas/${bloqueada.id}/consultar"`));
    assert.doesNotMatch(lista.html, new RegExp(`action="/notas/${bloqueada.id}/reemitir"`));
    assert.doesNotMatch(lista.html, new RegExp(`action="/notas/${bloqueada.id}/reenviar"`));
    assert.doesNotMatch(lista.html, new RegExp(`/notas/${bloqueada.id}#cancelar`));
    assert.doesNotMatch(lista.html, new RegExp(`/notas/${bloqueada.id}/xml`));

    // Reemitir: novo POST /v1/nfe com chave diferente, nova nota local apontando para a que falhou.
    c.api.modoEmissao = 'sincrono';
    const r = await c.post(`/notas/${falhou.id}/reemitir`);
    assert.match(r.html, new RegExp(`Reemissão da nota ${falhou.id} como nota 3, com a chave nova [0-9a-f-]{36}. HTTP 200: o wait resolveu, completed / authorized`));
    const envios = chamadas(c, 'POST', /^\/v1\/nfe\?/);
    assert.equal(envios.length, 3);
    assert.notEqual(envios[2].cabecalhos['idempotency-key'], envios[0].cabecalhos['idempotency-key'], 'chave NOVA');
    assert.deepEqual(envios[2].corpo, envios[0].corpo, 'mesmo corpo');
    const nova = c.banco.lerNota(3)!;
    assert.equal(nova.reemitidaDe, falhou.id);
    assert.equal(nova.status, 'completed');
    assert.equal(c.banco.lerNota(falhou.id)!.status, 'failed', 'a que falhou fica no histórico');
    assert.equal(c.api.comandos.size, 3, 'a API criou um comando novo');

    // blocked não se reemite por aqui: o ajuste é fora da nota. Recusado na tela, sem chamar a API.
    const recusa = await c.post(`/notas/${bloqueada.id}/reemitir`);
    assert.match(recusa.texto, /Reemitir só depois de failed; a nota 2 está bloqueada/);
    assert.match(recusa.texto, /blocked não se reemite por aqui: a numeração não deixou a nota sair/);
    assert.equal(chamadas(c, 'POST', /^\/v1\/nfe\?/).length, 3);

    const detalhe = await c.get(`/notas/${bloqueada.id}`);
    assert.match(detalhe.texto, /<b>blocked<\/b>: a <b>numeração<\/b> não deixou a nota sair/);
    // A duplicidade não traz o ajuste no motivo, e a série traz: o texto separa os dois caminhos, como o guia da API.
    assert.match(detalhe.texto, /Se a SEFAZ acusou duplicidade, revise a numeração antes de emitir de novo\. Se a série foi inativada, esgotou ou trocou de modo depois do aceite, o motivo diz também o ajuste\. Os dois ajustes são fora da nota; feito o ajuste, emita a nota de novo em <a href="\/nova-nota">Nova nota<\/a>/);
    assert.match(detalhe.texto, /Não oferecido: a nota está <b>bloqueada<\/b>/);
  } finally {
    await c.encerrar();
  }
});

test('DACCE: só a carta registrada tem documento; a rejeitada fica sem link, e pedida à mão é 409 nfe-dacce-unavailable', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    const nota = await notaAutorizada(c);

    // A carta registrada: o histórico oferece o DACCE, e a tela devolve o PDF com o nome que a API sugeriu.
    await c.post(`/notas/${nota.id}/carta`, { xCorrecao: 'Onde se le 10 caixas, leia-se 10 fardos com 12 caixas cada' });
    await c.post('/eventos/puxar');
    const [registrada] = c.banco.listarOperacoes(nota.id);
    assert.equal(registrada.situacao, 'registrada');
    let detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.html, new RegExp(`<a href="/notas/${nota.id}/cce/${registrada.commandId}/dacce">DACCE</a>`));
    const pdf = await fetch(`${c.base}/notas/${nota.id}/cce/${registrada.commandId}/dacce`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.headers.get('content-disposition'), `inline; filename="${nota.chave}-cce-1.pdf"`);
    assert.match(await pdf.text(), /^%PDF-1\.4 DACCE/);
    assert.equal(chamadas(c, 'GET', new RegExp(`^/v1/nfe/${nota.commandId}/cce/${registrada.commandId}/dacce$`)).length, 1, 'pela nota e pela carta');

    // A carta rejeitada: nada a imprimir. Sem link no histórico; pedida à mão, a tela mostra o envelope da API.
    c.api.modoOperacoes = 'assincrono';
    await c.post(`/notas/${nota.id}/carta`, { xCorrecao: 'Onde se le 10 caixas, leia-se 10 fardos com 12 caixas cada; CFOP 5102' });
    const [rejeitada] = c.banco.listarOperacoes(nota.id);
    assert.notEqual(rejeitada.id, registrada.id);
    c.api.concluirOperacao(rejeitada.commandId!, 'rejected');
    await c.post('/eventos/puxar');
    detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.html, /<td><b>rejeitada<\/b><\/td>.*?<td>-<\/td><td>-<\/td><\/tr>/s, 'sem registrada em, sem documento');
    assert.doesNotMatch(detalhe.html, new RegExp(`/cce/${rejeitada.commandId}/dacce`));
    const recusa = await c.get(`/notas/${nota.id}/cce/${rejeitada.commandId}/dacce`);
    assert.equal(recusa.status, 409);
    assert.match(recusa.texto, new RegExp(`DACCE da nota ${nota.id} indisponível: HTTP 409`));
    assert.match(recusa.texto, /type = nfe-dacce-unavailable/);
  } finally {
    await c.encerrar();
  }
});

test('reconciliando: o detalhe diz que a SEFAZ já autorizou e manda esperar, só quando a API diz reconciliando', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    c.api.modoEmissao = 'assincrono';
    await c.post('/nova-nota/emitir', pedido55(c));
    const [nota] = c.banco.listarNotas();

    // Em voo, sem marcador: a nota diz pendente, e não há o que esperar além do desfecho.
    let detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.texto, /Na API agora: <b>pendente<\/b>/);
    assert.doesNotMatch(detalhe.texto, /Espere e releia/);

    // A SEFAZ autorizou e a gravação do desfecho se perdeu: o comando segue processing, com o marcador.
    c.api.reconciliar(nota.commandId!);
    detalhe = await c.get(`/notas/${nota.id}`);
    assert.match(detalhe.texto, /Na API agora: <b>reconciliando<\/b> \(status processing/);
    assert.match(detalhe.texto, /<b>reconciliando<\/b>: a SEFAZ já autorizou a nota, e um erro interno abortou a gravação do desfecho na plataforma\. <b>Espere e releia<\/b>/);
    assert.match(detalhe.texto, /emitir de novo, com chave nova, criaria uma segunda nota para a mesma venda/);
  } finally {
    await c.encerrar();
  }
});

test('429: o cliente espera o Retry-After e repete a MESMA requisição, com a mesma Idempotency-Key', async () => {
  const c = await subir();
  try {
    await ateSeries(c);
    c.api.limitar = { vezes: 2, retryAfter: '0', caminho: /^\/v1\/nfe\?/ };
    const r = await c.post('/nova-nota/emitir', pedido55(c));
    assert.match(r.html, /HTTP 200: o wait resolveu, completed \/ authorized, número 1/);
    const envios = chamadas(c, 'POST', /^\/v1\/nfe\?/);
    assert.equal(envios.length, 3, 'dois 429 e a que passou');
    assert.equal(new Set(envios.map((e) => e.cabecalhos['idempotency-key'])).size, 1, 'a mesma chave nas três');
    assert.deepEqual(envios[0].corpo, envios[2].corpo);
    assert.equal(c.api.comandos.size, 1, 'uma nota só');
    // O rodapé mostra as três tentativas: 429, 429, 200.
    assert.match(r.html, /POST \/v1\/nfe\?wait=8000<\/span><\/td><td>429<\/td>.*POST \/v1\/nfe\?wait=8000<\/span><\/td><td>429<\/td>.*POST \/v1\/nfe\?wait=8000<\/span><\/td><td>200<\/td>/s);

    // Esgotadas as tentativas, o erro é mostrado como o que é: a borda, sem envelope de negócio.
    c.api.limitar = { vezes: 10, retryAfter: '0', caminho: /^\/v1\/nfe\?/ };
    const esgotado = await c.post('/nova-nota/emitir', pedido55(c));
    assert.match(esgotado.texto, /HTTP 429 depois de recuar e repetir/);
    assert.match(esgotado.texto, /sem envelope de negócio nem type/);
    assert.equal(chamadas(c, 'POST', /^\/v1\/nfe\?/).length, 6, 'três tentativas e desistiu');
    c.api.limitar = { vezes: 0, retryAfter: '0' };
    // A nota local ficou gravada com a chave: reenviar é o caminho, e é replay do nada (a API nunca a viu).
    const [pendente] = c.banco.listarNotas();
    assert.equal(pendente.commandId, null);
    const reenvio = await c.post(`/notas/${pendente.id}/reenviar`);
    assert.match(reenvio.html, /Reenvio com a mesma Idempotency-Key/);
    assert.equal(c.api.comandos.size, 2);
  } finally {
    await c.encerrar();
  }
});

test('nenhum ramo do cliente nem das telas depende do title do problem+json', () => {
  const pasta = join(import.meta.dirname, '..', 'src');
  const arquivos = readdirSync(pasta, { recursive: true }).map(String).filter((a) => a.endsWith('.ts'));
  assert.ok(arquivos.length > 10);
  for (const arquivo of arquivos) {
    const fonte = readFileSync(join(pasta, arquivo), 'utf8');
    // `title` pode ser exibido, e ter o tipo conferido ao ler o envelope; não pode ser comparado nem inspecionado.
    const ramifica = /(?<!typeof \w+)\.title\s*(===|!==|==|!=|\.includes|\.match|\.startsWith|\.test)|switch\s*\(\s*\w+\.title/;
    assert.ok(!ramifica.test(fonte), `${arquivo} ramifica pelo title`);
  }
});
