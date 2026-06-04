const chains = new Map<string, Promise<void>>()

export async function withGitLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = previous.then(
    () => current,
    () => current,
  )
  chains.set(key, next)

  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (chains.get(key) === next) chains.delete(key)
  }
}
