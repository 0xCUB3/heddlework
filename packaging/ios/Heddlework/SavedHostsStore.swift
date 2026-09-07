import Foundation

struct SavedHost: Codable, Identifiable, Equatable, Hashable {
    var id: String
    var name: String
    var url: URL
    var token: String
    var hostUrls: [String]
    var machine: HostMachineKind
    var os: String
    var lastSeenAt: Date
    var customName: Bool

    var connectLink: ConnectLink {
        ConnectLink(hostURL: url, token: token)
    }
}

private let savedHostsLimit = 24
private let savedHostsKey = "heddlework.savedHosts"
private let activeHostKey = "heddlework.activeHostId"
private let legacyConnectLinkKey = "heddlework.connectLink"

// Stable id for hosts that never sent an identity: a short FNV-1a of the URL, matching the TypeScript client.
func savedHostIdForUrl(_ url: String) -> String {
    var hash: UInt32 = 0x811c9dc5
    for scalar in url.unicodeScalars {
        hash ^= UInt32(scalar.value)
        hash = hash &* 0x01000193
    }
    return String(format: "url-%08x", hash)
}

@MainActor
final class SavedHostsStore: ObservableObject {
    @Published private(set) var hosts: [SavedHost] = []
    @Published private(set) var activeHostId: String?

    var activeHost: SavedHost? {
        guard let activeHostId else { return nil }
        return hosts.first { $0.id == activeHostId }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.defaults = defaults
        if environment["HEEDLEWORK_RESET_CONNECTION"] == "1" {
            defaults.removeObject(forKey: savedHostsKey)
            defaults.removeObject(forKey: activeHostKey)
            defaults.removeObject(forKey: legacyConnectLinkKey)
        }
        hosts = Self.loadHosts(from: defaults)
        migrateLegacyLink()
        if let raw = environment["HEEDLEWORK_CONNECT_URL"], let url = URL(string: raw), let parsed = ConnectLink(url: url) {
            connect(parsed)
            return
        }
        if environment["HEEDLEWORK_RESET_CONNECTION"] == "1" {
            activeHostId = nil
            persist()
            return
        }
        activeHostId = defaults.string(forKey: activeHostKey)
        if activeHostId != nil && activeHost == nil {
            activeHostId = hosts.first?.id
        }
    }

    func connect(_ link: ConnectLink) {
        let url = link.hostURL
        let normalized = normalizedURLString(url)
        let urlId = savedHostIdForUrl(normalized)
        if let index = hosts.firstIndex(where: { normalizedURLString($0.url) == normalized || $0.id == urlId }) {
            hosts[index].token = link.token
            hosts[index].url = url
            hosts[index].lastSeenAt = Date()
            if !hosts[index].hostUrls.contains(normalized) {
                hosts[index].hostUrls.insert(normalized, at: 0)
            }
            activeHostId = hosts[index].id
        } else {
            let host = SavedHost(
                id: urlId,
                name: url.host ?? normalized,
                url: url,
                token: link.token,
                hostUrls: [normalized],
                machine: .server,
                os: "unknown",
                lastSeenAt: Date(),
                customName: false
            )
            hosts.insert(host, at: 0)
            activeHostId = host.id
        }
        sortAndTrim()
        persist()
    }

    func select(id: String) {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        hosts[index].lastSeenAt = Date()
        activeHostId = id
        sortAndTrim()
        persist()
    }

    func remember(identity: HostIdentity, url: URL, token: String, hostUrls: [String]) {
        let id = identity.id
        let normalized = normalizedURLString(url)
        let urlId = savedHostIdForUrl(normalized)
        let existing = hosts.first(where: { $0.id == id })
            ?? hosts.first(where: { normalizedURLString($0.url) == normalized })
            ?? hosts.first(where: { $0.id == urlId })
        let custom = existing?.customName == true
        let trimmedName = identity.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let name: String
        if custom, let existing {
            name = existing.name
        } else if !trimmedName.isEmpty {
            name = trimmedName
        } else {
            name = existing?.name ?? url.host ?? normalized
        }
        var mergedUrls: [String] = []
        var seen = Set<String>()
        for item in [normalized] + hostUrls.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "/")) } + (existing?.hostUrls ?? []) {
            if seen.insert(item).inserted { mergedUrls.append(item) }
        }
        let next = SavedHost(
            id: id,
            name: name,
            url: url,
            token: token,
            hostUrls: mergedUrls,
            machine: identity.machine,
            os: identity.os,
            lastSeenAt: Date(),
            customName: custom
        )
        let removed = Set([id, existing?.id, urlId].compactMap { $0 })
        hosts = [next] + hosts.filter { !removed.contains($0.id) }
        if activeHostId == nil || removed.contains(activeHostId ?? "") || existing.map({ normalizedURLString($0.url) == normalized }) == true {
            activeHostId = id
        }
        sortAndTrim()
        persist()
    }

    func rename(id: String, name: String) {
        let trimmed = name.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        hosts[index].name = String(trimmed.prefix(60))
        hosts[index].customName = true
        persist()
    }

    func forget(id: String) {
        guard hosts.contains(where: { $0.id == id }) else { return }
        hosts.removeAll { $0.id == id }
        if activeHostId == id { activeHostId = nil }
        persist()
    }

    func disconnect() {
        activeHostId = nil
        persist()
    }

    private func migrateLegacyLink() {
        guard let raw = defaults.string(forKey: legacyConnectLinkKey) else { return }
        defaults.removeObject(forKey: legacyConnectLinkKey)
        guard let url = URL(string: raw), let link = ConnectLink(url: url) else { return }
        let normalized = normalizedURLString(link.hostURL)
        if let existing = hosts.first(where: { normalizedURLString($0.url) == normalized }) {
            if activeHostId == nil { activeHostId = existing.id }
            persist()
            return
        }
        let host = SavedHost(
            id: savedHostIdForUrl(normalized),
            name: link.hostURL.host ?? normalized,
            url: link.hostURL,
            token: link.token,
            hostUrls: [normalized],
            machine: .server,
            os: "unknown",
            lastSeenAt: Date(),
            customName: false
        )
        hosts.insert(host, at: 0)
        if activeHostId == nil { activeHostId = host.id }
        persist()
    }

    private func sortAndTrim() {
        hosts.sort { $0.lastSeenAt > $1.lastSeenAt }
        if hosts.count > savedHostsLimit { hosts = Array(hosts.prefix(savedHostsLimit)) }
    }

    private func persist() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        if let data = try? encoder.encode(hosts) {
            defaults.set(data, forKey: savedHostsKey)
        }
        if let activeHostId {
            defaults.set(activeHostId, forKey: activeHostKey)
        } else {
            defaults.removeObject(forKey: activeHostKey)
        }
    }

    private static func loadHosts(from defaults: UserDefaults) -> [SavedHost] {
        guard let data = defaults.data(forKey: savedHostsKey) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        guard var loaded = try? decoder.decode([SavedHost].self, from: data) else { return [] }
        loaded.sort { $0.lastSeenAt > $1.lastSeenAt }
        return Array(loaded.prefix(savedHostsLimit))
    }
}

func normalizedURLString(_ url: URL) -> String {
    url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
}
