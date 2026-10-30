import { afterEach, describe, expect, it, vi } from 'vitest'
import { UndoManager } from '@main/services/undo'

afterEach(() => {
  vi.useRealTimers()
})

describe('undo manager', () => {
  it('exposes an undo window and hands ids back once', () => {
    vi.useFakeTimers()
    const calls: number[] = []
    const undo = new UndoManager(() => calls.push(Date.now()))
    const now = Date.now()
    const state = undo.set('delete', ['a', 'b'], now)
    expect(state.count).toBe(2)
    expect(state.kind).toBe('delete')
    expect(undo.getState(now)?.expiresAt).toBe(now + 10_000)
    expect(calls.length).toBeGreaterThan(0)

    const taken = undo.take()
    expect(taken?.ids).toEqual(['a', 'b'])
    expect(undo.getState()).toBeNull()
  })

  it('automatically expires after its window', () => {
    vi.useFakeTimers()
    let changed = 0
    const undo = new UndoManager(() => {
      changed += 1
    })
    const now = Date.now()
    undo.set('clear', ['x'], now)
    expect(undo.getState(now)).not.toBeNull()
    vi.advanceTimersByTime(31_000)
    expect(undo.getState(Date.now())).toBeNull()
    expect(changed).toBeGreaterThanOrEqual(2)
  })

  it('replaces a previous action', () => {
    const undo = new UndoManager(() => undefined)
    undo.set('delete', ['a'])
    undo.set('delete', ['b', 'c'])
    expect(undo.take()?.ids).toEqual(['b', 'c'])
  })
})
