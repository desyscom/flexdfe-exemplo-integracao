// Tela Eventos: puxa o feed a partir do cursor guardado e mostra o histórico bruto do que chegou,
// do feed e do webhook, com a origem e o efeito de cada evento.
//
//   GET /v1/nfe/events?since=&limit=   operacional  o feed, a fonte de verdade
//   GET /v1/nfe/{id}                   operacional  a leitura que traz número, chave e situação
//
// A mecânica (idempotência por `seq`, cursor gravado por último, tipo desconhecido ignorado) está em
// `src/eventos.ts`, que o receptor de webhook também usa.

import type { Contexto, Resposta, Rota } from '../app.ts';
import { bruto, html, pagina, resultado, resultadoDeErro, type Resultado } from '../html.ts';
import { puxarFeed } from '../eventos.ts';

export const telaEventos: Rota = (ctx) => renderizar(ctx, null);

export const acoesEventos: Record<string, Rota> = {
  puxar: async (ctx) => renderizar(ctx, await puxar(ctx)),
};

async function puxar({ banco, cliente }: Contexto): Promise<Resultado> {
  const operacional = banco.credencialOperacional();
  if (!operacional) return { ok: false, titulo: 'O feed exige a credencial operacional' };
  try {
    const r = await puxarFeed({ banco, cliente, operacional });
    return {
      ok: true,
      titulo: `Feed lido: ${r.recebidos} evento(s) em ${r.paginas} página(s), cursor ${r.desde} → ${r.ate}`,
      detalhe: r.recebidos === 0 ? 'Nada novo. Um desfecho recém-criado pode aparecer com pequeno atraso: leia de novo.' : 'O cursor foi gravado depois de cada página aplicada.',
      corpo: r.efeitos.length ? r.efeitos : undefined,
    };
  } catch (erro) {
    return resultadoDeErro('Feed falhou', erro);
  }
}

async function renderizar({ banco, chamadas }: Contexto, ultimo: Resultado): Promise<Resposta> {
  const cfg = banco.configuracao();
  const eventos = banco.listarEventos();
  const corpo = html`
<h1>Eventos</h1>
<p>O feed é a fonte de verdade dos desfechos; o webhook é o aviso. Os dois entram pelo mesmo caminho (<code>aplicarEvento</code>), e é só por ele que o status local de uma nota muda depois da emissão.</p>
${resultado(ultimo)}
<section>
  <h2>Cursor guardado: ${cfg.cursorFeed}</h2>
  <p><span class="rota">GET /v1/nfe/events?since=${cfg.cursorFeed}</span> · <code>since</code> é exclusivo: o cursor é o último <code>seq</code> aplicado, e é gravado só depois de a página inteira ser aplicada. Reler de um cursor antigo é seguro: cada <code>seq</code> só tem efeito uma vez.</p>
  <form method="post" action="/eventos/puxar"><button>Puxar o feed</button></form>
</section>
<section>
  <h2>Histórico bruto</h2>
  ${eventos.length === 0 ? bruto('<p>Nenhum evento recebido ainda.</p>') : html`<table><tr><th>seq</th><th>type</th><th>status</th><th>outcome</th><th>comando</th><th>origem</th><th>recebido em</th><th>efeito</th></tr>
  ${eventos.map((e) => html`<tr><td>${e.seq}</td><td>${e.type}</td><td>${e.status}</td><td>${e.outcome ?? '-'}</td><td><code>${e.commandId}</code></td><td><b>${e.origem}</b></td><td>${e.recebidoEm}</td><td>${e.efeito}</td></tr>`)}</table>`}
</section>
<section>
  <h2>Receptor de webhook</h2>
  <p>Este processo aceita <span class="rota">POST /webhook</span>. Ele lê o corpo cru, confere <code>X-Signature</code> (HMAC SHA-256, em tempo constante) com o segredo guardado na tela Emitente, descarta assinatura inválida e aplica o evento pelo mesmo caminho do feed. Entrega repetida não tem efeito. Para a API alcançá-lo, exponha a porta com um túnel e cadastre a URL pública dele na tela Emitente. Veja <code>src/telas/webhook.ts</code>.</p>
</section>`;
  return { html: pagina('Eventos', '/eventos', corpo, chamadas) };
}
