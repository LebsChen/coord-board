import { describe, expect, it } from 'vitest'
import { truncateLabelText } from './StatusLabel'

describe('status label text', () => {
  it('keeps short labels unchanged and truncates long labels', () => {
    expect(truncateLabelText('Mina', 20)).toBe('Mina')
    expect(truncateLabelText('A very long agent name', 10)).toBe('A very lo…')
  })
})
