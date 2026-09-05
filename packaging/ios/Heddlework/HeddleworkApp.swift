import SwiftUI

@main
struct HeddleworkApp: App {
    @StateObject private var connection = ConnectionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(connection)
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
            WorkspaceView(link: link, onDisconnect: connection.disconnect)
                .background(AppColors.window.ignoresSafeArea())
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
        let env = ProcessInfo.processInfo.environment
        if env["HEEDLEWORK_RESET_CONNECTION"] == "1" {
            defaults.removeObject(forKey: key)
        }
        if let raw = env["HEEDLEWORK_CONNECT_URL"], let url = URL(string: raw), let parsed = ConnectLink(url: url) {
            link = parsed
            return
        }
        if env["HEEDLEWORK_RESET_CONNECTION"] == "1" {
            link = nil
            return
        }
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
