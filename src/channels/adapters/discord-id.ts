export function isDiscordSnowflake(value: string): boolean {
  if (!/^[1-9]\d{0,19}$/.test(value)) return false
  return BigInt(value) <= 18_446_744_073_709_551_615n
}
