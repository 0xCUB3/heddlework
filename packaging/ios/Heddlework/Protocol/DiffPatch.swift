import Foundation

struct DiffLine: Identifiable, Equatable {
    enum Kind: String, Equatable {
        case fileHeader
        case hunk
        case add
        case del
        case context
        case meta
    }

    var id: Int
    var kind: Kind
    var text: String
}

enum DiffPatch {
    static func parse(_ patch: String) -> [DiffLine] {
        var lines: [DiffLine] = []
        lines.reserveCapacity(min(patch.count / 8, 4_000))
        var index = 0
        patch.split(separator: "\n", omittingEmptySubsequences: false).prefix(2_000).forEach { raw in
            let text = String(raw)
            let kind: DiffLine.Kind
            if text.hasPrefix("diff ") || text.hasPrefix("index ") || text.hasPrefix("+++") || text.hasPrefix("---") {
                kind = .fileHeader
            } else if text.hasPrefix("@@") {
                kind = .hunk
            } else if text.hasPrefix("+") {
                kind = .add
            } else if text.hasPrefix("-") {
                kind = .del
            } else if text.hasPrefix("\\") {
                kind = .meta
            } else {
                kind = .context
            }
            lines.append(DiffLine(id: index, kind: kind, text: text.isEmpty ? " " : text))
            index += 1
        }
        return lines
    }
}
