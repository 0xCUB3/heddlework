import Foundation

struct SessionChrome: Codable, Equatable {
    var draft: String = ""
    var followTail: Bool = true
    var expandedTraceIds: [String] = []
    var lastReadMessageId: String?
}

@MainActor
final class WorkspaceSessionMemory {
    static let shared = WorkspaceSessionMemory()

    private let defaults: UserDefaults
    private let storageKey = "heddlework.sessionChrome.v1"
    private var cache: [String: SessionChrome]
    private let limit = 80

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: storageKey),
           let decoded = try? JSONDecoder().decode([String: SessionChrome].self, from: data) {
            cache = decoded
        } else {
            cache = [:]
        }
    }

    func key(host: String, session: String) -> String {
        "\(host)|\(session)"
    }

    func chrome(host: String, session: String) -> SessionChrome {
        cache[key(host: host, session: session)] ?? SessionChrome()
    }

    func update(host: String, session: String, mutate: (inout SessionChrome) -> Void) {
        guard !host.isEmpty, !session.isEmpty else { return }
        let storage = key(host: host, session: session)
        var next = cache[storage] ?? SessionChrome()
        mutate(&next)
        cache[storage] = next
        persist()
    }

    func clearHost(_ host: String) {
        cache = cache.filter { !$0.key.hasPrefix(host + "|") }
        persist()
    }

    private func persist() {
        if cache.count > limit {
            let extras = cache.count - limit
            for key in cache.keys.prefix(extras) { cache.removeValue(forKey: key) }
        }
        if let data = try? JSONEncoder().encode(cache) {
            defaults.set(data, forKey: storageKey)
        }
    }
}
