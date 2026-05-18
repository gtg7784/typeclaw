export type DeliveryDedup = {
  has: (deliveryId: string) => boolean
  add: (deliveryId: string) => void
  size: () => number
}

export function createDeliveryDedup(limit = 1000): DeliveryDedup {
  const seen = new Map<string, true>()
  return {
    has(deliveryId: string): boolean {
      return seen.has(deliveryId)
    },
    add(deliveryId: string): void {
      if (seen.has(deliveryId)) seen.delete(deliveryId)
      seen.set(deliveryId, true)
      while (seen.size > limit) {
        const oldest = seen.keys().next().value
        if (oldest === undefined) break
        seen.delete(oldest)
      }
    },
    size(): number {
      return seen.size
    },
  }
}
