# Exemplo em Node

Uma tela local, sem framework, que percorre o ciclo inteiro do emitente na API do Flex DFe: cadastro, certificado, série, emissão de NF-e e NFC-e e de NFS-e Padrão Nacional, feed, webhook, XML, DANFE e DANFSe, consulta, cancelamento, substituição, carta de correção com o DACCE e inutilização. TypeScript executado direto pelo Node, sem build; SQLite pelo módulo nativo, sem nada para compilar.

> Testado contra a API na tag **v0.3.1**. Se a Referência em `/docs` mudou depois disso, o que está aqui pode ter envelhecido. Não há CI nem smoke automatizado: a tag é a única defesa, junto com os testes, que só pegam a divergência depois que a API falsa for atualizada a partir da Referência.
>
> **O fluxo da NFS-e ainda não foi rodado contra a API de verdade.** O código, a API falsa e a cópia dos schemas seguem o contrato da **v0.5.0**, a primeira com a família `/v1/nfse`, mas a tag acima só muda depois de uma rodada real em homologação. Até lá, trate as telas Nova NFS-e e NFS-e como leitura do contrato, não como prova de que a SEFIN as aceita.

## Pré-requisitos

- Node **22.15 ou mais novo** (o `npm start` roda `.ts` direto e usa `node:sqlite`). O `node:sqlite` é estável desde a 22.13; a execução de `.ts` só deixa de precisar de flag na 22.18, e é por isso que os scripts passam `--experimental-strip-types`, inofensivo nas versões que já o dispensam.
- Uma **credencial de gestão** do Flex DFe: no painel, em Credenciais & Webhooks, gere uma credencial **sem** escolher emitente. O `secret` aparece uma única vez.
- O **certificado A1** (`.pfx`) do CNPJ que vai emitir, e a senha dele — **só** se você for cadastrar um emitente novo pela API. Se o emitente já existe no painel, com certificado e credencial operacional, não precisa: o atalho do passo 1 dispensa este pré-requisito.

## Configurar

```bash
cp .env.exemplo .env
```

Preencha `FLEXDFE_CLIENT_ID` e `FLEXDFE_SECRET`. `CERTIFICADO_PFX` e `CERTIFICADO_SENHA` são opcionais: só o cadastro de um emitente **novo** os usa. O restante tem padrão.

Para começar de novo — trocar de emitente, por exemplo —, use **Recomeçar do zero** na tela Configuração; apagar o arquivo do banco à mão faz o mesmo.

**Nunca commite `.env`, o `.pfx` nem o arquivo do banco.** O `.gitignore` deste repositório já os exclui; se copiar o código para o seu, leve a exclusão junto. **O banco SQLite guarda em claro a credencial operacional e o segredo do webhook**: é o custo de você configurar uma credencial só e a aplicação cunhar a outra. Trate o arquivo como trata o `.env`.

## Rodar

```bash
npm install
npm start
```

Abra `http://localhost:3080`. Só escuta em `localhost`. O exemplo roda em **homologação**, e a tela diz isso no canto; promover um emitente a produção é ato do cliente, no painel.

Para ver a tela funcionando **sem credencial nem certificado**, contra a API falsa dos testes:

```bash
node --disable-warning=ExperimentalWarning --experimental-strip-types test/demo.ts
```

## O ciclo, passo a passo

Cada tela consome rotas nomeadas da API, escritas no cabeçalho do arquivo dela em `src/telas/`, e cada página lista no rodapé as chamadas que fez, com status e tempo.

1. **Configuração** mostra o que veio do `.env` e chama `GET /v1/contexto` para provar a credencial e o escopo. A emissão não tem parâmetro de ambiente: a credencial é de um emitente, e a nota sai no ambiente dele. O ambiente muda no próprio emitente, e as rotas de série aceitam um `ambiente` opcional para operar no outro; este exemplo não usa nenhum dos dois.

   É também onde fica **Recomeçar do zero**, que apaga o banco local inteiro e semeia os dados de exemplo de novo — o caminho para **trocar de emitente** sem misturar as notas de um com as do outro. Não chama a API: o emitente continua cadastrado, as notas emitidas continuam autorizadas e a credencial continua válida. O que se perde é local e irrecuperável: os `secret` da credencial operacional e do webhook, que a API mostra uma única vez. Por isso o botão exige confirmação.

2. **Emitente** são seis passos, na ordem que a API exige:

   | # | Passo | Rota | Credencial |
   |---|---|---|---|
   | 1 | Cadastrar o emitente | `POST /v1/emitentes` | gestão |
   | 2 | Subir o certificado (base64 num JSON, com a senha) | `PUT /v1/emitentes/{id}/certificado` | gestão |
   | 3 | Ativar (exige certificado) | `PATCH /v1/emitentes/{id}` | gestão |
   | 4 | Cunhar a credencial **operacional** e guardá-la | `POST /v1/credenciais` | gestão |
   | 5 | Provisionar séries gerenciadas, 55, 65 e DPS, no ambiente atual | `POST /v1/series` | operacional |
   | 6 | Webhook (opcional; HTTPS pública) | `PUT /v1/emitentes/{id}/webhook` | operacional |

   A tela tem ainda uma seção **NFS-e Padrão Nacional**, com o que ela pede a mais, na ordem da API: a **inscrição municipal** (no cadastro, ou depois pelo `PATCH`), a **consulta de convênio** do município (entre o certificado e a ativação, e opcional) e a **série de DPS**, que é o próprio passo 5, escolhendo `dps` em Documento. Veja *A NFS-e* abaixo.

   A credencial de gestão **não emite**. A que emite é a operacional, que o passo 4 cunha a partir dela e guarda no banco local. Você só configura uma.

   **A série é por ambiente e por documento.** A série 1 de NF-e e a série 1 de DPS (a declaração da NFS-e) são duas, cada uma com o seu próximo número. A NF-e e a NFC-e se pedem pelo `modelo`, na faixa de 0 a 999; a DPS não tem modelo, se pede só pelo `tipoDocumento`, e a faixa dela é de 1 a 49999. Homologação e produção numeram separado: a série 1 de homologação e a de produção são duas, cada uma com o seu próximo número. Sem `ambiente` no corpo, o passo 5 provisiona no ambiente atual do emitente, que aqui é homologação. A promoção não cria a série de produção, e sem ela a primeira nota de produção volta `404 series-not-provisioned`: convém provisioná-la antes de promover. O guia *Séries e numeração* da [Referência](https://flexdfe.com.br/docs) mostra como.

   **Atalho, quando o emitente já existe na plataforma.** Os passos de 1 a 4 são o onboarding pela API, e existem porque um integrador precisa fazê-lo. Se o emitente já foi cadastrado no painel — com certificado, ativo, e com uma credencial **operacional** cunhada lá —, informe essa credencial no atalho do passo 1: a aplicação chama `GET /v1/contexto` para descobrir de quem ela é e `GET /v1/emitentes/{id}` para trazer a ficha, guarda as duas coisas no banco local e vai direto para a série. Duas leituras, nenhuma escrita, e nada é criado na plataforma. É o que um ERP faz de verdade quando o cliente entrega uma credencial pronta: a integração nunca cadastra ninguém, só se apresenta.

   Uma diferença fica: o cadastro pela API move o destinatário semeado para o município do emitente, e o atalho não consegue, porque a leitura do emitente publica município e UF mas não o código IBGE. Se as UFs divergirem, a tela avisa e o ajuste é na tela Destinatários.

3. **Produtos** e **Destinatários** são cadastros locais mínimos, já semeados: três produtos tributados nas duas variantes (Simples Nacional por `csosn`, Regime Normal por `cst`) e um destinatário com o nome que a SEFAZ exige em homologação. Qual variante vai para a nota é decidido pelo **CRT do emitente** cadastrado. Os códigos e as alíquotas são plausíveis, não uma recomendação: a classificação fiscal de cada item é sua, e é o que o seu contador define.

   Duas coisas que a plataforma faz com o `documento` e que aparecem quando se compara o enviado com o XML autorizado:
   - **Em homologação, a descrição do primeiro item é trocada** pela frase que a SEFAZ exige, `NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL`, nos dois modelos. O nome do destinatário a plataforma não troca, e é por isso que ele vem semeado.
   - **Na NFC-e, o CFOP, o CST e o CSOSN de cada item são conferidos** contra os códigos que a SEFAZ aceita no modelo 65. Os semeados passam; um código trocado na tela Produtos que fique fora deles volta como `failed`, com a regra no motivo.

4. **Nova nota** escolhe modelo 55 ou 65, destinatário (opcional no 65), itens e pagamento. A tela confere a soma dos pagamentos contra o total dos itens, monta o `documento`, gera a `Idempotency-Key`, **grava a nota antes de chamar** e só então faz `POST /v1/nfe?wait=8000`. Desfecho dentro do `wait` é gravado; estouro deixa a nota "processando".

5. **Eventos** puxa `GET /v1/nfe/events` a partir do cursor guardado, aplica cada evento (idempotente por `seq`, tipo desconhecido é gravado e ignorado) e grava o cursor **por último**. É o feed que fecha a emissão, o cancelamento, a carta e a inutilização, cada um pelo `type` do evento. O histórico bruto mostra a origem de cada evento, `feed` ou `webhook`, e o efeito que teve. A NFS-e tem o feed dela (`GET /v1/nfse/events`) e o cursor dela: veja *A NFS-e*.

6. **Notas** lista com o status local e diz quem o pôs ali: a resposta da emissão ("do wait"), o feed ou o webhook. Cada linha oferece só o que a situação permite, e o detalhe da nota tem os formulários:
   - **XML** só na autorizada; **DANFE** na autorizada e na cancelada.
   - **Consultar** pede a verdade à SEFAZ. É assíncrona e não gera evento: o resultado vem ao **reler** a nota, e é a releitura que a tela grava. Detecta um cancelamento feito por fora e destrava uma nota presa em processando.
   - **Cancelar** só na autorizada. Vai só a justificativa; a tela confere tamanho e caracteres antes de chamar, e a API responderia `422 cancellation-reason-invalid` e `409 nfe-not-cancelable` pelos mesmos motivos. O aceite devolve o id de um comando **novo**; a nota segue autorizada até o feed trazer o `nfe.cancel` dele.
   - **Carta de correção** só na NF-e (55) autorizada; a NFC-e não tem o instrumento. O formulário já vem com a correção vigente, porque **a última carta substitui todas as anteriores**: o texto é cumulativo. O histórico das cartas, inclusive as que não corrigiram nada, vem de `GET /v1/nfe/{id}/cce`, e cada carta **registrada** oferece o **DACCE**, o documento da carta que o emitente entrega ao destinatário; o DANFE da nota não muda com a correção.
   - **Reenviar (mesma chave)** enquanto a nota está em voo: prova que é replay, não uma segunda nota.
   - **Reemitir (chave nova)** só depois de `failed`. Veja abaixo.

   Uma nota **reconciliando** é a que a SEFAZ já autorizou e cuja gravação a plataforma está refazendo, depois de um erro interno. O detalhe explica e manda esperar: ela vira autorizada sozinha, e emitir de novo criaria uma segunda nota para a mesma venda.

7. **Inutilização** declara à SEFAZ que uma faixa de números de uma série não será usada. A tela confere a **forma** dos campos e nada mais, porque a API também só confere a forma: se a faixa procede, se `nNFIni ≤ nNFFin`, é a SEFAZ que decide, e a recusa dela volta como desfecho rejeitado, não como `422`. Experimente uma faixa invertida.

8. **Webhook** é opcional, com túnel. Veja a seção própria.

### As rotas, por tela

| Tela | Rota | Credencial |
|---|---|---|
| Configuração | `GET /v1/contexto` (o reset do banco local não chama nada) | gestão |
| Emitente | as seis da tabela acima | gestão, depois operacional |
| Nova nota | `GET /v1/emitentes/{id}`, `POST /v1/nfe?wait=8000` (com `Idempotency-Key`) | operacional |
| Notas | `GET /v1/nfe/{id}`, `GET /v1/nfe/{id}/xml`, `GET /v1/nfe/{id}/danfe`, `POST /v1/nfe/{id}/consulta`, `POST /v1/nfe/{id}/cancelamento`, `GET /v1/nfe/{id}/cancelamento`, `POST /v1/nfe/{id}/cce`, `GET /v1/nfe/{id}/cce`, `GET /v1/nfe/{id}/cce/{cartaId}/dacce` | operacional |
| Inutilização | `POST /v1/inutilizacoes?wait=8000` (com `Idempotency-Key`) | operacional |
| Emitente, seção NFS-e | `PATCH /v1/emitentes/{id}` (a inscrição municipal), `POST /v1/emitentes/{id}/consultas-convenio` | gestão |
| Nova NFS-e | `GET /v1/emitentes/{id}`, `POST /v1/nfse?wait=8000` (com `Idempotency-Key`) | operacional |
| NFS-e | `POST /v1/nfse?wait=8000` (reenviar e substituir), `GET /v1/nfse/{id}`, `GET /v1/nfse/{id}/xml`, `GET /v1/nfse/{id}/danfse`, `POST /v1/nfse/{id}/consulta`, `POST /v1/nfse/{id}/cancelamento`, `GET /v1/nfse/{id}/cancelamento` | operacional |
| Eventos | `GET /v1/nfe/events`, `GET /v1/nfe/{id}`, `GET /v1/nfe/{id}/cancelamento`, `GET /v1/nfe/{id}/cce`, `GET /v1/nfse/events`, `GET /v1/nfse/{id}`, `GET /v1/nfse/{id}/cancelamento` | operacional |

**O status local nunca vem da resposta da emissão além do `id` e do status inicial.** É o feed, com o webhook como aviso, que fecha o desfecho. É a lição que este exemplo existe para ensinar.

## A NFS-e Padrão Nacional

A NFS-e é **outra família** na API (`/v1/nfse`), e não uma nota com outro modelo: o `id` de uma NF-e responde `404` nas rotas da NFS-e, e o de uma NFS-e responde `404` nas da NF-e. Por isso o exemplo tem tabela, telas e cliente próprios, e o mesmo molde da NF-e: a `Idempotency-Key` e o corpo gravados **antes** da chamada, o `wait` e o feed como fonte de verdade.

**O onboarding tem três coisas a mais**, todas na tela Emitente:

- **A inscrição municipal** vai no `prest.im` de toda DPS, e a que vale é a do **CNC NFS-e** (o "Indicador Municipal" do Emissor Nacional), que pode não ser a do cartão nem a do alvará. A SEFIN recusa a DPS com a IM ausente ou errada (`E0116`, que dispensa o MEI) e com a que o CNC não registra para o CNPJ no município (`E0120`).
- **A consulta de convênio** pergunta ao Ambiente de Dados Nacional o que o município publicou, por código de município. O `veredito` diz se a parametrização **veio**, e não se o município aderiu ao Sistema Nacional; a consulta **não bloqueia a emissão**; e o `503` do ADN fora do ar se repete, porque indisponibilidade não é negativa. Antes da ativação ela vai com a credencial de gestão, porque a do emitente só autentica depois dela.
- **A série de DPS** é provisionada como a de NF-e, mas por `tipoDocumento: "dps"`, sem `modelo`, na faixa de 1 a 49999.

**A emissão** (Nova NFS-e) monta o `documento` da DPS com o mínimo de ponta a ponta: competência, tomador (CPF, CNPJ ou CNPJ alfanumérico, sem pontuação), serviço e valor. O prestador, o `dhEmi`, a série, o número e o ambiente são da plataforma, e o que vier deles no documento é ignorado, então a tela nem os pede. **O `totTrib` segue o regime**: o ME/EPP (CRT 1 e 2) leva `pTotTribSN`, porque o ramo `indTotTrib` lhe é vedado (`E0712`), e os outros levam `indTotTrib: "0"`. O código de tributação nacional que a tela traz é plausível, não uma recomendação: o enquadramento do seu serviço é o que o seu contador define, e é ele que o município parametriza.

**O desfecho** chega pelo feed da NFS-e, `GET /v1/nfse/events`, e pelo webhook, que é um só e leva as duas famílias (o `type` as distingue). Os dois feeds **dividem a numeração do `seq`**, então cada um enxerga como buraco o `seq` do outro, e **cada um tem o seu cursor**: com um só, o cursor da NF-e passaria do `seq` de uma NFS-e que concluiu antes dela, e o feed da NFS-e a perderia. A tabela de eventos continua uma só, porque o `seq` é único entre as famílias.

**A tela NFS-e** lista com o status local e oferece o que a situação permite:

- **XML** e **DANFSe** existem depois de a DPS virar NFS-e (antes é `409 nfse-xml-unavailable` e `409 nfse-danfse-unavailable`) e seguem na cancelada e na substituída, o DANFSe com a marca da situação atual.
- **Consultar** é assíncrona, não leva `Idempotency-Key` e não gera evento: a releitura traz o cancelamento feito fora da plataforma, com a origem (`pedido`, `analise-fiscal` ou `oficio`).
- **Cancelar** só na autorizada, com o código (`1` erro na emissão, `2` serviço não prestado, `9` outros) e a justificativa. O aceite devolve o id de um comando **novo**, e a NFS-e segue autorizada até o feed trazer o `nfse.cancel` dele, que sai **sem `outcome`**: quem diz como a tentativa terminou é a leitura de `GET /v1/nfse/{id}/cancelamento`. O prazo é do município, e a plataforma não o confere: a recusa por prazo vem da SEFIN, como tentativa rejeitada.
- **Substituir** é uma emissão nova com `substituicao` no corpo, que leva o `id` que a plataforma devolveu no aceite da original. A SEFIN gera a substituta e cancela a original no mesmo envio, e a original só vira substituída quando o feed fecha a substituta, que a tela então relê. O formulário parte do que a original informou, porque a SEFIN recusa com `E0063` a substituta de um prestador que era ME/EPP e que muda a competência, o valor ou o tomador, e a plataforma não confere isso antes do envio.

**O que o exemplo não faz:** reabrir uma DPS rejeitada no mesmo `numeroDps` (`reabrir: true`; emitir de novo toma o próximo número), a lista com filtros e os agregados (`GET /v1/nfse`, `GET /v1/nfse/agregados`), e os grupos opcionais da DPS (obra, evento, exportação, reforma tributária).

## `failed` e `blocked` não são a mesma coisa

Os dois são terminais sem nota autorizada, e cada um se conserta num lugar diferente. A tela distingue pelo `status`, nunca pelo texto do motivo.

| | `failed` | `blocked` |
|---|---|---|
| O que houve | A plataforma parou **antes** da SEFAZ (recusa antecipada) ou esgotou as tentativas | A **numeração** não deixou a nota sair: a SEFAZ acusou duplicidade, ou a série foi inativada, esgotou ou trocou de modo depois do aceite |
| O motivo | Traz o **caminho do campo** que reprovou, ex.: `PIS_COFINS_AUSENTE em /det[1]/imposto/PIS` | Diz a causa. Na série inativada, esgotada ou que trocou de modo, diz também o ajuste, ex.: `a série está inativa e não aceita número novo; reative-a ou envie a nota por outra série` |
| O que a tela oferece | **Reemitir com chave nova** (o mesmo corpo, outra `Idempotency-Key`) e consultar | **Consultar**. Na duplicidade, revise a numeração; na série, faça o ajuste que o motivo diz. Os dois são fora da nota, e só quem opera sabe quando foram feitos; feito o ajuste, a nota se emite de novo em Nova nota. Reenviar com a mesma chave só devolveria a nota bloqueada |

A nota que falhou fica no histórico local; a reemissão nasce apontando para ela.

## Os erros

Dois envelopes, separados pelo `Content-Type` e não pelo status HTTP. `application/problem+json` nas rotas de negócio, com um `type` estável; `application/json` com `{ "erro": "..." }` na autenticação, sem `type`. O cliente (`src/cliente-api.ts`) lê os dois e a tela mostra o que veio.

**Programe contra o `type`, nunca contra o `title`.** O título é humano e muda sem aviso. A API falsa dos testes troca o `title` a cada resposta de propósito, e um teste varre o código-fonte procurando ramo pelo título.

**`429` é a borda, não a API.** Não traz envelope nem `type`. O cliente lê o `Retry-After`, espera e repete a **mesma** requisição com a **mesma** `Idempotency-Key`: como a escrita é idempotente, repetir é seguro; trocar a chave é que criaria uma segunda nota. O rodapé da página mostra cada tentativa.

## Webhook (opcional, com túnel)

O mesmo processo recebe `POST /webhook`: lê o corpo cru, confere `X-Signature` (HMAC SHA-256) em tempo constante, descarta assinatura inválida, aceita entrega repetida sem efeito e aplica o evento pelo mesmo caminho do feed. A API só entrega em HTTPS num host público, então, para receber na sua máquina, exponha a porta com um túnel (`cloudflared tunnel --url http://localhost:3080`, ou `ngrok http 3080`) e cadastre a URL pública dele mais `/webhook` no passo 6 da tela Emitente. Sem túnel, tudo funciona pelo feed.

## Onde ler o código

- `src/cliente-api.ts`: **uma função por rota**. É o arquivo para portar quando o seu ERP fala outra linguagem. Ali estão o HTTP Basic, os dois envelopes de erro, o recuo no `429` e o comentário de qual escopo cada rota exige.
- `src/telas/`: uma tela por arquivo, com as rotas que consome no cabeçalho. `notas.ts` tem a lista, o detalhe e as operações sobre a nota; `inutilizacao.ts` a faixa; `webhook.ts` é o receptor.
- `src/documento.ts`: como o `documento` é montado a partir dos cadastros, e a escolha da variante pelo CRT.
- `src/documento-nfse.ts`: o mesmo para a DPS da NFS-e, com o ramo do `totTrib` escolhido pelo CRT. `src/telas/nova-nfse.ts` e `src/telas/nfse.ts` são as telas dela.
- `src/texto-sefaz.ts`: a restrição de leiaute que a justificativa e o texto da carta obedecem, conferida antes da chamada.
- `src/eventos.ts`: o único caminho que muda o status local depois da emissão e fecha as operações; o feed e o webhook entram por ele.
- `src/banco.ts`: o que a aplicação lembra entre uma requisição e outra, inclusive a tabela `operacao`.
- `schema/nfe-data.schema.json` e `schema/nfse-data.schema.json`: o JSON Schema do campo `documento` da emissão de NF-e e de NFS-e, copiados do Flex DFe na tag indicada no `$comment`. Nenhum código os importa: são para ler ao lado do documento que a aplicação monta.

## Testes

```bash
npm test
```

Sobem a aplicação e uma **API falsa** em processo, e dirigem a tela por HTTP. Não precisam de credencial nem de rede. A API falsa (`test/api-falsa.ts`) é escrita à mão a partir da Referência: se o contrato mudar, é ali que a divergência aparece. Os cenários cobrem o cadastro até a série, a emissão nos dois modelos, o feed reentrante, o webhook, a consulta, o cancelamento recusado e registrado, a carta cumulativa e recusada no 65, o DACCE só na carta registrada, a inutilização, `failed` e `blocked` nas ações oferecidas, a nota `reconciliando`, e o `429` com `Retry-After`. Os da NFS-e cobrem o onboarding (a IM, o convênio com o ADN fora do ar, a série de DPS), o `totTrib` por regime, o corpo da DPS, o feed com o cursor próprio, o webhook das duas famílias, a consulta, o cancelamento recusado e registrado, a substituição e o XML e o DANFSe.

`npm run check` roda a checagem de tipos e os testes.
