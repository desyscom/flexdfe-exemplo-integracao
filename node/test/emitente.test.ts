import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ateSeries, EMITENTE_VALIDO, pedido55, subir, type Cenario } from './apoio.ts';

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
    // Sem `ambiente` no corpo: a série nasce no ambiente atual do emitente, e a representação diz qual.
    const provisao = c.api.requisicoes.find((r) => r.metodo === 'POST' && r.caminho === '/v1/series')!;
    assert.deepEqual(provisao.corpo, { modelo: 55, serie: 1, mode: 'managed' });
    assert.deepEqual(c.api.series.map((s) => s.ambiente), ['homologacao', 'homologacao']);

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
    assert.match(tela.html, /<td>homologacao<\/td><td>55<\/td><td>1<\/td><td>managed<\/td>/);
    assert.match(tela.html, /a lista abaixo é a de <b>homologacao<\/b>/);
    assert.match(tela.html, /tunel\.exemplo\.com\/outro/);
    // A página lista as rotas que consumiu.
    assert.match(tela.html, /GET \/v1\/emitentes\//);
    assert.match(tela.html, /GET \/v1\/series/);
  } finally {
    await c.encerrar();
  }
});

test('a série é por ambiente: o emitente promovido não leva a de homologação, e a de produção numera do começo', async () => {
  const c = await subir();
  try {
    const id = await ateSeries(c);
    const homologacao = await c.post('/nova-nota/emitir', pedido55(c));
    assert.match(homologacao.html, /completed \/ authorized, número 1/);

    // A promoção acontece fora do exemplo (no painel). A série de homologação fica onde está.
    c.api.emitentes.get(id)!.ambiente = 'producao';
    let tela = await c.get('/emitente');
    assert.match(tela.html, /ambiente <b>producao<\/b>/);
    assert.match(tela.html, /a lista abaixo é a de <b>producao<\/b>/);
    assert.match(tela.html, /Nenhuma série ainda\. Sem série no ambiente atual, a emissão responde 404 series-not-provisioned\./);
    assert.ok(!tela.html.includes('5. Provisionar séries ✓'), 'as séries de homologação não contam em produção');

    // Sem série de produção, a emissão volta 404, e o detail nomeia o ambiente em que ela falta.
    const recusa = await c.post('/nova-nota/emitir', pedido55(c));
    assert.match(recusa.texto, /HTTP 404/);
    assert.match(recusa.texto, /type = series-not-provisioned/);
    assert.match(recusa.texto, /série modelo=55 serie=1 não provisionada no ambiente producao/);

    // A série 1 de produção é outra: nasce no ambiente atual e começa do 1, sem herdar o cursor de homologação.
    assert.match((await c.post('/emitente/serie', { modelo: '55', serie: '1' })).html, /Série 1 do modelo 55 provisionada/);
    tela = await c.get('/emitente');
    assert.match(tela.html, /<td>producao<\/td><td>55<\/td><td>1<\/td><td>managed<\/td><td>1<\/td>/);
    const producao = await c.post('/nova-nota/emitir', pedido55(c));
    assert.match(producao.html, /completed \/ authorized, número 1/);
    assert.deepEqual(c.api.series.map((s) => `${s.ambiente} ${s.modelo}/${s.serie} próximo ${s.nextNumber}`), ['homologacao 55/1 próximo 2', 'homologacao 65/1 próximo 1', 'producao 55/1 próximo 2']);
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
    assert.match(tela.texto, /Use Recomeçar do zero, na tela Configuração/);
  } finally {
    await c.encerrar();
  }
});

// ---------------------------------------------------------------- o atalho: emitente já cadastrado

/**
 * Cria o emitente e a credencial operacional na API e depois LIMPA o banco local, para o cenário
 * ficar igual ao de quem fez tudo no painel: a plataforma sabe do emitente, a aplicação não.
 */
async function jaCadastradoNaPlataforma(c: Cenario) {
  await ateCredencialOperacional(c);
  const cfg = c.banco.configuracao();
  c.banco.db.exec('UPDATE configuracao SET emitente_id = NULL, credencial_client_id = NULL, credencial_secret = NULL');
  return { id: cfg.emitenteId!, clientId: cfg.credencialClientId!, secret: cfg.credencialSecret! };
}

test('vincular um emitente já cadastrado descobre a ficha pela credencial operacional, sem escrever na API', async () => {
  const c = await subir();
  try {
    const { id, clientId, secret } = await jaCadastradoNaPlataforma(c);
    const antes = c.api.requisicoes.length;

    const r = await c.post('/emitente/vincular', { client_id: clientId, secret });
    assert.match(r.texto, /Emitente Loja Exemplo Ltda vinculado/);
    assert.match(r.texto, /nada foi criado na plataforma/);
    assert.match(r.texto, /pode ir direto para a série, no passo 5/);

    // Duas leituras, com a credencial informada, e nenhuma escrita.
    const novas = c.api.requisicoes.slice(antes);
    assert.ok(novas.every((x) => x.metodo === 'GET'), 'o atalho não escreve na API');
    const contexto = novas.find((x) => x.caminho === '/v1/contexto')!;
    assert.equal(contexto.clientId, clientId);
    assert.ok(novas.some((x) => x.caminho === `/v1/emitentes/${id}` && x.clientId === clientId));

    // O banco local aprendeu o mesmo que aprenderia pelo caminho longo.
    const cfg = c.banco.configuracao();
    assert.equal(cfg.emitenteId, id);
    assert.equal(cfg.credencialClientId, clientId);
    assert.equal(cfg.credencialSecret, secret);
    assert.doesNotMatch(r.html, new RegExp(secret), 'o secret não volta para a tela');

    // E a tela mostra os quatro primeiros passos prontos, com a série liberada.
    const tela = await c.get('/emitente');
    for (const passo of ['1. Cadastrar o emitente ✓', '2. Subir o certificado A1 ✓', '3. Ativar ✓', '4. Cunhar a credencial operacional ✓'])
      assert.ok(tela.html.includes(passo), `faltou "${passo}"`);
    assert.match((await c.post('/emitente/serie', { modelo: '55', serie: '7' })).html, /Série 7 do modelo 55 provisionada/);
  } finally {
    await c.encerrar();
  }
});

test('vincular com a credencial de gestão é recusado: ela não emite', async () => {
  const c = await subir();
  try {
    await jaCadastradoNaPlataforma(c);
    const r = await c.post('/emitente/vincular', { client_id: 'gestao', secret: 'segredo-gestao' });
    assert.match(r.texto, /escopo "integrador", e o atalho precisa de uma operacional/);
    assert.equal(c.banco.configuracao().emitenteId, null);
    assert.equal(c.banco.configuracao().credencialClientId, null);
  } finally {
    await c.encerrar();
  }
});

test('vincular com credencial inexistente mostra o envelope da autenticação e não grava nada', async () => {
  const c = await subir();
  try {
    const r = await c.post('/emitente/vincular', { client_id: 'nao-existe', secret: 'nem-esse' });
    assert.match(r.texto, /A API não aceitou a credencial: HTTP 401/);
    assert.match(r.texto, /sem type: é a autenticação falando/);
    assert.equal(c.banco.configuracao().emitenteId, null);
  } finally {
    await c.encerrar();
  }
});

test('vincular sobre um emitente já guardado é recusado antes de chamar a API', async () => {
  const c = await subir();
  try {
    await ateCredencialOperacional(c);
    const antes = c.api.requisicoes.length;
    const r = await c.post('/emitente/vincular', { client_id: 'x', secret: 'y' });
    assert.match(r.texto, /Já há um emitente no banco local/);
    assert.equal(c.api.requisicoes.length - antes, 2, 'só as leituras da tela');
  } finally {
    await c.encerrar();
  }
});

test('o atalho avisa quando o destinatário semeado está fora da UF do emitente', async () => {
  const c = await subir();
  try {
    // O cadastro alinha o destinatário semeado ao município do emitente; desfazê-lo simula o que o
    // atalho encontra de verdade, porque a leitura do emitente não publica o código IBGE.
    const { clientId, secret } = await jaCadastradoNaPlataforma(c);
    c.banco.alinharDestinatarioSemente({ codMunicipio: '3550308', municipio: 'SAO PAULO', uf: 'SP' });
    const r = await c.post('/emitente/vincular', { client_id: clientId, secret });
    assert.match(r.texto, /destinatário semeado está em SAO PAULO\/SP e o emitente em Parobé\/RS/);
    assert.match(r.texto, /DIFAL/);
  } finally {
    await c.encerrar();
  }
});
