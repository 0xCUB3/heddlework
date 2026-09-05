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
