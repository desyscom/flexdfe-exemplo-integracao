// O servidor da tela. `node:http` cru, formulários POST clássicos, uma função por rota da tela.
// Cada requisição cria o cliente da API com um registrador de chamadas, para a página listar as
// rotas que consumiu.
//
// O mesmo processo também recebe o webhook (`POST /webhook`): a rota lê o corpo cru, porque a
// assinatura HMAC é conferida sobre os bytes recebidos, não sobre o JSON re-serializado.

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import type { Banco } from './banco.ts';
import { criarClienteApi, type Chamada, type ClienteApi } from './cliente-api.ts';
import { acoesConfiguracao, telaConfiguracao } from './telas/configuracao.ts';
import { acoesEmitente, telaEmitente } from './telas/emitente.ts';
import { acoesProdutos, telaProdutos } from './telas/produtos.ts';
import { acoesDestinatarios, telaDestinatarios } from './telas/destinatarios.ts';
import { acoesNovaNota, telaNovaNota } from './telas/nova-nota.ts';
import { acoesNotas, leiturasNotas, telaNota, telaNotas } from './telas/notas.ts';
import { acoesInutilizacao, telaInutilizacao } from './telas/inutilizacao.ts';
import { acoesEventos, telaEventos } from './telas/eventos.ts';
import { receptorWebhook } from './telas/webhook.ts';

export type Deps = { config: Config; banco: Banco };

export type Contexto = Deps & {
  cliente: ClienteApi;
  chamadas: Chamada[];
  /** Campos do formulário, quando o método é POST. */
  form: URLSearchParams;
  /** Segmentos `:nome` da rota, ex.: `/notas/:id/xml`. */
  params: Record<string, string>;
  /** O corpo como chegou, byte a byte. O receptor de webhook assina sobre ele. */
  corpoCru: Buffer;
  cabecalhos: IncomingHttpHeaders;
};

export type Resposta =
  | { status?: number; html: string }
  | { redirecionar: string }
  | { arquivo: { bytes: Buffer; contentType: string; nome: string; inline?: boolean } }
  | { status: number; texto: string };

export type Rota = (ctx: Contexto) => Promise<Resposta>;

export function criarApp(deps: Deps): Server {
  const rotas: [string, Rota][] = [
    ['GET /', async () => ({ redirecionar: '/configuracao' })],
    ['GET /configuracao', telaConfiguracao],
    ...acoes('/configuracao', acoesConfiguracao),
    ['GET /emitente', telaEmitente],
    ...acoes('/emitente', acoesEmitente),
    ['GET /produtos', telaProdutos],
    ...acoes('/produtos', acoesProdutos),
    ['GET /destinatarios', telaDestinatarios],
    ...acoes('/destinatarios', acoesDestinatarios),
    ['GET /nova-nota', telaNovaNota],
    ...acoes('/nova-nota', acoesNovaNota),
    ['GET /notas', telaNotas],
    ['GET /notas/:id', telaNota],
    ...Object.entries(leiturasNotas).map(([nome, rota]): [string, Rota] => [`GET /notas/:id/${nome}`, rota]),
    ...Object.entries(acoesNotas).map(([nome, rota]): [string, Rota] => [`POST /notas/:id/${nome}`, rota]),
    ['GET /inutilizacao', telaInutilizacao],
    ...acoes('/inutilizacao', acoesInutilizacao),
    ['GET /eventos', telaEventos],
    ...acoes('/eventos', acoesEventos),
    ['POST /webhook', receptorWebhook],
  ];

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const encontrada = casar(rotas, `${req.method} ${url.pathname}`);
    if (!encontrada) return responder(res, 404, `Não há ${req.method} ${url.pathname} nesta aplicação.`);

    const corpoCru = req.method === 'POST' ? await lerCorpo(req) : Buffer.alloc(0);
    const chamadas: Chamada[] = [];
    const ctx: Contexto = {
      ...deps,
      cliente: criarClienteApi({ enderecoBase: deps.config.enderecoBase, aoChamar: (c) => chamadas.push(c) }),
      chamadas,
      form: new URLSearchParams(req.headers['content-type']?.includes('x-www-form-urlencoded') ? corpoCru.toString('utf8') : ''),
      params: encontrada.params,
      corpoCru,
      cabecalhos: req.headers,
    };

    try {
      const resposta = await encontrada.rota(ctx);
      if ('redirecionar' in resposta) {
        res.writeHead(303, { Location: resposta.redirecionar });
        return res.end();
      }
      if ('arquivo' in resposta) {
        const a = resposta.arquivo;
        res.writeHead(200, {
          'Content-Type': a.contentType,
          'Content-Disposition': `${a.inline ? 'inline' : 'attachment'}; filename="${a.nome}"`,
          'Content-Length': a.bytes.length,
        });
        return res.end(a.bytes);
      }
      if ('texto' in resposta) return responder(res, resposta.status, resposta.texto);
      return responder(res, resposta.status ?? 200, resposta.html, 'text/html; charset=utf-8');
    } catch (erro) {
      // Erro que nenhuma tela tratou. As telas tratam os da API; este é defeito da aplicação.
      console.error(erro);
      return responder(res, 500, `Erro na aplicação de exemplo: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  });
}

/** `POST <prefixo>/<acao>` para cada ação da tela. */
const acoes = (prefixo: string, mapa: Record<string, Rota>): [string, Rota][] =>
  Object.entries(mapa).map(([acao, rota]) => [`POST ${prefixo}/${acao}`, rota]);

/** Casa `METODO /caminho` com os padrões, onde `:nome` casa um segmento e vira `params.nome`. */
function casar(rotas: [string, Rota][], chave: string): { rota: Rota; params: Record<string, string> } | null {
  const pedido = chave.split('/');
  for (const [padrao, rota] of rotas) {
    const partes = padrao.split('/');
    if (partes.length !== pedido.length) continue;
    const params: Record<string, string> = {};
    const bate = partes.every((parte, i) => {
      if (parte.startsWith(':')) {
        params[parte.slice(1)] = decodeURIComponent(pedido[i]);
        return true;
      }
      return parte === pedido[i];
    });
    if (bate) return { rota, params };
  }
  return null;
}

function lerCorpo(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolver, rejeitar) => {
    const partes: Buffer[] = [];
    req.on('data', (p: Buffer) => partes.push(p));
    req.on('end', () => resolver(Buffer.concat(partes)));
    req.on('error', rejeitar);
  });
}

function responder(res: ServerResponse, status: number, corpo: string, tipo = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': tipo });
  res.end(corpo);
}
