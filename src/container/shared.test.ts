import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildxAvailable,
  checkDockerAvailable,
  classifyRmStderr,
  cleanupRunCorpse,
  containerNameFromCwd,
  DOCKER_NOT_FOUND_STDERR,
  type DockerExec,
  imageTagFromCwd,
  isContainerNameConflict,
  sanitizeDockerStderr,
  waitForRemoval,
} from './shared'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-shared-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('containerNameFromCwd', () => {
  test('uses the folder basename', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe('coder')
  })

  test('replaces disallowed characters with dashes', async () => {
    const folder = join(root, 'my agent@v2')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe('my-agent-v2')
  })

  test('prefixes tc- when the name does not start with alphanumeric', async () => {
    const folder = join(root, '.hidden')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe('tc-.hidden')
  })

  test('produces a valid Docker name for an all-non-ASCII folder (Korean)', async () => {
    const folder = join(root, '봇')
    await mkdir(folder)

    const name = containerNameFromCwd(folder)

    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
    expect(name).toMatch(/^tc-[0-9a-f]{8}$/)
  })

  test('disambiguates the sampled non-ASCII folder names that previously collided (the core bug)', async () => {
    // given: single-character CJK/Korean names that the old charset filter
    // collapsed to the same 'tc--' string — distinct agents, same container key.
    const bot = join(root, '봇')
    const house = join(root, '집')
    const cn = join(root, '中文')
    const jp = join(root, '日本')
    await Promise.all([mkdir(bot), mkdir(house), mkdir(cn), mkdir(jp)])

    const names = [
      containerNameFromCwd(bot),
      containerNameFromCwd(house),
      containerNameFromCwd(cn),
      containerNameFromCwd(jp),
    ]

    expect(new Set(names).size).toBe(names.length)
  })

  test('keeps surviving ASCII as a readable prefix and disambiguates by hash', async () => {
    // given: two folders that share an ASCII suffix but differ only in their
    // CJK prefix — the old filter mapped both to 'tc-------Agent'.
    const cn = join(root, '中文Agent')
    const jp = join(root, '日本Agent')
    await Promise.all([mkdir(cn), mkdir(jp)])

    const cnName = containerNameFromCwd(cn)
    const jpName = containerNameFromCwd(jp)

    expect(cnName).toMatch(/^Agent-[0-9a-f]{8}$/)
    expect(jpName).toMatch(/^Agent-[0-9a-f]{8}$/)
    expect(cnName).not.toBe(jpName)
  })

  test('is deterministic for the same non-ASCII folder name', async () => {
    const folder = join(root, '한글에이전트')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe(containerNameFromCwd(folder))
  })
})

describe('imageTagFromCwd', () => {
  test('prefixes with typeclaw-', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(imageTagFromCwd(folder)).toBe('typeclaw-coder')
  })
})

describe('checkDockerAvailable', () => {
  test('returns ok when docker info exits 0', async () => {
    const exec: DockerExec = async () => ({ exitCode: 0, stdout: '29.4.0\n', stderr: '' })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({ ok: true })
  })

  test('classifies as binary-missing when stderr is the ENOENT sentinel', async () => {
    const exec: DockerExec = async () => ({ exitCode: -1, stdout: '', stderr: DOCKER_NOT_FOUND_STDERR })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({
      ok: false,
      reason: 'binary-missing',
      detail: DOCKER_NOT_FOUND_STDERR,
    })
  })

  test('classifies any other non-zero exit as daemon-down', async () => {
    const exec: DockerExec = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
    })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({
      ok: false,
      reason: 'daemon-down',
      detail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    })
  })

  test('falls back to a synthetic detail when stderr is empty on non-zero exit', async () => {
    const exec: DockerExec = async () => ({ exitCode: 7, stdout: '', stderr: '   ' })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({
      ok: false,
      reason: 'daemon-down',
      detail: 'docker info exited with code 7',
    })
  })

  test('passes the right args to the exec stub', async () => {
    const calls: string[][] = []
    const exec: DockerExec = async (args) => {
      calls.push(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await checkDockerAvailable(exec)

    expect(calls).toEqual([['info', '--format', '{{.ServerVersion}}']])
  })
})

describe('classifyRmStderr', () => {
  test('returns "gone" for "No such container" (case-insensitive)', () => {
    expect(classifyRmStderr('Error: No such container: ati')).toBe('gone')
    expect(classifyRmStderr('error: no such container: ati')).toBe('gone')
  })

  test('returns "in-progress" for "removal of container … is already in progress" (case-insensitive)', () => {
    expect(classifyRmStderr('Error response from daemon: removal of container ati is already in progress')).toBe(
      'in-progress',
    )
    expect(classifyRmStderr('REMOVAL OF CONTAINER X IS ALREADY IN PROGRESS')).toBe('in-progress')
  })

  test('returns null for other stderr (non-benign failures)', () => {
    expect(classifyRmStderr('permission denied')).toBeNull()
    expect(classifyRmStderr('')).toBeNull()
    expect(classifyRmStderr('docker: command not found')).toBeNull()
  })

  test('"no such container" takes precedence when both substrings somehow appear', () => {
    // given: a synthetic stderr that contains both phrases (defensive — we
    // have not seen Docker emit this, but the helper's contract should be
    // total). The 'gone' state is strictly cheaper for callers than
    // 'in-progress', so prefer it when ambiguous.
    expect(classifyRmStderr('Error: No such container: x (removal of container x was already in progress)')).toBe(
      'gone',
    )
  })
})

describe('isContainerNameConflict', () => {
  test('detects the canonical "container name is already in use" error from docker run', () => {
    const stderr =
      'docker: Error response from daemon: Conflict. The container name "/anderson" is already in use by container "e8d39ae0eb16428c58b143b3a8ac60267ae87ce4fc0f2859022183b512287209". You have to remove (or rename) that container to be able to reuse that name.\n'
    expect(isContainerNameConflict(stderr)).toBe(true)
  })

  test('is case-insensitive', () => {
    expect(isContainerNameConflict('CONTAINER NAME "/x" IS ALREADY IN USE')).toBe(true)
  })

  test('returns false for unrelated docker run errors', () => {
    expect(isContainerNameConflict('docker: Bind for :::8973 failed: port is already allocated')).toBe(false)
    expect(isContainerNameConflict('permission denied')).toBe(false)
    expect(isContainerNameConflict('Error response from daemon: image not found')).toBe(false)
    expect(isContainerNameConflict('')).toBe(false)
  })

  test('requires BOTH "container name" and "is already in use" — neither alone is sufficient', () => {
    expect(isContainerNameConflict('container name was rejected')).toBe(false)
    expect(isContainerNameConflict('port is already in use')).toBe(false)
  })
})

describe('waitForRemoval', () => {
  test('returns true as soon as docker inspect reports the container gone', async () => {
    // given: an exec that returns "exists" twice then "no such container"
    let calls = 0
    const exec: DockerExec = async () => {
      calls += 1
      if (calls >= 3) return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      return { exitCode: 0, stdout: 'false\n', stderr: '' }
    }

    // when
    const ok = await waitForRemoval(exec, 'x', { timeoutMs: 1_000, intervalMs: 10 })

    // then
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })

  test('returns false on timeout when the container is still present', async () => {
    // given: an exec that always reports the container exists
    let calls = 0
    const exec: DockerExec = async () => {
      calls += 1
      return { exitCode: 0, stdout: 'false\n', stderr: '' }
    }

    // when: a short timeout
    const ok = await waitForRemoval(exec, 'x', { timeoutMs: 50, intervalMs: 10 })

    // then
    expect(ok).toBe(false)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  test('issues docker inspect with the configured name', async () => {
    const seen: string[][] = []
    const exec: DockerExec = async (args) => {
      seen.push(args)
      return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
    }

    await waitForRemoval(exec, 'anderson', { timeoutMs: 100, intervalMs: 10 })

    expect(seen[0]).toEqual(['inspect', '--format', '{{.State.Running}}', 'anderson'])
  })
})

describe('cleanupRunCorpse', () => {
  test('returns "gone" when inspect reports no such container (no rm issued)', async () => {
    let rmIssued = false
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      if (args[0] === 'rm') {
        rmIssued = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x')).toBe('gone')
    expect(rmIssued).toBe(false)
  })

  test('returns "removed" after force-removing a non-running corpse and waiting for the drain', async () => {
    // The probe uses `{{.Id}}|{{.State.Running}}` so cleanupRunCorpse can
    // issue rm by ID (closes the TOCTOU window where a peer might create
    // a different live container with the same name between probe and rm).
    let rmCalls = 0
    let inspectCalls = 0
    let rmDone = false
    let rmTarget: string | undefined
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') {
        inspectCalls++
        if (!rmDone) return { exitCode: 0, stdout: 'corpse-id-abc|false\n', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      }
      if (args[0] === 'rm') {
        rmCalls++
        rmTarget = args[args.length - 1]
        rmDone = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x')).toBe('removed')
    expect(rmCalls).toBe(1)
    // rm MUST target the probed ID, not the name — otherwise a same-name
    // peer created between probe and rm would be killed.
    expect(rmTarget).toBe('corpse-id-abc')
    // probe inspect + at least one waitForRemoval inspect = 2+
    expect(inspectCalls).toBeGreaterThanOrEqual(2)
  })

  test('returns "running" and does NOT issue rm when the named container is currently running', async () => {
    let rmIssued = false
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: 'live-id-abc|true\n', stderr: '' }
      if (args[0] === 'rm') {
        rmIssued = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x')).toBe('running')
    expect(rmIssued).toBe(false)
  })

  test('returns "removed" when rm reports "in-progress" and inspect later confirms removal', async () => {
    let rmDone = false
    let postRmInspects = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') {
        if (!rmDone) return { exitCode: 0, stdout: 'corpse-id|false\n', stderr: '' }
        postRmInspects++
        if (postRmInspects <= 1) return { exitCode: 0, stdout: 'false\n', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      }
      if (args[0] === 'rm') {
        rmDone = true
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Error response from daemon: removal of container x is already in progress',
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x')).toBe('removed')
    expect(postRmInspects).toBeGreaterThanOrEqual(2)
  })

  test('returns "gone" when rm reports the container is already gone', async () => {
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: 'corpse-id|false\n', stderr: '' }
      if (args[0] === 'rm') return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x')).toBe('gone')
  })

  test('returns "stuck" when rm fails with a non-benign error', async () => {
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: 'corpse-id|false\n', stderr: '' }
      if (args[0] === 'rm') return { exitCode: 1, stdout: '', stderr: 'permission denied' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x')).toBe('stuck')
  })

  test('returns "stuck" when probe stdout is malformed (no ID, defensive)', async () => {
    // Defensive: a daemon hiccup returning exit 0 with empty stdout
    // should not let us issue rm without an ID — we'd fall back to
    // killing by name and that's the very TOCTOU we're closing.
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x')).toBe('stuck')
  })
})

describe('sanitizeDockerStderr', () => {
  test('strips the trailing "Run docker ... --help" line and surrounding blank lines', () => {
    const stderr =
      'docker: Error response from daemon: Conflict. The container name "/anderson" is already in use by container "3d54c2b59b822a611703889f0b2e2c5805889653335a99eaaecb4d090dc5e2bf". You have to remove (or rename) that container to be able to reuse that name.\n\nRun \'docker run --help\' for more information\n'

    expect(sanitizeDockerStderr(stderr)).toBe(
      'Conflict. The container name "/anderson" is already in use by container "3d54c2b59b822a611703889f0b2e2c5805889653335a99eaaecb4d090dc5e2bf". You have to remove (or rename) that container to be able to reuse that name.',
    )
  })

  test('handles --help variants for other subcommands (build, stop, rm)', () => {
    const stderr = "some build error\n\nRun 'docker build --help' for more information\n"
    expect(sanitizeDockerStderr(stderr)).toBe('some build error')
  })

  test('collapses internal newlines to "; " so the result fits on one line', () => {
    const stderr = 'first detail line\nsecond detail line\nthird detail line'
    expect(sanitizeDockerStderr(stderr)).toBe('first detail line; second detail line; third detail line')
  })

  test('preserves the daemon error body when it stands alone (no docker: prefix)', () => {
    const stderr = 'Error response from daemon: removal of container abc is already in progress\n'
    expect(sanitizeDockerStderr(stderr)).toBe('removal of container abc is already in progress')
  })

  test('preserves substrings that downstream tests assert on (permission denied, etc.)', () => {
    expect(sanitizeDockerStderr('permission denied')).toBe('permission denied')
    expect(sanitizeDockerStderr('docker: permission denied\n')).toBe('permission denied')
  })

  test('returns empty string for empty / whitespace-only input (callers fall back to their own sentinel)', () => {
    expect(sanitizeDockerStderr('')).toBe('')
    expect(sanitizeDockerStderr('   \n\n  ')).toBe('')
    expect(sanitizeDockerStderr("\n\nRun 'docker run --help' for more information\n")).toBe('')
  })

  test('leaves an already-clean single-line message untouched', () => {
    expect(sanitizeDockerStderr('some plain error')).toBe('some plain error')
  })
})

describe('buildxAvailable', () => {
  test('true when `docker buildx version` exits 0', async () => {
    const exec: DockerExec = async (args) => {
      expect(args).toEqual(['buildx', 'version'])
      return { exitCode: 0, stdout: 'buildx v0.33.0\n', stderr: '' }
    }
    expect(await buildxAvailable(exec)).toBe(true)
  })

  test('false when the buildx plugin is missing (non-zero exit)', async () => {
    const exec: DockerExec = async () => ({ exitCode: 1, stdout: '', stderr: 'unknown command "buildx"' })
    expect(await buildxAvailable(exec)).toBe(false)
  })
})
