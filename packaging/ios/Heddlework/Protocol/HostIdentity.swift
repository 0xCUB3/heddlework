import Foundation

enum HostMachineKind: String, Codable, Equatable, Hashable, Sendable {
    case laptop
    case desktop
    case macMini = "mac-mini"
    case macStudio = "mac-studio"
    case linux
    case server
    case cloud

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = HostMachineKind(rawValue: raw) ?? .server
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var systemImage: String {
        switch self {
        case .laptop: return "laptopcomputer"
        case .desktop: return "desktopcomputer"
        case .macMini: return "macmini"
        case .macStudio: return "macstudio"
        case .linux: return "pc"
        case .server: return "server.rack"
        case .cloud: return "cloud"
        }
    }

    var label: String {
        switch self {
        case .laptop: return "Laptop"
        case .desktop: return "Desktop"
        case .macMini: return "Mac mini"
        case .macStudio: return "Mac Studio"
        case .linux: return "Linux"
        case .server: return "Server"
        case .cloud: return "Cloud"
        }
    }
}

struct HostIdentity: Decodable, Equatable, Hashable, Sendable {
    var id: String
    var name: String
    var os: String
    var arch: String
    var machine: HostMachineKind
    var version: String
    var protocolVersion: Int

    enum CodingKeys: String, CodingKey {
        case id, name, os, arch, machine, version
        case protocolVersion = "protocol"
    }
}

func shortHostName(_ name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "Unnamed host" }
    if trimmed.contains(" ") { return trimmed }
    let suffixes = [".local", ".lan", ".home", ".internal", ".localdomain"]
    let lower = trimmed.lowercased()
    for suffix in suffixes where lower.hasSuffix(suffix) {
        return String(trimmed.dropLast(suffix.count))
    }
    return trimmed
}
