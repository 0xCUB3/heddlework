import { useEffect, useRef, useState } from 'react'

export const SPRING_SETTLE_MS = 500

const STIFFNESS = 420
const DAMPING = 38
const POSITION_EPSILON = 0.001
const VELOCITY_EPSILON = 0.01

export function useSpringProgress(open: boolean): number {
  const target = open ? 1 : 0
  const [progress, setProgress] = useState(target)
  const progressRef = useRef(progress)
  const velocityRef = useRef(0)

  useEffect(() => {
    let previousTime = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      const seconds = Math.min(0.032, (now - previousTime) / 1_000)
      previousTime = now
      const displacement = target - progressRef.current
      const acceleration = STIFFNESS * displacement - DAMPING * velocityRef.current
      velocityRef.current += acceleration * seconds
      progressRef.current += velocityRef.current * seconds

      if (Math.abs(target - progressRef.current) < POSITION_EPSILON && Math.abs(velocityRef.current) < VELOCITY_EPSILON) {
        progressRef.current = target
        velocityRef.current = 0
        setProgress(target)
        clearInterval(timer)
        return
      }
      setProgress(progressRef.current)
    }, 16)
    return () => clearInterval(timer)
  }, [target])

  return Math.max(0, progress)
}
