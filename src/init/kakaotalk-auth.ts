import { join } from 'node:path'

export type KakaotalkBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type KakaotalkLoginCallbacks = {
  onPasscode: (passcode: string) => void
}

export type KakaotalkLoginInput = {
  email: string
  password: string
  agentDir: string
  callbacks: KakaotalkLoginCallbacks
  // Test seam. Production resolves to spawning `agent-kakaotalk auth login`
  // via Bun.spawn; tests inject a fake to avoid hitting real KakaoTalk.
  spawnLogin?: (args: SpawnLoginArgs) => Promise<SpawnLoginResult>
}

export type SpawnLoginArgs = {
  configDir: string
  email: string
  passwordFile: string
  onPasscode: (passcode: string) => void
}

export type SpawnLoginResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export function kakaotalkConfigDir(agentDir: string): string {
  return join(agentDir, 'workspace', '.agent-messenger')
}

// agent-messenger's `loginFlow` is internal (not in the package's `exports`
// map), so we cannot import it directly from the SDK. The public entry point
// for one-shot device-registration login is the `agent-kakaotalk auth login`
// CLI, which is reexported by the same npm package and accepts
// AGENT_MESSENGER_CONFIG_DIR + --email + --password-file + --pretty.
//
// Adapter runtime (kakaotalk.ts) still uses the SDK directly — only this
// host-stage init bootstrap shells out to the CLI, because:
//   1. The credential file format is the public surface; the CLI writes it
//      to AGENT_MESSENGER_CONFIG_DIR/kakaotalk-credentials.json which the
//      in-container SDK then reads.
//   2. The login flow involves a phone-passcode round-trip (printed on
//      stderr as `Enter this code on your phone: NNNN`); replicating that
//      via private SDK imports would couple us to internal symbols that
//      are not part of the package's exports map.
export async function runKakaotalkBootstrap(input: KakaotalkLoginInput): Promise<KakaotalkBootstrapStatus> {
  const configDir = kakaotalkConfigDir(input.agentDir)
  const passwordFile = await writePasswordFile(input.password)
  try {
    const spawnLogin = input.spawnLogin ?? defaultSpawnLogin
    const result = await spawnLogin({
      configDir,
      email: input.email,
      passwordFile,
      onPasscode: input.callbacks.onPasscode,
    })
    return interpretLoginResult(result)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    await removeIfExists(passwordFile)
  }
}

function interpretLoginResult(result: SpawnLoginResult): KakaotalkBootstrapStatus {
  if (result.exitCode !== 0) {
    const reason =
      parseErrorFromOutput(result.stdout, result.stderr) ?? `agent-kakaotalk exited with code ${result.exitCode}`
    return { ok: false, reason }
  }
  // Successful exit: parse the last JSON object on stdout. The CLI emits
  // exactly one `{...}` payload on success; we tolerate trailing whitespace.
  const payload = parseFinalJson(result.stdout)
  if (payload === null) return { ok: false, reason: 'agent-kakaotalk produced no JSON output' }
  if (payload.authenticated === true) return { ok: true }
  const reason =
    typeof payload.message === 'string' && payload.message !== ''
      ? payload.message
      : typeof payload.error === 'string' && payload.error !== ''
        ? payload.error
        : 'agent-kakaotalk did not authenticate (check email/password)'
  return { ok: false, reason }
}

function parseErrorFromOutput(stdout: string, stderr: string): string | null {
  const payload = parseFinalJson(stdout)
  if (payload !== null) {
    const message = typeof payload.message === 'string' ? payload.message : null
    const error = typeof payload.error === 'string' ? payload.error : null
    if (message !== null && message !== '') return message
    if (error !== null && error !== '') return error
  }
  const trimmed = stderr.trim()
  return trimmed === '' ? null : trimmed
}

function parseFinalJson(stdout: string): { authenticated?: boolean; message?: unknown; error?: unknown } | null {
  const trimmed = stdout.trim()
  if (trimmed === '') return null
  // CLI emits one JSON line on success. Walk lines from the end so any
  // future debug breadcrumbs printed before the final payload don't
  // confuse the parser.
  const lines = trimmed.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line === '' || !line.startsWith('{')) continue
    try {
      return JSON.parse(line) as { authenticated?: boolean; message?: unknown; error?: unknown }
    } catch {
      continue
    }
  }
  return null
}

async function writePasswordFile(password: string): Promise<string> {
  const { mkdtemp, writeFile, chmod } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-kakao-'))
  const path = join(dir, 'pw')
  await writeFile(path, password)
  // Best-effort 0600. The CLI deletes the file after reading it, but if
  // anything crashes between write and read, restrict access in the
  // meantime so other users on the host can't read it from /tmp.
  try {
    await chmod(path, 0o600)
  } catch {
    // chmod is unsupported on some filesystems (Windows host shares,
    // tmpfs without permission emulation). Continue with default mode.
  }
  return path
}

async function removeIfExists(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  try {
    await rm(path, { force: true })
    // Also remove the parent tmpdir we created in writePasswordFile.
    const parent = join(path, '..')
    await rm(parent, { recursive: true, force: true })
  } catch {
    // Cleanup is best-effort; the OS will reap /tmp eventually.
  }
}

const PASSCODE_PATTERN = /Enter this code on your phone:\s*(\S+)/

async function defaultSpawnLogin(args: SpawnLoginArgs): Promise<SpawnLoginResult> {
  const proc = Bun.spawn(
    ['bunx', '--bun', 'agent-kakaotalk', 'auth', 'login', '--email', args.email, '--password-file', args.passwordFile],
    {
      env: { ...process.env, AGENT_MESSENGER_CONFIG_DIR: args.configDir },
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  // Tee stderr so the CLI's interactive passcode line ("Enter this code on
  // your phone: NNNN") reaches the user without us swallowing it. We also
  // detect the passcode regex and surface it via the caller's callback so
  // a non-TTY runner (e.g. a future scripted init) can render it however
  // it likes.
  const stderrChunks: string[] = []
  let stderrBuffer = ''
  const pumpStderr = (async () => {
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      stderrChunks.push(text)
      stderrBuffer += text
      const match = stderrBuffer.match(PASSCODE_PATTERN)
      if (match) {
        args.onPasscode(match[1]!)
        // Drop everything up to and including the matched newline so we
        // don't fire the callback twice for the same code.
        const after = stderrBuffer.indexOf('\n', stderrBuffer.indexOf(match[0]))
        stderrBuffer = after === -1 ? '' : stderrBuffer.slice(after + 1)
      }
      process.stderr.write(text)
    }
    const trailing = decoder.decode()
    if (trailing !== '') {
      stderrChunks.push(trailing)
      process.stderr.write(trailing)
    }
  })()

  const stdout = await new Response(proc.stdout).text()
  await pumpStderr
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr: stderrChunks.join('') }
}
