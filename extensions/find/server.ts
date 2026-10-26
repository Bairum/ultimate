import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ClassifyApi } from '../classify/api.ts'
import { find } from './cascade.ts'
import { gitSource } from './files.ts'

const guidance = `Use find first when you do not know where a behaviour is implemented: describe it in words and read the returned line ranges.
Use grep instead for known literals: exact strings, identifiers, error messages, regexes.
find scores are probabilities from 0 to 1; below 0.4 is weak evidence, so widen the query or grep before concluding something is absent.`

/** Whether this project sends source excerpts to TypeSafe: its own settings only, never the user's. */
export function sendsSource(settings: Record<string, unknown>) {
  const value = settings.find
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { sendSource?: unknown }).sendSource === true
  )
}

export default function findExtension(host: Pick<ExtensionHost, 'want' | 'projectSettings'>) {
  // Optional service, resolved per call; declared here so the catalogue lists it.
  host.want(ClassifyApi)
  return defineExtension({
    name: 'find',
    sections: [section('find', () => guidance)],
    tools: [
      defineTool({
        name: 'find',
        // Repeating a search reads files and asks for judgments again; it changes no project state.
        replay: 'safe',
        description:
          'Describe a behaviour in words; get the files and line ranges that implement it, strongest first, with a 0–1 confidence each. Searches the git-visible files under `path` (default: the working directory). Use grep for known strings.',
        parameters: Type.Object({
          query: Type.String({
            minLength: 1,
            maxLength: 2000,
            description: 'What the code does, in plain language (not a regex).',
          }),
          keywords: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
              maxItems: 20,
              description:
                'Identifiers or terms likely to appear verbatim in the implementation; [] if unsure.',
            }),
          ),
          path: Type.Optional(
            Type.String({
              description: 'A directory or file inside the working directory to search.',
            }),
          ),
        }),
        async execute(args, api, context) {
          const cwd = api.env?.cwd
          if (!cwd) throw new Error('find needs a file execution environment')
          const scope = relative(cwd, resolve(cwd, args.path ?? '.'))
          if (scope.startsWith('..') || isAbsolute(scope))
            throw new Error(`path must be inside the working directory: ${args.path}`)
          const { text, details } = await find({
            query: args.query,
            keywords: args.keywords,
            project: basename(cwd),
            source: gitSource(cwd, scope || '.'),
            classify: host.want(ClassifyApi),
            sendSource: sendsSource(await host.projectSettings()),
            signal: context.abortSignal,
          })
          await api.details(details, context)
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
