import React from 'react'
import { markdownSourceWithNewlines } from '../ui/markdown-source.ts'
import { containsPotentialMath, segmentMathMarkdown } from '../ui/math-segment.ts'
import { parseMarkdownBlocks, type BlockNode, type InlineNode } from './markdown-blocks.ts'

export function MarkdownBody({ source }: { source: string }) {
  const prepared = markdownSourceWithNewlines(source)
  const segments = containsPotentialMath(prepared) ? segmentMathMarkdown(prepared) : [{ kind: 'text' as const, text: prepared }]
  return (
    <div className="web-markdown">
      {segments.map((segment, index) => segment.kind === 'math'
        ? <code key={index} className={segment.display ? 'web-math web-math-display' : 'web-math'}>{segment.latex}</code>
        : <Blocks key={index} blocks={parseMarkdownBlocks(segment.text)} />)}
    </div>
  )
}

function Blocks({ blocks }: { blocks: BlockNode[] }) {
  return <>{blocks.map((block, index) => <Block key={index} block={block} />)}</>
}

function Block({ block }: { block: BlockNode }) {
  switch (block.kind) {
    case 'paragraph': return <p><Inline nodes={block.children} /></p>
    case 'heading': return React.createElement(`h${Math.min(6, block.level + 2)}`, { className: `web-md-h${block.level}` }, <Inline nodes={block.children} />)
    case 'code': return <pre className="web-md-code" data-language={block.language || undefined}><code>{block.text}</code></pre>
    case 'quote': return <blockquote><Blocks blocks={block.children} /></blockquote>
    case 'rule': return <hr />
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}><ListItem blocks={item} /></li>)
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>
    }
    case 'table': return (
      <div className="web-md-table">
        <table>
          <thead><tr>{block.header.map((cell, index) => <th key={index}><Inline nodes={cell} /></th>)}</tr></thead>
          <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}><Inline nodes={cell} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    )
  }
}

// A list item whose only content is one paragraph renders inline so bullets stay tight, matching the desktop layout.
function ListItem({ blocks }: { blocks: BlockNode[] }) {
  if (blocks.length === 1 && blocks[0]!.kind === 'paragraph') return <Inline nodes={blocks[0]!.children} />
  return <Blocks blocks={blocks} />
}

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return <>{nodes.map((node, index) => <InlineItem key={index} node={node} />)}</>
}

function InlineItem({ node }: { node: InlineNode }) {
  switch (node.kind) {
    case 'text': return <>{node.text}</>
    case 'code': return <code>{node.text}</code>
    case 'strong': return <strong><Inline nodes={node.children} /></strong>
    case 'em': return <em><Inline nodes={node.children} /></em>
    case 'strike': return <s><Inline nodes={node.children} /></s>
    case 'break': return <br />
    case 'link': return <a href={node.href} target="_blank" rel="noreferrer noopener"><Inline nodes={node.children} /></a>
  }
}
