import { describe, expect, it } from 'bun:test'

import { decodeWebexId, isWebexIdOfType, toRef } from './webex-id-ref'

const ROOM_ID = 'Y2lzY29zcGFyazovL3VzL1JPT00vZTM1NGY2YjAtMmMyZS0xMWYxLTlmNGYtZmI5NzVmM2ViZWZi'
const PERSON_UUID_ID = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMjM0NTY3OC0xMjM0LTEyMzQtMTIzNC0xMjM0NTY3ODkwYWI='
const PERSON_EMAIL_ID = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9hbGljZUBleGFtcGxlLmNvbQ=='

describe('decodeWebexId (re-exported from agent-messenger)', () => {
  it('decodes a room id into cluster/type/uuid', () => {
    expect(decodeWebexId(ROOM_ID)).toEqual({
      cluster: 'us',
      type: 'ROOM',
      uuid: 'e354f6b0-2c2e-11f1-9f4f-fb975f3ebefb',
    })
  })

  it('decodes a modern person id whose trailing value is a uuid', () => {
    expect(decodeWebexId(PERSON_UUID_ID)).toEqual({
      cluster: 'us',
      type: 'PEOPLE',
      uuid: '12345678-1234-1234-1234-1234567890ab',
    })
  })

  it('decodes a legacy person id whose trailing value is an email', () => {
    expect(decodeWebexId(PERSON_EMAIL_ID)).toEqual({
      cluster: 'us',
      type: 'PEOPLE',
      uuid: 'alice@example.com',
    })
  })

  it('returns null (does not throw) for an empty string', () => {
    expect(decodeWebexId('')).toBeNull()
  })

  it('returns null (does not throw) for a value that is not a ciscospark uri', () => {
    // given: a plausible-looking base64 string that decodes to non-uri text
    const notAWebexId = Buffer.from('just some text').toString('base64')
    expect(decodeWebexId(notAWebexId)).toBeNull()
  })

  it('returns null (does not throw) for a bare uuid already in ref form', () => {
    expect(decodeWebexId('12345678-1234-1234-1234-1234567890ab')).toBeNull()
  })
})

describe('toRef', () => {
  it('returns the trailing uuid for a room id', () => {
    expect(toRef(ROOM_ID)).toBe('e354f6b0-2c2e-11f1-9f4f-fb975f3ebefb')
  })

  it('returns the email for a legacy person id', () => {
    expect(toRef(PERSON_EMAIL_ID)).toBe('alice@example.com')
  })

  it('falls open: a value already in ref form passes through unchanged', () => {
    expect(toRef('alice@example.com')).toBe('alice@example.com')
    expect(toRef('12345678-1234-1234-1234-1234567890ab')).toBe('12345678-1234-1234-1234-1234567890ab')
  })
})

describe('isWebexIdOfType', () => {
  it('matches the decoded resource type', () => {
    expect(isWebexIdOfType(ROOM_ID, 'ROOM')).toBe(true)
    expect(isWebexIdOfType(PERSON_UUID_ID, 'PEOPLE')).toBe(true)
  })

  it('refuses a cross-type match (room id is not a person)', () => {
    expect(isWebexIdOfType(ROOM_ID, 'PEOPLE')).toBe(false)
  })

  it('is false for a non-Webex value', () => {
    expect(isWebexIdOfType('alice@example.com', 'PEOPLE')).toBe(false)
  })
})
