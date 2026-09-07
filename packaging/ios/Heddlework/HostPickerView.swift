import SwiftUI

struct HostBadge: View {
    @ObservedObject var client: WorkspaceClient
    @EnvironmentObject private var store: SavedHostsStore
    var onTap: () -> Void

    private var machine: HostMachineKind {
        client.host?.machine ?? store.activeHost?.machine ?? .server
    }

    private var shortName: String {
        shortHostName(store.activeHost?.name ?? client.host?.name ?? "Host")
    }

    private var statusColor: Color {
        switch client.status {
        case .open: return AppColors.success
        case .connecting: return AppColors.warning
        case .closed: return AppColors.error
        }
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 6) {
                Image(systemName: machine.systemImage)
                    .font(.workbench(size: 13))
                Text(shortName)
                    .font(.workbench(size: 12, weight: .medium))
                    .lineLimit(1)
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
            }
            .foregroundStyle(AppColors.text)
        }
        .accessibilityIdentifier("host-badge")
        .accessibilityLabel("\(shortName), \(client.status.rawValue)")
    }
}

struct HostPickerView: View {
    @ObservedObject var client: WorkspaceClient
    let link: ConnectLink
    @EnvironmentObject private var store: SavedHostsStore
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false
    @State private var renameTarget: SavedHost?
    @State private var renameText = ""

    private var others: [SavedHost] {
        store.hosts.filter { $0.id != store.activeHostId }
    }

    var body: some View {
        NavigationStack {
            List {
                if let current = store.activeHost {
                    Section("This computer") {
                        currentCard(current)
                            .accessibilityIdentifier("host-picker-current")
                            .contextMenu { Button("Rename") { beginRename(current) } }
                    }
                }
                if !others.isEmpty {
                    Section("Saved computers") {
                        ForEach(others) { host in
                            Button {
                                store.select(id: host.id)
                                dismiss()
                            } label: {
                                savedRow(host)
                            }
                            .accessibilityIdentifier("host-picker-saved-\(host.id)")
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) { store.forget(id: host.id) } label: { Text("Delete") }
                            }
                            .contextMenu { Button("Rename") { beginRename(host) } }
                        }
                    }
                }
                Section {
                    Button { adding = true } label: {
                        Label("Add computer", systemImage: "plus")
                    }
                    .accessibilityIdentifier("host-picker-add")
                }
            }
            .navigationTitle("Computers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") {
                        if let current = store.activeHost { beginRename(current) }
                    }
                }
            }
            .navigationDestination(isPresented: $adding) {
                ConnectView(embedded: true, onConnected: { dismiss() })
            }
            .alert("Rename", isPresented: Binding(
                get: { renameTarget != nil },
                set: { if !$0 { renameTarget = nil } }
            )) {
                TextField("Name", text: $renameText)
                Button("Save") {
                    if let id = renameTarget?.id { store.rename(id: id, name: renameText) }
                    renameTarget = nil
                }
                Button("Cancel", role: .cancel) { renameTarget = nil }
            }
        }
        .accessibilityIdentifier("host-picker")
    }

    private func currentCard(_ host: SavedHost) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: (client.host?.machine ?? host.machine).systemImage)
                    .font(.workbench(size: 18))
                VStack(alignment: .leading, spacing: 2) {
                    Text(host.name)
                        .font(.workbench(size: 15, weight: .semibold))
                    Text((client.host?.machine ?? host.machine).label)
                        .font(.workbench(size: 12))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Circle()
                    .fill(statusColor)
                    .frame(width: 9, height: 9)
            }
            Text(host.url.host ?? link.hostURL.host ?? host.url.absoluteString)
                .font(.workbench(size: 12))
                .foregroundStyle(.secondary)
            if let version = client.host?.version, !version.isEmpty {
                Text("Version \(version)")
                    .font(.workbench(size: 12))
                    .foregroundStyle(.secondary)
            }
            Text(statusLabel)
                .font(.workbench(size: 12, weight: .medium))
                .foregroundStyle(statusColor)
        }
        .padding(.vertical, 4)
    }

    private func savedRow(_ host: SavedHost) -> some View {
        HStack(spacing: 10) {
            Image(systemName: host.machine.systemImage)
            VStack(alignment: .leading, spacing: 2) {
                Text(host.name)
                Text(host.url.host ?? host.url.absoluteString)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var statusColor: Color {
        switch client.status {
        case .open: return AppColors.success
        case .connecting: return AppColors.warning
        case .closed: return AppColors.error
        }
    }

    private var statusLabel: String {
        switch client.status {
        case .open: return "Open"
        case .connecting: return "Connecting"
        case .closed: return "Closed"
        }
    }

    private func beginRename(_ host: SavedHost) {
        renameText = host.name
        renameTarget = host
    }
}
