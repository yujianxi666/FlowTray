import { useRef, type PointerEvent } from 'react'
import { useAppStore } from '../store'

export function ResizeHandles() {
  const snapshot = useAppStore((state) => state.snapshot)
  const side = snapshot?.settings.shelfSide ?? 'right'
  const startRef = useRef({
    x: 0,
    y: 0,
    width: 396,
    height: 680
  })
  const frame = useRef<number | null>(null)
  const pending = useRef<{ width: number; height: number } | null>(null)

  if (!snapshot) return null

  const flush = (): void => {
    frame.current = null
    if (!pending.current) return
    window.flowtray.window.resizeLive(pending.current.width, pending.current.height)
    pending.current = null
  }

  const begin = (event: PointerEvent, corner: boolean): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    startRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: snapshot.settings.shelfWidth,
      height: snapshot.settings.shelfHeight
    }
    window.flowtray.window.setInteractionLock(true)
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    const move = (moveEvent: globalThis.PointerEvent): void => {
      const dx = moveEvent.clientX - startRef.current.x
      const dy = moveEvent.clientY - startRef.current.y
      const width = clamp(
        side === 'right' ? startRef.current.width - dx : startRef.current.width + dx,
        340,
        560
      )
      const height = corner
        ? clamp(startRef.current.height + dy, 480, Math.min(1000, window.innerHeight - 16))
        : startRef.current.height
      pending.current = { width, height }
      if (frame.current == null) {
        frame.current = requestAnimationFrame(flush)
      }
    }

    const up = (): void => {
      target.removeEventListener('pointermove', move as unknown as EventListener)
      target.removeEventListener('pointerup', up as unknown as EventListener)
      target.removeEventListener('pointercancel', up as unknown as EventListener)
      if (frame.current != null) cancelAnimationFrame(frame.current)
      frame.current = null
      pending.current = null
      window.flowtray.window.resizeEnd()
      window.flowtray.window.setInteractionLock(false)
    }

    target.addEventListener('pointermove', move as unknown as EventListener)
    target.addEventListener('pointerup', up as unknown as EventListener)
    target.addEventListener('pointercancel', up as unknown as EventListener)
  }

  return (
    <>
      <div
        className="resize-edge"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整悬浮窗宽度"
        onPointerDown={(event) => begin(event, false)}
      />
      <div
        className="resize-corner"
        role="separator"
        aria-label="调整悬浮窗高度"
        onPointerDown={(event) => begin(event, true)}
      />
    </>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}
