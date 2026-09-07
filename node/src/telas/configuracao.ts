// Tela Configuração: o que veio do `.env`, com os segredos mascarados, e o eco do contexto.
//
// Rota consumida: GET /v1/contexto. É a primeira chamada que qualquer integração deveria fazer:
// prova que a credencial existe, diz o escopo dela e, na de gestão, lista os emitentes do grupo.

import type { Rota } from '../app.ts';
import { html, pagina, resultado, resultadoDeErro, type Resultado } from '../html.ts';

const mascarar = (valor: string): string => (valor.length <= 6 ? '••••' : valor.slice(0, 4) + '••••' + valor.slice(-2));

export const telaConfiguracao: Rota = async ({ config, banco, cliente, chamadas }) => {
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
<section>
  <h2>Lido do <code>.env</code></h2>
  <div class="grid">
    <p><b>Endereço-base</b><br>${config.enderecoBase}</p>
    <p><b>Credencial de gestão</b><br><code>${config.gestao.clientId}</code> : <code>${mascarar(config.gestao.secret)}</code></p>
    <p><b>Certificado</b><br><code>${config.certificado.caminho}</code></p>
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
</section>`;

  return { html: pagina('Configuração', '/configuracao', corpo, chamadas) };
};
