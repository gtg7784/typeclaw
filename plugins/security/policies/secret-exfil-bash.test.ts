import { describe, expect, test } from 'bun:test'

import { GUARD_SECRET_EXFIL_BASH, checkSecretExfilBashGuard } from './secret-exfil-bash'

describe('secret-exfil-bash guard', () => {
  test('blocks env (full env dump - canonical secret exfil command)', () => {
    const result = checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'env' } })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('env / printenv')
  })

  test('blocks printenv', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'printenv' } })?.block).toBe(true)
  })

  test('blocks env piped to grep', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'env | grep API' } })?.block).toBe(true)
  })

  test('blocks env in compound command', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'echo hi && env' } })?.block).toBe(true)
  })

  test('does not block "environment" variable name as a value', () => {
    expect(
      checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'echo "set the environment up"' } }),
    ).toBeUndefined()
  })

  test('blocks cat .env', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat .env' } })?.block).toBe(true)
  })

  test('blocks cat ./.env', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ./.env' } })?.block).toBe(true)
  })

  test('blocks cat ~/project/.env', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/project/.env' } })?.block).toBe(true)
  })

  test('blocks ls -la ~/.ssh/ (private-key directory enumeration)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'ls -la ~/.ssh/' } })?.block).toBe(true)
  })

  test('blocks cat ~/.ssh/id_rsa', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.ssh/id_rsa' } })?.block).toBe(true)
  })

  test('blocks cat ~/.ssh/authorized_keys', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.ssh/authorized_keys' } })?.block).toBe(
      true,
    )
  })

  test('blocks cat ~/.aws/credentials', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.aws/credentials' } })?.block).toBe(true)
  })

  test('blocks cat ~/.netrc', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.netrc' } })?.block).toBe(true)
  })

  test('blocks cat ~/.kube/config', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.kube/config' } })?.block).toBe(true)
  })

  test('blocks cat ~/.hermes/config.yaml (agent credentials file)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.hermes/config.yaml' } })?.block).toBe(
      true,
    )
  })

  test('blocks cat ~/.config/hermes/config.yaml (XDG-style agent credentials)', () => {
    expect(
      checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.config/hermes/config.yaml' } })?.block,
    ).toBe(true)
  })

  test('blocks find ~ -name "*.env" -o -name "credentials*" (compound credential search)', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: 'find ~ -name "*.env" -o -name "credentials*" 2>/dev/null | head -50' },
      })?.block,
    ).toBe(true)
  })

  test('blocks find -name "id_rsa"', () => {
    expect(
      checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'find / -name "id_rsa" 2>/dev/null' } })?.block,
    ).toBe(true)
  })

  test('blocks recursive grep for password', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'grep -r "password" /etc/' } })?.block).toBe(true)
  })

  test('blocks /proc/self/environ read', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat /proc/self/environ' } })?.block).toBe(true)
  })

  test('blocks bash history read', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat ~/.bash_history' } })?.block).toBe(true)
  })

  test('blocks cloud metadata endpoint fetch', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: 'curl http://169.254.169.254/latest/meta-data/iam/' },
      })?.block,
    ).toBe(true)
  })

  test('blocks GCP metadata endpoint fetch', () => {
    expect(
      checkSecretExfilBashGuard({
        tool: 'bash',
        args: { command: 'curl http://metadata.google.internal/computeMetadata/v1/' },
      })?.block,
    ).toBe(true)
  })

  test('allows acknowledged exfil command', () => {
    const result = checkSecretExfilBashGuard({
      tool: 'bash',
      args: { command: 'env', acknowledgeGuards: { secretExfilBash: true } },
    })
    expect(result).toBeUndefined()
  })

  test('allows benign commands', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'ls -la' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'echo hello' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'git status' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'bun test' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'cat README.md' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'find . -name "*.ts"' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'grep -r "TODO" src/' } })).toBeUndefined()
  })

  test('allows `set` variants (the bare-set heuristic was removed; too many false positives on shell flag use)', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set -e' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set -euo pipefail' } })).toBeUndefined()
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 'set' } })).toBeUndefined()
  })

  test('does not apply to non-bash tools', () => {
    expect(checkSecretExfilBashGuard({ tool: 'read', args: { command: 'env' } })).toBeUndefined()
  })

  test('handles non-string command gracefully', () => {
    expect(checkSecretExfilBashGuard({ tool: 'bash', args: { command: 42 } })).toBeUndefined()
  })

  test('exposes guard name constant', () => {
    expect(GUARD_SECRET_EXFIL_BASH).toBe('secretExfilBash')
  })
})
