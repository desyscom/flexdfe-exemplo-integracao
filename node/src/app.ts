// O servidor da tela. `node:http` cru, formulários POST clássicos, uma função por rota da tela.
// Cada requisição cria o cliente da API com um registrador de chamadas, para a página listar as
// rotas que consumiu.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import type { Banco } from './banco.ts';
import { criarClienteApi, type Chamada, type ClienteApi } from './cliente-api.ts';
import { telaConfiguracao } from './telas/configuracao.ts';
import { acoesEmitente, telaEmitente } from './telas/emitente.ts';

export type Deps = { config: Config; banco: Banco };

export type Contexto = Deps & {
  cliente: ClienteApi;
  chamadas: Chamada[];
  /** Campos do formulário, quando o método é POST. */
  form: URLSearchParams;
};

export type Resposta = { status?: number; html: string } | { redirecionar: string };

export type Rota = (ctx: Contexto) => Promise<Resposta>;

export function criarApp(deps: Deps): Server {
  const rotas = new Map<string, Rota>([
    ['GET /', async () => ({ redirecionar: '/configuracao' })],
    ['GET /configuracao', telaConfiguracao],
    ['GET /emitente', telaEmitente],
    ...Object.entries(acoesEmitente).map(([acao, rota]): [string, Rota] => [`POST /emitente/${acao}`, rota]),
  ]);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chave = `${req.method} ${url.pathname}`;
    const rota = rotas.get(chave);
    if (!rota) return responder(res, 404, `Não há ${chave} nesta aplicação.`);

    const chamadas: Chamada[] = [];
    const ctx: Contexto = {
      ...deps,
      cliente: criarClienteApi({ enderecoBase: deps.config.enderecoBase, aoChamar: (c) => chamadas.push(c) }),
      chamadas,
      form: req.method === 'POST' ? await lerFormulario(req) : new URLSearchParams(),
    };

    try {
      const resposta = await rota(ctx);
      if ('redirecionar' in resposta) {
        res.writeHead(303, { Location: resposta.redirecionar });
        return res.end();
      }
      return responder(res, resposta.status ?? 200, resposta.html, 'text/html; charset=utf-8');
    } catch (erro) {
      // Erro que nenhuma tela tratou. As telas tratam os da API; este é defeito da aplicação.
      console.error(erro);
      return responder(res, 500, `Erro na aplicação de exemplo: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  });
}

function lerFormulario(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolver, rejeitar) => {
    const partes: Buffer[] = [];
    req.on('data', (p: Buffer) => partes.push(p));
    req.on('end', () => resolver(new URLSearchParams(Buffer.concat(partes).toString('utf8'))));
    req.on('error', rejeitar);
  });
}

function responder(res: ServerResponse, status: number, corpo: string, tipo = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': tipo });
  res.end(corpo);
}
