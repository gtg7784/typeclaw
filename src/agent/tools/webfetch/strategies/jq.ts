import { raw } from 'jq-wasm'

export class JqError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JqError'
  }
}

export async function applyJq(content: string, query: string): Promise<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new JqError(`Response is not valid JSON: ${message}`)
  }

  try {
    const result = await raw(parsed as string | object, query)
    if (result.exitCode !== 0 || result.stderr) {
      const detail = result.stderr.trim() || `exit code ${result.exitCode}`
      throw new JqError(`jq query failed: ${detail}`)
    }
    return result.stdout.replace(/\n+$/, '')
  } catch (error) {
    if (error instanceof JqError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new JqError(`jq query failed: ${message}`)
  }
}
