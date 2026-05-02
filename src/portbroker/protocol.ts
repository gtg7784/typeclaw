import type { BindAddr } from './proc-net-tcp'

export type StreamId = number

export type HostdToContainer =
  | { type: 'broker-hello'; token: string }
  | { type: 'port-watch-subscribe' }
  | { type: 'port-watch-unsubscribe' }
  | { type: 'relay-open'; streamId: StreamId; port: number }
  | { type: 'relay-data'; streamId: StreamId; bytes: string }
  | { type: 'relay-close'; streamId: StreamId; side: 'upstream' | 'downstream' }

export type ContainerToHostd =
  | { type: 'broker-hello-ack' }
  | { type: 'broker-hello-nack'; reason: string }
  | { type: 'port-listen-snapshot'; ports: Array<{ port: number; bindAddr: BindAddr }> }
  | { type: 'port-listen-opened'; port: number; bindAddr: BindAddr }
  | { type: 'port-listen-closed'; port: number }
  | { type: 'relay-open-ack'; streamId: StreamId }
  | { type: 'relay-open-nack'; streamId: StreamId; reason: string }
  | { type: 'relay-data'; streamId: StreamId; bytes: string }
  | { type: 'relay-close'; streamId: StreamId; side: 'upstream' | 'downstream' }

export type PortForwardEvent =
  | { kind: 'port-forward-opened'; containerName: string; port: number; bindAddr: BindAddr }
  | { kind: 'port-forward-closed'; containerName: string; port: number; reason: PortForwardCloseReason }
  | { kind: 'port-forward-failed'; containerName: string; port: number; reason: string }

export type PortForwardCloseReason = 'container-released' | 'host-error' | 'deregistered' | 'broker-stopped'

export function encodeBytes(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64')
}

export function decodeBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}
