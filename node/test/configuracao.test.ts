import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMITENTE_VALIDO, subir } from './apoio.ts';
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
