// A justificativa do cancelamento e da inutilização e o texto da carta de correção obedecem à mesma
// restrição de leiaute da SEFAZ: tamanho mínimo e máximo, só letras (acentuadas inclusive), dígitos,
// espaço e pontuação simples, sem espaço no início ou no fim. A API recusa com `422` na hora
// (`cancellation-reason-invalid`, `correction-text-invalid`); conferir aqui é mais barato do que
// gastar uma chamada, e mostra ao programador o que a SEFAZ aceita antes de ele esbarrar nela.
//
// A expressão é a mesma da Referência: `^(?:[!-ÿ][ -ÿ]*[!-ÿ]|[!-ÿ])$`. O intervalo `!`–`ÿ` é o
// Latin-1 imprimível; fora dele ficam quebra de linha, tabulação, travessão, aspas e reticências
// tipográficas, emoji e símbolos como `€`.

const ENVELOPE_SEFAZ = /^(?:[!-ÿ][ -ÿ]*[!-ÿ]|[!-ÿ])$/;

/** Devolve o motivo pelo qual o texto seria recusado, ou `null` quando ele passa. */
export function motivoTextoInvalido(texto: string, nome: string, minimo: number, maximo: number): string | null {
  if (texto.length < minimo || texto.length > maximo) return `${nome} tem ${texto.length} caracteres; a SEFAZ exige de ${minimo} a ${maximo}`;
  if (texto !== texto.trim()) return `${nome} não pode começar nem terminar com espaço`;
  if (!ENVELOPE_SEFAZ.test(texto)) {
    const posicao = [...texto].findIndex((c) => !/[ -ÿ]/.test(c));
    const culpado = posicao >= 0 ? JSON.stringify(texto[posicao]) : '?';
    return `${nome} tem caractere fora do envelope da SEFAZ na posição ${posicao + 1} (${culpado}): sem quebra de linha, travessão, aspas tipográficas, emoji ou símbolos`;
  }
  return null;
}

export const LIMITES = {
  /** `justificativa` do cancelamento e `xJust` da inutilização. */
  justificativa: { minimo: 15, maximo: 255 },
  /** `xCorrecao` da carta de correção. */
  correcao: { minimo: 15, maximo: 1000 },
} as const;
