import { markdownSourceWithNewlines } from '../ui/markdown-source.ts'
import { containsPotentialMath, segmentMathMarkdown } from '../ui/math-segment.ts'

export function MarkdownBody({ source }: { source: string }) {
  const prepared = markdownSourceWithNewlines(source)
  const segments = containsPotentialMath(prepared) ? segmentMathMarkdown(prepared) : [{ kind: 'text' as const, text: prepared }]
  return (
    <div className="web-markdown">
      {segments.map((segment, index) => segment.kind === 'math'
        ? <code key={index} className={segment.display ? 'web-math web-math-display' : 'web-math'}>{segment.latex}</code>
        : <span key={index}>{segment.text}</span>)}
    </div>
  )
}
