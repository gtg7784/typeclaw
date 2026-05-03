import type { PortForward } from '@/config'
import { CONTAINER_PORT } from '@/container'

export type ShouldForwardOptions = {
  policy: PortForward
  port: number
  containerPort?: number
}

// CONTAINER_PORT is always implicitly excluded: that mapping is owned by
// `docker run -p ${hostPort}:${CONTAINER_PORT}` and forwarding it again would
// fight the published port. Tests can override containerPort to verify the
// implicit exclusion independently of the global constant.
export function shouldForward({ policy, port, containerPort = CONTAINER_PORT }: ShouldForwardOptions): boolean {
  if (port === containerPort) return false
  if (Array.isArray(policy.allow)) return policy.allow.includes(port)
  if (policy.deny?.includes(port)) return false
  return true
}

export function brokerEnabled(policy: PortForward): boolean {
  if (Array.isArray(policy.allow) && policy.allow.length === 0) return false
  return true
}
