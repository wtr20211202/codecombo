import { describe, expect, it } from 'vitest'
import type { AxiosError } from 'axios'
import { AppError, classify } from '@/api/error-types'

function makeErr(status: number | null, data?: { error?: string }): AxiosError {
  if (status === null) return { message: 'Network Error' } as unknown as AxiosError
  return { response: { status, data } } as unknown as AxiosError
}

describe('classify', () => {
  it('network when no response', () => {
    expect(classify(makeErr(null))).toBe('network')
  })
  it('auth for 401', () => expect(classify(makeErr(401))).toBe('auth'))
  it('forbidden for 403', () => expect(classify(makeErr(403))).toBe('forbidden'))
  it('notFound for 404', () => expect(classify(makeErr(404))).toBe('notFound'))
  it('validation for 400', () => expect(classify(makeErr(400))).toBe('validation'))
  it('gitConflict for 409 with CONFLICT', () => {
    expect(classify(makeErr(409, { error: 'git merge: CONFLICT in src/a.ts' }))).toBe('gitConflict')
  })
  it('conflict for 409 without CONFLICT', () => {
    expect(classify(makeErr(409, { error: 'file already exists' }))).toBe('conflict')
  })
  it('server for 5xx', () => {
    expect(classify(makeErr(500))).toBe('server')
    expect(classify(makeErr(503))).toBe('server')
  })
  it('client for other 4xx', () => {
    expect(classify(makeErr(429))).toBe('client')
    expect(classify(makeErr(418))).toBe('client')
  })
  it('unknown for non-error status', () => {
    expect(classify(makeErr(200))).toBe('unknown')
  })
})

describe('AppError', () => {
  it('preserves all fields', () => {
    const e = new AppError('auth', 'invalid token', 401, '/api/x', 'POST', 'login.fail')
    expect(e.category).toBe('auth')
    expect(e.rawMessage).toBe('invalid token')
    expect(e.status).toBe(401)
    expect(e.url).toBe('/api/x')
    expect(e.method).toBe('POST')
    expect(e.sourceLabel).toBe('login.fail')
    expect(e.name).toBe('AppError')
    expect(e.message).toBe('invalid token')
  })
})
