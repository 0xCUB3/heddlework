import SwiftUI

@main
struct HeddleworkApp: App {
    @StateObject private var store = SavedHostsStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .onOpenURL { url in
                    if let link = ConnectLink(url: url) { store.connect(link) }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: SavedHostsStore

    var body: some View {
        if let host = store.activeHost {
            WorkspaceView(link: host.connectLink, onDisconnect: store.disconnect)
                .id(host.id)
                .background(AppColors.window.ignoresSafeArea())
        } else {
            ConnectView()
        }
    }
}
