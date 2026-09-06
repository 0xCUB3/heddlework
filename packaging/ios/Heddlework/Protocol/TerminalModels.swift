import Foundation

struct RemoteTerminalSession: Decodable, Equatable, Identifiable {
    var id: String
    var name: String?
    var title: String?
    var cwd: String?
    var cols: Int?
    var rows: Int?
    var status: String?
    var exitCode: Int?
}

struct RemoteTerminalSnapshot: Decodable, Equatable {
    var sessions: [RemoteTerminalSession]?
    var activeId: String?
}

struct RemoteTerminalFrame: Decodable, Equatable {
    var id: String
    var cols: Int?
    var rows: Int?
    var cursorX: Int?
    var cursorY: Int?
    var cursorVisible: Bool?
    var title: String?
    var lines: [String]?
}

extension CommandFactory {
    static func openTerminal(cols: Int, rows: Int) -> [String: JSONValue] {
        var command = simple("openTerminal")
        command["cols"] = .number(Double(cols))
        command["rows"] = .number(Double(rows))
        return command
    }

    static func writeTerminal(id: String, data: String) -> [String: JSONValue] {
        var command = simple("writeTerminal")
        command["id"] = .string(id)
        command["data"] = .string(data)
        return command
    }

    static func resizeTerminal(id: String, cols: Int, rows: Int) -> [String: JSONValue] {
        var command = simple("resizeTerminal")
        command["id"] = .string(id)
        command["cols"] = .number(Double(cols))
        command["rows"] = .number(Double(rows))
        return command
    }

    static func closeTerminal(id: String) -> [String: JSONValue] {
        withString("closeTerminal", key: "id", value: id)
    }
}
