import { Position } from 'vscode-languageserver'

export function findStringRange (text: string, target: string, position: Position, delimiter = '{'): { line: number, start: number, end: number } | void {
  const lines = text.split('\n')
  if (!lines) { return }
  return lines.reduce(
    (acc, line, i) => {
      if (line.includes(target)) {
        const lastIndex = line.lastIndexOf(delimiter, position.character)
        const start = line.indexOf(target, lastIndex)
        const lineStart = text.indexOf(line)
        acc.line = i
        acc.start = lineStart + start
        acc.end = acc.start + target.length
      }
      return acc
    },
    {
      start: 0,
      end: 0,
      line: 0
    }
  )
}
