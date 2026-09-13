# Exemplo de integração com o Flex DFe

Uma aplicação mínima, para rodar na sua máquina, que percorre o ciclo inteiro de um emitente na API do [Flex DFe](https://flexdfe.com.br): cadastro, certificado, série, webhook, emissão de NF-e e NFC-e em homologação, acompanhamento pelo feed de eventos, XML, DANFE, consulta, cancelamento, carta de correção com o DACCE e inutilização.

É **código para ler**, não biblioteca para depender. Cada chamada HTTP fica num único arquivo, uma função por rota, escrita para que um programador de qualquer linguagem a leia como pseudocódigo. A tela existe para dar contexto às chamadas, não para ser produto.

## Implementações

| Pasta | Linguagem | Estado |
|---|---|---|
| [`node/`](node/) | TypeScript em Node, sem framework, sem dependência nativa | completa: testada contra a API na tag `v0.1.0` |

Outras linguagens entram ao lado, cada uma na sua pasta, sem mover a primeira. Cada implementação declara no próprio README a tag da API contra a qual foi testada.

## Antes de começar

Você precisa de uma conta no Flex DFe com uma **credencial de gestão**. O certificado A1 (`.pfx`) do CNPJ que vai emitir só é necessário para **cadastrar um emitente novo** pela API: se o emitente já existe no painel, o exemplo o adota informando a credencial **operacional** dele, e descobre o resto sozinho. O [tutorial de primeiros passos](https://flexdfe.com.br/tutorial) mostra como chegar até a credencial. A [Referência da API](https://flexdfe.com.br/docs) descreve cada rota que o exemplo consome.

O exemplo roda **em homologação**. Promover um emitente a produção é ato do cliente, no painel, e pede antes a série de produção: a série é por ambiente, e a de homologação não vai junto.

## Licença

MIT. Copie à vontade. Os códigos fiscais e as alíquotas dos dados de exemplo são plausíveis, não uma recomendação: a classificação fiscal de cada item é sua, e é o que o seu contador define.
