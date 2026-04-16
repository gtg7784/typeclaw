import type { ServerMessage } from '@/shared'

export type Renderer = ReturnType<typeof createRenderer>

export function createRenderer() {
  const stdout = process.stdout
  const stderr = process.stderr

  return {
    connecting: (baseUrl: string) => stderr.write(`connecting to ${baseUrl}...\n`),
    connected: (sessionId: string) => stderr.write(`session: ${sessionId}\n`),
    disconnected: () => stderr.write('disconnected\n'),
    connectError: (err: unknown) =>
      stderr.write(`connection error: ${err instanceof Error ? err.message : String(err)}\n`),
    userPrompt: (text: string) => stderr.write(`> ${text}\n`),
    message: (msg: ServerMessage) => {
      switch (msg.type) {
        case 'text_delta':
          stdout.write(msg.delta)
          break
        case 'tool_start':
          stderr.write(`\n[tool] ${msg.name}\n`)
          break
        case 'tool_end':
          stderr.write(`[tool] ${msg.name} ${msg.error ? '✗' : '✓'}\n`)
          break
        case 'done':
          stdout.write('\n')
          break
        case 'error':
          stderr.write(`\nerror: ${msg.message}\n`)
          break
      }
    },
  }
}
