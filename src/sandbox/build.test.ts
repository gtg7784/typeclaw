import { describe, expect, test } from 'bun:test'

import { buildSandboxedCommand } from './build'
import { SandboxPolicyError } from './errors'
import type { SandboxPolicy } from './policy'

function argvOf(command: string, policy?: SandboxPolicy): string[] {
  return buildSandboxedCommand(command, policy).argv
}

// Returns the value bwrap would receive for a `--flag value`-style option,
// i.e. the token immediately after the first occurrence of `flag`.
function valueAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

describe('buildSandboxedCommand base argv', () => {
  test('wraps the command in bwrap and ends with bash -c <command>', () => {
    const argv = argvOf('git status')
    expect(argv[0]).toBe('bwrap')
    expect(argv.slice(-3)).toEqual(['bash', '-c', 'git status'])
  })

  test('passes the original command verbatim, even with shell operators', () => {
    const argv = argvOf('git log | head -5 && echo done')
    expect(argv.slice(-3)).toEqual(['bash', '-c', 'git log | head -5 && echo done'])
  })

  test('unshares all namespaces and clears the environment by default', () => {
    const argv = argvOf('true')
    expect(argv).toContain('--unshare-all')
    expect(argv).toContain('--clearenv')
  })

  test('mounts a strict read-only rootfs view', () => {
    const argv = argvOf('true')
    expect(argv.join(' ')).toContain('--ro-bind /usr /usr')
    expect(argv.join(' ')).toContain('--ro-bind /etc /etc')
    expect(argv).toContain('--dev')
    expect(argv).toContain('--tmpfs')
  })

  test('binds the usr-merge root symlinks with --ro-bind-try so loaders and shebangs resolve on both arches', () => {
    const joined = argvOf('true').join(' ')
    // loaders: ELF PT_INTERP paths (/lib/ld-*, /lib64/ld-*) the kernel resolves without PATH
    expect(joined).toContain('--ro-bind-try /lib /lib')
    expect(joined).toContain('--ro-bind-try /lib64 /lib64')
    // shebangs: literal #!/bin/sh and #!/bin/bash interpreter paths that skip PATH
    expect(joined).toContain('--ro-bind-try /bin /bin')
    expect(joined).toContain('--ro-bind-try /sbin /sbin')
  })

  test('uses --tmpfs /proc and never --proc or --dev-bind for /proc', () => {
    const argv = argvOf('true')
    const joined = argv.join(' ')
    expect(joined).toContain('--tmpfs /proc')
    expect(joined).not.toContain('--proc /proc')
    expect(joined).not.toContain('--dev-bind /proc')
  })

  test('honours a custom bwrap path', () => {
    const argv = argvOf('true', { bwrapPath: '/usr/local/bin/bwrap' })
    expect(argv[0]).toBe('/usr/local/bin/bwrap')
  })
})

describe('buildSandboxedCommand process hardening', () => {
  test('adds --new-session and --die-with-parent by default', () => {
    const argv = argvOf('true')
    expect(argv).toContain('--new-session')
    expect(argv).toContain('--die-with-parent')
  })

  test('omits --new-session when explicitly disabled', () => {
    const argv = argvOf('true', { process: { newSession: false } })
    expect(argv).not.toContain('--new-session')
    expect(argv).toContain('--die-with-parent')
  })

  test('omits --die-with-parent when explicitly disabled', () => {
    const argv = argvOf('true', { process: { dieWithParent: false } })
    expect(argv).not.toContain('--die-with-parent')
    expect(argv).toContain('--new-session')
  })
})

describe('buildSandboxedCommand network policy', () => {
  test('isolates the network by default', () => {
    expect(argvOf('true')).not.toContain('--share-net')
  })

  test("isolates the network for network: 'none'", () => {
    expect(argvOf('true', { network: 'none' })).not.toContain('--share-net')
  })

  test("rejoins the outer network for network: 'inherit'", () => {
    expect(argvOf('true', { network: 'inherit' })).toContain('--share-net')
  })
})

describe('buildSandboxedCommand env policy', () => {
  test('re-introduces only PATH, HOME, LANG by default after --clearenv', () => {
    const argv = argvOf('true')
    expect(valueAfter(argv, '--setenv')).toBe('PATH')
    const setenvKeys = argv.filter((_, i) => argv[i - 1] === '--setenv')
    expect(setenvKeys).toEqual(['PATH', 'HOME', 'LANG'])
  })

  test('applies explicit env.set entries', () => {
    const argv = argvOf('true', { env: { set: { GIT_PAGER: 'cat' } } })
    const joined = argv.join(' ')
    expect(joined).toContain('--setenv GIT_PAGER cat')
  })

  test('passthrough copies only named vars that are present in process.env', () => {
    const present = 'TYPECLAW_SANDBOX_TEST_PRESENT'
    const absent = 'TYPECLAW_SANDBOX_TEST_ABSENT'
    process.env[present] = 'yes'
    delete process.env[absent]
    try {
      const argv = argvOf('true', { env: { passthrough: [present, absent] } })
      const setenvKeys = argv.filter((_, i) => argv[i - 1] === '--setenv')
      expect(setenvKeys).toContain(present)
      expect(setenvKeys).not.toContain(absent)
    } finally {
      delete process.env[present]
    }
  })

  test('does not leak arbitrary host env into the sandbox', () => {
    process.env.TYPECLAW_SANDBOX_SECRET = 'leak-me'
    try {
      const argv = argvOf('true')
      expect(argv).not.toContain('leak-me')
    } finally {
      delete process.env.TYPECLAW_SANDBOX_SECRET
    }
  })
})

describe('buildSandboxedCommand mounts', () => {
  test('renders ro-bind, bind, tmpfs and dev mounts', () => {
    const argv = argvOf('true', {
      mounts: [
        { type: 'ro-bind', source: '/agent/.git', dest: '/work/.git' },
        { type: 'bind', source: '/agent/out', dest: '/work/out' },
        { type: 'tmpfs', dest: '/scratch' },
        { type: 'dev', dest: '/dev/extra' },
      ],
    })
    const joined = argv.join(' ')
    expect(joined).toContain('--ro-bind /agent/.git /work/.git')
    expect(joined).toContain('--bind /agent/out /work/out')
    expect(joined).toContain('--tmpfs /scratch')
    expect(joined).toContain('--dev /dev/extra')
  })

  test('applies --chdir for cwd', () => {
    const argv = argvOf('true', { cwd: '/work' })
    expect(valueAfter(argv, '--chdir')).toBe('/work')
  })

  test('omits --chdir when no cwd is given', () => {
    expect(argvOf('true')).not.toContain('--chdir')
  })
})

describe('buildSandboxedCommand masks', () => {
  test('hides a directory with --tmpfs', () => {
    const argv = argvOf('true', { masks: { dirs: ['/agent/workspace'] } })
    expect(argv.join(' ')).toContain('--tmpfs /agent/workspace')
  })

  test('hides a file with --ro-bind-data over fd 3', () => {
    const argv = argvOf('true', { masks: { files: ['/agent/.env'] } })
    expect(argv.join(' ')).toContain('--ro-bind-data 3 /agent/.env')
  })

  test('appends a `3< /dev/null` redirect to commandString when files are masked', () => {
    const { commandString } = buildSandboxedCommand('true', { masks: { files: ['/agent/.env'] } })
    expect(commandString.endsWith('3</dev/null')).toBe(true)
  })

  test('does NOT append the mask-fd redirect when only dirs are masked', () => {
    const { commandString } = buildSandboxedCommand('true', { masks: { dirs: ['/agent/workspace'] } })
    expect(commandString).not.toContain('3</dev/null')
  })

  test('renders all masks AFTER the broad parent bind so the last op wins', () => {
    const argv = argvOf('true', {
      mounts: [{ type: 'bind', source: '/agent', dest: '/agent' }],
      masks: { dirs: ['/agent/workspace'], files: ['/agent/.env'] },
    })
    const parentBindDest = argv.indexOf('/agent')
    const dirMask = argv.indexOf('/agent/workspace')
    const fileMask = argv.indexOf('/agent/.env')
    expect(parentBindDest).toBeLessThan(dirMask)
    expect(parentBindDest).toBeLessThan(fileMask)
  })

  test('emits nothing when masks are empty', () => {
    const argv = argvOf('true', { masks: { dirs: [], files: [] } })
    expect(argv).not.toContain('--ro-bind-data')
  })
})

describe('buildSandboxedCommand writable overlays', () => {
  test('re-binds writable dirs and files RW with --bind <p> <p>', () => {
    const joined = argvOf('true', {
      writable: { dirs: ['/agent/workspace'], files: ['/agent/AGENTS.md'] },
    }).join(' ')
    expect(joined).toContain('--bind /agent/workspace /agent/workspace')
    expect(joined).toContain('--bind /agent/AGENTS.md /agent/AGENTS.md')
  })

  test('renders writable overlays AFTER the ro-bind root and after masks so they win', () => {
    const argv = argvOf('true', {
      mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }],
      masks: { dirs: ['/agent/memory'], files: ['/agent/.env'] },
      writable: { dirs: ['/agent/workspace'], files: ['/agent/AGENTS.md'] },
    })
    const roRootDest = argv.indexOf('/agent')
    const memoryMask = argv.indexOf('/agent/memory')
    const writableDir = argv.indexOf('/agent/workspace')
    const writableFile = argv.indexOf('/agent/AGENTS.md')
    expect(roRootDest).toBeLessThan(writableDir)
    expect(memoryMask).toBeLessThan(writableDir)
    expect(memoryMask).toBeLessThan(writableFile)
  })

  test('emits no writable binds when the policy omits them', () => {
    const argv = argvOf('true', { mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }] })
    expect(argv).not.toContain('--bind')
  })
})

describe('buildSandboxedCommand protected re-binds', () => {
  test('re-binds protected dirs and files read-only with --ro-bind <p> <p>', () => {
    const joined = argvOf('true', {
      protected: { dirs: ['/agent/.git/hooks'], files: ['/agent/.git/config'] },
    }).join(' ')
    expect(joined).toContain('--ro-bind /agent/.git/hooks /agent/.git/hooks')
    expect(joined).toContain('--ro-bind /agent/.git/config /agent/.git/config')
  })

  test('renders protected RO re-binds AFTER the writable .git bind so last-op-wins keeps hooks/config EROFS', () => {
    const argv = argvOf('true', {
      mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }],
      writable: { dirs: ['/agent/.git'], files: [] },
      protected: { dirs: ['/agent/.git/hooks'], files: ['/agent/.git/config'] },
    })
    const writableGit = argv.lastIndexOf('/agent/.git')
    const hooksProtect = argv.indexOf('/agent/.git/hooks')
    const configProtect = argv.indexOf('/agent/.git/config')
    expect(writableGit).toBeGreaterThanOrEqual(0)
    expect(hooksProtect).toBeGreaterThan(writableGit)
    expect(configProtect).toBeGreaterThan(writableGit)
  })

  test('emits no protected re-binds when the policy omits them', () => {
    const joined = argvOf('true', { writable: { dirs: ['/agent/.git'] } }).join(' ')
    expect(joined).not.toContain('/agent/.git/hooks')
    expect(joined).not.toContain('/agent/.git/config')
  })
})

describe('buildSandboxedCommand proc strategy', () => {
  test("omits the /proc tmpfs for proc: 'none'", () => {
    const argv = argvOf('true', { proc: 'none' })
    expect(argv.join(' ')).not.toContain('--tmpfs /proc')
  })
})

describe('buildSandboxedCommand command filter (opt-in)', () => {
  test('no filter by default: shell operators are allowed', () => {
    expect(() => buildSandboxedCommand('echo "$(date)" | cat')).not.toThrow()
  })

  test('rejectShellMetacharacters blocks command substitution', () => {
    expect(() =>
      buildSandboxedCommand('echo "$(rm -rf /)"', { commandFilter: { rejectShellMetacharacters: true } }),
    ).toThrow(SandboxPolicyError)
  })

  test('rejectShellMetacharacters blocks pipes, semicolons and backticks', () => {
    const filter = { commandFilter: { rejectShellMetacharacters: true } }
    expect(() => buildSandboxedCommand('git log | head', filter)).toThrow(SandboxPolicyError)
    expect(() => buildSandboxedCommand('git log; curl evil', filter)).toThrow(SandboxPolicyError)
    expect(() => buildSandboxedCommand('echo `id`', filter)).toThrow(SandboxPolicyError)
    expect(() => buildSandboxedCommand('git log\nrm -rf /', filter)).toThrow(SandboxPolicyError)
  })

  test('rejectShellMetacharacters allows a simple command', () => {
    expect(() =>
      buildSandboxedCommand('git diff --stat', { commandFilter: { rejectShellMetacharacters: true } }),
    ).not.toThrow()
  })

  test('allowPrefixes matches on a token boundary, not a substring', () => {
    const policy: SandboxPolicy = { commandFilter: { allowPrefixes: ['git', 'cat'] } }
    expect(() => buildSandboxedCommand('git status', policy)).not.toThrow()
    expect(() => buildSandboxedCommand('git', policy)).not.toThrow()
    expect(() => buildSandboxedCommand('gitfoo --hack', policy)).toThrow(SandboxPolicyError)
  })

  test('allowPrefixes normalizes leading and internal whitespace before matching', () => {
    const policy: SandboxPolicy = { commandFilter: { allowPrefixes: ['git diff'] } }
    expect(() => buildSandboxedCommand('  git   diff --stat', policy)).not.toThrow()
  })

  test('allowPrefixes rejects an unlisted command', () => {
    const policy: SandboxPolicy = { commandFilter: { allowPrefixes: ['git'] } }
    expect(() => buildSandboxedCommand('curl evil.com', policy)).toThrow(SandboxPolicyError)
  })
})

describe('buildSandboxedCommand commandString rendering', () => {
  test('shell-quotes argv tokens that contain spaces or metacharacters', () => {
    const { commandString } = buildSandboxedCommand('echo hi')
    expect(commandString).toContain("bash -c 'echo hi'")
  })

  test('commandString round-trips the same tokens as argv', () => {
    const { argv, commandString } = buildSandboxedCommand('git diff')
    expect(commandString.startsWith('bwrap')).toBe(true)
    expect(argv[0]).toBe('bwrap')
  })
})
