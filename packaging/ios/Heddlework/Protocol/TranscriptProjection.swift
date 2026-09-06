import Foundation

struct TimelineImage: Equatable {
    var data: String
    var mimeType: String
}

struct TimelineItem: Equatable {
    enum Kind: String, Equatable {
        case user
        case assistant
        case thinking
        case contextInjection = "context-injection"
        case tool
        case notice
        case compaction
        case status
    }

    var id: String
    var kind: Kind
    var text: String = ""
    var images: [TimelineImage] = []
    var streaming: Bool = false
    var timestamp: Double?
    var revertEntryId: String?
    var tool: ToolRun?
    var notice: Notice?
    var tokensBefore: Double?
    var source: String?
    var tone: String?
}

struct WorkTrace: Equatable {
    enum Identity: String, Equatable { case boundary, terminal }
    var id: String
    var items: [TimelineItem]
    var changedPaths: [String]
    var identity: Identity
    var boundaryId: String?
    var revertEntryId: String?
}

enum DisplayTimelineItem: Equatable {
    case user(TimelineItem)
    case assistant(TimelineItem)
    case status(TimelineItem)
    case workTrace(WorkTrace)

    var id: String {
        switch self {
        case .user(let item), .assistant(let item), .status(let item): return item.id
        case .workTrace(let trace): return trace.id
        }
    }

    var kindName: String {
        switch self {
        case .user: return "user"
        case .assistant: return "assistant"
        case .status: return "status"
        case .workTrace: return "work-trace"
        }
    }

    var workTrace: WorkTrace? {
        if case .workTrace(let trace) = self { return trace }
        return nil
    }
}

struct TranscriptProjectionRow: Identifiable, Equatable {
    enum Kind: String, Equatable {
        case timelineItem = "timeline-item"
        case traceHeader = "trace-header"
        case traceEntry = "trace-entry"
        case traceNotices = "trace-notices"
        case traceFiles = "trace-files"
        case traceContinuation = "trace-continuation"
    }

    var id: String
    var kind: Kind
    var item: TimelineItem?
    var trace: WorkTrace?
    var traceId: String?
    var notices: [TimelineItem] = []
    var paths: [String] = []
    var remaining: Int = 0
}

enum TranscriptProjection {
    static func buildTimeline(
        messages: [PiMessage],
        liveAssistant: LiveAssistant?,
        liveTools: [ToolRun],
        forkMessages: [PiForkMessage] = [],
        messageIndexOffset: Int = 0,
        notices: [Notice] = []
    ) -> [TimelineItem] {
        var items: [TimelineItem] = []
        var toolIndexes: [String: Int] = [:]
        var userMessageIndex = 0
        var revertEntryId: String?
        let forkByEntry = Dictionary(uniqueKeysWithValues: forkMessages.map { ($0.entryId, $0) })

        for (localIndex, message) in messages.enumerated() {
            if message.role == "custom" && message.display != true { continue }
            let messageIndex = messageIndexOffset + localIndex
            let entryId = message.workbenchEntryId
            let base = entryId.map { "entry-\($0)" } ?? "\(message.timestamp ?? Double(messageIndex))-\(messageIndex)"
            if message.role == "custom" {
                let text = messageText(message)
                let images = messageImages(message)
                if !text.isEmpty || !images.isEmpty {
                    items.append(TimelineItem(id: "\(base)-context", kind: .contextInjection, text: text, images: images, timestamp: message.timestamp, revertEntryId: revertEntryId, source: message.customType))
                }
                continue
            }
            if message.role == "user" {
                let positional = userMessageIndex < forkMessages.count ? forkMessages[userMessageIndex] : nil
                userMessageIndex += 1
                let fork = entryId.flatMap { forkByEntry[$0] } ?? positional
                revertEntryId = fork?.entryId ?? entryId
                items.append(TimelineItem(id: "\(base)-user", kind: .user, text: messageText(message), images: messageImages(message), timestamp: message.timestamp, revertEntryId: revertEntryId))
                continue
            }
            if message.role == "assistant" {
                if case .string(let content)? = message.content {
                    if !content.isEmpty {
                        items.append(TimelineItem(id: "\(base)-assistant", kind: .assistant, text: content, timestamp: message.timestamp, revertEntryId: revertEntryId))
                    }
                    continue
                }
                for (blockIndex, block) in (message.content?.blocks ?? []).enumerated() {
                    if block.type == "text", let text = block.text, !text.isEmpty {
                        items.append(TimelineItem(id: "\(base)-text-\(blockIndex)", kind: .assistant, text: text, timestamp: message.timestamp, revertEntryId: revertEntryId))
                    } else if block.type == "thinking", let thinking = block.thinking, !thinking.isEmpty {
                        items.append(TimelineItem(id: "\(base)-thinking-\(blockIndex)", kind: .thinking, text: thinking, timestamp: message.timestamp, revertEntryId: revertEntryId))
                    } else if block.type == "toolCall" {
                        let id = block.id ?? "\(base)-tool-\(blockIndex)"
                        let tool = ToolRun(id: id, name: block.name ?? "tool", args: block.arguments, argsText: nil, output: nil, details: nil, status: "preparing", isError: false)
                        toolIndexes[id] = items.count
                        items.append(TimelineItem(id: "tool-\(id)", kind: .tool, timestamp: message.timestamp, revertEntryId: revertEntryId, tool: tool))
                    }
                }
                continue
            }
            if message.role == "toolResult" {
                let id = message.toolCallId ?? "\(base)-result"
                let result = ToolRun(
                    id: id,
                    name: message.toolName ?? "tool",
                    args: nil,
                    argsText: nil,
                    output: contentText(message.content),
                    details: message.details,
                    status: "complete",
                    isError: message.isError ?? false
                )
                if let existingIndex = toolIndexes[id] {
                    var existing = items[existingIndex]
                    if existing.kind == .tool, var tool = existing.tool {
                        let args = tool.args
                        tool = result
                        tool.args = args
                        existing.tool = tool
                        items[existingIndex] = existing
                    }
                } else {
                    toolIndexes[id] = items.count
                    items.append(TimelineItem(id: "tool-\(id)", kind: .tool, timestamp: message.timestamp, revertEntryId: revertEntryId, tool: result))
                }
                continue
            }
            if let compaction = readCompaction(message) {
                items.append(TimelineItem(id: "\(base)-compaction", kind: .compaction, text: compaction.text, timestamp: message.timestamp, revertEntryId: revertEntryId, tokensBefore: compaction.tokensBefore))
                continue
            }
            if message.role == "bashExecution" {
                let id = "\(base)-bash"
                let isError = (message.exitCode ?? 0) != 0
                let args: JSONValue = .object(["command": .string(message.command ?? "")])
                items.append(TimelineItem(
                    id: id,
                    kind: .tool,
                    timestamp: message.timestamp,
                    revertEntryId: revertEntryId,
                    tool: ToolRun(id: id, name: "bash", args: args, argsText: nil, output: message.output ?? "", details: nil, status: "complete", isError: isError)
                ))
                continue
            }
            let text = messageText(message)
            if !text.isEmpty, message.role == "telemetry" {
                items.append(TimelineItem(id: "\(base)-telemetry", kind: .contextInjection, text: text, timestamp: message.timestamp, source: "turn metrics"))
                continue
            }
            if !text.isEmpty {
                items.append(TimelineItem(id: "\(base)-status", kind: .status, text: text, timestamp: message.timestamp, revertEntryId: revertEntryId))
            }
        }

        if let liveAssistant {
            for block in liveAssistant.blocks where !block.text.isEmpty {
                items.append(TimelineItem(
                    id: "\(liveAssistant.id)-\(block.kind)-\(block.index)",
                    kind: block.kind == "text" ? .assistant : .thinking,
                    text: block.text,
                    streaming: true,
                    revertEntryId: revertEntryId
                ))
            }
        }

        for liveTool in liveTools {
            if let index = toolIndexes[liveTool.id] {
                var existing = items[index]
                if existing.kind == .tool, var tool = existing.tool {
                    tool = mergedTool(tool, liveTool)
                    existing.tool = tool
                    items[index] = existing
                }
            } else {
                items.append(TimelineItem(id: "live-tool-\(liveTool.id)", kind: .tool, revertEntryId: revertEntryId, tool: liveTool))
            }
        }

        return interleaveTraceNotices(settleAbandonedTools(items), notices)
    }

    static func groupWorkItems(_ items: [TimelineItem], isStreaming: Bool = false) -> [DisplayTimelineItem] {
        let absorbedAssistants = intermediateAssistantIds(items)
        var grouped: [DisplayTimelineItem] = []
        var boundaryId: String?
        for item in items {
            // Turn metrics may be persisted after the final answer. Keep them with that turn's work, as desktop does.
            if item.kind == .contextInjection, item.source == "turn metrics" {
                var attached = false
                var index = grouped.count - 1
                while index >= 0 {
                    let candidate = grouped[index]
                    if case .user = candidate { break }
                    if case .workTrace(var trace) = candidate, !isCompactionWorkTrace(trace) {
                        trace.items.append(item)
                        grouped[index] = .workTrace(trace)
                        attached = true
                        break
                    }
                    index -= 1
                }
                if attached { continue }
            }
            if item.kind == .compaction {
                grouped.append(.workTrace(WorkTrace(
                    id: "work-trace-\(item.id)",
                    items: [item],
                    changedPaths: [],
                    identity: .terminal,
                    revertEntryId: item.revertEntryId
                )))
                continue
            }
            if !isTraceItem(item, absorbedAssistants: absorbedAssistants) {
                grouped.append(displayLeaf(item))
                boundaryId = item.id
                continue
            }
            if case .workTrace(var previous) = grouped.last, previous.items.allSatisfy({ $0.kind != .compaction }) {
                previous.items.append(item)
                if item.kind != .notice { previous.id = "work-trace-\(item.id)" }
                if let revert = item.revertEntryId { previous.revertEntryId = revert }
                if let path = changedPath(item), !previous.changedPaths.contains(path) { previous.changedPaths.append(path) }
                grouped[grouped.count - 1] = .workTrace(previous)
            } else {
                let path = changedPath(item)
                grouped.append(.workTrace(WorkTrace(
                    id: "work-trace-\(item.id)",
                    items: [item],
                    changedPaths: path.map { [$0] } ?? [],
                    identity: .terminal,
                    boundaryId: boundaryId,
                    revertEntryId: item.revertEntryId
                )))
            }
        }

        var lastUser = -1
        for (index, item) in grouped.enumerated() where item.kindName == "user" { lastUser = index }
        for index in grouped.indices {
            guard case .workTrace(var item) = grouped[index], let boundary = item.boundaryId, !item.items.contains(where: { $0.kind == .compaction }) else { continue }
            let later = grouped.suffix(from: index + 1)
            let currentTurn = index > lastUser && later.allSatisfy { next in
                if next.kindName == "user" { return false }
                if case .assistant(let assistant) = next, !assistant.streaming { return false }
                return true
            }
            if !item.items.contains(where: isActiveTraceEntry) && !(isStreaming && currentTurn) { continue }
            item.id = "work-trace-after-\(boundary)"
            item.identity = .boundary
            grouped[index] = .workTrace(item)
        }
        return grouped
    }

    static func pendingWorkTraceId(_ items: [DisplayTimelineItem], isStreaming: Bool) -> String? {
        if !isStreaming || liveWorkTraceId(items, isStreaming: isStreaming) != nil { return nil }
        var lastUser = -1
        for (index, item) in items.enumerated() where item.kindName == "user" { lastUser = index }
        if lastUser < 0 { return nil }
        if lastUser + 1 < items.count {
            for index in (lastUser + 1)..<items.count {
                let item = items[index]
                if item.kindName == "assistant" || item.kindName == "work-trace" { return nil }
            }
        }
        return "work-trace-after-\(items[lastUser].id)"
    }

    static func emptyWorkTrace(_ id: String) -> WorkTrace {
        let boundaryId = id.hasPrefix("work-trace-after-") ? String(id.dropFirst("work-trace-after-".count)) : id
        return WorkTrace(id: id, items: [], changedPaths: [], identity: .boundary, boundaryId: boundaryId)
    }

    static func liveWorkTraceId(_ items: [DisplayTimelineItem], isStreaming: Bool) -> String? {
        var lastUser = -1
        for (index, item) in items.enumerated() where item.kindName == "user" { lastUser = index }
        var index = items.count - 1
        while index > lastUser {
            let item = items[index]
            if item.kindName == "assistant" { return nil }
            if case .workTrace(let trace) = item {
                if isCompactionWorkTrace(trace) { return nil }
                return isStreaming ? trace.id : nil
            }
            index -= 1
        }
        return nil
    }

    static func currentWorkWave(_ items: [TimelineItem]) -> (tools: [TimelineItem], preview: TimelineItem?) {
        var start = 0
        for (index, item) in items.enumerated() where item.kind == .assistant { start = index + 1 }
        let wave = Array(items.suffix(from: start))
        return (wave.filter { $0.kind == .tool }, wave.last)
    }

    static func projectTranscriptRows(_ items: [DisplayTimelineItem], expandedTraceIds: Set<String>, traceLimits: [String: Int]) -> [TranscriptProjectionRow] {
        var rows: [TranscriptProjectionRow] = []
        for item in items {
            guard case .workTrace(let trace) = item else {
                if case .user(let leaf) = item { rows.append(TranscriptProjectionRow(id: leaf.id, kind: .timelineItem, item: leaf)) }
                else if case .assistant(let leaf) = item { rows.append(TranscriptProjectionRow(id: leaf.id, kind: .timelineItem, item: leaf)) }
                else if case .status(let leaf) = item { rows.append(TranscriptProjectionRow(id: leaf.id, kind: .timelineItem, item: leaf)) }
                continue
            }
            rows.append(TranscriptProjectionRow(id: trace.id, kind: .traceHeader, trace: trace))
            if expandedTraceIds.contains(trace.id) {
                let defaultLimit = traceLimits[trace.id] ?? trace.items.count
                let limit = min(trace.items.count, max(0, defaultLimit))
                let entries = Array(trace.items.prefix(limit))
                var index = 0
                while index < entries.count {
                    let entry = entries[index]
                    if entry.kind != .notice {
                        rows.append(TranscriptProjectionRow(id: "\(trace.id):entry:\(entry.id)", kind: .traceEntry, item: entry, traceId: trace.id))
                        index += 1
                        continue
                    }
                    var notices = [entry]
                    while index + 1 < entries.count, entries[index + 1].kind == .notice {
                        let next = entries[index + 1]
                        let previous = notices[notices.count - 1]
                        if (next.notice?.createdAt ?? 0) - (previous.notice?.createdAt ?? 0) > 5_000 { break }
                        notices.append(next)
                        index += 1
                    }
                    rows.append(TranscriptProjectionRow(id: "\(trace.id):notices:\(notices[0].id)", kind: .traceNotices, traceId: trace.id, notices: notices))
                    index += 1
                }
                if limit < trace.items.count {
                    rows.append(TranscriptProjectionRow(id: "\(trace.id):continuation", kind: .traceContinuation, traceId: trace.id, remaining: trace.items.count - limit))
                }
            }
            if !trace.changedPaths.isEmpty {
                rows.append(TranscriptProjectionRow(id: "\(trace.id):files", kind: .traceFiles, traceId: trace.id, paths: trace.changedPaths))
            }
        }
        return rows
    }

    static func projectWorkspace(snapshot: WorkbenchSnapshot, expandedTraceIds: Set<String> = [], traceLimits: [String: Int] = [:]) -> [TranscriptProjectionRow] {
        let timeline = buildTimeline(
            messages: snapshot.messages ?? [],
            liveAssistant: snapshot.liveAssistant,
            liveTools: snapshot.liveTools ?? [],
            forkMessages: snapshot.forkMessages ?? [],
            notices: snapshot.notices ?? []
        )
        let grouped = groupWorkItems(timeline, isStreaming: snapshot.session?.isStreaming ?? false)
        var rows = projectTranscriptRows(grouped, expandedTraceIds: expandedTraceIds, traceLimits: traceLimits)
        let streaming = snapshot.session?.isStreaming ?? false
        if let liveId = liveWorkTraceId(grouped, isStreaming: streaming) ?? pendingWorkTraceId(grouped, isStreaming: streaming) {
            if !rows.contains(where: { $0.id == liveId }) {
                rows.append(TranscriptProjectionRow(id: liveId, kind: .traceHeader, trace: emptyWorkTrace(liveId)))
            }
        }
        return rows
    }

    static func isActiveTraceEntry(_ item: TimelineItem) -> Bool {
        if item.kind == .thinking { return item.streaming }
        if item.kind == .tool { return item.tool?.status != "complete" }
        return false
    }

    static func isCompactionWorkTrace(_ trace: WorkTrace) -> Bool {
        trace.items.contains(where: { $0.kind == .compaction })
            && trace.items.allSatisfy({ $0.kind == .compaction || $0.kind == .notice })
    }

    static func workTraceLabel(_ trace: WorkTrace, running: Bool, durationKnown: Bool) -> String {
        if running { return "Working" }
        if let compaction = compactionTraceLabel(trace) { return compaction }
        if durationKnown, let duration = traceDuration(trace.items) { return "Worked for \(duration)" }
        return "Worked"
    }

    static func compactionTraceLabel(_ trace: WorkTrace) -> String? {
        guard isCompactionWorkTrace(trace), let compaction = trace.items.first(where: { $0.kind == .compaction }) else { return nil }
        if let tokens = compaction.tokensBefore {
            return "Compacted from \(formatGrouped(Int(tokens))) tokens"
        }
        return "Compacted"
    }

    static func traceDuration(_ items: [TimelineItem]) -> String? {
        var earliest = Double.infinity
        var latest = -Double.infinity
        var count = 0
        for item in items {
            guard let timestamp = item.timestamp, timestamp.isFinite else { continue }
            earliest = min(earliest, timestamp)
            latest = max(latest, timestamp)
            count += 1
        }
        guard count > 1 else { return nil }
        return formatElapsedSeconds((latest - earliest) / 1_000)
    }

    static func formatElapsedSeconds(_ value: Double) -> String {
        let seconds = value.isFinite ? max(1, Int((value).rounded())) : 1
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3_600 {
            let minutes = seconds / 60
            let remainder = seconds % 60
            return remainder == 0 ? "\(minutes)m" : "\(minutes)m \(remainder)s"
        }
        if seconds < 86_400 {
            let hours = seconds / 3_600
            let minutes = (seconds % 3_600) / 60
            return minutes == 0 ? "\(hours)h" : "\(hours)h \(minutes)m"
        }
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        return hours == 0 ? "\(days)d" : "\(days)d \(hours)h"
    }

    private static func formatGrouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    private static func displayLeaf(_ item: TimelineItem) -> DisplayTimelineItem {
        switch item.kind {
        case .assistant: return .assistant(item)
        case .status: return .status(item)
        default: return .user(item)
        }
    }

    private static func isTraceItem(_ item: TimelineItem, absorbedAssistants: Set<String>) -> Bool {
        if item.kind == .thinking || item.kind == .contextInjection || item.kind == .tool || item.kind == .notice || item.kind == .compaction { return true }
        return item.kind == .assistant && absorbedAssistants.contains(item.id)
    }

    private static func intermediateAssistantIds(_ items: [TimelineItem]) -> Set<String> {
        var ids = Set<String>()
        var pending: [String] = []
        for item in items {
            if item.kind == .user {
                pending = []
                continue
            }
            if item.kind == .assistant {
                pending.append(item.id)
                continue
            }
            if item.kind == .tool {
                for id in pending { ids.insert(id) }
                pending = []
            }
        }
        return ids
    }

    private static func changedPath(_ item: TimelineItem) -> String? {
        guard item.kind == .tool, let tool = item.tool, tool.name == "edit" || tool.name == "write" else { return nil }
        return tool.args?.string("path")
    }

    private static func messageText(_ message: PiMessage) -> String {
        contentText(message.content)
    }

    private static func contentText(_ content: MessageContent?) -> String {
        content?.text ?? ""
    }

    private static func messageImages(_ message: PiMessage) -> [TimelineImage] {
        (message.content?.blocks ?? []).compactMap { block in
            guard block.type == "image", let data = block.data, let mime = block.mimeType else { return nil }
            return TimelineImage(data: data, mimeType: mime)
        }
    }

    private static func readCompaction(_ message: PiMessage) -> (text: String, tokensBefore: Double?)? {
        guard message.role == "compaction" || message.role == "compactionSummary" else { return nil }
        let summary = message.summary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let text = summary.isEmpty ? messageText(message) : summary
        if text.isEmpty && message.tokensBefore == nil { return nil }
        return (text, message.tokensBefore)
    }

    private static func settleAbandonedTools(_ items: [TimelineItem]) -> [TimelineItem] {
        var lastUser = -1
        for (index, item) in items.enumerated() where item.kind == .user { lastUser = index }
        if lastUser <= 0 { return items }
        return items.enumerated().map { index, item in
            guard index < lastUser, item.kind == .tool, var tool = item.tool, tool.status != "complete" else { return item }
            var next = item
            tool.status = "complete"
            next.tool = tool
            return next
        }
    }

    private static func interleaveTraceNotices(_ items: [TimelineItem], _ notices: [Notice]) -> [TimelineItem] {
        var byTurn: [Int: [Notice]] = [:]
        for notice in notices {
            guard let turn = notice.transcriptTurn else { continue }
            byTurn[turn, default: []].append(notice)
        }
        for key in byTurn.keys {
            byTurn[key]?.sort { left, right in
                let lp = left.transcriptPosition ?? 0
                let rp = right.transcriptPosition ?? 0
                if lp != rp { return lp < rp }
                if left.createdAt != right.createdAt { return left.createdAt < right.createdAt }
                return left.id < right.id
            }
        }

        var merged: [TimelineItem] = []
        var turn = -1
        var position = 0
        var pending: [Notice] = []
        func appendThrough(_ limit: Double) {
            while let notice = pending.first, Double(notice.transcriptPosition ?? 0) <= limit {
                pending.removeFirst()
                let revert = merged.last?.revertEntryId
                merged.append(TimelineItem(id: "notice-\(notice.id)", kind: .notice, timestamp: notice.createdAt, revertEntryId: revert, notice: notice))
            }
        }
        func appendRemaining() { appendThrough(.infinity) }

        for item in items {
            if item.kind == .user {
                appendRemaining()
                turn += 1
                position = 0
                pending = byTurn[turn] ?? []
                merged.append(item)
                appendThrough(0)
                continue
            }
            if item.kind == .thinking || item.kind == .contextInjection || item.kind == .tool || item.kind == .compaction {
                merged.append(item)
                position += 1
                appendThrough(Double(position))
                continue
            }
            appendRemaining()
            merged.append(item)
        }
        appendRemaining()
        return merged
    }

    static func reuseRows(_ previous: [TranscriptProjectionRow], next: [TranscriptProjectionRow]) -> [TranscriptProjectionRow] {
        guard !previous.isEmpty else { return next }
        let map = Dictionary(previous.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return next.map { row in
            if let old = map[row.id], old == row { return old }
            return row
        }
    }

    private static func mergedTool(_ base: ToolRun, _ live: ToolRun) -> ToolRun {
        var next = base
        next.name = live.name
        if live.args != nil { next.args = live.args }
        if live.argsText != nil { next.argsText = live.argsText }
        if live.output != nil { next.output = live.output }
        if live.details != nil { next.details = live.details }
        next.status = live.status
        next.isError = live.isError
        return next
    }
}

extension JSONValue {
    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    func string(_ key: String) -> String? {
        objectValue?[key]?.stringValue
    }
}
