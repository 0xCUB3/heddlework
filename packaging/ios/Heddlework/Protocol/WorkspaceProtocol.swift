import Foundation

struct ClientEnvelope: Encodable {
    let kind: String
    let protocolVersion: Int?
    let id: Int?
    let command: [String: JSONValue]?

    enum CodingKeys: String, CodingKey {
        case kind
        case protocolVersion = "protocol"
        case id
        case command
    }

    static func hello() -> ClientEnvelope {
        ClientEnvelope(kind: "hello", protocolVersion: 1, id: nil, command: nil)
    }

    static func command(id: Int, command: [String: JSONValue]) -> ClientEnvelope {
        ClientEnvelope(kind: "command", protocolVersion: nil, id: id, command: command)
    }
}

struct ServerEnvelope: Decodable {
    let kind: String
    let protocolVersion: Int?
    let workspacePath: String?
    let snapshot: [String: JSONValue]?
    let flows: FlowRuntimeSnapshot?
    let hostUrls: [String]?
    let browserIntegrations: BrowserIntegrationSnapshot?
    let sleepPrevention: SleepPreventionSnapshot?
    let terminal: RemoteTerminalSnapshot?
    let terminalFrame: RemoteTerminalFrame?
    let patch: SnapshotPatch?
    let id: Int?
    let ok: Bool?
    let error: String?
    let message: String?
    let event: AttentionEvent?

    enum CodingKeys: String, CodingKey {
        case kind
        case protocolVersion = "protocol"
        case workspacePath
        case snapshot
        case flows
        case hostUrls
        case browserIntegrations
        case sleepPrevention
        case terminal
        case terminalFrame
        case patch
        case id
        case ok
        case error
        case message
        case event
    }
}

struct AttentionEvent: Decodable, Sendable {
    var eventId: String
    var noticeId: Double
    var title: String
    var body: String
    var sessionPath: String?
}

struct SnapshotPatch: Decodable, Equatable {
    let version: Int
    let changed: [String: JSONValue]
    let removed: [String]?
}

enum CommandFactory {
    static func simple(_ type: String) -> [String: JSONValue] { ["type": .string(type)] }

    static func submit(text: String, queue: Bool = false) -> [String: JSONValue] {
        var command = simple("submit")
        command["text"] = .string(text)
        if queue { command["queue"] = .bool(true) }
        return command
    }

    static func queueInput(text: String, lane: String? = nil, paused: Bool? = nil) -> [String: JSONValue] {
        var command = simple("queueInput")
        command["text"] = .string(text)
        if let lane { command["lane"] = .string(lane) }
        if let paused { command["paused"] = .bool(paused) }
        return command
    }

    static func withString(_ type: String, key: String, value: String) -> [String: JSONValue] {
        var command = simple(type)
        command[key] = .string(value)
        return command
    }

    static func updateQueuedInput(id: String, text: String) -> [String: JSONValue] {
        var command = simple("updateQueuedInput")
        command["id"] = .string(id)
        command["text"] = .string(text)
        return command
    }

    static func moveQueuedInput(id: String, targetIndex: Int) -> [String: JSONValue] {
        var command = simple("moveQueuedInput")
        command["id"] = .string(id)
        command["targetIndex"] = .number(Double(targetIndex))
        return command
    }

    static func moveQueuedInputToLane(id: String, lane: String) -> [String: JSONValue] {
        var command = simple("moveQueuedInputToLane")
        command["id"] = .string(id)
        command["lane"] = .string(lane)
        return command
    }

    static func snoozeThread(path: String, snoozedUntil: Double) -> [String: JSONValue] {
        var command = simple("snoozeThread")
        command["path"] = .string(path)
        command["snoozedUntil"] = .number(snoozedUntil)
        return command
    }

    static func setModel(provider: String, id: String) -> [String: JSONValue] {
        var command = simple("setModel")
        command["provider"] = .string(provider)
        command["id"] = .string(id)
        return command
    }

    static func setSleepPreventionPolicy(when: String, keepDisplayAwake: Bool) -> [String: JSONValue] {
        var command = simple("setSleepPreventionPolicy")
        command["when"] = .string(when)
        command["keepDisplayAwake"] = .bool(keepDisplayAwake)
        return command
    }

    static func reportPresence(clientId: String, surface: String, visibility: String, sessionPath: String?) -> [String: JSONValue] {
        var command = simple("reportPresence")
        command["clientId"] = .string(clientId)
        command["surface"] = .string(surface)
        command["visibility"] = .string(visibility)
        if let sessionPath { command["sessionPath"] = .string(sessionPath) }
        return command
    }

    static func activateNotice(id: Int) -> [String: JSONValue] {
        var command = simple("activateNotice")
        command["id"] = .number(Double(id))
        return command
    }

    static func dismissNotice(id: Int) -> [String: JSONValue] {
        var command = simple("dismissNotice")
        command["id"] = .number(Double(id))
        return command
    }

    static func respondToDialog(value: String? = nil, confirmed: Bool? = nil, cancelled: Bool? = nil) -> [String: JSONValue] {
        var command = simple("respondToDialog")
        if let value { command["value"] = .string(value) }
        if let confirmed { command["confirmed"] = .bool(confirmed) }
        if let cancelled { command["cancelled"] = .bool(cancelled) }
        return command
    }
}
