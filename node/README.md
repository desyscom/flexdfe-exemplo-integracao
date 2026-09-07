# Exemplo em Node

Uma tela local, sem framework, que percorre o ciclo do emitente na API do Flex DFe. TypeScript executado direto pelo Node, sem build; SQLite pelo módulo nativo, sem nada para compilar.

> Testado contra a API na tag **v0.1.0**. Se a Referência em `/docs` mudou depois disso, o que está aqui pode ter envelhecido.

## Pré-requisitos

- Node **22.18 ou mais novo** (o `npm start` roda `.ts` direto e usa `node:sqlite`).
- Uma **credencial de gestão** do Flex DFe: no painel, em Credenciais & Webhooks, gere uma credencial **sem** escolher emitente. O `secret` aparece uma única vez.
- O **certificado A1** (`.pfx`) do CNPJ que vai emitir, e a senha dele.

## Configurar

```bash
cp .env.exemplo .env
```

Preencha `FLEXDFE_CLIENT_ID`, `FLEXDFE_SECRET`, `CERTIFICADO_PFX` e `CERTIFICADO_SENHA`. O restante tem padrão.

**Nunca commite `.env`, o `.pfx` nem o arquivo do banco.** O `.gitignore` deste repositório já os exclui; se copiar o código para o seu, leve a exclusão junto. O banco guarda em claro a credencial operacional e o segredo do webhook.

## Rodar

```bash
npm install
npm start
```

Abra `http://localhost:3080`. Só escuta em `localhost`.

## O que a tela faz

**Configuração** mostra o que veio do `.env` e chama `GET /v1/contexto` para provar a credencial e o escopo. Não há parâmetro de ambiente em lugar nenhum: a credencial é de um emitente, e o emitente é de um ambiente. Este exemplo é de **homologação**.

**Emitente** são seis passos, na ordem que a API exige:

| # | Passo | Rota | Credencial |
|---|---|---|---|
| 1 | Cadastrar o emitente | `POST /v1/emitentes` | gestão |
| 2 | Subir o certificado (base64 num JSON, com a senha) | `PUT /v1/emitentes/{id}/certificado` | gestão |
| 3 | Ativar (exige certificado) | `PATCH /v1/emitentes/{id}` | gestão |
| 4 | Cunhar a credencial **operacional** e guardá-la | `POST /v1/credenciais` | gestão |
| 5 | Provisionar séries gerenciadas, 55 e 65 | `POST /v1/series` | operacional |
| 6 | Webhook (opcional; HTTPS pública) | `PUT /v1/emitentes/{id}/webhook` | operacional |

A credencial de gestão **não emite**. A que emite é a operacional, que o passo 4 cunha a partir dela e guarda no banco local. Você só configura uma.

**Produtos** e **Destinatários** são cadastros locais mínimos, já semeados: três produtos tributados nas duas variantes (Simples Nacional por `csosn`, Regime Normal por `cst`) e um destinatário com o nome que a SEFAZ exige em homologação. Qual variante vai para a nota é decidido pelo **CRT do emitente** cadastrado. Os códigos e as alíquotas são plausíveis, não uma recomendação: a classificação fiscal de cada item é sua.

**Nova nota** escolhe modelo 55 ou 65, destinatário (opcional no 65), itens e pagamento. A tela confere a soma dos pagamentos contra o total dos itens, monta o `documento`, gera a `Idempotency-Key`, **grava a nota antes de chamar** e só então faz `POST /v1/nfe?wait=8000`. Desfecho dentro do `wait` é gravado; estouro deixa a nota "processando".

**Notas** lista com o status local e diz quem o pôs ali: a resposta da emissão ("do wait"), o feed ou o webhook. XML só aparece na autorizada; DANFE, na autorizada e na cancelada. "Reenviar" manda o mesmo corpo com a mesma chave e prova que é replay, não uma segunda nota.

**Eventos** puxa `GET /v1/nfe/events` a partir do cursor guardado, aplica cada evento (idempotente por `seq`, tipo desconhecido é gravado e ignorado) e grava o cursor **por último**. O histórico bruto mostra a origem de cada evento, `feed` ou `webhook`.

| Tela | Rota | Credencial |
|---|---|---|
| Nova nota | `POST /v1/nfe?wait=8000` (com `Idempotency-Key`) | operacional |
| Notas | `GET /v1/nfe/{id}/xml`, `GET /v1/nfe/{id}/danfe` | operacional |
| Eventos | `GET /v1/nfe/events`, `GET /v1/nfe/{id}` | operacional |

**O status local nunca vem da resposta da emissão além do `id` e do status inicial.** É o feed, com o webhook como aviso, que fecha o desfecho. É a lição que este exemplo existe para ensinar.

### Webhook (opcional, com túnel)

O mesmo processo recebe `POST /webhook`: lê o corpo cru, confere `X-Signature` (HMAC SHA-256) em tempo constante, descarta assinatura inválida, aceita entrega repetida sem efeito e aplica o evento pelo mesmo caminho do feed. A API só entrega em HTTPS num host público, então, para receber na sua máquina, exponha a porta com um túnel (`cloudflared tunnel --url http://localhost:3080`, ou `ngrok http 3080`) e cadastre a URL pública dele mais `/webhook` no passo 6 da tela Emitente. Sem túnel, tudo funciona pelo feed.

Cada página lista, no rodapé, as chamadas à API que fez.

## Onde ler o código

- `src/cliente-api.ts`: **uma função por rota**. É o arquivo para portar quando o seu ERP fala outra linguagem. Ali estão o HTTP Basic, os dois envelopes de erro e o comentário de qual escopo cada rota exige.
- `src/telas/`: uma tela por arquivo, com as rotas que consome no cabeçalho. `webhook.ts` é o receptor.
- `src/documento.ts`: como o `documento` é montado a partir dos cadastros, e a escolha da variante pelo CRT.
- `src/eventos.ts`: o único caminho que muda o status local depois da emissão; o feed e o webhook entram por ele.
- `src/banco.ts`: o que a aplicação lembra entre uma requisição e outra.
- `schema/nfe-data.schema.json`: o JSON Schema do campo `documento` da emissão, copiado do Flex DFe na tag indicada no `$comment`.

## Testes

```bash
npm test
```

Sobem a aplicação e uma **API falsa** em processo, e dirigem a tela por HTTP. Não precisam de credencial nem de rede. A API falsa (`test/api-falsa.ts`) é escrita à mão a partir da Referência: se o contrato mudar, é ali que a divergência aparece.

`npm run check` roda a checagem de tipos e os testes.
