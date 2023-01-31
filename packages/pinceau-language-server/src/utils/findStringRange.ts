import { Position } from 'vscode-languageserver'

export function findStringRange (text: string, target: string, position: Position, delimiter = '{'): { start: number, end: number } | void {
  if (text.includes(target)) {
    const lastIndex = text.lastIndexOf(delimiter, position.character)
    const start = text.indexOf(target, lastIndex)

    if (lastIndex === -1 || start === -1) { return }

    return {
      start,
      end: start + target.length
    }
  }
}
