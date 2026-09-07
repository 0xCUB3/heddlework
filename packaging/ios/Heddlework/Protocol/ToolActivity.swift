import Foundation

// Swift port of src/ui/tool-activity.ts. Same presentation records, same bounds. Mobile previews fewer lines by default but
// keeps the operation, its state, its error and an expansion affordance.

enum ToolActivityPhase: String, Equatable {
    case preparing
    case running
    case complete
    case failed
}

struct BoundedExcerpt: Equatable {
    var text: String
    var lineCount: Int
    var totalLines: Int
    var hiddenLines: Int
}

struct FabricChildActivityPreview: Equatable, Identifiable {
    var ref: String
    var title: String
    var phase: ToolActivityPhase
    var durationMs: Double?
    var path: String?
    var rangeLabel: String?
    var excerpt: BoundedExcerpt?
    var fullText: String?
    var id: String { ref }
}

struct FabricActivityPreview: Equatable {
    var name: String
    var description: String?
    var codeExcerpt: BoundedExcerpt?
    var code: String?
    var children: [FabricChildActivityPreview]
    var completed: Int
    var failed: Int
    var running: Int
}

struct ToolActivityPreview: Equatable {
    var phase: ToolActivityPhase
    var title: String
    var subtitle: String?
    var statusLabel: String
    var durationMs: Double?
    var path: String?
    var rangeLabel: String?
    var language: String?
    var excerpt: BoundedExcerpt?
    var outputTail: BoundedExcerpt?
    var diffExcerpt: BoundedExcerpt?
    var matchLines: BoundedExcerpt?
    var matchTotal: Int?
    var preparingLabel: String?
    var fabric: FabricActivityPreview?
    /// The complete retained result text, for the "show all" affordance. Nil when the host supplied nothing.
    var fullText: String?

    var hiddenLines: Int {
        [excerpt, outputTail, diffExcerpt, matchLines].compactMap { $0?.hiddenLines }.max() ?? 0
    }
}

enum TranscriptVisibilityMode: String, CaseIterable, Identifiable {
    case balanced
    case detailed
    var id: String { rawValue }
    var label: String { self == .balanced ? "Balanced" : "Detailed" }
    static let storageKey = "heddlework.transcript.visibility"
}

enum ToolActivity {
    static let balancedPreviewMaxLines = 8
    static let balancedPreviewMaxChars = 2_400
    static let detailedPreviewMaxLines = 48
    /// Compact iPhone previews keep fewer lines; the affordance to expand remains.
    static let mobileBalancedPreviewMaxLines = 5

    static func previewLines(detailed: Bool, mobile: Bool) -> Int {
        if detailed { return detailedPreviewMaxLines }
        return mobile ? mobileBalancedPreviewMaxLines : balancedPreviewMaxLines
    }

    // MARK: Partial arguments

    static func mergeToolArgs(_ args: JSONValue?, argsText: String?) -> [String: JSONValue] {
        var merged = args?.objectValue ?? [:]
        guard let argsText, !argsText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return merged }
        for (key, value) in parsePartialToolArgs(argsText) where merged[key] == nil {
            merged[key] = value
        }
        return merged
    }

    /// Bounded, tolerant extraction of display metadata from streamed argument text. Never throws, never implies execution.
    static func parsePartialToolArgs(_ raw: String) -> [String: JSONValue] {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return [:] }
        if let data = trimmed.data(using: .utf8),
           let parsed = try? JSONDecoder().decode(JSONValue.self, from: data),
           let object = parsed.objectValue {
            return object
        }
        var out: [String: JSONValue] = [:]
        let displayName = extractPartialJSONString(trimmed, key: "display", nestedKey: "name") ?? extractPartialJSONString(trimmed, key: "name")
        let displayDescription = extractPartialJSONString(trimmed, key: "display", nestedKey: "description") ?? extractPartialJSONString(trimmed, key: "description")
        if displayName != nil || displayDescription != nil {
            var display: [String: JSONValue] = [:]
            if let displayName { display["name"] = .string(displayName) }
            if let displayDescription { display["description"] = .string(displayDescription) }
            out["display"] = .object(display)
        }
        if let code = extractPartialJSONString(trimmed, key: "code") { out["code"] = .string(code) }
        for key in ["path", "command", "pattern", "query"] {
            if let value = extractPartialJSONString(trimmed, key: key) { out[key] = .string(value) }
        }
        return out
    }

    static func extractPartialJSONString(_ raw: String, key: String, nestedKey: String? = nil) -> String? {
        let quoted = "\"((?:\\\\.|[^\"\\\\])*)\""
        let pattern: String
        if let nestedKey {
            pattern = "\"\(NSRegularExpression.escapedPattern(for: key))\"\\s*:\\s*\\{[^}]*\"\(NSRegularExpression.escapedPattern(for: nestedKey))\"\\s*:\\s*\(quoted)"
        } else {
            pattern = "\"\(NSRegularExpression.escapedPattern(for: key))\"\\s*:\\s*\(quoted)"
        }
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else { return nil }
        let range = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        guard let match = regex.firstMatch(in: raw, options: [], range: range), match.numberOfRanges > 1,
              let captured = Range(match.range(at: 1), in: raw) else { return nil }
        let body = String(raw[captured])
        if body.isEmpty { return nil }
        if let data = "\"\(body)\"".data(using: .utf8), let decoded = try? JSONDecoder().decode(String.self, from: data) {
            return decoded
        }
        return body
            .replacingOccurrences(of: "\\n", with: "\n")
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\\\", with: "\\")
    }

    // MARK: Bounds

    static func boundedExcerpt(_ value: String, maxLines: Int = balancedPreviewMaxLines, maxChars: Int = balancedPreviewMaxChars) -> BoundedExcerpt? {
        let normalized = value.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        if normalized.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let totalLines = lines.count
        var selected = Array(lines.prefix(max(0, maxLines)))
        var text = selected.joined(separator: "\n")
        if text.count > maxChars {
            text = String(text.prefix(maxChars))
            selected = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        }
        let lineCount = selected.count
        return BoundedExcerpt(text: text, lineCount: lineCount, totalLines: totalLines, hiddenLines: max(0, totalLines - lineCount))
    }

    static func hiddenLinesLabel(_ hiddenLines: Int) -> String {
        if hiddenLines <= 0 { return "" }
        return hiddenLines == 1 ? "1 line hidden" : "\(hiddenLines) lines hidden"
    }

    // MARK: Phase and timing

    static func phase(of tool: ToolRun) -> ToolActivityPhase {
        if tool.isError { return .failed }
        if tool.status == "preparing" { return .preparing }
        if tool.status == "running" { return .running }
        return .complete
    }

    static func statusLabel(_ tool: ToolRun) -> String {
        switch phase(of: tool) {
        case .failed: return "failed"
        case .preparing: return "preparing"
        case .running: return "running"
        case .complete: return "done"
        }
    }

    /// Duration only when the host supplied it. Never derived from transcript timestamps.
    static func durationMs(_ tool: ToolRun, isFabric: Bool) -> Double? {
        if !isFabric, let direct = findNumber(tool.details, key: "durationMs") { return direct }
        if let started = findNumber(tool.details, key: "startedAt"), let ended = findNumber(tool.details, key: "endedAt") {
            return max(0, ended - started)
        }
        return nil
    }

    static func formatDuration(_ ms: Double) -> String {
        if ms < 1_000 { return "\(Int(ms.rounded()))ms" }
        if ms < 60_000 {
            let seconds = ms / 1_000
            return seconds < 10 ? String(format: "%.1fs", seconds) : "\(Int(seconds.rounded()))s"
        }
        return TranscriptProjection.formatElapsedSeconds(ms / 1_000)
    }

    // MARK: Presentation

    static func preview(for tool: ToolRun, detailed: Bool = false, mobile: Bool = false, maxPreviewLines: Int? = nil) -> ToolActivityPreview {
        let maxLines = maxPreviewLines ?? previewLines(detailed: detailed, mobile: mobile)
        let phase = phase(of: tool)
        let merged = mergeToolArgs(tool.args, argsText: tool.argsText)
        let isFabric = tool.name == "fabric_exec"
        let duration = durationMs(tool, isFabric: isFabric)
        if isFabric { return fabricPreview(tool, merged: merged, phase: phase, durationMs: duration, maxLines: maxLines) }
        switch tool.name {
        case "read": return readPreview(tool, merged: merged, phase: phase, durationMs: duration, maxLines: maxLines)
        case "edit", "write": return editPreview(tool, merged: merged, phase: phase, durationMs: duration, maxLines: maxLines)
        case "bash": return bashPreview(tool, merged: merged, phase: phase, durationMs: duration, maxLines: maxLines)
        case "grep", "find", "ls": return searchPreview(tool, merged: merged, phase: phase, durationMs: duration, maxLines: maxLines)
        default: break
        }
        let content = tool.output ?? ""
        let diff = findString(tool.details, key: "diff") ?? findDiff(content)
        var preview = ToolActivityPreview(
            phase: phase,
            title: headlineArg(merged) ?? tool.name,
            statusLabel: statusLabel(tool),
            durationMs: duration,
            path: merged["path"]?.stringValue,
            fullText: content.isEmpty ? nil : content
        )
        if let diff {
            preview.diffExcerpt = boundedExcerpt(diff, maxLines: maxLines)
            preview.fullText = diff
        } else if !content.isEmpty {
            preview.excerpt = boundedExcerpt(content, maxLines: maxLines)
        } else if phase == .preparing, let argsText = tool.argsText, !argsText.isEmpty {
            preview.excerpt = boundedExcerpt(argsText, maxLines: min(3, maxLines))
        }
        if phase == .preparing { preview.preparingLabel = "Preparing call…" }
        return preview
    }

    // MARK: Turn metrics

    static func isTurnMetrics(_ item: TimelineItem) -> Bool {
        item.kind == .contextInjection && item.source == "turn metrics"
    }

    static func turnMetricsText(_ items: [TimelineItem]) -> String? {
        for item in items.reversed() where isTurnMetrics(item) {
            let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
        }
        return nil
    }

    static func itemsWithoutTurnMetrics(_ items: [TimelineItem]) -> [TimelineItem] {
        items.filter { !isTurnMetrics($0) }
    }

    // MARK: Tool families

    private static func fabricPreview(_ tool: ToolRun, merged: [String: JSONValue], phase: ToolActivityPhase, durationMs: Double?, maxLines: Int) -> ToolActivityPreview {
        let partial = parsePartialToolArgs(tool.argsText ?? "")
        let display = runDisplay(merged["display"] ?? partial["display"])
        let name = display.name.isEmpty ? "Fabric execution" : display.name
        let code = merged["code"]?.stringValue ?? partial["code"]?.stringValue ?? extractPartialJSONString(tool.argsText ?? "", key: "code")
        let children = fabricAudits(tool.details).map { fabricChild($0, maxLines: maxLines) }
        let outputFormat = tool.details?.string("outputFormat")
        let output = tool.output ?? ""
        var preview = ToolActivityPreview(
            phase: phase,
            title: name,
            subtitle: display.description,
            statusLabel: statusLabel(tool),
            durationMs: durationMs,
            language: outputFormat == "json" || outputFormat == "yaml" ? outputFormat : "text",
            fullText: output.isEmpty ? nil : output
        )
        if !output.isEmpty {
            // Fabric's returned value is a compact result; the children already carry each operation's payload.
            preview.excerpt = boundedExcerpt(output, maxLines: min(4, maxLines))
        }
        if phase == .preparing { preview.preparingLabel = "Preparing Fabric call…" }
        preview.fabric = FabricActivityPreview(
            name: name,
            description: display.description,
            codeExcerpt: code.flatMap { boundedExcerpt($0, maxLines: min(4, maxLines)) },
            code: code,
            children: children,
            completed: children.filter { $0.phase == .complete }.count,
            failed: children.filter { $0.phase == .failed }.count,
            running: children.filter { $0.phase == .running || $0.phase == .preparing }.count
        )
        return preview
    }

    struct FabricAudit: Equatable {
        var ref: String
        var tool: String?
        var provider: String?
        var success: Bool?
        var args: [String: JSONValue]
        var result: JSONValue?
        var error: String?
        var durationMs: Double?
    }

    static func fabricAudits(_ details: JSONValue?) -> [FabricAudit] {
        guard let details = details?.objectValue else { return [] }
        let raw: [JSONValue]
        if case .array(let audits)? = details["audits"] {
            raw = audits
        } else if case .object(let trace)? = details["trace"], case .array(let operations)? = trace["operations"] {
            raw = operations
        } else {
            return []
        }
        return raw.compactMap { value in
            guard let audit = value.objectValue, let ref = audit["ref"]?.stringValue else { return nil }
            var success: Bool?
            if case .bool(let flag)? = audit["success"] { success = flag }
            if let outcome = audit["outcome"]?.stringValue { success = outcome == "succeeded" }
            var duration: Double?
            if case .number(let started)? = audit["startedAt"], case .number(let ended)? = audit["endedAt"] { duration = max(0, ended - started) }
            if case .number(let direct)? = audit["durationMs"] { duration = direct }
            return FabricAudit(
                ref: ref,
                tool: audit["tool"]?.stringValue ?? audit["action"]?.stringValue,
                provider: audit["provider"]?.stringValue,
                success: success,
                args: audit["args"]?.objectValue ?? [:],
                result: audit["result"],
                error: audit["error"]?.stringValue,
                durationMs: duration
            )
        }
    }

    private static func fabricChild(_ audit: FabricAudit, maxLines: Int) -> FabricChildActivityPreview {
        let phase: ToolActivityPhase
        switch audit.success {
        case .some(false): phase = .failed
        case .some(true): phase = .complete
        case .none: phase = .running
        }
        let path = audit.args["path"]?.stringValue
        let offset = audit.args["offset"]?.numberValue
        let limit = audit.args["limit"]?.numberValue
        var rangeLabel: String?
        if path != nil, offset != nil || limit != nil {
            rangeLabel = formatRange(start: Int(offset ?? 1), end: rangeEnd(offset: offset, limit: limit))
        }
        let resultText = formatAuditResult(audit)
        let toolName = [audit.provider, audit.tool].compactMap { $0 }.joined(separator: ".")
        let base = toolName.isEmpty ? audit.ref : toolName
        let detail = headlineArg(audit.args)
        return FabricChildActivityPreview(
            ref: audit.ref,
            title: detail.map { "\(base) \($0)" } ?? base,
            phase: phase,
            durationMs: audit.durationMs,
            path: path,
            rangeLabel: rangeLabel,
            excerpt: resultText.isEmpty ? nil : boundedExcerpt(resultText, maxLines: maxLines),
            fullText: resultText.isEmpty ? nil : resultText
        )
    }

    private static func readPreview(_ tool: ToolRun, merged: [String: JSONValue], phase: ToolActivityPhase, durationMs: Double?, maxLines: Int) -> ToolActivityPreview {
        let path = merged["path"]?.stringValue ?? ""
        let offset = merged["offset"]?.numberValue
        let limit = merged["limit"]?.numberValue
        let content = tool.output ?? ""
        var preview = ToolActivityPreview(
            phase: phase,
            title: path.isEmpty ? "Read file" : path,
            statusLabel: statusLabel(tool),
            durationMs: durationMs,
            path: path.isEmpty ? nil : path,
            rangeLabel: path.isEmpty ? nil : formatRange(start: Int(offset ?? 1), end: rangeEnd(offset: offset, limit: limit)),
            language: languageForPath(path),
            excerpt: numberedExcerpt(content, startLine: Int(offset ?? 1), maxLines: maxLines),
            fullText: content.isEmpty ? nil : numberedText(content, startLine: Int(offset ?? 1))
        )
        if phase == .preparing { preview.preparingLabel = "Preparing read…" }
        return preview
    }

    private static func editPreview(_ tool: ToolRun, merged: [String: JSONValue], phase: ToolActivityPhase, durationMs: Double?, maxLines: Int) -> ToolActivityPreview {
        let path = merged["path"]?.stringValue ?? ""
        let content = tool.output ?? ""
        let diff = findString(tool.details, key: "diff") ?? findDiff(content)
        var preview = ToolActivityPreview(
            phase: phase,
            title: path.isEmpty ? (tool.name == "write" ? "Wrote file" : "Edited file") : path,
            statusLabel: statusLabel(tool),
            durationMs: durationMs,
            path: path.isEmpty ? nil : path,
            language: languageForPath(path),
            fullText: diff ?? (content.isEmpty ? nil : content)
        )
        if let diff {
            preview.diffExcerpt = boundedExcerpt(diff, maxLines: maxLines)
        } else if !content.isEmpty {
            preview.excerpt = boundedExcerpt(content, maxLines: maxLines)
        }
        if phase == .preparing { preview.preparingLabel = "Preparing edit…" }
        return preview
    }

    private static func bashPreview(_ tool: ToolRun, merged: [String: JSONValue], phase: ToolActivityPhase, durationMs: Double?, maxLines: Int) -> ToolActivityPreview {
        let command = merged["command"]?.stringValue ?? ""
        let output = tool.output ?? ""
        var preview = ToolActivityPreview(
            phase: phase,
            title: command.isEmpty ? "Command" : command,
            statusLabel: statusLabel(tool),
            durationMs: durationMs,
            language: "bash",
            excerpt: command.isEmpty ? nil : boundedExcerpt(command, maxLines: 3),
            fullText: output.isEmpty ? nil : output
        )
        if !output.isEmpty {
            let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
            let lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            let tail = Array(lines.suffix(maxLines)).joined(separator: "\n")
            var excerpt = boundedExcerpt(tail, maxLines: maxLines)
            // The tail hides the *leading* lines; report the real count from the complete output.
            excerpt?.totalLines = lines.count
            excerpt?.hiddenLines = max(0, lines.count - (excerpt?.lineCount ?? 0))
            preview.outputTail = excerpt
        }
        if phase == .preparing { preview.preparingLabel = "Preparing command…" }
        return preview
    }

    private static func searchPreview(_ tool: ToolRun, merged: [String: JSONValue], phase: ToolActivityPhase, durationMs: Double?, maxLines: Int) -> ToolActivityPreview {
        let pattern = merged["pattern"]?.stringValue ?? merged["query"]?.stringValue ?? merged["path"]?.stringValue ?? tool.name
        let output = tool.output ?? ""
        let lines = output.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        var preview = ToolActivityPreview(
            phase: phase,
            title: pattern,
            statusLabel: statusLabel(tool),
            durationMs: durationMs,
            path: merged["path"]?.stringValue,
            fullText: output.isEmpty ? nil : output
        )
        if !lines.isEmpty {
            preview.matchLines = boundedExcerpt(Array(lines.prefix(maxLines)).joined(separator: "\n"), maxLines: maxLines)
            preview.matchLines?.totalLines = lines.count
            preview.matchLines?.hiddenLines = max(0, lines.count - (preview.matchLines?.lineCount ?? 0))
            preview.matchTotal = lines.count
        }
        if phase == .preparing { preview.preparingLabel = "Preparing search…" }
        return preview
    }

    // MARK: Helpers

    static func numberedExcerpt(_ content: String, startLine: Int, maxLines: Int) -> BoundedExcerpt? {
        guard var excerpt = boundedExcerpt(content, maxLines: maxLines) else { return nil }
        excerpt.text = numberedText(excerpt.text, startLine: startLine)
        return excerpt
    }

    static func numberedText(_ content: String, startLine: Int) -> String {
        content.split(separator: "\n", omittingEmptySubsequences: false).enumerated().map { index, line in
            let number = String(startLine + index)
            let padded = String(repeating: " ", count: max(0, 4 - number.count)) + number
            return "\(padded) | \(line)"
        }.joined(separator: "\n")
    }

    private static func rangeEnd(offset: Double?, limit: Double?) -> Int? {
        guard let limit else { return nil }
        if let offset { return Int(offset + limit - 1) }
        return Int(limit)
    }

    static func formatRange(start: Int, end: Int?) -> String {
        if let end, end != start { return "L\(start)-\(end)" }
        return "L\(start)"
    }

    static func languageForPath(_ path: String) -> String? {
        let lower = path.lowercased()
        if lower.hasSuffix(".ts") || lower.hasSuffix(".tsx") { return "typescript" }
        if lower.hasSuffix(".js") || lower.hasSuffix(".jsx") { return "javascript" }
        if lower.hasSuffix(".json") { return "json" }
        if lower.hasSuffix(".md") { return "markdown" }
        if lower.hasSuffix(".swift") { return "swift" }
        if lower.hasSuffix(".rs") { return "rust" }
        if lower.hasSuffix(".py") { return "python" }
        if lower.hasSuffix(".sh") { return "bash" }
        if lower.hasSuffix(".yml") || lower.hasSuffix(".yaml") { return "yaml" }
        return nil
    }

    static func headlineArg(_ record: [String: JSONValue]) -> String? {
        for key in ["path", "command", "cmd", "pattern", "query", "url", "name"] {
            if let value = record[key]?.stringValue, !value.isEmpty {
                let firstLine = value.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? value
                return firstLine.count > 120 ? String(firstLine.prefix(120)) + "…" : firstLine
            }
        }
        return nil
    }

    private static func formatAuditResult(_ audit: FabricAudit) -> String {
        if let error = audit.error, !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return error }
        guard let result = audit.result else { return "" }
        switch result {
        case .string(let text): return text
        case .null: return ""
        case .object(let record):
            // pi.bash returns { ok, output, details }; the output is the readable part.
            if let output = record["output"]?.stringValue { return output }
            return prettyJSON(result)
        default: return prettyJSON(result)
        }
    }

    static func prettyJSON(_ value: JSONValue) -> String {
        guard JSONSerialization.isValidJSONObject(value.any) || value.objectValue != nil || { if case .array = value { return true }; return false }() else {
            return String(describing: value.any)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: value.any, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return String(describing: value.any) }
        return text
    }

    private static func runDisplay(_ value: JSONValue?) -> (name: String, description: String?) {
        guard let value else { return ("", nil) }
        if case .string(let raw) = value {
            if let data = raw.data(using: .utf8), let parsed = try? JSONDecoder().decode(JSONValue.self, from: data), parsed.objectValue != nil {
                return runDisplay(parsed)
            }
            return (raw.trimmingCharacters(in: .whitespacesAndNewlines), nil)
        }
        let record = value.objectValue ?? [:]
        let name = record["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let description = record["description"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (name, description?.isEmpty == false ? description : nil)
    }

    static func findString(_ value: JSONValue?, key: String) -> String? {
        guard let record = value?.objectValue else { return nil }
        if let direct = record[key]?.stringValue { return direct }
        for child in record.values {
            if let found = findString(child, key: key) { return found }
        }
        return nil
    }

    static func findNumber(_ value: JSONValue?, key: String) -> Double? {
        guard let record = value?.objectValue else { return nil }
        if case .number(let direct)? = record[key], direct.isFinite { return direct }
        for child in record.values {
            if let found = findNumber(child, key: key) { return found }
        }
        return nil
    }

    static func findDiff(_ value: String?) -> String? {
        guard let value, let marker = value.range(of: "diff --git ") else { return nil }
        return String(value[marker.lowerBound...])
    }
}

extension JSONValue {
    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }
}

