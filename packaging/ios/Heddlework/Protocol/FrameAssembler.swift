import Foundation

let workspaceWebSocketMaximumMessageSize = 16 * 1024 * 1024
let workspaceMaxAssembledBytes = 32 * 1024 * 1024
let workspacePatchPublishNanoseconds: UInt64 = 16_000_000

struct WireFrame: Decodable, Equatable {
    let kind: String
    let id: String
    let index: Int
    let count: Int
    let data: String
}

enum FrameAssemblerError: LocalizedError {
    case interrupted
    case invalidIndex(Int, Int)
    case countChanged
    case duplicate(Int)
    case tooLarge(Int)

    var errorDescription: String? {
        switch self {
        case .interrupted: return "Workspace stream was interrupted by a non-frame message"
        case .invalidIndex(let index, let count): return "Invalid workspace frame \(index)/\(count)"
        case .countChanged: return "Workspace frame count changed mid-stream"
        case .duplicate(let index): return "Duplicate workspace frame \(index)"
        case .tooLarge(let bytes): return "Workspace snapshot is too large to open (\(bytes) bytes)"
        }
    }
}

struct FrameAssembler {
    private struct Pending {
        var count: Int
        var parts: [String?]
        var received: Int
        var bytes: Int
    }

    private var pending: [String: Pending] = [:]

    mutating func reset() { pending.removeAll() }

    mutating func push(_ data: Data, maxAssembledBytes: Int = workspaceMaxAssembledBytes) throws -> Data? {
        guard let frame = try? JSONDecoder().decode(WireFrame.self, from: data), frame.kind == "frame" else {
            if !pending.isEmpty { throw FrameAssemblerError.interrupted }
            return data
        }
        if frame.count < 1 || frame.index < 0 || frame.index >= frame.count {
            throw FrameAssemblerError.invalidIndex(frame.index, frame.count)
        }
        var entry = pending[frame.id] ?? Pending(count: frame.count, parts: Array(repeating: nil, count: frame.count), received: 0, bytes: 0)
        if entry.count != frame.count { throw FrameAssemblerError.countChanged }
        if entry.parts[frame.index] != nil { throw FrameAssemblerError.duplicate(frame.index) }
        let added = frame.data.utf8.count
        if entry.bytes + added > maxAssembledBytes { throw FrameAssemblerError.tooLarge(entry.bytes + added) }
        entry.parts[frame.index] = frame.data
        entry.received += 1
        entry.bytes += added
        if entry.received < entry.count {
            pending[frame.id] = entry
            return nil
        }
        pending.removeValue(forKey: frame.id)
        return Data(entry.parts.compactMap { $0 }.joined().utf8)
    }
}

func websocketMessageData(_ message: URLSessionWebSocketTask.Message) -> Data {
    switch message {
    case .data(let received): return received
    case .string(let string): return Data(string.utf8)
    @unknown default: return Data()
    }
}
