import { motion } from '@gpuix/react'
import React, { useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react'

export const SPRING_SETTLE_MS = 500
export const LAYOUT_MOTION_TRANSITION = { duration: 0.42, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } as const
export const MotionDiv = motion.div as ComponentType<ComponentProps<typeof motion.div> & { testId?: string; tabIndex?: number }>

export function useEaseProgress(open: boolean, duration = 0.22): number {
  const [progress, setProgress] = useState(open ? 1 : 0)
  const progressRef = useRef(progress)
  useEffect(() => {
    const from = progressRef.current
    const to = open ? 1 : 0
    if (from === to) return
    const started = performance.now()
    const timer = setInterval(() => {
      const t = Math.min(1, (performance.now() - started) / (duration * 1000))
      const eased = 1 - (1 - t) ** 3
      const next = from + (to - from) * eased
      progressRef.current = next
      setProgress(next)
      if (t >= 1) {
        progressRef.current = to
        setProgress(to)
        clearInterval(timer)
      }
    }, 16)
    return () => clearInterval(timer)
  }, [duration, open])
  return progress
}

export function TextShimmer({
  text,
  testId,
  fontSize,
  fontWeight,
  baseColor,
  highlightColor,
  duration = 2,
}: {
  text: string
  testId?: string
  fontSize: number
  fontWeight?: number
  baseColor: string
  highlightColor: string
  duration?: number
}) {
  return React.createElement('shimmer' as never, {
    testId,
    text,
    baseColor,
    highlightColor,
    duration,
    style: { display: 'flex', flexDirection: 'row', alignItems: 'center', fontSize, ...(fontWeight === undefined ? {} : { fontWeight }), userSelect: 'none', pointerEvents: 'none' },
  } as never, text)
}
