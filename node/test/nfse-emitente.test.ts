// O onboarding da NFS-e, na tela Emitente: a inscrição municipal, a consulta de convênio e a série de DPS.
// Os três são "a mais" em relação à NF-e, e cada um tem a sua credencial e a sua armadilha.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMITENTE_NFSE, subir, type Cenario } from './apoio.ts';

const envio = (c: Cenario, metodo: string, caminho: RegExp) => c.api.requisicoes.find((r) => r.metodo === metodo && caminho.test(r.caminho))!;

test('inscrição municipal: o cadastro a leva como foi digitada, e a ficha mostra a que a API gravou', async () => {
  const c = await subir();
  try {
    // O campo diz de onde sai a IM: a que vale é a do CNC NFS-e, e não necessariamente a do alvará.
    const formulario = await c.get('/emitente');
    assert.match(formulario.texto, /Inscrição municipal \(NFS-e\)/);
    assert.match(formulario.texto, /Indicador Municipal/);

    assert.match((await c.post('/emitente/cadastrar', EMITENTE_NFSE)).html, /Emitente cadastrado \(rascunho\)/);
    // A limpeza de espaço e pontuação é da API: a aplicação não a repete.
    assert.equal((envio(c, 'POST', /^\/v1\/emitentes$/).corpo as { inscricao_municipal: string }).inscricao_municipal, '01.234-5');
    assert.match((await c.get('/emitente')).texto, /IM 012345/);
  } finally {
    await c.encerrar();
  }
});

test('a inscrição municipal se informa e se limpa depois do cadastro, pela credencial de gestão', async () => {
  const c = await subir();
  try {
    await c.post('/emitente/cadastrar', { ...EMITENTE_NFSE, inscricao_municipal: '' });
    let tela = await c.get('/emitente');
    assert.match(tela.texto, /IM não informada/);
    // Quem só emite NF-e vive sem ela. Para a DPS, a SEFIN recusa a IM ausente ou errada, e se o município a exige depende dele.
    assert.match(tela.texto, /A SEFIN recusa a DPS com a IM ausente ou errada \(E0116, que dispensa o MEI\)/);
    assert.match(tela.texto, /nenhuma consulta de convênio responde isso/);

    const gravada = await c.post('/emitente/inscricao-municipal', { inscricao_municipal: ' 98.765-4 ' });
    assert.match(gravada.html, /Inscrição municipal gravada/);
    const patch = envio(c, 'PATCH', /^\/v1\/emitentes\/[^/]+$/);
    assert.equal(patch.clientId, 'gestao', 'editar o cadastro é escopo de integrador');
    assert.deepEqual(patch.corpo, { inscricao_municipal: '98.765-4' });
    assert.match((await c.get('/emitente')).texto, /IM 987654/);

    // Vazio limpa: o PATCH leva `null`, como o telefone.
    assert.match((await c.post('/emitente/inscricao-municipal', { inscricao_municipal: '' })).html, /Inscrição municipal removida/);
    assert.deepEqual(c.api.requisicoes.filter((r) => r.metodo === 'PATCH').at(-1)!.corpo, { inscricao_municipal: null });
    tela = await c.get('/emitente');
    assert.match(tela.texto, /IM não informada/);

    // Acima de 15 letras e dígitos a API recusa, e a tela mostra o envelope.
    const longa = await c.post('/emitente/inscricao-municipal', { inscricao_municipal: 'A'.repeat(16) });
    assert.match(longa.html, /Inscrição municipal recusada: HTTP 422/);
    assert.match(longa.html, /type = invalid-request-body/);
  } finally {
    await c.encerrar();
  }
});

test('convênio: sai pela credencial de gestão, antes da ativação, e a tela não o lê como adesão', async () => {
  const c = await subir();
  try {
    await c.post('/emitente/cadastrar', EMITENTE_NFSE);
    await c.post('/emitente/certificado');

    const r = await c.post('/emitente/convenio', { codigo_municipio: '4106902' });
    const consulta = envio(c, 'POST', /\/consultas-convenio$/);
    assert.equal(consulta.clientId, 'gestao', 'antes da ativação a credencial do emitente não autentica: a consulta vai com a de gestão');
    assert.deepEqual(consulta.corpo, { codigoMunicipio: '4106902' });
    assert.equal(consulta.cabecalhos['idempotency-key'], undefined, 'a consulta não cria nada: não leva Idempotency-Key');

    // A parametrização vem verbatim, e o veredito diz só que ela veio.
    assert.match(r.texto, /Convênio consultado: parametrizado/);
    assert.match(r.texto, /"aderenteAmbienteNacional": "1"/);
    assert.match(r.texto, /diz se a parametrização veio, não se o município aderiu ao Sistema Nacional/);
    assert.match(r.texto, /não bloqueia a emissão/);
    assert.match(r.texto, /E0038/);
    assert.match(r.texto, /E0039/);
    // O emitente segue rascunho: a consulta não pede a ativação.
    assert.match((await c.get('/emitente')).texto, /inativo \(rascunho\)/);
  } finally {
    await c.encerrar();
  }
});

test('convênio: depois da ativação vai pela credencial operacional, que alcança o emitente mesmo fora da carteira de gestão', async () => {
  const c = await subir();
  try {
    await c.post('/emitente/cadastrar', EMITENTE_NFSE);
    await c.post('/emitente/certificado');
    await c.post('/emitente/ativar');
    await c.post('/emitente/credencial');

    assert.match((await c.post('/emitente/convenio', { codigo_municipio: '4106902' })).texto, /Convênio consultado: parametrizado/);
    const consulta = envio(c, 'POST', /\/consultas-convenio$/);
    assert.equal(consulta.clientId, c.banco.configuracao().credencialClientId, 'a rota aceita a de emitente, e a de gestão do .env pode nem enxergar um emitente vinculado');
  } finally {
    await c.encerrar();
  }
});

test('a credencial de um emitente inativo não autentica: o 403 vem sem type, e nada é guardado', async () => {
  const c = await subir();
  try {
    // O emitente nasce rascunho. A credencial dele existe (foi cunhada no painel), mas só autentica depois da ativação.
    await c.post('/emitente/cadastrar', EMITENTE_NFSE);
    const emitenteId = c.banco.configuracao().emitenteId!;
    c.api.credenciais.push({ clientId: 'op-rascunho', secret: 'segredo', escopo: 'emitente', emitenteId });
    c.banco.db.exec('UPDATE configuracao SET emitente_id = NULL');

    const r = await c.post('/emitente/vincular', { client_id: 'op-rascunho', secret: 'segredo' });
    assert.match(r.texto, /A API não aceitou a credencial: HTTP 403/);
    assert.match(r.texto, /sem type: é a autenticação falando/);
    assert.match(r.texto, /emitente inativo/);
    assert.equal(c.banco.configuracao().credencialClientId, null);
    assert.equal(c.banco.configuracao().emitenteId, null);
  } finally {
    await c.encerrar();
  }
});

test('convênio: a consulta que não concluiu na janela é 504, e se repete como o 503', async () => {
  const c = await subir();
  try {
    await c.post('/emitente/cadastrar', EMITENTE_NFSE);
    await c.post('/emitente/certificado');
    c.api.convenio.lenta = true;

    const r = await c.post('/emitente/convenio', { codigo_municipio: '4106902' });
    assert.match(r.texto, /Consulta de convênio recusada: HTTP 504/);
    assert.match(r.texto, /type = municipal-agreement-lookup-unavailable/);
    // O 504 não é o ADN sem resposta: é a consulta que não concluiu dentro da janela. Os dois se repetem.
    assert.match(r.texto, /Indisponibilidade não é negativa: a consulta não concluiu dentro da janela: repita/);
    assert.doesNotMatch(r.texto, /o ADN não respondeu/);
  } finally {
    await c.encerrar();
  }
});

test('convênio sem parametrização é uma resposta, e não "o município está fora"', async () => {
  const c = await subir();
  try {
    await c.post('/emitente/cadastrar', EMITENTE_NFSE);
    await c.post('/emitente/certificado');
    c.api.convenio.semParametrizacao.add('3550308');

    const r = await c.post('/emitente/convenio', { codigo_municipio: '3550308' });
    assert.match(r.texto, /Convênio consultado: sem-parametrizacao/);
    assert.match(r.texto, /o ADN respondeu em definitivo e o grupo de parâmetros não veio/);
    assert.match(r.texto, /Nenhum dos dois vereditos quer dizer "o município está fora"/);
  } finally {
    await c.encerrar();
  }
});

test('convênio: o ADN fora do ar é 503 e se repete, e não vira "o município não tem convênio"', async () => {
  const c = await subir();
  try {
    await c.post('/emitente/cadastrar', EMITENTE_NFSE);
    await c.post('/emitente/certificado');
    c.api.convenio.indisponivel = true;

    const r = await c.post('/emitente/convenio', { codigo_municipio: '4106902' });
    assert.match(r.texto, /Consulta de convênio recusada: HTTP 503/);
    assert.match(r.texto, /type = municipal-agreement-lookup-unavailable/);
    assert.match(r.texto, /o ADN não respondeu: repita; isto não é a resposta "o município não tem convênio"/);

    // Repetir é inofensivo: a consulta não cria nada.
    c.api.convenio.indisponivel = false;
    assert.match((await c.post('/emitente/convenio', { codigo_municipio: '4106902' })).texto, /Convênio consultado: parametrizado/);
  } finally {
    await c.encerrar();
  }
});

test('convênio: o código fora de forma é recusado na tela, e sem certificado a API recusa com 422', async () => {
  const c = await subir();
  try {
    await c.post('/emitente/cadastrar', EMITENTE_NFSE);

    const curto = await c.post('/emitente/convenio', { codigo_municipio: '4106' });
    assert.match(curto.texto, /Código do município: sete dígitos do IBGE/);
    assert.equal(c.api.requisicoes.filter((r) => /consultas-convenio/.test(r.caminho)).length, 0, 'a forma se confere antes de chamar a API');

    // O certificado é o que abre o mTLS com o ADN: sem ele, a consulta é recusada antes de sair.
    const semCertificado = await c.post('/emitente/convenio', { codigo_municipio: '4106902' });
    assert.match(semCertificado.texto, /Consulta de convênio recusada: HTTP 422/);
    assert.match(semCertificado.texto, /type = invalid-request-body/);
  } finally {
    await c.encerrar();
  }
});

test('série de DPS: sai por tipoDocumento, sem modelo, na faixa de 1 a 49999, e habilita a NFS-e no emitente', async () => {
  const c = await subir();
  try {
    await c.post('/emitente/cadastrar', EMITENTE_NFSE);
    await c.post('/emitente/certificado');
    await c.post('/emitente/ativar');
    await c.post('/emitente/credencial');

    // A faixa da DPS é a do canal de API na SEFIN: a série 0 e a 70000 (a do Emissor Web) são recusadas antes da chamada.
    for (const fora of ['0', '70000']) {
      assert.match((await c.post('/emitente/serie', { documento: 'dps', serie: fora })).texto, /Série de DPS: de 1 a 49999/);
    }
    assert.equal(c.api.requisicoes.filter((r) => r.metodo === 'POST' && r.caminho === '/v1/series').length, 0);

    const ok = await c.post('/emitente/serie', { documento: 'dps', serie: '1' });
    assert.match(ok.texto, /Série 1 da DPS \(NFS-e\) provisionada \(managed\)/);
    const provisao = envio(c, 'POST', /^\/v1\/series$/);
    assert.equal(provisao.clientId, c.banco.configuracao().credencialClientId, 'série é escopo de emitente');
    assert.deepEqual(provisao.corpo, { tipoDocumento: 'dps', serie: 1, mode: 'managed' }, 'a DPS não tem modelo: só o tipoDocumento a pede');

    const tela = await c.get('/emitente');
    assert.match(tela.html, /<td>homologacao<\/td><td>dps<\/td><td>-<\/td><td>1<\/td><td>managed<\/td><td>1<\/td>/);
    assert.match(tela.texto, /documentos habilitados: dps/);

    // A série 1 de DPS e a série 1 de NF-e são duas: a segunda não é conflito.
    assert.match((await c.post('/emitente/serie', { documento: '55', serie: '1' })).texto, /Série 1 do modelo 55 provisionada/);
    assert.match((await c.get('/emitente')).texto, /documentos habilitados: nfe, dps/);
    // A mesma série de DPS duas vezes é 409.
    assert.match((await c.post('/emitente/serie', { documento: 'dps', serie: '1' })).texto, /type = series-already-exists/);
  } finally {
    await c.encerrar();
  }
});
