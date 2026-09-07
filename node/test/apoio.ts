// Sobe a API falsa e a aplicação, em processo, em portas efêmeras, com o banco em memória.
// Os testes falam com a aplicação pela mesma porta que o programador usa: a tela.

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ApiFalsa } from './api-falsa.ts';
import { Banco } from '../src/banco.ts';
import { criarApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';

export type Pagina = { status: number; html: string; texto: string };

/** Desfaz o escape do HTML, para as asserções lerem o que o programador lê na tela. */
export const decodificar = (html: string): string =>
  html.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

export type Cenario = {
  api: ApiFalsa;
  banco: Banco;
  config: Config;
  base: string;
  /** GET de uma tela; devolve status, o HTML cru e o texto com as entidades decodificadas. */
  get: (caminho: string) => Promise<Pagina>;
  /** POST de um formulário da tela. */
  post: (caminho: string, campos?: Record<string, string>) => Promise<Pagina>;
  encerrar: () => Promise<void>;
};

export async function subir(opcoes: { senha?: string; conteudoPfx?: string } = {}): Promise<Cenario> {
  const api = new ApiFalsa();
  const enderecoBase = await api.iniciar();

  const pasta = mkdtempSync(join(tmpdir(), 'flexdfe-exemplo-'));
  const pfx = join(pasta, 'teste.pfx');
  writeFileSync(pfx, opcoes.conteudoPfx ?? api.conteudoPfxDoTitular);

  const config: Config = {
    enderecoBase,
    gestao: { clientId: 'gestao', secret: 'segredo-gestao' },
    certificado: { caminho: pfx, senha: opcoes.senha ?? api.senhaCerta },
    banco: ':memory:',
    porta: 0,
  };
  const banco = new Banco(':memory:');
  const app = criarApp({ config, banco });
  await new Promise<void>((ok) => app.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  const ler = async (r: Response): Promise<Pagina> => {
    const html = await r.text();
    return { status: r.status, html, texto: decodificar(html) };
  };
  return {
    api,
    banco,
    config,
    base,
    get: (caminho) => fetch(base + caminho, { redirect: 'manual' }).then(ler),
    post: (caminho, campos = {}) =>
      fetch(base + caminho, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(campos).toString() }).then(ler),
    encerrar: async () => {
      await new Promise<void>((ok) => app.close(() => ok()));
      await api.parar();
      banco.fechar();
    },
  };
}

export const EMITENTE_VALIDO = {
  cnpj: '12.345.678/0001-95',
  razao_social: 'Loja Exemplo Ltda',
  inscricao_estadual: 'ISENTO',
  crt: '1',
  logradouro: 'Rua das Flores',
  numero: '100',
  bairro: 'Centro',
  cod_municipio: '4314100',
  municipio: 'Parobé',
  uf: 'rs',
  cep: '95630-000',
};
