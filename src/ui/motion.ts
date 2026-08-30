import { motion } from '@gpuix/react'
import React, { useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react'

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
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const started = performance.now()
    const timer = setInterval(() => setElapsed(performance.now() - started), 32)
    return () => clearInterval(timer)
  }, [])
  const phase = (elapsed / 1000 / duration) % 1
  const letters = [...text]
  return React.createElement(
    'div',
    { testId, style: { display: 'flex', flexDirection: 'row', alignItems: 'center' } },
    ...letters.map((letter, index) => {
      const mix = Math.max(0, 1 - Math.abs(index - (phase * (letters.length + 2) - 1)) / 1.6)
      return React.createElement('text', {
        key: `${index}:${letter}`,
        style: { color: mixHex(baseColor, highlightColor, mix), fontSize, ...(fontWeight === undefined ? {} : { fontWeight }) },
      }, letter)
    }),
  )
}

function mixHex(left: string, right: string, amount: number): string {
  const t = Math.min(1, Math.max(0, amount))
  const a = hexRgb(left)
  const b = hexRgb(right)
  const channel = (from: number, to: number) => Math.round(from + (to - from) * t)
  return `rgb(${channel(a[0], b[0])}, ${channel(a[1], b[1])}, ${channel(a[2], b[2])})`
}

function hexRgb(value: string): [number, number, number] {
  const hex = value.replace('#', '')
  const normalized = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex
  return [Number.parseInt(normalized.slice(0, 2), 16) || 0, Number.parseInt(normalized.slice(2, 4), 16) || 0, Number.parseInt(normalized.slice(4, 6), 16) || 0]
}
