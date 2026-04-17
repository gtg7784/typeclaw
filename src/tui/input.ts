import * as readline from 'node:readline/promises'

export type Input = ReturnType<typeof createInput>

const QUIT_COMMANDS = new Set(['/quit', '/exit'])

export function createInput() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    rl.close()
  }
  rl.once('SIGINT', close)
  rl.once('close', () => {
    closed = true
  })

  return {
    async *lines(): AsyncGenerator<string, void, void> {
      while (!closed) {
        const line = await rl.question('> ').catch(() => null)
        if (closed || line === null || QUIT_COMMANDS.has(line.trim())) return
        if (!line.trim()) continue
        yield line
      }
    },
    close,
  }
}
