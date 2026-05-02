import { describe, expect, test } from 'bun:test'

import { parseProcNetTcp } from './proc-net-tcp'

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

describe('parseProcNetTcp', () => {
  test('returns empty for empty input', () => {
    expect(parseProcNetTcp('')).toEqual([])
  })

  test('skips header rows', () => {
    expect(parseProcNetTcp(HEADER)).toEqual([])
  })

  test('parses an IPv4 LISTEN on 127.0.0.1:8080', () => {
    const input = `${HEADER}
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([{ port: 8080, bindAddr: '127.0.0.1' }])
  })

  test('parses an IPv4 LISTEN on 0.0.0.0:5173', () => {
    const input = `${HEADER}
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([{ port: 5173, bindAddr: '0.0.0.0' }])
  })

  test('parses an IPv6 LISTEN on ::1:3000 as 127.0.0.1', () => {
    const input = `${HEADER}
   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([{ port: 3000, bindAddr: '127.0.0.1' }])
  })

  test('parses an IPv6 LISTEN on :: (IN6ADDR_ANY) as 0.0.0.0', () => {
    const input = `${HEADER}
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([{ port: 3000, bindAddr: '0.0.0.0' }])
  })

  test('skips ESTABLISHED (state != 0A) connections', () => {
    const input = `${HEADER}
   0: 0100007F:1F90 0100007F:9999 01 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([])
  })

  test('handles multiple LISTEN rows', () => {
    const input = `${HEADER}
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1
   1: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([
      { port: 8080, bindAddr: '0.0.0.0' },
      { port: 5173, bindAddr: '127.0.0.1' },
    ])
  })

  test('dedupes the same port appearing in both tcp and tcp6, preferring 127.0.0.1', () => {
    const input = `${HEADER}
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1
   1: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([{ port: 5173, bindAddr: '127.0.0.1' }])
  })

  test('keeps 0.0.0.0 when both rows are 0.0.0.0 (IPv4 + IPv6 both any)', () => {
    const input = `${HEADER}
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1
   1: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([{ port: 5173, bindAddr: '0.0.0.0' }])
  })

  test('skips rows bound to non-loopback non-any IPs (we only forward loopback-reachable)', () => {
    const input = `${HEADER}
   0: 0202A8C0:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([])
  })

  test('skips malformed rows without throwing', () => {
    const input = `${HEADER}
   garbage row that is not a real entry
   0: nope 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1
   0: 00000000:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([])
  })

  test('skips rows with port 0', () => {
    const input = `${HEADER}
   0: 0100007F:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1`
    expect(parseProcNetTcp(input)).toEqual([])
  })
})
