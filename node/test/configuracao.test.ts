import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subir } from './apoio.ts';

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
