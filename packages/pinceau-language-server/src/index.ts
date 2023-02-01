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
  Diagnostic
} from 'vscode-languageserver/node'
import { Position, Range, TextDocument } from 'vscode-languageserver-textdocument'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { DesignToken } from 'pinceau/index'
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
let rootPath: string

const pinceauTokensManager = new PinceauTokensManager()

connection.onInitialize((params: InitializeParams) => {
  connection.console.log('🖌️ Booting Pinceau extension...')

  const capabilities = params.capabilities

  hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration)
  hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders)

  connection.onInitialized(async () => {
    if (hasConfigurationCapability) {
      // Register for all configuration changes.
      connection.client.register(
        DidChangeConfigurationNotification.type,
        undefined
      )
    }
    if (hasWorkspaceFolderCapability) {
      connection.workspace.onDidChangeWorkspaceFolders(_event => connection.console.log('Workspace folder change event received.'))
    }

    const workspaceFolders = await connection.workspace.getWorkspaceFolders()
    const validFolders = workspaceFolders
      ?.map(folder => uriToPath(folder.uri) || '')
      .filter(path => !!path)

    rootPath = validFolders?.[0]

    const settings = await getDocumentSettings()
    debug = settings?.debug || false

    await pinceauTokensManager.syncTokens(validFolders || [], settings)

    connection.console.log('🖌️ Booted Pinceau extension!')
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
      colorProvider: true,
      inlineValueProvider: true
    }
  }

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
        changeNotifications: true
      }
    }
  }

  return result
})

let globalSettings = defaultSettings

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<PinceauVSCodeSettings>> = new Map()

connection.onDidChangeConfiguration(async (change) => {
  debug && connection.console.log('⌛ onDidChangeConfiguration')

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
  debug && connection.console.log('⌛ getDocumentSettings')
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

connection.onDidChangeWatchedFiles(async (_change) => {
  const settings = await getDocumentSettings()

  // Update cached tokens
  return _change.changes.forEach(
    (change) => {
      const filePath = uriToPath(change.uri)
      debug && connection.console.log(`⌛ fileChange ${filePath}`)
      if (filePath) {
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
connection.onCompletion(async (_textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[]> => {
  if (pinceauTokensManager.synchronizing) { await pinceauTokensManager.synchronizing }

  debug && connection.console.log('⌛ onCompletion')

  const doc = documents.get(_textDocumentPosition.textDocument.uri)
  if (!doc) { return [] }

  const { isInStringExpression, isOffsetOnStyleTsTag, isTokenFunctionCall } = getCursorContext(doc, _textDocumentPosition.position)

  // Create completion symbols
  const items: CompletionItem[] = []
  if (isTokenFunctionCall || ((doc.uri.includes('tokens.config.ts') || isOffsetOnStyleTsTag) && isInStringExpression)) {
    pinceauTokensManager.getAll().forEach((token) => {
      if (!token?.name || !token?.value) { return }

      const insertText = isTokenFunctionCall ? token?.name : `{${token.name}}`

      const originalString = stringifiedValue({ value: token?.original })
      const configValue = originalString ? `🎨 Config value:\n${originalString}` : undefined
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

      items.push(completion)
    })
  }
  return items
}
)

// This handler resolves additional information for the item selected in the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  debug && connection.console.log('⌛ onCompletionResolve')
  return item
})

connection.onDocumentColor(async (params): Promise<ColorInformation[]> => {
  if (pinceauTokensManager.synchronizing) { await pinceauTokensManager.synchronizing }

  debug && connection.console.log('⌛ onDocumentColor')

  const doc = documents.get(params.textDocument.uri)
  if (!doc) { return [] }

  const colors: ColorInformation[] = []

  const settings = await getDocumentSettings()

  getDocumentTokens(
    doc,
    settings,
    ({ range, token }) => {
      if ((token as any)?.color) {
        colors.push({
          color: (token as any)?.color,
          range
        })
      }
    }
  )

  return colors
})

connection.onHover(async (params) => {
  if (pinceauTokensManager.synchronizing) { await pinceauTokensManager.synchronizing }

  debug && connection.console.log('⌛ onHover')

  const doc = documents.get(params.textDocument.uri)
  if (!doc) { return }

  const { token } = getClosestToken(doc, params.position)

  if (token) { return { contents: `🎨 ${(token.value as any)?.initial || token.value}`, code: '', message: '', data: {}, name: '' } }
})

connection.onColorPresentation((params) => {
  debug && connection.console.log('⌛ onColorPresentation')

  if (!pinceauTokensManager.initialized) { return }

  const document = documents.get(params.textDocument.uri)
  const className = document.getText(params.range)

  if (!className) { return [] }

  return []
})

connection.onDefinition(async (params) => {
  if (pinceauTokensManager.synchronizing) { await pinceauTokensManager.synchronizing }

  debug && connection.console.log('⌛ onDefinition')

  if (!pinceauTokensManager.initialized) { return }

  const doc = documents.get(params.textDocument.uri)
  if (!doc) { return null }

  const { token, lineRange } = getClosestToken(doc, params.position)

  if (token?.definition && lineRange) {
    return [
      {
        uri: doc.uri,
        targetUri: token.definition.uri,
        range: {
          start: { character: lineRange.start, line: params.position.line },
          end: { character: lineRange.end, line: params.position.line }
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
          start: { line: params.position.line, character: lineRange.start },
          end: { line: params.position.line, character: lineRange.end }
        }
      }
    ]
  }
})

documents.onDidChangeContent(async (params) => {
  const settings = await getDocumentSettings()
  const diagnostics: Diagnostic[] = []
  const text = params.document.getText()

  getDocumentTokens(
    params.document,
    settings,
    ({ range, token, tokenPath, match }) => {
      if (pinceauTokensManager.initialized && !token && !tokenPath.includes(' ') && text.charAt(match.index - 1) !== '$') {
        debug && console.warn(`🎨 Token not found: ${tokenPath}`)

        const settingsSeverity = (['error', 'warning', 'information', 'hint', 'disable'].indexOf(settings.missingTokenHintSeverity) + 1) as 1 | 2 | 3 | 4 | 5

        if (settingsSeverity === 5) { return }

        diagnostics.push({
          message: `🎨 Token '${tokenPath}' not found.`,
          range: {
            start: {
              character: range.start.character + 1,
              line: range.start.line
            },
            end: {
              character: range.end.character + 1,
              line: range.start.line
            }
          },
          severity: settingsSeverity,
          code: tokenPath
        })
      }
    }
  )

  connection.sendDiagnostics({
    uri: params.document.uri,
    version: params.document.version,
    diagnostics
  })
})

// Only keep settings for open documents
documents.onDidClose(e => documentSettings.delete(e.document.uri))

documents.listen(connection)

connection.listen()

/**
 * Get all the tokens from the document and call a callback on it.
 */
function getDocumentTokens (
  doc: TextDocument,
  settings?: PinceauVSCodeSettings,
  onToken?: (token: { match: RegExpMatchArray, tokenPath: string, token: DesignToken, range: Range, settings: PinceauVSCodeSettings }) => void
) {
  const colors: ColorInformation[] = []

  const text = doc.getText()
  const referencesRegex = /{([a-zA-Z0-9.]+)}/g
  const dtRegex = /\$dt\(['|`|"]([a-zA-Z0-9.]+)['|`|"](?:,\s*(['|`|"]([a-zA-Z0-9.]+)['|`|"]))?\)?/g
  const dtMatches = findAll(dtRegex, text)
  const tokenMatches = findAll(referencesRegex, text)

  const globalStart: Position = { line: 0, character: 0 }

  for (const match of [...dtMatches, ...tokenMatches]) {
    const tokenPath = match[1]
    const start = indexToPosition(text, match.index)
    const end = indexToPosition(text, match.index + tokenPath.length)

    const token = pinceauTokensManager.getAll().get(tokenPath)

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

    onToken({
      match,
      tokenPath,
      token,
      range,
      settings
    })
  }

  return colors
}

/**
 * Get the closest token starting from a cursor position.
 *
 * Useful for hover/definition.
 */
function getClosestToken (doc: TextDocument, position: Position) {
  const toRet: {
    delimiter: string
    currentLine?: { text: string, range: { start: number; end: number; } }
    currentToken?: { token: string, range: { start: number; end: number; } }
    closestToken?: any
    token?: any
    lineRange?: { start: number, end: number }
  } = {
    delimiter: '{',
    currentToken: undefined,
    currentLine: undefined,
    closestToken: undefined,
    token: undefined,
    lineRange: undefined
  }

  toRet.currentLine = getCurrentLine(doc, position)
  if (!toRet.currentLine) { return }

  // Try to grab `{}` syntax
  toRet.currentToken = getHoveredToken(doc, position)

  // Try to grab `$dt()` syntax
  if (!toRet.currentToken) {
    toRet.currentToken = getHoveredTokenFunction(doc, position)
    if (toRet.currentToken) { toRet.delimiter = '$dt(' }
  }

  // No syntax found
  if (!toRet.currentToken) { return toRet }

  toRet.token = pinceauTokensManager.getAll().get(toRet.currentToken.token)

  // Try to resolve from parent token
  if (!toRet?.token?.definitions) {
    let currentTokenPath = toRet.currentToken.token.split('.')
    while (currentTokenPath.length) {
      toRet.currentToken.token = currentTokenPath.join('.')
      toRet.closestToken = pinceauTokensManager.getAll().get(toRet.currentToken.token)
      if (toRet.closestToken) { currentTokenPath = [] }
      currentTokenPath = currentTokenPath.splice(1)
    }
  }

  toRet.lineRange = findStringRange(toRet.currentLine.text, toRet.currentToken.token, position, toRet.delimiter)

  return toRet
}

/**
 * Get the context of the current cursor position.
 *
 * Useful for completions
 */
function getCursorContext (doc: TextDocument, position: Position) {
  const ext = path.extname(doc.uri).slice(1)
  const offset = doc.offsetAt(position)
  const currentLine = getCurrentLine(doc, position)

  // Resolve Vue <style> contexts
  const styleTsBlocks: [number, number][] = []
  if (ext === 'vue') {
    try {
      const parsedVueComponent = parseSfc(doc.getText())
      parsedVueComponent.descriptor.styles.forEach(styleTag => styleTsBlocks.push([styleTag.loc.start.offset, styleTag.loc.end.offset]))
    } catch (e) {}
  }

  const isTokenFunctionCall = currentLine ? isInFunctionExpression(currentLine.text, position) : false
  const isOffsetOnStyleTsTag = styleTsBlocks.some(([start, end]) => (offset >= start && offset <= end))
  const isInStringExpression = currentLine ? isInString(currentLine.text, position) : false

  return {
    position,
    currentLine,
    styleTsBlocks,
    isTokenFunctionCall,
    isOffsetOnStyleTsTag,
    isInStringExpression
  }
}

/**
 * Check if a token is responsive expression or not
 */
function isResponsiveToken (token) { return !!((token?.value as any)?.initial) }

/**
 * Return stringified value of a token (to display in hints).
 */
function stringifiedValue (token) {
  return isResponsiveToken(token)
    ? Object.entries(token.value).map(([key, value]) => `@${key}: ${value}`).join('\n')
    : token.value?.toString() || token?.value
}
