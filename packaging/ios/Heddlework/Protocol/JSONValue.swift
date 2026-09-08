import Foundation

enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var any: Any {
        switch self {
        case .string(let value): return value
        case .number(let value): return value
        case .bool(let value): return value
        case .object(let value): return value.mapValues { $0.any }
        case .array(let value): return value.map { $0.any }
        case .null: return NSNull()
        }
    }

    static func from(any: Any) -> JSONValue {
        switch any {
        case is NSNull: return .null
        case let value as String: return .string(value)
        case let value as Bool: return .bool(value)
        case let value as Int: return .number(Double(value))
        case let value as Double: return .number(value)
        case let value as [String: Any]:
            return .object(value.mapValues { JSONValue.from(any: $0) })
        case let value as [Any]:
            return .array(value.map { JSONValue.from(any: $0) })
        default:
            return .string(String(describing: any))
        }
    }
}

func mergeSnapshotJSON(_ base: [String: JSONValue], patch: [String: JSONValue], removing removed: [String] = []) -> [String: JSONValue] {
    var next = base
    for (key, value) in patch {
        if case .null = value {
            next.removeValue(forKey: key)
        } else {
            next[key] = value
        }
    }
    for key in removed { next.removeValue(forKey: key) }
    return next
}

func decodeSnapshot<T: Decodable>(_ type: T.Type, from object: [String: JSONValue]) -> T? {
    guard JSONSerialization.isValidJSONObject(object.mapValues { $0.any }) else { return nil }
    guard let data = try? JSONSerialization.data(withJSONObject: object.mapValues { $0.any }) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
}

func decodeJSONValue<T: Decodable>(_ type: T.Type, from value: JSONValue) -> T? {
    if T.self == String.self, case .string(let string) = value { return string as? T }
    if T.self == Bool.self, case .bool(let flag) = value { return flag as? T }
    if T.self == Double.self, case .number(let number) = value { return number as? T }
    if T.self == Int.self, case .number(let number) = value { return Int(number) as? T }
    switch value {
    case .null:
        return nil
    case .string, .number, .bool:
        guard let data = try? JSONSerialization.data(withJSONObject: [value.any]) else { return nil }
        return (try? JSONDecoder().decode([T].self, from: data))?.first
    default:
        let any = value.any
        guard JSONSerialization.isValidJSONObject(any) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: any) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

func applySnapshotPatch(_ current: WorkbenchSnapshot, patch: SnapshotPatch) -> WorkbenchSnapshot {
    var next = current
    for key in patch.removed ?? [] {
        clearSnapshotKey(&next, key)
    }
    for (key, value) in patch.changed {
        applySnapshotChangedKey(&next, key: key, value: value)
    }
    if let prepend = patch.messagesPrepend, !prepend.isEmpty {
        let decoded = prepend.compactMap { decodeJSONValue(PiMessage.self, from: $0) }
        next.messages = decoded + (next.messages ?? [])
    }
    if let ops = patch.liveOps, !ops.isEmpty {
        let resyncAssistant = patch.changed["liveAssistant"] != nil
            || (patch.removed ?? []).contains("liveAssistant")
        let resyncTools = patch.changed["liveTools"] != nil
            || (patch.removed ?? []).contains("liveTools")
        let kept = ops.filter { op in
            if op.target == "assistant" { return !resyncAssistant }
            if op.target == "tool" || op.target == "tools" { return !resyncTools }
            return true
        }
        if !kept.isEmpty {
            next = applyLiveOps(next, kept)
        }
    }
    return next
}

func applyLiveOps(_ snapshot: WorkbenchSnapshot, _ ops: [LiveContentOp]) -> WorkbenchSnapshot {
    var next = snapshot
    for op in ops {
        next = applyLiveOp(next, op)
    }
    return next
}

private func applyLiveOp(_ snapshot: WorkbenchSnapshot, _ op: LiveContentOp) -> WorkbenchSnapshot {
    var next = snapshot
    if op.op == "append", op.target == "assistant", let id = op.id, let blockIndex = op.blockIndex, let text = op.text {
        guard var assistant = next.liveAssistant, assistant.id == id else { return next }
        assistant.blocks = assistant.blocks.map { block in
            guard block.index == blockIndex else { return block }
            var updated = block
            updated.text += text
            return updated
        }
        next.liveAssistant = assistant
        return next
    }
    if op.op == "trim", op.target == "assistant", let id = op.id, let blockIndex = op.blockIndex, let bytes = op.bytes, bytes > 0 {
        guard var assistant = next.liveAssistant, assistant.id == id else { return next }
        assistant.blocks = assistant.blocks.map { block in
            guard block.index == blockIndex else { return block }
            var updated = block
            updated.text = dropUTF8Prefix(block.text, bytes: bytes)
            updated.textOffset = (block.textOffset ?? 0) + bytes
            return updated
        }
        next.liveAssistant = assistant
        return next
    }
    if op.op == "append", op.target == "tool", let id = op.id, let text = op.text {
        next.liveTools = (next.liveTools ?? []).map { tool in
            guard tool.id == id else { return tool }
            var updated = tool
            updated.output = (updated.output ?? "") + text
            return updated
        }
        return next
    }
    if op.op == "trim", op.target == "tool", let id = op.id, let bytes = op.bytes, bytes > 0 {
        next.liveTools = (next.liveTools ?? []).map { tool in
            guard tool.id == id else { return tool }
            var updated = tool
            updated.output = dropUTF8Prefix(updated.output ?? "", bytes: bytes)
            updated.outputOffset = (tool.outputOffset ?? 0) + bytes
            return updated
        }
        return next
    }
    if op.op == "replace", op.target == "assistant", let assistant = op.assistant {
        next.liveAssistant = assistant
        return next
    }
    if op.op == "replace", op.target == "tool", let tool = op.tool {
        var tools = next.liveTools ?? []
        if let index = tools.firstIndex(where: { $0.id == tool.id }) {
            tools[index] = tool
        } else {
            tools.append(tool)
        }
        next.liveTools = tools
        return next
    }
    if op.op == "replace", op.target == "tools" {
        next.liveTools = op.tools
        return next
    }
    return next
}

private func dropUTF8Prefix(_ text: String, bytes: Int) -> String {
    guard bytes > 0 else { return text }
    var encoded = Array(text.utf8)
    if bytes >= encoded.count { return "" }
    var start = bytes
    while start < encoded.count && (encoded[start] & 0xc0) == 0x80 { start += 1 }
    encoded.removeFirst(start)
    return String(bytes: encoded, encoding: .utf8) ?? ""
}

private func clearSnapshotKey(_ snapshot: inout WorkbenchSnapshot, _ key: String) {
    switch key {
    case "dialog": snapshot.dialog = nil
    case "liveAssistant": snapshot.liveAssistant = nil
    case "liveTools": snapshot.liveTools = nil
    case "messages": snapshot.messages = nil
    case "stats": snapshot.stats = nil
    case "uiRequest": snapshot.uiRequest = nil
    case "questionnaireSubmitting": snapshot.questionnaireSubmitting = nil
    case "questionnaireCollapsed": snapshot.questionnaireCollapsed = nil
    case "connectionMessage": snapshot.connectionMessage = nil
    case "activity": snapshot.activity = nil
    case "notices": snapshot.notices = nil
    case "forkMessages": snapshot.forkMessages = nil
    case "threadTitles": snapshot.threadTitles = nil
    case "workspaceDiff": snapshot.workspaceDiff = nil
    case "editorImages": snapshot.editorImages = nil
    case "receipts": snapshot.receipts = nil
    case "windowTitle": snapshot.windowTitle = nil
    case "statusItems": snapshot.statusItems = nil
    case "widgets": snapshot.widgets = nil
    case "dialogQueue": snapshot.dialogQueue = nil
    default: break
    }
}

private func assignIfDecoded<T: Decodable>(_ target: inout T?, from value: JSONValue) {
    if case .null = value { return }
    if let decoded = decodeJSONValue(T.self, from: value) { target = decoded }
}

private func applySnapshotChangedKey(_ snapshot: inout WorkbenchSnapshot, key: String, value: JSONValue) {
    switch key {
    case "workspacePath": assignIfDecoded(&snapshot.workspacePath, from: value)
    case "connection": assignIfDecoded(&snapshot.connection, from: value)
    case "connectionMessage": assignIfDecoded(&snapshot.connectionMessage, from: value)
    case "session": assignIfDecoded(&snapshot.session, from: value)
    case "models": assignIfDecoded(&snapshot.models, from: value)
    case "thinkingLevels": assignIfDecoded(&snapshot.thinkingLevels, from: value)
    case "messages": assignIfDecoded(&snapshot.messages, from: value)
    case "messagesHasOlder": assignIfDecoded(&snapshot.messagesHasOlder, from: value)
    case "messagesLoadingEarlier": assignIfDecoded(&snapshot.messagesLoadingEarlier, from: value)
    case "forkMessages": assignIfDecoded(&snapshot.forkMessages, from: value)
    case "sessions": assignIfDecoded(&snapshot.sessions, from: value)
    case "sessionsLoading": assignIfDecoded(&snapshot.sessionsLoading, from: value)
    case "sessionsHasMore": assignIfDecoded(&snapshot.sessionsHasMore, from: value)
    case "liveAssistant": assignIfDecoded(&snapshot.liveAssistant, from: value)
    case "liveTools": assignIfDecoded(&snapshot.liveTools, from: value)
    case "activity": assignIfDecoded(&snapshot.activity, from: value)
    case "queue": assignIfDecoded(&snapshot.queue, from: value)
    case "stats": assignIfDecoded(&snapshot.stats, from: value)
    case "notices": assignIfDecoded(&snapshot.notices, from: value)
    case "threadLifecycle": assignIfDecoded(&snapshot.threadLifecycle, from: value)
    case "threadTitles": assignIfDecoded(&snapshot.threadTitles, from: value)
    case "workspaceDiff": assignIfDecoded(&snapshot.workspaceDiff, from: value)
    case "statusItems": assignIfDecoded(&snapshot.statusItems, from: value)
    case "widgets": assignIfDecoded(&snapshot.widgets, from: value)
    case "dialog": assignIfDecoded(&snapshot.dialog, from: value)
    case "dialogQueue": assignIfDecoded(&snapshot.dialogQueue, from: value)
    case "commands": assignIfDecoded(&snapshot.commands, from: value)
    case "uiRequest": assignIfDecoded(&snapshot.uiRequest, from: value)
    case "questionnaireSubmitting": assignIfDecoded(&snapshot.questionnaireSubmitting, from: value)
    case "questionnaireCollapsed": assignIfDecoded(&snapshot.questionnaireCollapsed, from: value)
    case "editorText": assignIfDecoded(&snapshot.editorText, from: value)
    case "editorImages": assignIfDecoded(&snapshot.editorImages, from: value)
    case "receipts": assignIfDecoded(&snapshot.receipts, from: value)
    case "windowTitle": assignIfDecoded(&snapshot.windowTitle, from: value)
    default: break
    }
}
