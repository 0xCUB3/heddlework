import { motion } from '@gpuix/react'
import { useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react'

export const SPRING_SETTLE_MS = 500
export const MotionDiv = motion.div as ComponentType<ComponentProps<typeof motion.div> & { testId?: string; tabIndex?: number }>

const STIFFNESS = 420
const DAMPING = 38
const POSITION_EPSILON = 0.001
const VELOCITY_EPSILON = 0.01

export interface SpringValueOptions {
  stiffness?: number
  damping?: number
  positionEpsilon?: number
  velocityEpsilon?: number
}

export function useSpringValue(target: number, options: SpringValueOptions = {}): number {
  const stiffness = options.stiffness ?? STIFFNESS
  const damping = options.damping ?? DAMPING
  const positionEpsilon = options.positionEpsilon ?? POSITION_EPSILON
  const velocityEpsilon = options.velocityEpsilon ?? VELOCITY_EPSILON
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
      const acceleration = stiffness * displacement - damping * velocityRef.current
      velocityRef.current += acceleration * seconds
      progressRef.current += velocityRef.current * seconds

      if (Math.abs(target - progressRef.current) < positionEpsilon && Math.abs(velocityRef.current) < velocityEpsilon) {
        progressRef.current = target
        velocityRef.current = 0
        setProgress(target)
        clearInterval(timer)
        return
      }
      setProgress(progressRef.current)
    }, 16)
    return () => clearInterval(timer)
  }, [damping, positionEpsilon, stiffness, target, velocityEpsilon])

  return progress
}

export function useSpringProgress(open: boolean): number {
  return Math.max(0, useSpringValue(open ? 1 : 0))
}
