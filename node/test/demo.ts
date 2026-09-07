// Sobe a tela contra a API FALSA, para ver o exemplo funcionando sem credencial nem certificado:
//   node --disable-warning=ExperimentalWarning test/demo.ts
// Tudo em memória; feche o processo e nada sobra.

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiFalsa } from './api-falsa.ts';
import { Banco } from '../src/banco.ts';
import { criarApp } from '../src/app.ts';

const api = new ApiFalsa();
const enderecoBase = await api.iniciar();
const pfx = join(mkdtempSync(join(tmpdir(), 'flexdfe-demo-')), 'demo.pfx');
writeFileSync(pfx, api.conteudoPfxDoTitular);

const porta = Number(process.env.PORTA ?? 3080);
const app = criarApp({
  config: {
    enderecoBase,
    gestao: { clientId: 'gestao', secret: 'segredo-gestao' },
    certificado: { caminho: pfx, senha: api.senhaCerta },
    banco: ':memory:',
    porta,
  },
  banco: new Banco(':memory:'),
});
app.listen(porta, '127.0.0.1', () => console.log(`Demo em http://localhost:${porta}  (API falsa em ${enderecoBase})`));
