import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ateSeries, EMITENTE_VALIDO, pedido55, subir } from './apoio.ts';
import { carregarConfig } from '../src/config.ts';

test('a raiz leva à Configuração', async () => {
  const c = await subir();
  try {
    const r = await fetch(c.base + '/', { redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/configuracao');
  } finally {
    await c.encerrar();
  }
});

test('Configuração ecoa o contexto da credencial de gestão, com escopo e emitentes do grupo', async () => {
  const c = await subir();
  try {
    const { status, html, texto } = await c.get('/configuracao');
    assert.equal(status, 200);
    assert.match(html, /Credencial de gestão reconhecida/);
    assert.match(texto, /"escopo": "integrador"/);
    assert.match(html, /GET \/v1\/contexto/);
    // Segredo mascarado: nunca inteiro na tela.
    assert.doesNotMatch(html, /segredo-gestao/);
    assert.equal(c.api.requisicoes.at(-1)?.caminho, '/v1/contexto');
  } finally {
    await c.encerrar();
  }
});

test('credencial errada mostra o envelope de autenticação { erro }, sem type', async () => {
  const c = await subir();
  c.config.gestao.secret = 'errado';
  try {
    const { texto } = await c.get('/configuracao');
    assert.match(texto, /HTTP 401/);
    assert.match(texto, /sem type: é a autenticação falando/);
    assert.match(texto, /"erro": "credencial inválida"/);
  } finally {
    await c.encerrar();
  }
});

test('credencial operacional no .env é reconhecida como escopo errado para esta aplicação', async () => {
  const c = await subir();
  c.api.emitentes.set('e1', { id: 'e1', cnpj: '1', razao_social: 'X', ambiente: 'homologacao' });
  c.api.credenciais.push({ clientId: 'op', secret: 's', escopo: 'emitente', emitenteId: 'e1' });
  c.config.gestao = { clientId: 'op', secret: 's' };
  try {
    const { texto } = await c.get('/configuracao');
    assert.match(texto, /tem escopo "emitente", e esta aplicação espera uma de gestão/);
  } finally {
    await c.encerrar();
  }
});

// ---------------------------------------------------------------- o .pfx é opcional

const ENV_MINIMO = { FLEXDFE_URL: 'https://api.exemplo/', FLEXDFE_CLIENT_ID: 'c', FLEXDFE_SECRET: 's' };

test('sem CERTIFICADO_PFX a configuração carrega: quem vincula um emitente pronto não sobe certificado', () => {
  const config = carregarConfig({ ...ENV_MINIMO } as NodeJS.ProcessEnv, '/nao/existe/.env');
  assert.equal(config.certificado.caminho, null);
  assert.equal(config.enderecoBase, 'https://api.exemplo');
});

test('a credencial de gestão continua obrigatória', () => {
  assert.throws(() => carregarConfig({ FLEXDFE_URL: 'https://x' } as NodeJS.ProcessEnv, '/nao/existe/.env'), /Falta FLEXDFE_CLIENT_ID/);
});

test('sem .pfx as telas dizem o que falta, em vez de apontar para um arquivo que não existe', async () => {
  const c = await subir();
  c.config.certificado.caminho = null;
  try {
    assert.match((await c.get('/configuracao')).texto, /não configurado \(só faz falta ao cadastrar um emitente novo\)/);
    await c.post('/emitente/cadastrar', EMITENTE_VALIDO);
    assert.match((await c.get('/emitente')).texto, /Sem <code>CERTIFICADO_PFX<\/code> no <code>.env<\/code>, não há o que enviar/);
    const r = await c.post('/emitente/certificado');
    assert.match(r.texto, /Não há certificado configurado/);
  } finally {
    await c.encerrar();
  }
});

// ---------------------------------------------------------------- recomeçar do zero

test('recomeçar do zero apaga o banco local, semeia de novo e não chama a API', async () => {
  const c = await subir();
  try {
    const id = await ateSeries(c);
    await c.post('/nova-nota/emitir', pedido55(c));
    assert.ok(c.banco.listarNotas().length > 0, 'a nota precisa existir antes do reset');
    c.banco.criarDestinatario({ documento: '11444777000161', nome: 'OUTRO', logradouro: 'R', numero: '1', bairro: 'B', codMunicipio: '3550308', municipio: 'SAO PAULO', uf: 'SP', cep: '01310000' });
    const antes = c.api.requisicoes.length;

    const r = await c.post('/configuracao/reiniciar', { confirmar: 'sim' });
    assert.match(r.texto, /Banco local recomeçado do zero/);
    assert.match(r.texto, /Nada foi chamado na API/);
    assert.match(r.texto, /o secret da credencial operacional e o segredo do webhook/);

    const cfg = c.banco.configuracao();
    assert.deepEqual(
      { ...cfg },
      { emitenteId: null, credencialClientId: null, credencialSecret: null, webhookSecret: null, cursorFeed: 0 },
    );
    assert.deepEqual(c.banco.listarNotas(), []);
    // Semeado de novo, como numa instalação nova: três produtos e um destinatário só.
    assert.equal(c.banco.listarProdutos().length, 3);
    assert.deepEqual(c.banco.listarDestinatarios().map((d) => d.semente), [1]);
    assert.equal(c.banco.listarDestinatarios()[0].id, 1, 'os ids recomeçam do 1');

    // A única chamada nova é o `GET /v1/contexto` que a própria tela sempre faz; o reset não fala
    // com a API, e o emitente continua cadastrado na plataforma.
    assert.deepEqual(c.api.requisicoes.slice(antes).map((x) => `${x.metodo} ${x.caminho}`), ['GET /v1/contexto']);
    assert.ok(c.api.emitentes.has(id), 'o emitente continua cadastrado na plataforma');

    // E a tela volta ao começo, com o passo 1 aberto de novo.
    assert.match((await c.get('/emitente')).texto, /Já tenho o emitente cadastrado na plataforma/);
  } finally {
    await c.encerrar();
  }
});

test('sem a confirmação marcada, o reset não apaga nada', async () => {
  const c = await subir();
  try {
    const id = await ateSeries(c);
    const r = await c.post('/configuracao/reiniciar');
    assert.match(r.texto, /Nada foi apagado/);
    assert.equal(c.banco.configuracao().emitenteId, id);
  } finally {
    await c.encerrar();
  }
});

test('depois do reset dá para vincular a mesma credencial e seguir de onde parou', async () => {
  const c = await subir();
  try {
    const id = await ateSeries(c);
    const { credencialClientId, credencialSecret } = c.banco.configuracao();
    await c.post('/configuracao/reiniciar', { confirmar: 'sim' });

    const r = await c.post('/emitente/vincular', { client_id: credencialClientId!, secret: credencialSecret! });
    assert.match(r.texto, /Emitente Loja Exemplo Ltda vinculado/);
    assert.equal(c.banco.configuracao().emitenteId, id);
    // As séries já provisionadas continuam na plataforma: a tela as lista sem provisionar de novo.
    assert.match((await c.get('/emitente')).html, /<td>55<\/td><td>1<\/td><td>managed<\/td>/);
  } finally {
    await c.encerrar();
  }
});
