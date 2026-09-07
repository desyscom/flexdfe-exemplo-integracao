// HTML renderizado no servidor, sem JavaScript no navegador. Feio de propósito: a tela existe
// para mostrar as chamadas à API, não para ser produto.

import type { Chamada } from './cliente-api.ts';
import { ErroApi } from './cliente-api.ts';

export function escapar(valor: unknown): string {
  return String(valor ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Um trecho de HTML já seguro. É o que `html` devolve, e o que passa por ela sem ser escapado. */
export class Html {
  readonly texto: string;
  constructor(texto: string) {
    this.texto = texto;
  }
  toString(): string {
    return this.texto;
  }
}

/** Template literal que escapa tudo que interpola, exceto o que já é `Html` (ou array de `Html`). */
export function html(partes: TemplateStringsArray, ...valores: unknown[]): Html {
  const seguro = (v: unknown): string => (v instanceof Html ? v.texto : Array.isArray(v) ? v.map(seguro).join('') : escapar(v));
  return new Html(partes.reduce((acc, parte, i) => acc + seguro(valores[i - 1]) + parte));
}

export const bruto = (texto: string): Html => new Html(texto);
export const vazio = new Html('');

const TELAS: [caminho: string, nome: string][] = [
  ['/configuracao', 'Configuração'],
  ['/emitente', 'Emitente'],
];

export function pagina(titulo: string, ativa: string, corpo: Html, chamadas: Chamada[]): string {
  return html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo} · Exemplo Flex DFe</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; color: #1a1a1a; background: #fafafa; }
  header { background: #0b3d91; color: #fff; padding: .6rem 1.2rem; display: flex; gap: 1.5rem; align-items: baseline; }
  header a { color: #cfe0ff; text-decoration: none; } header a.ativa { color: #fff; font-weight: 600; border-bottom: 2px solid #fff; }
  main { max-width: 60rem; margin: 0 auto; padding: 1.2rem; }
  section { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 1rem 1.2rem; margin-bottom: 1rem; }
  h1 { font-size: 1.4rem; margin: .2rem 0 1rem; } h2 { font-size: 1.05rem; margin: 0 0 .6rem; }
  .rota { font-family: ui-monospace, monospace; font-size: .85rem; color: #555; background: #f1f4f9; padding: .1rem .4rem; border-radius: 3px; }
  .ok { border-left: 4px solid #2e7d32; } .erro { border-left: 4px solid #c62828; } .pendente { border-left: 4px solid #999; opacity: .7; }
  label { display: block; margin: .4rem 0 .1rem; font-size: .9rem; } input, select { padding: .3rem .4rem; min-width: 14rem; }
  button { padding: .4rem .9rem; margin-top: .6rem; cursor: pointer; }
  pre { background: #f6f6f6; padding: .6rem; overflow-x: auto; font-size: .8rem; }
  table { border-collapse: collapse; } td, th { border-bottom: 1px solid #eee; padding: .2rem .6rem; text-align: left; font-size: .9rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 0 1rem; }
  footer { font-size: .8rem; color: #666; }
</style>
</head>
<body>
<header><strong>Exemplo Flex DFe</strong>${TELAS.map(([c, n]) => html`<a href="${c}" class="${c === ativa ? 'ativa' : ''}">${n}</a>`)}<span style="margin-left:auto;font-size:.8rem">homologação</span></header>
<main>
${corpo}
<footer><section><h2>Chamadas à API nesta página</h2>${tabelaChamadas(chamadas)}</section></footer>
</main>
</body>
</html>`.texto;
}

function tabelaChamadas(chamadas: Chamada[]): Html {
  if (chamadas.length === 0) return html`<p>Nenhuma.</p>`;
  return html`<table><tr><th>Rota</th><th>Status</th><th>ms</th></tr>${chamadas.map(
    (c) => html`<tr><td><span class="rota">${c.metodo} ${c.caminho}</span></td><td>${c.status}</td><td>${c.ms}</td></tr>`,
  )}</table>`;
}

export type Resultado = { ok: boolean; titulo: string; detalhe?: string; corpo?: unknown } | null;

/** Um bloco de resultado para mostrar sucesso ou o envelope de erro tal como veio. */
export function resultado(r: Resultado): Html {
  if (!r) return vazio;
  return html`<section class="${r.ok ? 'ok' : 'erro'}"><h2>${r.titulo}</h2>${r.detalhe ? html`<p>${r.detalhe}</p>` : vazio}${
    r.corpo !== undefined ? html`<pre>${JSON.stringify(r.corpo, null, 2)}</pre>` : vazio
  }</section>`;
}

/** Traduz um erro qualquer no bloco de resultado, sem esconder o envelope. */
export function resultadoDeErro(titulo: string, erro: unknown): Resultado {
  if (erro instanceof ErroApi) {
    const envelope = erro.type ? 'application/problem+json' : 'json com { erro }';
    return {
      ok: false,
      titulo: `${titulo}: HTTP ${erro.status}`,
      detalhe: `Envelope ${envelope}. ${erro.type ? `type = ${erro.type}` : 'sem type: é a autenticação falando'}.`,
      corpo: erro.type ? { type: erro.type, title: erro.title, detail: erro.detail } : { erro: erro.erro },
    };
  }
  return { ok: false, titulo, detalhe: erro instanceof Error ? erro.message : String(erro) };
}
