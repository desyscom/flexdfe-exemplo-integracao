// Configuração lida do `.env`. Só o que o programador precisa preencher à mão; tudo o que a
// aplicação aprende conversando com a API (id do emitente, credencial operacional) vai para o banco.

import { existsSync } from 'node:fs';

export type Credencial = {
  /** O `client_id`, a parte antes do `:` no HTTP Basic. */
  clientId: string;
  /** O `secret`, a parte depois do `:`. Aparece uma única vez quando a credencial é cunhada. */
  secret: string;
};

export type Config = {
  enderecoBase: string;
  /** Credencial de gestão (escopo de integrador). Cadastra, não emite. */
  gestao: Credencial;
  certificado: { caminho: string; senha: string };
  banco: string;
  porta: number;
};

export function carregarConfig(env: NodeJS.ProcessEnv = process.env, arquivo = '.env'): Config {
  if (env === process.env && existsSync(arquivo)) process.loadEnvFile(arquivo);

  const obrigatoria = (nome: string): string => {
    const valor = env[nome]?.trim();
    if (!valor) throw new Error(`Falta ${nome} no .env (veja .env.exemplo).`);
    return valor;
  };

  return {
    enderecoBase: obrigatoria('FLEXDFE_URL').replace(/\/+$/, ''),
    gestao: { clientId: obrigatoria('FLEXDFE_CLIENT_ID'), secret: obrigatoria('FLEXDFE_SECRET') },
    certificado: { caminho: obrigatoria('CERTIFICADO_PFX'), senha: env.CERTIFICADO_SENHA ?? '' },
    banco: env.BANCO?.trim() || './exemplo.sqlite',
    porta: Number(env.PORTA ?? 3080),
  };
}
