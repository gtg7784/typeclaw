export type BindAddr = '0.0.0.0' | '127.0.0.1'

export type ListenEntry = {
  port: number
  bindAddr: BindAddr
}

const STATE_LISTEN = '0A'

// /proc/net/tcp[6] format (one row per connection):
//   sl  local_address          rem_address            st  tx_queue:rx_queue  ...
//   0:  0100007F:1F90          00000000:0000          0A  00000000:00000000  ...
//
// `local_address` is `<ip-hex>:<port-hex>`. The IP is little-endian for IPv4
// (so "0100007F" = 127.0.0.1) and big-endian-grouped for IPv6. We only care
// about the LISTEN state (st === '0A') and the bind side (loopback vs any).
//
// Parser is loose-by-design: anything that doesn't look like a LISTEN row is
// silently skipped (header rows, partial reads, kernel format additions). We
// never throw — the procfs file changes between syscalls and a transient
// parse failure must not propagate up.
export function parseProcNetTcp(input: string): ListenEntry[] {
  const out: ListenEntry[] = []
  for (const raw of input.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const cols = line.split(/\s+/)
    if (cols.length < 4) continue
    const localAddr = cols[1]
    const state = cols[3]
    if (state !== STATE_LISTEN || localAddr === undefined) continue
    const colonIdx = localAddr.lastIndexOf(':')
    if (colonIdx < 0) continue
    const ipHex = localAddr.slice(0, colonIdx)
    const portHex = localAddr.slice(colonIdx + 1)
    const port = Number.parseInt(portHex, 16)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    const bindAddr = classifyBindAddr(ipHex)
    if (bindAddr === null) continue
    out.push({ port, bindAddr })
  }
  return dedupePreferringLoopback(out)
}

function classifyBindAddr(ipHex: string): BindAddr | null {
  if (ipHex.length === 8) {
    if (ipHex === '00000000') return '0.0.0.0'
    if (ipHex.toUpperCase() === '0100007F') return '127.0.0.1'
    return null
  }
  if (ipHex.length === 32) {
    if (ipHex === '00000000000000000000000000000000') return '0.0.0.0'
    if (ipHex === '00000000000000000000000001000000') return '127.0.0.1'
    return null
  }
  return null
}

// A server bound to both 0.0.0.0 (IPv4) and ::1 (IPv6) appears twice in our
// merged tcp+tcp6 input. Collapse to one entry per port. If the same port has
// both classifications, prefer 127.0.0.1 (the more restrictive one) so the
// downstream forwarder routes through `Bun.connect('127.0.0.1', port)` either
// way — the loopback path works for both bind addresses.
function dedupePreferringLoopback(entries: ListenEntry[]): ListenEntry[] {
  const byPort = new Map<number, BindAddr>()
  for (const e of entries) {
    const existing = byPort.get(e.port)
    if (existing === undefined) byPort.set(e.port, e.bindAddr)
    else if (existing === '0.0.0.0' && e.bindAddr === '127.0.0.1') byPort.set(e.port, '127.0.0.1')
  }
  return Array.from(byPort.entries()).map(([port, bindAddr]) => ({ port, bindAddr }))
}
