// Tela Configuração: o que veio do `.env`, com os segredos mascarados, e o eco do contexto.
//
// Rota consumida: GET /v1/contexto. É a primeira chamada que qualquer integração deveria fazer:
// prova que a credencial existe, diz o escopo dela e, na de gestão, lista os emitentes do grupo.
//
// É também onde se recomeça do zero: o banco local é a única coisa que esta aplicação possui, e
// apagá-lo não chama a API nem desfaz nada na plataforma.

import type { Contexto, Resposta, Rota } from '../app.ts';
import { html, pagina, resultado, resultadoDeErro, vazio, type Html, type Resultado } from '../html.ts';

const mascarar = (valor: string): string => (valor.length <= 6 ? '••••' : valor.slice(0, 4) + '••••' + valor.slice(-2));

export const telaConfiguracao: Rota = (ctx) => renderizar(ctx, null);

export const acoesConfiguracao: Record<string, Rota> = {
  reiniciar: async (ctx) => renderizar(ctx, reiniciar(ctx)),
};

/**
 * Apaga o banco local e semeia de novo. Nenhuma chamada à API: o emitente, as notas e a credencial
 * continuam na plataforma exatamente como estavam. O que morre aqui são os dois segredos que a API
 * mostra uma única vez — o da credencial operacional e o do webhook —, e por isso o formulário
 * exige a confirmação em vez de disparar num clique.
 */
function reiniciar({ form, banco }: Contexto): Resultado {
  if (form.get('confirmar') !== 'sim') return { ok: false, titulo: 'Nada foi apagado', detalhe: 'Marque a confirmação para recomeçar do zero.' };
  const antes = banco.configuracao();
  banco.reiniciar();
  const perdidos = [antes.credencialSecret && 'o secret da credencial operacional', antes.webhookSecret && 'o segredo do webhook'].filter(Boolean).join(' e ');
  return {
    ok: true,
    titulo: 'Banco local recomeçado do zero',
    detalhe: `Emitente, credencial, notas, operações, eventos e cadastros locais apagados; produtos e destinatário de exemplo semeados de novo. Nada foi chamado na API: o que existe na plataforma continua lá.${perdidos ? ` Foi-se ${perdidos}: a API os mostra uma vez só. Para voltar, vincule uma credencial na tela Emitente ou cunhe outra no painel.` : ''}`,
  };
}

async function renderizar(ctx: Contexto, ultimo: Resultado): Promise<Resposta> {
  const { config, banco, cliente, chamadas } = ctx;
  const cfg = banco.configuracao();

  let contexto: Resultado;
  try {
    const { corpo } = await cliente.contexto(config.gestao);
    const escopoCerto = corpo.escopo === 'integrador';
    contexto = {
      ok: escopoCerto,
      titulo: escopoCerto
        ? 'Credencial de gestão reconhecida'
        : `A credencial do .env tem escopo "${corpo.escopo}", e esta aplicação espera uma de gestão`,
      detalhe: escopoCerto
        ? 'Escopo de integrador: cadastra emitentes e cunha credenciais. Não emite. A credencial que emite é cunhada na tela Emitente.'
        : 'Gere no painel, em Credenciais & Webhooks, uma credencial sem escolher emitente.',
      corpo,
    };
  } catch (erro) {
    contexto = resultadoDeErro('GET /v1/contexto falhou', erro);
  }

  const corpo = html`
<h1>Configuração</h1>
${resultado(ultimo)}
<section>
  <h2>Lido do <code>.env</code></h2>
  <div class="grid">
    <p><b>Endereço-base</b><br>${config.enderecoBase}</p>
    <p><b>Credencial de gestão</b><br><code>${config.gestao.clientId}</code> : <code>${mascarar(config.gestao.secret)}</code></p>
    <p><b>Certificado</b><br>${config.certificado.caminho ? html`<code>${config.certificado.caminho}</code>` : 'não configurado (só faz falta ao cadastrar um emitente novo)'}</p>
    <p><b>Banco local</b><br><code>${config.banco}</code></p>
  </div>
  <p>O ambiente não é configurado em lugar nenhum: a credencial é de um emitente, e o emitente é de um ambiente. O <span class="rota">GET /v1/contexto</span> abaixo diz qual.</p>
</section>
${resultado(contexto)}
<section>
  <h2>Aprendido conversando com a API (banco local)</h2>
  <div class="grid">
    <p><b>Emitente</b><br>${cfg.emitenteId ?? 'ainda não cadastrado'}</p>
    <p><b>Credencial operacional</b><br>${cfg.credencialClientId ? html`<code>${cfg.credencialClientId}</code> : <code>${mascarar(cfg.credencialSecret ?? '')}</code>` : 'ainda não cunhada'}</p>
    <p><b>Segredo do webhook</b><br>${cfg.webhookSecret ? mascarar(cfg.webhookSecret) : 'nenhum'}</p>
    <p><b>Cursor do feed</b><br>${cfg.cursorFeed}</p>
  </div>
  <p>Tudo isto fica em claro no arquivo do banco. Não o commite.</p>
</section>
${blocoRecomecar(Boolean(cfg.emitenteId || cfg.credencialClientId))}`;

  return { html: pagina('Configuração', '/configuracao', corpo, chamadas) };
}

/** O botão de recomeçar. Fica atrás de uma confirmação porque dois segredos se perdem com ele. */
function blocoRecomecar(temEstado: boolean): Html {
  return html`<section>
  <h2>Recomeçar do zero</h2>
  <p>Apaga o banco local inteiro — emitente, credencial operacional, segredo do webhook, cursor do feed, notas, operações, eventos, produtos e destinatários — e semeia os dados de exemplo outra vez. É o que fazer para <b>trocar de emitente</b> sem misturar as notas de um com as do outro.</p>
  <p><b>Não chama a API.</b> O emitente continua cadastrado, as notas emitidas continuam autorizadas e a credencial continua válida na plataforma. ${
    temEstado
      ? html`O que se perde é local e irrecuperável: os <code>secret</code> da credencial operacional e do webhook, que a API mostra <b>uma única vez</b>. Anote-os antes, ou cunhe outros no painel depois.`
      : vazio
  }</p>
  <form method="post" action="/configuracao/reiniciar">
    <label><input type="checkbox" name="confirmar" value="sim" required style="min-width:auto"> Sim, apagar o banco local</label>
    <button>Recomeçar do zero</button>
  </form>
</section>`;
}
