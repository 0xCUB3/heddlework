import SwiftUI
import UIKit

struct RichMarkdownView: View {
    let source: String
    var streaming = false
    var style: MarkdownStyle = .body
    @State private var prepared: PreparedMarkdown
    @State private var pending: String?
    @State private var flushTask: Task<Void, Never>?

    init(source: String, streaming: Bool = false, style: MarkdownStyle = .body) {
        self.source = source
        self.streaming = streaming
        self.style = style
        _prepared = State(initialValue: MarkdownMath.prepare(source))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: style.blockGap) {
            ForEach(Array(prepared.blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block, style: style)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("rich-markdown")
        .onChange(of: source) { _, next in
            schedulePrepare(next)
        }
        .onDisappear { flushTask?.cancel() }
    }

    private func schedulePrepare(_ next: String) {
        if !streaming {
            prepared = MarkdownMath.prepare(next)
            pending = nil
            return
        }
        pending = next
        guard flushTask == nil else { return }
        flushTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: MarkdownMath.streamingIntervalNs)
            if let pending {
                prepared = await Task.detached(priority: .utility) { MarkdownMath.prepare(pending) }.value
            }
            self.pending = nil
            flushTask = nil
        }
    }
}

enum MarkdownStyle {
    case body
    case compact

    var fontSize: CGFloat { self == .body ? 14 : 12 }
    var blockGap: CGFloat { self == .body ? 10 : 6 }
    var codeSize: CGFloat { self == .body ? 12 : 11 }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let style: MarkdownStyle

    var body: some View {
        switch block {
        case .heading(let level, let inlines):
            MarkdownInlineView(inlines: inlines, font: headingFont(level), weight: .semibold)
                .padding(.top, level <= 2 ? 8 : 4)
                .accessibilityIdentifier("markdown-heading")
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let inlines):
            MarkdownInlineView(inlines: inlines, font: .workbench(size: style.fontSize), weight: .regular)
        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(index + 1)." : "•")
                            .font(.workbench(size: style.fontSize))
                            .foregroundStyle(AppColors.muted)
                            .frame(minWidth: 14, alignment: .trailing)
                        MarkdownInlineView(inlines: item, font: .workbench(size: style.fontSize), weight: .regular)
                    }
                }
            }
            .accessibilityIdentifier("markdown-list")
        case .code(_, let code):
            MarkdownCodeBlock(code: code, size: style.codeSize)
        case .quote(let inlines):
            MarkdownInlineView(inlines: inlines, font: .workbench(size: style.fontSize), weight: .regular)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(AppColors.borderStrong).frame(width: 2) }
                .foregroundStyle(AppColors.muted)
        case .table(let headers, let rows):
            MarkdownTableView(headers: headers, rows: rows, style: style)
        case .displayMath(let latex):
            FormulaView(latex: latex, display: true, fontSize: style.fontSize + 2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        case .thematicBreak:
            Divider().overlay(AppColors.border)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .workbench(size: 20, weight: .semibold)
        case 2: return .workbench(size: 17, weight: .semibold)
        case 3: return .workbench(size: 15, weight: .semibold)
        default: return .workbench(size: 14, weight: .semibold)
        }
    }
}

private struct MarkdownInlineView: View {
    let inlines: [MarkdownInline]
    let font: Font
    var weight: Font.Weight = .regular

    var body: some View {
        inlines.reduce(Text("")) { partial, inline in
            partial + render(inline)
        }
        .font(font)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func render(_ inline: MarkdownInline) -> Text {
        switch inline {
        case .text(let text):
            return Text(text)
        case .strong(let children):
            return children.reduce(Text("")) { $0 + render($1) }.fontWeight(.semibold)
        case .emphasis(let children):
            return children.reduce(Text("")) { $0 + render($1) }.italic()
        case .code(let code):
            return Text(code)
                .font(.workbench(size: 12, design: .monospaced))
                .foregroundColor(AppColors.text)
        case .link(let text, let url):
            var attributed = AttributedString(text)
            attributed.link = URL(string: url)
            attributed.underlineStyle = .single
            attributed.foregroundColor = UIColor(AppColors.primary)
            return Text(attributed)
        case .math(let latex):
            return Text(FormulaTypesetter.attributed(latex, display: false, fontSize: 14))
        }
    }
}

private struct MarkdownCodeBlock: View {
    let code: String
    let size: CGFloat
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: size, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button(copied ? "Copied" : "Copy") {
                UIPasteboard.general.string = code
                copied = true
            }
            .font(.workbench(size: 11, weight: .medium))
            .accessibilityLabel(copied ? "Copied" : "Copy code")
        }
        .padding(10)
        .background(AppColors.raised)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityIdentifier("markdown-code")
        .simultaneousGesture(DragGesture(minimumDistance: 12))
    }
}

private struct MarkdownTableView: View {
    let headers: [[MarkdownInline]]
    let rows: [[[MarkdownInline]]]
    let style: MarkdownStyle

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { _, cell in
                        MarkdownInlineView(inlines: cell, font: .workbench(size: style.fontSize, weight: .semibold), weight: .semibold)
                            .padding(8)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            MarkdownInlineView(inlines: cell, font: .workbench(size: style.fontSize), weight: .regular)
                                .padding(8)
                        }
                    }
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppColors.border, lineWidth: 1))
        }
        .accessibilityIdentifier("markdown-table")
    }
}

struct FormulaView: View {
    let latex: String
    var display = false
    var fontSize: CGFloat = 14

    var body: some View {
        Text(FormulaTypesetter.attributed(latex, display: display, fontSize: fontSize))
            .textSelection(.enabled)
            .padding(display ? 8 : 0)
            .frame(maxWidth: display ? .infinity : nil)
            .accessibilityIdentifier("markdown-math")
            .accessibilityLabel(latex)
    }
}

enum FormulaTypesetter {
    static func attributed(_ latex: String, display: Bool, fontSize: CGFloat) -> AttributedString {
        let rendered = render(latex)
        if rendered == nil {
            var fallback = AttributedString(latex)
            fallback.font = .system(size: fontSize, design: .monospaced).italic()
            fallback.foregroundColor = UIColor(AppColors.muted)
            return fallback
        }
        var result = AttributedString(rendered!)
        result.font = display
            ? .system(size: fontSize + 2, design: .serif).italic()
            : .system(size: fontSize, design: .serif).italic()
        return result
    }

    static func render(_ latex: String) -> String? {
        do {
            return try TeXRenderer.render(latex)
        } catch {
            return nil
        }
    }
}

enum TeXRenderError: Error { case malformed }

enum TeXRenderer {
    static func render(_ latex: String) throws -> String {
        var parser = TeXParser(latex)
        let nodes = try parser.parse()
        if parser.failed { throw TeXRenderError.malformed }
        return stringify(nodes)
    }

    private static func stringify(_ nodes: [TeXNode]) -> String {
        nodes.map(stringify).joined()
    }

    private static func stringify(_ node: TeXNode) -> String {
        switch node {
        case .text(let text): return text
        case .space: return " "
        case .symbol(let symbol): return symbol
        case .group(let children): return stringify(children)
        case .superscript(let base, let exp):
            return stringify(base) + toSuperscript(stringify(exp))
        case .subscript_(let base, let sub):
            return stringify(base) + toSubscript(stringify(sub))
        case .frac(let num, let den):
            return stringify(num) + "/" + stringify(den)
        case .sqrt(let inner):
            return "√" + stringify(inner)
        }
    }

    private static func toSuperscript(_ text: String) -> String {
        let map: [Character: Character] = [
            "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
            "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ",
        ]
        return String(text.map { map[$0] ?? $0 })
    }

    private static func toSubscript(_ text: String) -> String {
        let map: [Character: Character] = [
            "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
            "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ",
            "j": "ⱼ", "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ", "p": "ₚ", "r": "ᵣ", "s": "ₛ",
            "t": "ₜ", "u": "ᵤ", "v": "ᵥ", "x": "ₓ",
        ]
        return String(text.map { map[$0] ?? $0 })
    }
}

indirect enum TeXNode {
    case text(String)
    case space
    case symbol(String)
    case group([TeXNode])
    case superscript(base: TeXNode, exp: TeXNode)
    case subscript_(base: TeXNode, sub: TeXNode)
    case frac(TeXNode, TeXNode)
    case sqrt(TeXNode)
}

struct TeXParser {
    private let chars: [Character]
    private var index = 0
    var failed = false

    init(_ source: String) { chars = Array(source) }

    mutating func parse() throws -> [TeXNode] {
        var nodes: [TeXNode] = []
        while index < chars.count {
            nodes.append(try atom())
        }
        return foldScripts(nodes)
    }

    private mutating func atom() throws -> TeXNode {
        guard index < chars.count else { throw TeXRenderError.malformed }
        let character = chars[index]
        if character == "{" {
            index += 1
            var children: [TeXNode] = []
            while index < chars.count, chars[index] != "}" {
                children.append(try atom())
            }
            guard index < chars.count, chars[index] == "}" else { failed = true; throw TeXRenderError.malformed }
            index += 1
            return .group(foldScripts(children))
        }
        if character == "}" { failed = true; throw TeXRenderError.malformed }
        if character == "^" || character == "_" {
            index += 1
            let script = try requiredAtom()
            return character == "^" ? .superscript(base: .text(""), exp: script) : .subscript_(base: .text(""), sub: script)
        }
        if character == "\\" {
            return try command()
        }
        if character.isWhitespace {
            index += 1
            return .space
        }
        index += 1
        if let symbol = TeXSymbols.operators[character] { return .symbol(symbol) }
        return .text(String(character))
    }

    private mutating func requiredAtom() throws -> TeXNode {
        skipSpaces()
        return try atom()
    }

    private mutating func command() throws -> TeXNode {
        index += 1
        guard index < chars.count else { throw TeXRenderError.malformed }
        if !chars[index].isLetter {
            let character = chars[index]
            index += 1
            if character == "," || character == ";" || character == " " { return .space }
            if character == "{" || character == "}" { return .text(String(character)) }
            return .symbol(String(character))
        }
        var name = ""
        while index < chars.count, chars[index].isLetter {
            name.append(chars[index])
            index += 1
        }
        skipSpaces()
        switch name {
        case "frac":
            return .frac(try requiredAtom(), try requiredAtom())
        case "sqrt":
            return .sqrt(try requiredAtom())
        case "text", "mathrm", "mathbf", "mathit":
            return try requiredAtom()
        case "left", "right":
            return try requiredAtom()
        case "begin", "end":
            if index < chars.count, chars[index] == "{" {
                while index < chars.count, chars[index] != "}" { index += 1 }
                if index < chars.count { index += 1 }
            }
            return .space
        default:
            if let symbol = TeXSymbols.commands[name] { return .symbol(symbol) }
            return .text("\\(name)")
        }
    }

    private mutating func skipSpaces() {
        while index < chars.count, chars[index].isWhitespace { index += 1 }
    }

    private func foldScripts(_ nodes: [TeXNode]) -> [TeXNode] {
        var folded: [TeXNode] = []
        for node in nodes {
            switch node {
            case .superscript(let base, let exp) where isEmpty(base):
                if let last = folded.popLast() {
                    folded.append(.superscript(base: last, exp: exp))
                } else {
                    folded.append(node)
                }
            case .subscript_(let base, let sub) where isEmpty(base):
                if let last = folded.popLast() {
                    folded.append(.subscript_(base: last, sub: sub))
                } else {
                    folded.append(node)
                }
            default:
                folded.append(node)
            }
        }
        return folded
    }

    private func isEmpty(_ node: TeXNode) -> Bool {
        if case .text(let text) = node { return text.isEmpty }
        return false
    }
}

enum TeXSymbols {
    static let operators: [Character: String] = ["+": "+", "-": "−", "=": "=", "<": "<", ">": ">"]
    static let commands: [String: String] = [
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε",
        "zeta": "ζ", "eta": "η", "theta": "θ", "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ",
        "nu": "ν", "xi": "ξ", "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ",
        "phi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω", "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ",
        "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
        "infty": "∞", "sum": "∑", "int": "∫", "prod": "∏", "cdot": "·", "times": "×", "div": "÷",
        "pm": "±", "mp": "∓", "leq": "≤", "geq": "≥", "neq": "≠", "approx": "≈", "equiv": "≡",
        "to": "→", "rightarrow": "→", "leftarrow": "←", "in": "∈", "subset": "⊂", "cup": "∪",
        "cap": "∩", "ldots": "…", "cdots": "⋯", "quad": "  ", "qquad": "    ", "dots": "…",
        "partial": "∂", "nabla": "∇", "ell": "ℓ", "hbar": "ℏ", "Re": "ℜ", "Im": "ℑ",
    ]
}
