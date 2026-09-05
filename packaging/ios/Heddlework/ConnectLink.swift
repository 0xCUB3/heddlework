import Foundation

// A host connect link as printed by `bun run host`: http://host:port/?token=…
// Also accepts the deep link form heddlework://connect?url=<percent-encoded connect link>.
struct ConnectLink: Equatable {
    static let deepLinkScheme = "heddlework"

    let hostURL: URL
    let token: String

    init?(url: URL) {
        guard let parsed = Self.parse(url) else { return nil }
        hostURL = parsed.hostURL
        token = parsed.token
    }

    private static func parse(_ url: URL) -> (hostURL: URL, token: String)? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false), let scheme = components.scheme?.lowercased() else { return nil }
        if scheme == deepLinkScheme {
            guard let wrapped = components.queryItems?.first(where: { $0.name == "url" })?.value,
                  let inner = URL(string: wrapped), inner.scheme?.lowercased() != deepLinkScheme else { return nil }
            return parse(inner)
        }
        guard let host = components.host, !host.isEmpty else { return nil }
        let httpScheme: String
        switch scheme {
        case "http", "ws": httpScheme = "http"
        case "https", "wss": httpScheme = "https"
        default: return nil
        }
        guard let token = components.queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty else { return nil }
        var hostComponents = URLComponents()
        hostComponents.scheme = httpScheme
        hostComponents.host = host
        hostComponents.port = components.port
        var path = components.path
        if path.hasSuffix("/ws") { path = String(path.dropLast(3)) }
        if path.hasSuffix("/") { path = String(path.dropLast()) }
        hostComponents.path = path
        guard let hostURL = hostComponents.url else { return nil }
        return (hostURL, token)
    }

    var webSocketURL: URL? {
        workspaceSocketURL(hostURL: hostURL.absoluteString, token: token)
    }
}
