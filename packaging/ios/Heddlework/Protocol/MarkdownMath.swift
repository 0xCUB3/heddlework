import Foundation

enum MathSegment: Equatable {
    case text(String)
    case math(latex: String, display: Bool, standalone: Bool)
}

enum MarkdownInline: Equatable {
    case text(String)
    case strong([MarkdownInline])
    case emphasis([MarkdownInline])
    case code(String)
    case link(text: String, url: String)
    case math(String)
}

enum MarkdownBlock: Equatable {
    case heading(level: Int, inlines: [MarkdownInline])
    case paragraph(inlines: [MarkdownInline])
    case list(ordered: Bool, items: [[MarkdownInline]])
    case code(language: String, code: String)
    case quote([MarkdownInline])
    case table(headers: [[MarkdownInline]], rows: [[[MarkdownInline]]])
    case displayMath(String)
    case thematicBreak
}

struct PreparedMarkdown: Equatable {
    var blocks: [MarkdownBlock]
}

enum MarkdownMath {
    static let streamingIntervalNs: UInt64 = 80_000_000
    private static let placeholderStart = "\u{E000}"
    private static let placeholderEnd = "\u{E001}"
    private static let cache = NSCache<NSString, PreparedBox>()
    private static let blockEnvironments: Set<String> = [
        "equation", "equation*", "displaymath", "math", "align", "align*", "alignat", "alignat*",
        "flalign", "flalign*", "gather", "gather*", "multline", "multline*", "split", "aligned",
        "alignedat", "gathered", "array", "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix",
        "Vmatrix", "cases", "CD",
    ]

    static func containsPotentialMath(_ markdown: String) -> Bool {
        markdown.contains("$") || markdown.contains("\\(") || markdown.contains("\\[") || markdown.contains("\\begin{")
    }

    static func prepare(_ source: String) -> PreparedMarkdown {
        let key = source as NSString
        if let cached = cache.object(forKey: key) { return cached.value }
        let prepared = parse(source)
        cache.setObject(PreparedBox(prepared), forKey: key)
        cache.countLimit = 256
        return prepared
    }

    static func segmentMathMarkdown(_ markdown: String) -> [MathSegment] {
        if !containsPotentialMath(markdown) { return [.text(markdown)] }
        let lower = markdown.lowercased()
        var segments: [MathSegment] = []
        var copiedThrough = 0
        var index = markdown.startIndex

        func offset(_ i: String.Index) -> Int { markdown.distance(from: markdown.startIndex, to: i) }
        func indexAt(_ pos: Int) -> String.Index { markdown.index(markdown.startIndex, offsetBy: pos) }

        func emit(start: String.Index, end: String.Index, latex: String, display: Bool) {
            if index > markdown.index(markdown.startIndex, offsetBy: copiedThrough) {
                let from = indexAt(copiedThrough)
                segments.append(.text(String(markdown[from..<index])))
            }
            segments.append(.math(latex: latex, display: display, standalone: isStandalone(markdown, start: start, end: end)))
            copiedThrough = offset(end)
            index = end
        }

        while index < markdown.endIndex {
            if let end = skipIndentedCode(markdown, at: index) {
                index = end
                continue
            }
            if let end = skipFencedCode(markdown, at: index) {
                index = end
                continue
            }
            let ch = markdown[index]
            if ch == "`" {
                index = skipInlineCode(markdown, at: index)
                continue
            }
            if ch == "<", let end = skipHtmlCode(markdown, lower: lower, at: index) {
                index = end
                continue
            }
            if ch == "\\" && !isEscaped(markdown, at: index), let end = skipTexVerb(markdown, at: index) {
                index = end
                continue
            }
            if ch == "$" && !isEscaped(markdown, at: index) {
                let next = markdown.index(after: index)
                if next < markdown.endIndex, markdown[next] == "$" {
                    if let closing = findUnescapedSequence(markdown, "$$", from: markdown.index(after: next)) {
                        let innerStart = markdown.index(after: next)
                        let inner = String(markdown[innerStart..<closing]).trimmingCharacters(in: .whitespacesAndNewlines)
                        if inner.isEmpty {
                            index = markdown.index(closing, offsetBy: 2, limitedBy: markdown.endIndex) ?? markdown.endIndex
                        } else {
                            let endIndex = markdown.index(closing, offsetBy: 2, limitedBy: markdown.endIndex) ?? markdown.endIndex
                            emit(start: index, end: endIndex, latex: inner, display: true)
                        }
                        continue
                    }
                    index = markdown.index(after: next)
                    continue
                }
                if isInlineDollarOpener(markdown, at: index), let closing = findInlineDollarCloser(markdown, from: next) {
                    let raw = String(markdown[next..<closing])
                    if containsUnescapedDollar(raw) {
                        index = next
                        continue
                    }
                    let latex = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                    let end = markdown.index(after: closing)
                    if latex.isEmpty {
                        index = end
                    } else {
                        emit(start: index, end: end, latex: latex, display: false)
                    }
                    continue
                }
                index = next
                continue
            }
            if ch == "\\" && !isEscaped(markdown, at: index) {
                let delimIndex = markdown.index(after: index)
                if delimIndex < markdown.endIndex {
                    let delim = markdown[delimIndex]
                    if delim == "(" || delim == "[" {
                        let closingSeq = delim == "(" ? "\\)" : "\\]"
                        let searchFrom = markdown.index(after: delimIndex)
                        if let closing = findUnescapedSequence(markdown, closingSeq, from: searchFrom) {
                            let inner = String(markdown[searchFrom..<closing]).trimmingCharacters(in: .whitespacesAndNewlines)
                            let end = markdown.index(closing, offsetBy: closingSeq.count, limitedBy: markdown.endIndex) ?? markdown.endIndex
                            if inner.isEmpty {
                                index = end
                            } else {
                                emit(start: index, end: end, latex: inner, display: delim == "[")
                            }
                            continue
                        }
                    }
                }
                if let env = matchBeginEnvironment(markdown, at: index) {
                    if let end = findEnvironmentEnd(markdown, openingEnd: env.end, name: env.name) {
                        let latex = String(markdown[index..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
                        if latex.isEmpty {
                            index = end
                        } else {
                            emit(start: index, end: end, latex: latex, display: env.name != "math")
                        }
                        continue
                    }
                }
            }
            index = markdown.index(after: index)
        }
        if offset(index) > copiedThrough {
            segments.append(.text(String(markdown[indexAt(copiedThrough)..<index])))
        }
        return segments
    }

    static func parse(_ source: String) -> PreparedMarkdown {
        let limited = source.count > 12_000 ? String(source.prefix(12_000)) + "\n…" : source
        let segments = segmentMathMarkdown(limited)
        var math: [String] = []
        var masked = ""
        for segment in segments {
            switch segment {
            case .text(let text):
                masked += text
            case .math(let latex, let display, let standalone):
                let token = "\(placeholderStart)\(math.count)\(placeholderEnd)"
                math.append(latex)
                if display && standalone {
                    masked += "\n\n\(token)\n\n"
                } else {
                    masked += token
                }
            }
        }
        return PreparedMarkdown(blocks: parseBlocks(masked, math: math))
    }

    private static func parseBlocks(_ source: String, math: [String]) -> [MarkdownBlock] {
        let lines = source.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        var blocks: [MarkdownBlock] = []
        var index = 0
        var paragraph: [String] = []

        func flushParagraph() {
            let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            paragraph.removeAll(keepingCapacity: true)
            guard !text.isEmpty else { return }
            if let only = onlyPlaceholder(text), math.indices.contains(only) {
                blocks.append(.displayMath(math[only]))
                return
            }
            blocks.append(.paragraph(inlines: parseInlines(text, math: math)))
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let fence = trimmed.hasPrefix("```") ? "```" : "~~~"
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                index += 1
                var body: [String] = []
                while index < lines.count {
                    if lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) { index += 1; break }
                    body.append(lines[index])
                    index += 1
                }
                blocks.append(.code(language: language, code: body.joined(separator: "\n")))
                continue
            }
            if let heading = headingLine(trimmed) {
                flushParagraph()
                blocks.append(.heading(level: heading.level, inlines: parseInlines(heading.text, math: math)))
                index += 1
                continue
            }
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph()
                blocks.append(.thematicBreak)
                index += 1
                continue
            }
            if trimmed.hasPrefix("> ") || trimmed == ">" {
                flushParagraph()
                var quote: [String] = []
                while index < lines.count {
                    let next = lines[index].trimmingCharacters(in: .whitespaces)
                    if next.hasPrefix("> ") { quote.append(String(next.dropFirst(2))); index += 1; continue }
                    if next == ">" { quote.append(""); index += 1; continue }
                    break
                }
                blocks.append(.quote(parseInlines(quote.joined(separator: "\n"), math: math)))
                continue
            }
            if isTableSeparatorCandidate(lines, at: index) {
                flushParagraph()
                let header = splitTableRow(trimmed)
                index += 2
                var rows: [[String]] = []
                while index < lines.count {
                    let next = lines[index].trimmingCharacters(in: .whitespaces)
                    if !next.contains("|") { break }
                    rows.append(splitTableRow(next))
                    index += 1
                }
                blocks.append(.table(
                    headers: header.map { parseInlines($0, math: math) },
                    rows: rows.map { $0.map { parseInlines($0, math: math) } }
                ))
                continue
            }
            if let list = listMarker(trimmed) {
                flushParagraph()
                var items: [[MarkdownInline]] = []
                var ordered = list.ordered
                while index < lines.count {
                    let next = lines[index].trimmingCharacters(in: .whitespaces)
                    guard let marker = listMarker(next) else { break }
                    ordered = marker.ordered
                    items.append(parseInlines(marker.text, math: math))
                    index += 1
                }
                blocks.append(.list(ordered: ordered, items: items))
                continue
            }
            paragraph.append(line)
            index += 1
        }
        flushParagraph()
        return blocks
    }

    static func parseInlines(_ text: String, math: [String]) -> [MarkdownInline] {
        var result: [MarkdownInline] = []
        var remaining = Substring(text)
        while !remaining.isEmpty {
            if remaining.hasPrefix(placeholderStart),
               let end = remaining.range(of: placeholderEnd),
               let number = Int(remaining[remaining.index(remaining.startIndex, offsetBy: 1)..<end.lowerBound]),
               math.indices.contains(number) {
                result.append(.math(math[number]))
                remaining = remaining[end.upperBound...]
                continue
            }
            if remaining.hasPrefix("`") {
                let rest = remaining.dropFirst()
                if let close = rest.firstIndex(of: "`") {
                    result.append(.code(String(rest[..<close])))
                    remaining = rest[rest.index(after: close)...]
                    continue
                }
            }
            if remaining.hasPrefix("[") {
                if let parsed = parseLink(remaining) {
                    result.append(.link(text: parsed.text, url: parsed.url))
                    remaining = parsed.rest
                    continue
                }
            }
            if remaining.hasPrefix("**"), let close = remaining.dropFirst(2).range(of: "**") {
                let inner = String(remaining[remaining.index(remaining.startIndex, offsetBy: 2)..<close.lowerBound])
                result.append(.strong(parseInlines(inner, math: math)))
                remaining = remaining[close.upperBound...]
                continue
            }
            if remaining.hasPrefix("*"), !remaining.hasPrefix("**"), let close = remaining.dropFirst().firstIndex(of: "*") {
                let inner = String(remaining[remaining.index(after: remaining.startIndex)..<close])
                result.append(.emphasis(parseInlines(inner, math: math)))
                remaining = remaining[remaining.index(after: close)...]
                continue
            }
            let nextSpecial = remaining.dropFirst().firstIndex(where: { $0 == "`" || $0 == "[" || $0 == "*" || $0 == "\u{E000}" }) ?? remaining.endIndex
            result.append(.text(String(remaining[..<nextSpecial])))
            remaining = remaining[nextSpecial...]
        }
        return mergeText(result)
    }

    private static func mergeText(_ inlines: [MarkdownInline]) -> [MarkdownInline] {
        var merged: [MarkdownInline] = []
        for inline in inlines {
            if case .text(let text) = inline, case .text(let previous)? = merged.last {
                merged[merged.count - 1] = .text(previous + text)
            } else {
                merged.append(inline)
            }
        }
        return merged.filter {
            if case .text(let text) = $0 { return !text.isEmpty }
            return true
        }
    }

    private static func parseLink(_ remaining: Substring) -> (text: String, url: String, rest: Substring)? {
        guard remaining.first == "[" else { return nil }
        guard let closeText = remaining.dropFirst().firstIndex(of: "]") else { return nil }
        let after = remaining[remaining.index(after: closeText)...]
        guard after.first == "(" else { return nil }
        guard let closeURL = after.dropFirst().firstIndex(of: ")") else { return nil }
        let text = String(remaining[remaining.index(after: remaining.startIndex)..<closeText])
        let url = String(after[after.index(after: after.startIndex)..<closeURL])
        return (text, url, remaining[remaining.index(after: closeURL)...])
    }

    private static func headingLine(_ trimmed: String) -> (level: Int, text: String)? {
        var level = 0
        for character in trimmed {
            if character == "#" { level += 1 } else { break }
            if level > 6 { return nil }
        }
        guard level > 0, level <= 6 else { return nil }
        let rest = trimmed.dropFirst(level)
        guard rest.first == " " || rest.first == "\t" else { return nil }
        return (level, rest.trimmingCharacters(in: .whitespaces))
    }

    private static func listMarker(_ trimmed: String) -> (ordered: Bool, text: String)? {
        if trimmed.hasPrefix("- ") { return (false, String(trimmed.dropFirst(2))) }
        if trimmed.hasPrefix("* ") { return (false, String(trimmed.dropFirst(2))) }
        var digits = 0
        for character in trimmed {
            if character.isNumber { digits += 1 } else { break }
        }
        guard digits > 0 else { return nil }
        let rest = trimmed.dropFirst(digits)
        if rest.hasPrefix(". ") { return (true, String(rest.dropFirst(2))) }
        return nil
    }

    private static func isTableSeparatorCandidate(_ lines: [String], at index: Int) -> Bool {
        guard index + 1 < lines.count else { return false }
        let header = lines[index].trimmingCharacters(in: .whitespaces)
        let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
        guard header.contains("|"), separator.contains("|") else { return false }
        let cells = splitTableRow(separator)
        return !cells.isEmpty && cells.allSatisfy { cell in
            let marks = cell.trimmingCharacters(in: .whitespaces)
            return !marks.isEmpty && marks.allSatisfy { $0 == "-" || $0 == ":" || $0 == " " }
        }
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var body = line.trimmingCharacters(in: .whitespaces)
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|") { body.removeLast() }
        return body.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func onlyPlaceholder(_ text: String) -> Int? {
        guard text.hasPrefix(placeholderStart), text.hasSuffix(placeholderEnd) else { return nil }
        let inner = text.dropFirst().dropLast()
        return Int(inner)
    }

    private static func isEscaped(_ text: String, at index: String.Index) -> Bool {
        var count = 0
        var cursor = index
        while cursor > text.startIndex {
            cursor = text.index(before: cursor)
            if text[cursor] == "\\" { count += 1 } else { break }
        }
        return count % 2 == 1
    }

    private static func countRun(_ text: String, at index: String.Index, character: Character) -> Int {
        var count = 0
        var cursor = index
        while cursor < text.endIndex, text[cursor] == character {
            count += 1
            cursor = text.index(after: cursor)
        }
        return count
    }

    private static func skipFencedCode(_ text: String, at index: String.Index) -> String.Index? {
        let character = text[index]
        guard character == "`" || character == "~" else { return nil }
        let lineStart = text[..<index].lastIndex(of: "\n").map { text.index(after: $0) } ?? text.startIndex
        let prefix = String(text[lineStart..<index])
        guard prefix.allSatisfy({ $0 == " " || $0 == "\t" || $0 == ">" }) else { return nil }
        let opening = countRun(text, at: index, character: character)
        guard opening >= 3 else { return nil }
        guard let openingLineEnd = text[index...].firstIndex(of: "\n") else { return text.endIndex }
        var nextLineStart = text.index(after: openingLineEnd)
        while nextLineStart <= text.endIndex {
            let nextLineEnd = text[nextLineStart...].firstIndex(of: "\n") ?? text.endIndex
            let line = text[nextLineStart..<nextLineEnd].trimmingCharacters(in: .whitespaces)
            if line.first == character, countRun(String(line), at: line.startIndex, character: character) >= opening {
                return nextLineEnd == text.endIndex ? text.endIndex : text.index(after: nextLineEnd)
            }
            if nextLineEnd == text.endIndex { break }
            nextLineStart = text.index(after: nextLineEnd)
        }
        return text.endIndex
    }

    private static func skipIndentedCode(_ text: String, at index: String.Index) -> String.Index? {
        if index != text.startIndex, text[text.index(before: index)] != "\n" { return nil }
        let firstEnd = text[index...].firstIndex(of: "\n") ?? text.endIndex
        let firstLine = String(text[index..<firstEnd])
        let content = firstLine.replacingOccurrences(of: "^(?: {0,3}>[ \\t]?)+", with: "", options: .regularExpression)
        guard content.hasPrefix("    ") || content.hasPrefix("\t"), !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        var lineStart = index
        while lineStart < text.endIndex {
            let lineEnd = text[lineStart...].firstIndex(of: "\n") ?? text.endIndex
            let line = String(text[lineStart..<lineEnd])
            let trimmedContent = line.replacingOccurrences(of: "^(?: {0,3}>[ \\t]?)+", with: "", options: .regularExpression)
            if !trimmedContent.trimmingCharacters(in: .whitespaces).isEmpty && !(trimmedContent.hasPrefix("    ") || trimmedContent.hasPrefix("\t")) {
                return lineStart
            }
            if lineEnd == text.endIndex { return text.endIndex }
            lineStart = text.index(after: lineEnd)
        }
        return text.endIndex
    }

    private static func skipInlineCode(_ text: String, at index: String.Index) -> String.Index {
        let run = countRun(text, at: index, character: "`")
        let marker = String(repeating: "`", count: run)
        var search = text.index(index, offsetBy: run)
        while search < text.endIndex {
            guard let closing = text[search...].range(of: marker)?.lowerBound else { return text.index(index, offsetBy: run) }
            let before = closing > text.startIndex ? text[text.index(before: closing)] : " "
            let afterIndex = text.index(closing, offsetBy: run, limitedBy: text.endIndex)
            let after = afterIndex != nil && afterIndex! < text.endIndex ? text[afterIndex!] : " "
            if before != "`" && after != "`" { return text.index(closing, offsetBy: run) }
            search = text.index(after: closing)
        }
        return text.index(index, offsetBy: run)
    }

    private static func skipHtmlCode(_ text: String, lower: String, at index: String.Index) -> String.Index? {
        let pos = text.distance(from: text.startIndex, to: index)
        if text[index...].hasPrefix("<!--") {
            if let closing = text[index...].range(of: "-->") {
                return closing.upperBound
            }
            return text.endIndex
        }
        let slice = lower[lower.index(lower.startIndex, offsetBy: pos)...]
        let opening: String
        if slice.hasPrefix("<code") { opening = "code" }
        else if slice.hasPrefix("<pre") { opening = "pre" }
        else { return nil }
        let closingTag = "</\(opening)>"
        if let closing = slice.range(of: closingTag) {
            let distance = lower.distance(from: lower.startIndex, to: closing.upperBound)
            return text.index(text.startIndex, offsetBy: distance)
        }
        return text.endIndex
    }

    private static func skipTexVerb(_ text: String, at index: String.Index) -> String.Index? {
        guard text[index...].hasPrefix("\\verb") else { return nil }
        var cursor = text.index(index, offsetBy: 5)
        if cursor < text.endIndex, text[cursor].isLetter { return nil }
        if cursor < text.endIndex, text[cursor] == "*" { cursor = text.index(after: cursor) }
        guard cursor < text.endIndex else { return nil }
        let delimiter = text[cursor]
        if delimiter.isLetter || delimiter.isNumber || delimiter.isWhitespace { return nil }
        let search = text.index(after: cursor)
        guard let closing = text[search...].firstIndex(of: delimiter) else { return text.endIndex }
        return text.index(after: closing)
    }

    private static func findUnescapedSequence(_ text: String, _ sequence: String, from: String.Index) -> String.Index? {
        var index = from
        while index < text.endIndex {
            if text[index] == "%" && !isEscaped(text, at: index) {
                index = text[index...].firstIndex(of: "\n").map { text.index(after: $0) } ?? text.endIndex
                continue
            }
            if text[index] == "\\" && !isEscaped(text, at: index), let verb = skipTexVerb(text, at: index) {
                index = verb
                continue
            }
            if text[index...].hasPrefix(sequence) && !isEscaped(text, at: index) { return index }
            index = text.index(after: index)
        }
        return nil
    }

    private static func isInlineDollarOpener(_ text: String, at index: String.Index) -> Bool {
        if isEscaped(text, at: index) { return false }
        let next = text.index(after: index)
        guard next < text.endIndex, text[next] != "$" else { return false }
        return !text[next].isWhitespace
    }

    private static func findInlineDollarCloser(_ text: String, from: String.Index) -> String.Index? {
        var index = from
        while index < text.endIndex {
            let character = text[index]
            if character == "\n" || character == "\r" { return nil }
            if character == "$" && !isEscaped(text, at: index) {
                let prev = text.index(before: index)
                let next = text.index(after: index)
                if next < text.endIndex, text[next] == "$" { index = next; continue }
                if text[prev] == "$" || text[prev].isWhitespace { index = next; continue }
                if next < text.endIndex, text[next].isNumber { index = next; continue }
                return index
            }
            index = text.index(after: index)
        }
        return nil
    }

    private static func containsUnescapedDollar(_ text: String) -> Bool {
        var index = text.startIndex
        while index < text.endIndex {
            if text[index] == "$" && !isEscaped(text, at: index) { return true }
            index = text.index(after: index)
        }
        return false
    }

    private static func isStandalone(_ markdown: String, start: String.Index, end: String.Index) -> Bool {
        let lineStart = markdown[..<start].lastIndex(of: "\n").map { markdown.index(after: $0) } ?? markdown.startIndex
        let lineEnd = markdown[end...].firstIndex(of: "\n") ?? markdown.endIndex
        return markdown[lineStart..<start].trimmingCharacters(in: .whitespaces).isEmpty
            && markdown[end..<lineEnd].trimmingCharacters(in: .whitespaces).isEmpty
    }

    private static func matchBeginEnvironment(_ text: String, at index: String.Index) -> (name: String, end: String.Index)? {
        guard text[index...].hasPrefix("\\begin{") else { return nil }
        let nameStart = text.index(index, offsetBy: 7)
        guard let close = text[nameStart...].firstIndex(of: "}") else { return nil }
        let name = String(text[nameStart..<close])
        guard blockEnvironments.contains(name) else { return nil }
        return (name, text.index(after: close))
    }

    private static func findEnvironmentEnd(_ text: String, openingEnd: String.Index, name: String) -> String.Index? {
        var stack = [name]
        var index = openingEnd
        while index < text.endIndex {
            if text[index] == "%" && !isEscaped(text, at: index) {
                index = text[index...].firstIndex(of: "\n").map { text.index(after: $0) } ?? text.endIndex
                continue
            }
            if text[index] == "\\" && !isEscaped(text, at: index) {
                if let verb = skipTexVerb(text, at: index) {
                    index = verb
                    continue
                }
                if let token = matchBeginOrEnd(text, at: index) {
                    if token.kind == "begin" {
                        stack.append(token.name)
                    } else if stack.last == token.name {
                        stack.removeLast()
                        if stack.isEmpty { return token.end }
                    }
                    index = token.end
                    continue
                }
            }
            index = text.index(after: index)
        }
        return nil
    }

    private static func matchBeginOrEnd(_ text: String, at index: String.Index) -> (kind: String, name: String, end: String.Index)? {
        let slice = text[index...]
        let kind: String
        if slice.hasPrefix("\\begin{") { kind = "begin" }
        else if slice.hasPrefix("\\end{") { kind = "end" }
        else { return nil }
        let nameStart = text.index(index, offsetBy: kind == "begin" ? 7 : 5)
        guard let close = text[nameStart...].firstIndex(of: "}") else { return nil }
        return (kind, String(text[nameStart..<close]), text.index(after: close))
    }
}

private final class PreparedBox: NSObject {
    let value: PreparedMarkdown
    init(_ value: PreparedMarkdown) { self.value = value }
}
