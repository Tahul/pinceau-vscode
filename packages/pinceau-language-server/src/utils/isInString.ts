import { Position } from 'vscode-languageserver'

export function isInString (text: string, position: Position): boolean {
  const index = position.character
  const quoteStart = text.lastIndexOf("'", index)
  const doubleQuoteStart = text.lastIndexOf('"', index)
  const backtickStart = text.lastIndexOf('`', index)

  const quoteEnd = text.indexOf("'", index)
  const doubleQuoteEnd = text.indexOf('"', index)
  const backtickEnd = text.indexOf('`', index)

  return ((quoteStart < quoteEnd && quoteStart !== -1) ||
    (doubleQuoteStart < doubleQuoteEnd && doubleQuoteStart !== -1) ||
    (backtickStart < backtickEnd && backtickStart !== -1))
}
