// Ponto de entrada: `npm start`. Lê o `.env`, abre o banco e sobe a tela em localhost.

import { carregarConfig } from './config.ts';
import { Banco } from './banco.ts';
import { criarApp } from './app.ts';

const config = carregarConfig();
const banco = new Banco(config.banco);
const app = criarApp({ config, banco });

app.listen(config.porta, '127.0.0.1', () => {
  console.log(`Exemplo Flex DFe em http://localhost:${config.porta}/  (API: ${config.enderecoBase})`);
});
