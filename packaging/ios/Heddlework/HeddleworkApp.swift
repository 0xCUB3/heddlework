import SwiftUI

@main
struct HeddleworkApp: App {
    @StateObject private var connection = ConnectionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(connection)
                .preferredColorScheme(.dark)
                .onOpenURL { url in
                    if let link = ConnectLink(url: url) { connection.connect(link) }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var connection: ConnectionStore

    var body: some View {
        if let link = connection.link {
            WorkspaceWebView(link: link, onDisconnect: connection.disconnect)
                .ignoresSafeArea(edges: .bottom)
                .background(Color(red: 0.04, green: 0.04, blue: 0.04).ignoresSafeArea())
        } else {
            ConnectView()
        }
    }
}

// Persists the last host connect link so the shell reopens straight into the workspace.
@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var link: ConnectLink?

    private let defaults = UserDefaults.standard
    private let key = "heddlework.connectLink"

    init() {
        if let raw = defaults.string(forKey: key), let url = URL(string: raw) {
            link = ConnectLink(url: url)
        }
    }

    func connect(_ link: ConnectLink) {
        defaults.set(link.hostURL.absoluteString + "?token=" + link.token, forKey: key)
        self.link = link
    }

    func disconnect() {
        defaults.removeObject(forKey: key)
        link = nil
    }
}
