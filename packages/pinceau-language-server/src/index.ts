import path, { dirname } from 'node:path'
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  ColorInformation,
  FileChangeType,
  DiagnosticSeverity
} from 'vscode-languageserver/node'
import { Position, TextDocument } from 'vscode-languageserver-textdocument'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { uriToPath } from './utils/protocol'
import { findAll } from './utils/findAll'
import { isInFunctionExpression } from './utils/isInFunctionExpression'
import PinceauTokensManager, { PinceauVSCodeSettings, defaultSettings } from './PinceauTokensManager'
import { getCurrentLine } from './utils/getCurrentLine'
import { isInString } from './utils/isInString'
import { getHoveredToken, getHoveredTokenFunction } from './utils/getHoveredToken'
import { findStringRange } from './utils/findStringRange'
import { indexToPosition } from './utils/indexToPosition'

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all)

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)

let hasConfigurationCapability = false
let hasWorkspaceFolderCapability = false
let debug = false
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let hasDiagnosticRelatedInformationCapability = false
let rootPath: string

const pinceauTokensManager = new PinceauTokensManager()

connection.onInitialize((params: InitializeParams) => {
  console.log('🖌️ Booting Pinceau extension...')

  const capabilities = params.capabilities

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration)
  hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders)
  hasDiagnosticRelatedInformationCapability = !!(capabilities.textDocument && capabilities.textDocument.publishDiagnostics && capabilities.textDocument.publishDiagnostics.relatedInformation)

  connection.onInitialized(async () => {
    if (hasConfigurationCapability) {
      // Register for all configuration changes.
      connection.client.register(
        DidChangeConfigurationNotification.type,
        undefined
      )
    }
    if (hasWorkspaceFolderCapability) {
      connection.workspace.onDidChangeWorkspaceFolders((_event) => {
        connection.console.log('Workspace folder change event received.')
      })
    }

    const workspaceFolders = await connection.workspace.getWorkspaceFolders()
    const validFolders = workspaceFolders
      ?.map(folder => uriToPath(folder.uri) || '')
      .filter(path => !!path)

    rootPath = validFolders?.[0]

    const settings = await getDocumentSettings()
    debug = settings?.debug || false

    pinceauTokensManager.syncTokens(validFolders || [], settings)

    console.log('🖌️ Booted Pinceau extension!')
  })

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true
      },
      definitionProvider: true,
      hoverProvider: true,
      colorProvider: true
    }
  }

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true
      }
    }
  }

  return result
})

let globalSettings = defaultSettings

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<PinceauVSCodeSettings>> = new Map()

connection.onDidChangeConfiguration(async (change) => {
  debug && console.log('🖌️ onDidChangeConfiguration')

  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear()
    pinceauTokensManager.clearAllCache()

    const validFolders = await connection.workspace
      .getWorkspaceFolders()
      .then(folders =>
        folders
          ?.map(folder => uriToPath(folder.uri) || '')
          .filter(path => !!path)
      )

    const settings = await getDocumentSettings()

    pinceauTokensManager.syncTokens(validFolders || [], settings)
  } else {
    globalSettings = <PinceauVSCodeSettings>(
      (change.settings?.pinceau || defaultSettings)
    )
  }
})

function getDocumentSettings (): Thenable<PinceauVSCodeSettings> {
  debug && console.log('🖌️ getDocumentSettings')
  const resource = 'all'
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings)
  }
  let result = documentSettings.get(resource)
  if (!result) {
    result = connection.workspace.getConfiguration('pinceau')
    documentSettings.set(resource, result)
  }
  return result
}

// Only keep settings for open documents
documents.onDidClose(e => documentSettings.delete(e.document.uri))

connection.onDidChangeWatchedFiles(async (_change) => {
  const settings = await getDocumentSettings()

  // update cached variables
  return _change.changes.forEach(
    (change) => {
      const filePath = uriToPath(change.uri)
      debug && console.log('🖌️ fileChange', filePath)
      if (filePath) {
        // remove variables from cache
        if (change.type === FileChangeType.Deleted) {
          return pinceauTokensManager.clearFileCache(filePath)
        } else {
          return pinceauTokensManager.syncTokens([dirname(filePath)], settings)
        }
      }
    }
  )
})

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    debug && console.log('🖌️ onCompletion')
    const doc = documents.get(_textDocumentPosition.textDocument.uri)
    if (!doc) { return [] }
    const items: CompletionItem[] = []

    const ext = path.extname(doc.uri).slice(1)
    const offset = doc.offsetAt(_textDocumentPosition.position)

    const position = doc.positionAt(offset)
    const currentLine = getCurrentLine(doc, position)

    // Resolve Vue <style> contexts
    const styleTsBlocks: [number, number][] = []
    if (ext === 'vue') {
      try {
        const parsedVueComponent = parseSfc(doc.getText())
        parsedVueComponent.descriptor.styles.forEach(styleTag => styleTsBlocks.push([styleTag.loc.start.offset, styleTag.loc.end.offset]))
      } catch (e) {
        // console.log({ e })
      }
    }

    const isTokenFunctionCall = currentLine ? isInFunctionExpression(currentLine.text, position) : false
    const isOffsetOnStyleTsTag = styleTsBlocks.some(([start, end]) => isBetween(offset, start, end))
    const isInStringExpression = currentLine ? isInString(currentLine.text, position) : false

    const isResponsiveToken = token => !!((token?.value as any)?.initial)
    const stringifiedValue = token => isResponsiveToken(token)
      ? Object.entries(token.value).map(([key, value]) => `@${key}: ${value}`).join('\n')
      : token.value?.toString() || token?.value

    // Debug output
    debug && console.log({ completion: { ext, offset, position, currentLine, isTokenFunctionCall, isOffsetOnStyleTsTag, isInStringExpression } })

    // Create completion symbols
    if (isTokenFunctionCall || (isOffsetOnStyleTsTag && isInStringExpression)) {
      pinceauTokensManager.getAll().forEach((token) => {
        if (!token?.name || !token?.value) { return }

        const insertText = isTokenFunctionCall ? token?.name : `{${token.name}}`

        const originalString = stringifiedValue({ value: token?.original })
        const configValue = originalString ? `⚙️ Config value:\n${originalString}` : undefined
        const stringValue = stringifiedValue(token)
        const sourcePath = token?.definition?.uri.replace(rootPath || '', '')
        const source = sourcePath ? `📎 Source:\n${sourcePath}` : ''

        const completion: CompletionItem = {
          label: token?.name,
          detail: stringValue?.split?.('\n')?.[0],
          documentation: `${configValue}${sourcePath ? '\n\n' + source : ''}`,
          insertText,
          kind: CompletionItemKind.Color,
          sortText: token?.name
        }

        if (isTokenFunctionCall) { completion.detail = token.value?.toString() }

        items.push(completion)
      })
    }

    return items
  }
)

// This handler resolves additional information for the item selected in the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  debug && console.log('🖌️ onCompletionResolve')
  return item
})

connection.onDocumentColor(async (params): Promise<ColorInformation[]> => {
  debug && console.log('🖌️ onDocumentColor')

  const doc = documents.get(params.textDocument.uri)
  if (!doc) { return [] }

  const colors: ColorInformation[] = []

  // const ext = path.extname(doc.uri).slice(1)
  const text = doc.getText()
  const referencesRegex = /{([a-zA-Z0-9.]+)}/g
  const dtRegex = /\$dt\(['|`|"]([a-zA-Z0-9.]+)['|`|"](?:,\s*(['|`|"]([a-zA-Z0-9.]+)['|`|"]))?\)?/g
  const dtMatches = findAll(dtRegex, text)
  const tokenMatches = findAll(referencesRegex, text)

  const globalStart: Position = { line: 0, character: 0 }

  for (const match of [...dtMatches, ...tokenMatches]) {
    const isDt = match[0].startsWith('$dt')
    const start = indexToPosition(text, isDt ? match.index : match.index + 1)
    const end = indexToPosition(text, match.index + match[1].length)

    const token = pinceauTokensManager.getAll().get(match[1])

    if (pinceauTokensManager.getInitialized() && !token && text.charAt(match.index - 1) !== '$' && !match[1].includes(' ')) {
      await connection.sendDiagnostics({
        uri: params.textDocument.uri,
        diagnostics: [{
          message: `🖌️ Theme token not found: \`${match[1]}\``,
          range: { start, end },
          severity: DiagnosticSeverity.Hint
        }]
      })
    }

    if (token?.color) {
      const range = {
        start: {
          line: globalStart.line + start.line,
          character: (end.line === 0 ? globalStart.character : 0) + start.character
        },
        end: {
          line: globalStart.line + end.line,
          character: (end.line === 0 ? globalStart.character : 0) + end.character
        }
      }

      colors.push({
        color: token?.color,
        range
      })
    }
  }

  return colors
})

connection.onHover((params) => {
  debug && console.log('🖌️ onHover')

  const doc = documents.get(params.textDocument.uri)
  if (!doc) { return }

  let token
  token = getHoveredToken(doc, params.position)
  if (!token) { token = getHoveredTokenFunction(doc, params.position) }
  if (!token) { return }

  const cssVariable = pinceauTokensManager.getAll().get(token.token)

  debug && console.log({ hover: { token, cssVariable } })

  if (cssVariable) { return { contents: `⚙️ ${(cssVariable.value as any)?.initial || cssVariable.value}`, code: '', message: '', data: {}, name: '' } }
})

connection.onColorPresentation((params) => {
  debug && console.log('🖌️ onColorPresentation')

  if (!pinceauTokensManager.getInitialized()) { return }

  const document = documents.get(params.textDocument.uri)
  const className = document.getText(params.range)
  if (!className) { return [] }
  return []
})

connection.onDefinition((params) => {
  debug && console.log('🖌️ onDefinition')

  if (!pinceauTokensManager.getInitialized()) { return }

  const doc = documents.get(params.textDocument.uri)
  if (!doc) { return null }
  const currentLine = getCurrentLine(doc, params.position)
  if (!currentLine) { return }
  let delimiter = '{'
  let currentToken = getHoveredToken(doc, params.position)
  if (!currentToken) {
    currentToken = getHoveredTokenFunction(doc, params.position)
    if (currentToken) { delimiter = '$dt(' }
  }
  if (!currentToken) { return }

  let token = pinceauTokensManager.getAll().get(currentToken.token)

  // Try to resolve from parent token
  if (!token?.definition) {
    const currentTokenPath = currentToken.token.split('.')
    currentTokenPath.pop()
    token = pinceauTokensManager.getAll().get(currentTokenPath.join('.'))
  }

  // No token found
  if (!token?.definition) { return }

  const inlineRange = findStringRange(currentLine.text, currentToken.token, params.position, delimiter)

  // Debug output
  if (debug) { console.log({ definition: { currentToken, token, inlineRange } }) }

  if (token?.definition && inlineRange) {
    return [
      {
        uri: doc.uri,
        targetUri: token.definition.uri,
        range: {
          start: { character: inlineRange.start, line: params.position.line },
          end: { character: inlineRange.end, line: params.position.line }
        },
        targetRange: {
          start: { character: (token.definition.range.start as any).column, line: token.definition.range.start.line - 1 },
          end: { character: (token.definition.range.start as any).column, line: token.definition.range.start.line - 1 }
        },
        targetSelectionRange: {
          start: { character: (token.definition.range.start as any).column, line: token.definition.range.start.line - 1 },
          end: { character: (token.definition.range.end as any).column, line: token.definition.range.end.line - 1 }
        },
        originSelectionRange: {
          start: { line: params.position.line, character: inlineRange.start },
          end: { line: params.position.line, character: inlineRange.end }
        }
      }
    ]
  }
})

documents.listen(connection)

connection.listen()

function isBetween (x: number, a: number, b: number) {
  return (x >= a && x <= b)
}
