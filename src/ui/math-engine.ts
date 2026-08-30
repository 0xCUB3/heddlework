export interface RenderedFormula {
  svg: string
  widthPx: number
  heightPx: number
}

export type FormulaRenderer = (
  latex: string,
  display: boolean,
  color: string | undefined,
  fontSizePx: number,
) => RenderedFormula | null

/** MathJax SVG dimensions are in `ex`; scale relative to the surrounding text size. */
const EX_TO_EM = 0.5
const RENDER_CACHE_LIMIT = 512

let rendererPromise: Promise<FormulaRenderer | null> | undefined

const TEX_PACKAGES = [
  'base', 'action', 'ams', 'amscd', 'autoload', 'bbm', 'bboldx', 'bbox', 'begingroup',
  'boldsymbol', 'braket', 'bussproofs', 'cancel', 'cases', 'centernot', 'color', 'colortbl',
  'colorv2', 'configmacros', 'dsfont', 'empheq', 'enclose', 'extpfeil', 'fontsizev3',
  'gensymb', 'mathtools', 'mhchem', 'newcommand', 'physics', 'require', 'setoptions',
  'tagformat', 'texhtml', 'textcomp', 'textmacros', 'unicode', 'units', 'upgreek', 'verb',
] as const

async function loadTexPackages(): Promise<void> {
  await Promise.all([
    import('@mathjax/src/js/input/tex/action/ActionConfiguration.js'),
    import('@mathjax/src/js/input/tex/ams/AmsConfiguration.js'),
    import('@mathjax/src/js/input/tex/amscd/AmsCdConfiguration.js'),
    import('@mathjax/src/js/input/tex/autoload/AutoloadConfiguration.js'),
    import('@mathjax/src/js/input/tex/bbm/BbmConfiguration.js'),
    import('@mathjax/src/js/input/tex/bboldx/BboldxConfiguration.js'),
    import('@mathjax/src/js/input/tex/bbox/BboxConfiguration.js'),
    import('@mathjax/src/js/input/tex/begingroup/BegingroupConfiguration.js'),
    import('@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js'),
    import('@mathjax/src/js/input/tex/braket/BraketConfiguration.js'),
    import('@mathjax/src/js/input/tex/bussproofs/BussproofsConfiguration.js'),
    import('@mathjax/src/js/input/tex/cancel/CancelConfiguration.js'),
    import('@mathjax/src/js/input/tex/cases/CasesConfiguration.js'),
    import('@mathjax/src/js/input/tex/centernot/CenternotConfiguration.js'),
    import('@mathjax/src/js/input/tex/color/ColorConfiguration.js'),
    import('@mathjax/src/js/input/tex/colortbl/ColortblConfiguration.js'),
    import('@mathjax/src/js/input/tex/colorv2/ColorV2Configuration.js'),
    import('@mathjax/src/js/input/tex/configmacros/ConfigMacrosConfiguration.js'),
    import('@mathjax/src/js/input/tex/dsfont/DsfontConfiguration.js'),
    import('@mathjax/src/js/input/tex/empheq/EmpheqConfiguration.js'),
    import('@mathjax/src/js/input/tex/enclose/EncloseConfiguration.js'),
    import('@mathjax/src/js/input/tex/extpfeil/ExtpfeilConfiguration.js'),
    import('@mathjax/src/js/input/tex/fontsizev3/FontSizeV3Configuration.js'),
    import('@mathjax/src/js/input/tex/gensymb/GensymbConfiguration.js'),
    import('@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js'),
    import('@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js'),
    import('@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js'),
    import('@mathjax/src/js/input/tex/physics/PhysicsConfiguration.js'),
    import('@mathjax/src/js/input/tex/require/RequireConfiguration.js'),
    import('@mathjax/src/js/input/tex/setoptions/SetOptionsConfiguration.js'),
    import('@mathjax/src/js/input/tex/tagformat/TagFormatConfiguration.js'),
    import('@mathjax/src/js/input/tex/texhtml/TexHtmlConfiguration.js'),
    import('@mathjax/src/js/input/tex/textcomp/TextcompConfiguration.js'),
    import('@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js'),
    import('@mathjax/src/js/input/tex/unicode/UnicodeConfiguration.js'),
    import('@mathjax/src/js/input/tex/units/UnitsConfiguration.js'),
    import('@mathjax/src/js/input/tex/upgreek/UpgreekConfiguration.js'),
    import('@mathjax/src/js/input/tex/verb/VerbConfiguration.js'),
  ])
}

export function loadFormulaRenderer(): Promise<FormulaRenderer | null> {
  rendererPromise ??= createFormulaRenderer()
  return rendererPromise
}

async function createFormulaRenderer(): Promise<FormulaRenderer | null> {
  try {
    const [{ liteAdaptor }, { RegisterHTMLHandler }, { SafeHandler }, { TeX }, { mathjax }, { SVG }] = await Promise.all([
      import('@mathjax/src/js/adaptors/liteAdaptor.js'),
      import('@mathjax/src/js/handlers/html.js'),
      import('@mathjax/src/js/ui/safe/SafeHandler.js'),
      import('@mathjax/src/js/input/tex.js'),
      import('@mathjax/src/js/mathjax.js'),
      import('@mathjax/src/js/output/svg.js'),
    ])
    await loadTexPackages()

    const adaptor = liteAdaptor({ cjkCharWidth: 1, unknownCharWidth: 0.6, unknownCharHeight: 0.8 })
    SafeHandler(RegisterHTMLHandler(adaptor))
    const disabledPackages = new Set(['html', 'noerrors', 'noundefined'])
    const input = new TeX({
      packages: TEX_PACKAGES.filter((name) => !disabledPackages.has(name)),
      tags: 'none',
      formatError: (_jax: unknown, error: Error) => {
        throw error
      },
    })
    const output = new SVG({ fontCache: 'none', mtextInheritFont: true, unknownFamily: 'serif', linebreaks: { inline: false } })
    const document = mathjax.document('', { InputJax: input, OutputJax: output })
    const cache = new Map<string, RenderedFormula | null>()

    const render: FormulaRenderer = (latex, display, color, fontSizePx) => {
      if (!latex.trim()) return null
      const key = `${display ? 'D' : 'I'}\u0000${color ?? ''}\u0000${fontSizePx}\u0000${latex}`
      if (cache.has(key)) return cache.get(key) ?? null
      let rendered: RenderedFormula | null = null
      try {
        input.reset()
        const node = document.convert(latex, { display })
        const source = node === null ? undefined : extractSvg(adaptor.outerHTML(node))
        if (source && !source.includes('data-mml-node="merror"')) {
          const widthEx = parseExDimension(source, 'width')
          const heightEx = parseExDimension(source, 'height')
          if (widthEx !== undefined && heightEx !== undefined) {
            rendered = scaleSvg(source, widthEx, heightEx, fontSizePx * EX_TO_EM)
          }
        }
      } catch {
        rendered = null
      }
      if (cache.size >= RENDER_CACHE_LIMIT) {
        const oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
      cache.set(key, rendered)
      return rendered
    }
    return render
  } catch {
    return null
  }
}

function extractSvg(container: string): string | undefined {
  const start = container.indexOf('<svg')
  if (start < 0) return undefined
  const end = container.lastIndexOf('</svg>')
  return end < 0 ? undefined : container.slice(start, end + 6)
}

function parseExDimension(svg: string, name: 'width' | 'height'): number | undefined {
  const match = new RegExp(`${name}="([0-9.]+)ex"`).exec(svg)
  const value = match ? Number.parseFloat(match[1]!) : Number.NaN
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function scaleSvg(svg: string, widthEx: number, heightEx: number, pxPerEx: number): RenderedFormula {
  const widthPx = Math.max(1, Math.round(widthEx * pxPerEx))
  const heightPx = Math.max(1, Math.round(heightEx * pxPerEx))
  const scaled = svg
    .replace(/<svg\b/, '<svg overflow="hidden"')
    .replace(/width="[0-9.]+ex"/, `width="${widthPx}px"`)
    .replace(/height="[0-9.]+ex"/, `height="${heightPx}px"`)
    .replace(/ style="[^"]*"/, '')
  return { svg: scaled, widthPx, heightPx }
}

export function formulaFallbackSource(latex: string, display: boolean): string {
  return display ? `\n\`\`\`\n${latex}\n\`\`\`\n` : `\`${latex}\``
}
