import { Position } from 'vscode-languageserver'

export function isInFunctionExpression (line: string, position: Position): boolean {
  const lastIndex = line.lastIndexOf('(', position.character)
  const charBefore = line[lastIndex - 3] + line[lastIndex - 2] + line[lastIndex - 1] + line[lastIndex]
  if (charBefore === '$dt(') { return true }
  return false
}
