import * as readline from 'node:readline/promises'

export type Input = ReturnType<typeof createInput>

const QUIT_COMMANDS = new Set(['/quit', '/exit'])

export function createInput() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })

  return {
    async *lines(): AsyncGenerator<string, void, void> {
      while (true) {
        const line = await rl.question('> ').catch(() => null)
        if (line === null || QUIT_COMMANDS.has(line.trim())) return
        if (!line.trim()) continue
        yield line
      }
    },
    close: () => rl.close(),
  }
}
