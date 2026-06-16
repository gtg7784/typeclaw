// Centralized seam so host-stage macOS/Linux/Windows branches stay greppable as
// native-Windows support lands; the default arg lets tests pass a platform
// without mutating the read-only `process.platform`.

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

export function isMacOS(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin'
}
