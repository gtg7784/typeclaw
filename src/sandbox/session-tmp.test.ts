import { describe, expect, test } from 'bun:test'

import { isUnderTmp, mapVirtualTmpPath, SESSION_TMP_ROOT, sessionTmpDir } from './session-tmp'

describe('session-tmp path mapping', () => {
  test('sessionTmpDir namespaces by session id under the shared root', () => {
    expect(sessionTmpDir('abc')).toBe(`${SESSION_TMP_ROOT}/abc`)
  })

  test('maps an absolute /tmp path to the session backing dir', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/tmp/review.json')).toBe(`${SESSION_TMP_ROOT}/sid/review.json`)
  })

  test('maps a nested /tmp path preserving subdirs', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/tmp/sub/dir/f.txt')).toBe(`${SESSION_TMP_ROOT}/sid/sub/dir/f.txt`)
  })

  test('maps bare /tmp to the session root', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/tmp')).toBe(`${SESSION_TMP_ROOT}/sid`)
  })

  test('returns undefined for a non-/tmp absolute path', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/etc/passwd')).toBeUndefined()
  })

  test('returns undefined for a relative path resolved inside the agent dir', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', 'workspace/x.json')).toBeUndefined()
  })

  test('does not treat a /tmpfoo sibling as under /tmp', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/tmpfoo/x')).toBeUndefined()
    expect(isUnderTmp('/agent', '/tmpfoo/x')).toBe(false)
  })

  test('isUnderTmp matches /tmp and its children only', () => {
    expect(isUnderTmp('/agent', '/tmp/x')).toBe(true)
    expect(isUnderTmp('/agent', '/tmp')).toBe(true)
    expect(isUnderTmp('/agent', 'workspace/x')).toBe(false)
  })
})
