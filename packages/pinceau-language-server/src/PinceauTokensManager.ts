import { Color, Location } from 'vscode-languageserver/node'
import type { DesignToken } from 'pinceau'
import fastGlob from 'fast-glob'
import createJITI from 'jiti'
import * as culori from 'culori'
import CacheManager from './CacheManager'
import isColor from './utils/isColor'
import { culoriColorToVscodeColor } from './utils/culoriColorToVscodeColor'

export interface PinceauVSCodeSettings {
  tokensOutput: string[];
  definitionsOutput: string[];
}

export const defaultSettings: PinceauVSCodeSettings = {
  tokensOutput: [
    '**/*/.nuxt/pinceau/index.ts',
    '**/*/node_modules/.vite/pinceau/index.ts'
  ],
  definitionsOutput: [
    '**/*/.nuxt/pinceau/definitions.ts',
    '**/*/node_modules/.vite/pinceau/definitions.ts'
  ]
}

async function globRequire (folderPath: string, globPaths: string[], cb: (filePath: string) => void) {
  return await fastGlob(
    globPaths,
    {
      cwd: folderPath,
      onlyFiles: true,
      absolute: true
    }
  ).then(files => Promise.all(files.map(cb)))
}

export default class PinceauTokensManager {
  public initialized = false
  private cacheManager = new CacheManager<DesignToken & { definition: Location; color?: Color }>()

  public async syncTokens (folders: string[], settings: PinceauVSCodeSettings) {
    for (const folderPath of folders) {
      // index.ts
      try {
        await globRequire(
          folderPath,
          settings?.tokensOutput || defaultSettings.tokensOutput,
          (filePath) => {
            const file = createJITI(folderPath)(filePath)
            this.updateCacheFromTokensContent({ content: file?.default || file, filePath })
          }
        )
      } catch (e) {
        console.log('Could not load theme file:', folderPath)
      }

      // defintions.ts
      try {
        await globRequire(
          folderPath,
          settings?.definitionsOutput || defaultSettings.definitionsOutput,
          (filePath) => {
            const file = createJITI(folderPath)(filePath)
            this.pushDefinitions({ content: file?.default || file, filePath })
          }
        )
      } catch (e) {
        console.log('Could not load definitions file:', folderPath)
      }
    }

    if (!this.initialized) { this.initialized = true }
  }

  public pushDefinitions ({
    content,
    filePath
  }: {
    content: any
    filePath: string
  }) {
    const indexFileName = filePath.replace('definitions.ts', 'index.ts')
    Object
      .entries(content.definitions)
      .forEach(
        ([key, definition]) => {
          const tokenValue = this.cacheManager.get(key, indexFileName)
          this.cacheManager.set(
            indexFileName,
            key,
            {
              ...(tokenValue || {}),
              name: tokenValue?.name || key,
              definition
            }
          )
        }
      )
  }

  public updateCacheFromTokensContent ({
    content,
    filePath
  }: {
    content: any;
    filePath: string;
  }) {
    walkTokens(
      content || {},
      (token, _, paths) => {
        const name = paths.join('.')
        const value = token.value?.initial || token?.value
        if (isColor(value)) {
          const culoriColor = culori.parse(value)
          if (culoriColor) { token.color = culoriColorToVscodeColor(culoriColor) }
        }
        this.cacheManager.set(filePath, name, { ...token, name })
      }
    )
  }

  public getAll () {
    return this.cacheManager.getAll()
  }

  public clearFileCache (filePath: string) {
    this.cacheManager.clearFileCache(filePath)
  }

  public clearAllCache () {
    this.cacheManager.clearAllCache()
  }
}

/**
 * Walk through tokens definition an call callback on each design token.
 */
export function walkTokens (
  obj: any,
  cb: (value: any, obj: any, paths: string[]) => any,
  paths: string[] = []
) {
  let result: Record<string, any> = {}

  if (obj.value) {
    result = cb(obj, result, paths)
  } else {
    for (const k in obj) {
      if (obj[k] && typeof obj[k] === 'object') {
        result[k] = walkTokens(obj[k], cb, [...paths, k])
      }
    }
  }

  return result
}
