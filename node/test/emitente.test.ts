import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMITENTE_VALIDO, subir, type Cenario } from './apoio.ts';

async function cadastrar(c: Cenario) {
  const r = await c.post('/emitente/cadastrar', EMITENTE_VALIDO);
  assert.match(r.html, /Emitente cadastrado \(rascunho\)/);
  return c.banco.configuracao().emitenteId!;
}

async function ateCredencialOperacional(c: Cenario) {
  await cadastrar(c);
  assert.match((await c.post('/emitente/certificado')).html, /Certificado no cofre/);
  assert.match((await c.post('/emitente/ativar')).html, /Emitente ativo/);
  assert.match((await c.post('/emitente/credencial')).html, /Credencial operacional cunhada e guardada/);
}

test('o ciclo completo: cadastro, certificado, ativação, credencial, série 55 e 65, webhook', async () => {
  const c = await subir();
  try {
    const id = await cadastrar(c);
    // O que saiu para a API é o contrato: CNPJ sem máscara, UF maiúscula, ambiente fixo.
    const criacao = c.api.requisicoes.find((r) => r.metodo === 'POST' && r.caminho === '/v1/emitentes')!;
    assert.equal(criacao.clientId, 'gestao');
    assert.deepEqual(
      { ...(criacao.corpo as Record<string, unknown>) },
      { cnpj: '12345678000195', razao_social: 'Loja Exemplo Ltda', nome_fantasia: null, inscricao_estadual: 'ISENTO', crt: 1, ambiente: 'homologacao', logradouro: 'Rua das Flores', numero: '100', bairro: 'Centro', cod_municipio: '4314100', municipio: 'Parobé', uf: 'RS', cep: '95630000', telefone: null },
    );

    let tela = await c.get('/emitente');
    assert.match(tela.html, /1\. Cadastrar o emitente ✓/);
    assert.match(tela.html, /inativo \(rascunho\)/);

    // Certificado: base64 do arquivo, com a senha, num JSON.
    assert.match((await c.post('/emitente/certificado')).html, /Certificado no cofre/);
    const envio = c.api.requisicoes.find((r) => r.metodo === 'PUT' && r.caminho.endsWith('/certificado'))!;
    assert.deepEqual(envio.corpo, { pfx_base64: Buffer.from(c.api.conteudoPfxDoTitular).toString('base64'), senha: c.api.senhaCerta });

    assert.match((await c.post('/emitente/ativar')).html, /Emitente ativo/);

    // Cunhagem: com emitente_id, pela credencial de gestão; o secret vai para o banco.
    const cunhagem = await c.post('/emitente/credencial');
    assert.match(cunhagem.html, /Credencial operacional cunhada e guardada/);
    assert.match(cunhagem.html, /\(guardado no banco local\)/);
    const cfg = c.banco.configuracao();
    const cunhada = c.api.credenciais.find((x) => x.escopo === 'emitente')!;
    assert.equal(cfg.credencialClientId, cunhada.clientId);
    assert.equal(cfg.credencialSecret, cunhada.secret);
    assert.doesNotMatch(cunhagem.html, new RegExp(cunhada.secret));
    assert.deepEqual(c.api.requisicoes.find((r) => r.caminho === '/v1/credenciais')!.corpo, { descricao: 'Exemplo de integração', emitente_id: id });

    // Série: daqui em diante as chamadas de escopo de emitente usam a credencial cunhada.
    assert.match((await c.post('/emitente/serie', { modelo: '55', serie: '1' })).html, /Série 1 do modelo 55 provisionada/);
    assert.match((await c.post('/emitente/serie', { modelo: '65', serie: '1' })).html, /Série 1 do modelo 65 provisionada/);
    for (const r of c.api.requisicoes.filter((r) => r.caminho === '/v1/series')) assert.equal(r.clientId, cunhada.clientId);

    // Webhook: criado, o secret vem e é guardado.
    const webhook = await c.post('/emitente/webhook', { url: 'https://tunel.exemplo.com/webhook' });
    assert.match(webhook.html, /Webhook criado; segredo guardado/);
    assert.equal(c.banco.configuracao().webhookSecret, c.api.webhooks.get(id)!.secret);
    // Editado: sem secret no corpo, o guardado permanece.
    const edicao = await c.post('/emitente/webhook', { url: 'https://tunel.exemplo.com/outro' });
    assert.match(edicao.html, /Webhook atualizado/);
    assert.equal(c.banco.configuracao().webhookSecret, c.api.webhooks.get(id)!.secret);

    tela = await c.get('/emitente');
    for (const passo of ['1. Cadastrar o emitente ✓', '2. Subir o certificado A1 ✓', '3. Ativar ✓', '4. Cunhar a credencial operacional ✓', '5. Provisionar séries ✓', '6. Webhook (opcional) ✓'])
      assert.ok(tela.html.includes(passo), `faltou "${passo}"`);
    assert.match(tela.html, /<td>55<\/td><td>1<\/td><td>managed<\/td>/);
    assert.match(tela.html, /tunel\.exemplo\.com\/outro/);
    // A página lista as rotas que consumiu.
    assert.match(tela.html, /GET \/v1\/emitentes\//);
    assert.match(tela.html, /GET \/v1\/series/);
  } finally {
    await c.encerrar();
  }
});

test('cadastro com CNPJ repetido mostra o problem+json com o type', async () => {
  const c = await subir();
  try {
    await cadastrar(c);
    c.banco.db.exec('UPDATE configuracao SET emitente_id = NULL');
    const r = await c.post('/emitente/cadastrar', EMITENTE_VALIDO);
    assert.match(r.html, /Cadastro recusado: HTTP 409/);
    assert.match(r.html, /type = emitente-cnpj-already-exists/);
    assert.match(r.html, /Envelope application\/problem\+json/);
  } finally {
    await c.encerrar();
  }
});

test('certificado com senha errada e com titular diferente são recusados sem alterar o emitente', async () => {
  const errada = await subir({ senha: 'outra' });
  try {
    await cadastrar(errada);
    assert.match((await errada.post('/emitente/certificado')).html, /type = certificate-unreadable/);
    assert.equal([...errada.api.emitentes.values()][0].certificado, null);
  } finally {
    await errada.encerrar();
  }
  const outro = await subir({ conteudoPfx: 'PFX-DE-OUTRO-CNPJ' });
  try {
    await cadastrar(outro);
    assert.match((await outro.post('/emitente/certificado')).html, /type = certificate-holder-mismatch/);
  } finally {
    await outro.encerrar();
  }
});

test('ativar sem certificado é 409 certificate-required-to-activate', async () => {
  const c = await subir();
  try {
    await cadastrar(c);
    const r = await c.post('/emitente/ativar');
    assert.match(r.html, /Ativação recusada: HTTP 409/);
    assert.match(r.html, /type = certificate-required-to-activate/);
  } finally {
    await c.encerrar();
  }
});

test('a ordem é imposta pela tela: série e webhook ficam bloqueados até a credencial operacional', async () => {
  const c = await subir();
  try {
    await cadastrar(c);
    const tela = await c.get('/emitente');
    assert.match(tela.html, /cunhe a credencial operacional; a de gestão recebe 403 emitente-scope-required/);
    assert.match((await c.post('/emitente/serie', { modelo: '55', serie: '1' })).html, /Série exige a credencial operacional/);
    assert.match((await c.post('/emitente/webhook', { url: 'https://a.b/c' })).html, /Webhook vem depois da credencial operacional/);
    assert.equal(c.api.requisicoes.filter((r) => r.caminho === '/v1/series' || r.caminho.endsWith('/webhook')).length, 0);
  } finally {
    await c.encerrar();
  }
});

test('série repetida é 409 series-already-exists', async () => {
  const c = await subir();
  try {
    await ateCredencialOperacional(c);
    await c.post('/emitente/serie', { modelo: '55', serie: '3' });
    const r = await c.post('/emitente/serie', { modelo: '55', serie: '3' });
    assert.match(r.html, /type = series-already-exists/);
  } finally {
    await c.encerrar();
  }
});

test('cunhar uma segunda credencial é recusado localmente para não perder o segredo da primeira', async () => {
  const c = await subir();
  try {
    await ateCredencialOperacional(c);
    const r = await c.post('/emitente/credencial');
    assert.match(r.html, /Já existe uma credencial operacional guardada/);
    assert.equal(c.api.requisicoes.filter((r) => r.caminho === '/v1/credenciais').length, 1);
  } finally {
    await c.encerrar();
  }
});

test('URL de webhook que não é HTTPS pública é recusada antes de chamar a API', async () => {
  const c = await subir();
  try {
    await ateCredencialOperacional(c);
    const antes = c.api.requisicoes.length;
    for (const [url, motivo] of [
      ['http://tunel.exemplo.com/webhook', 'precisa ser https'],
      ['https://localhost:3080/webhook', 'localhost não é alcançável'],
      ['https://192.168.0.10/webhook', 'IP privado'],
      ['https://127.0.0.1/webhook', 'loopback'],
      ['https://169.254.169.254/latest', 'metadados'],
      ['isso não é url', 'não é uma URL'],
    ]) {
      const r = await c.post('/emitente/webhook', { url });
      assert.match(r.html, /URL recusada antes de chamar a API/, url);
      assert.match(r.html, new RegExp(motivo), url);
    }
    assert.equal(c.api.requisicoes.length - antes, 6 * 2, 'só as leituras da tela (emitente e séries), nenhum PUT');
    assert.ok(c.api.requisicoes.slice(antes).every((r) => r.metodo === 'GET'));
  } finally {
    await c.encerrar();
  }
});

test('id de emitente que a API não conhece mais é explicado na tela', async () => {
  const c = await subir();
  try {
    c.banco.gravarEmitenteId('00000000-0000-0000-0000-000000000000');
    const tela = await c.get('/emitente');
    assert.match(tela.html, /Não consegui ler o emitente guardado: HTTP 404/);
    assert.match(tela.html, /Apague o banco local para recomeçar/);
  } finally {
    await c.encerrar();
  }
});
