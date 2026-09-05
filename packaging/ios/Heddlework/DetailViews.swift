import SwiftUI

struct DetailPanelView: View {
    let panel: DetailPanel
    @ObservedObject var client: WorkspaceClient
    let contract: UIContract

    var body: some View {
        switch panel {
        case .notifications: NotificationsPanel(client: client)
        case .diff: DiffPanel(client: client)
        case .queue: QueuePanel(client: client)
        case .receipts: ReceiptsPanel(client: client)
        case .surfaces: SurfacesPanel(client: client, contract: contract)
        case .triage: UnsupportedPanel(title: "Triage", message: "Native triage controls require host support not exposed in the current iOS contract.")
        }
    }
}

struct NotificationsPanel: View {
    @ObservedObject var client: WorkspaceClient
    var body: some View {
        List {
            ForEach((client.snapshot?.notices ?? []).reversed()) { notice in
                VStack(alignment: .leading) { Text(notice.kind.uppercased()).font(.caption).foregroundStyle(.secondary); Text(notice.message) }
            }
            if !(client.snapshot?.notices?.isEmpty == false) { Text("No notifications") }
        }
        .toolbar { Button("Clear") { client.send(CommandFactory.simple("clearNotices"), label: "Clear notices") } }
    }
}

struct DiffPanel: View {
    @ObservedObject var client: WorkspaceClient
    var body: some View {
        VStack(alignment: .leading) {
            HStack { Text(client.snapshot?.workspaceDiff?.branch ?? "Changes").font(.headline); Spacer(); Button("Refresh") { client.send(CommandFactory.simple("refreshWorkspaceDiff"), label: "Refresh changes") } }
            List(client.snapshot?.workspaceDiff?.files ?? []) { file in
                DisclosureGroup("\(file.path) +\(file.additions) -\(file.deletions)") { Text(file.patch).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
            }
        }.padding()
    }
}

struct QueuePanel: View {
    @ObservedObject var client: WorkspaceClient
    @State private var editingItem: QueuedInput?
    @State private var editText = ""

    var body: some View {
        List {
            if let queue = client.snapshot?.queue, let blocking = queue.blockingActivity {
                Section("Blocking activity") {
                    VStack(alignment: .leading) { Text(blocking); Text(queue.blockingNote ?? "Queue is waiting on host activity.").font(.caption).foregroundStyle(.secondary) }
                    Button("Cancel blocking activity") { client.send(CommandFactory.simple("abort"), label: "Cancel blocking queue activity") }
                }
            }
            Section("Queued") {
                ForEach(Array((client.snapshot?.queue?.items ?? []).enumerated()), id: \.element.id) { index, item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.text)
                        if !item.images.isEmpty { Text("\(item.images.count) attachment(s)").font(.caption).foregroundStyle(.secondary) }
                        if let flow = item.flow { Text("Flow: \(flow.title) · \(flow.phase)").font(.caption).foregroundStyle(.secondary) }
                        HStack { Text(item.lane ?? "followUp").font(.caption); if item.paused == true { Text("paused").font(.caption).foregroundStyle(.orange) } }
                    }
                    .swipeActions(edge: .leading) {
                        Button("Steer") { client.send(CommandFactory.withString("steerQueuedInput", key: "id", value: item.id), label: "Steer queued input") }
                        Button(item.paused == true ? "Unpause" : "Pause") { client.send(CommandFactory.withString("toggleQueuedInputPause", key: "id", value: item.id), label: "Toggle queued pause") }
                    }
                    .swipeActions {
                        Button("Edit") { editingItem = item; editText = item.text }.tint(.blue)
                        Button("Lane") { client.send(CommandFactory.moveQueuedInputToLane(id: item.id, lane: item.lane == "steer" ? "followUp" : "steer"), label: "Move queued lane") }.tint(.purple)
                        Button("Up") { client.send(CommandFactory.moveQueuedInput(id: item.id, targetIndex: max(0, index - 1)), label: "Move queued input") }.tint(.gray)
                        Button(role: .destructive) { client.send(CommandFactory.withString("removeQueuedInput", key: "id", value: item.id), label: "Remove queued input") } label: { Text("Remove") }
                    }
                }
            }
            Section { Button(client.snapshot?.queue?.paused == true ? "Resume" : "Pause") { client.send(CommandFactory.simple(client.snapshot?.queue?.paused == true ? "resumeQueue" : "pause"), label: "Queue pause") } }
        }
        .sheet(item: $editingItem) { item in
            NavigationStack { Form { TextField("Queued prompt", text: $editText, axis: .vertical).lineLimit(4...12) }.navigationTitle("Edit queued input").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { editingItem = nil } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { client.send(CommandFactory.updateQueuedInput(id: item.id, text: editText), label: "Update queued input"); editingItem = nil } } } }
        }
    }
}

struct ReceiptsPanel: View {
    @ObservedObject var client: WorkspaceClient
    var body: some View {
        List(client.snapshot?.receipts ?? []) { receipt in
            DisclosureGroup("Turn \(receipt.turn) · \(receipt.files.count) file(s)") {
                if let commit = receipt.commit { Text("Commit: \(commit)").font(.caption).textSelection(.enabled) }
                ForEach(receipt.files) { file in Text("\(file.status) \(file.path) +\(file.additions) -\(file.deletions)").font(.caption) }
                ForEach(receipt.tools) { tool in Text("\(tool.name) ×\(tool.count)").font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
}

struct SurfacesPanel: View {
    @ObservedObject var client: WorkspaceClient
    let contract: UIContract
    var body: some View {
        List {
            Section("Remote capability contract") {
                Text("Contract v\(contract.version) loaded from ui-contract.json when bundled.")
                ForEach(contract.surfaces) { Text($0.label) }
            }
            Section("Host status") {
                ForEach((client.snapshot?.statusItems ?? [:]).sorted(by: { $0.key < $1.key }), id: \.key) { key, value in LabeledContent(key, value: value) }
            }
            Section("Extension widgets") {
                ForEach(Array((client.snapshot?.widgets ?? [:]).values)) { widget in VStack(alignment: .leading) { Text(widget.key).font(.headline); ForEach(widget.lines, id: \.self) { Text($0).font(.system(.caption, design: .monospaced)) } } }
            }
        }
    }
}

struct FlowsWorkspace: View {
    @ObservedObject var client: WorkspaceClient
    var body: some View {
        List {
            if let error = client.flows?.lastError { Text(error).foregroundStyle(.red) }
            Section("Pending") { ForEach(client.flows?.pending ?? []) { flow in VStack(alignment: .leading) { Text(flow.title); Text("\(flow.mode) · \(flow.prompts.count) prompt(s)").font(.caption).foregroundStyle(.secondary) } } }
            Section("Runs") { ForEach(client.flows?.runs ?? []) { run in DisclosureGroup(run.launch.title) { ForEach(run.tasks) { task in HStack { Text(task.specId); Spacer(); Text(task.status).foregroundStyle(.secondary) } } } } }
            Section("Schedules") { ForEach(client.flows?.schedules ?? []) { schedule in VStack(alignment: .leading) { Text(schedule.title); Text(schedule.enabled ? "Enabled" : "Disabled").font(.caption).foregroundStyle(schedule.enabled ? .green : .secondary) } } }
        }
    }
}

struct SettingsWorkspace: View {
    @ObservedObject var client: WorkspaceClient
    let contract: UIContract
    var onClose: () -> Void = {}
    var onDisconnect: () -> Void = {}
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var mobile: Bool { horizontalSizeClass == .compact }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Settings").font(.workbench(size: 13, weight: .semibold)).foregroundStyle(AppColors.text)
                Spacer()
                Button("Done", action: onClose)
                    .font(.workbench(size: 12, weight: .medium))
                    .padding(.horizontal, 9)
                    .frame(height: 28)
                    .background(AppColors.raised)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("settings-done")
            }
            .padding(.horizontal, 16)
            .frame(height: WorkbenchLayoutMetrics.headerHeight(contract))
            .accessibilityIdentifier("settings-header")
            Divider().overlay(AppColors.border)
            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: mobile ? 20 : 24) {
                    settingsSection("Runtime", description: "Live model and session controls for this remote workbench.") {
                        settingsRow("Status", value: client.snapshot?.connectionMessage ?? client.status.rawValue)
                        settingsRow("Workspace", value: client.snapshot?.workspacePath ?? client.workspacePath)
                        settingsRow("Activity", value: client.snapshot?.activity ?? "Ready")
                        Button {
                            client.disconnect()
                            onDisconnect()
                        } label: {
                            HStack {
                                Text("Disconnect").font(.workbench(size: 12, weight: .medium)).foregroundStyle(AppColors.error)
                                Spacer()
                            }
                            .padding(.horizontal, 13)
                            .frame(minHeight: 46)
                        }
                    }
                    settingsSection("Interface", description: "Application-wide presentation and navigation defaults.") {
                        settingsRow("Appearance", value: "System")
                        settingsRow("Text font", value: "Helvetica Neue")
                        settingsRow("Code font", value: "Menlo")
                    }
                    settingsSection("Remote access", description: "Connection details for this device.") {
                        settingsRow("Host", value: client.candidates.joined(separator: ", "))
                    }
                    settingsSection("Updates", description: "Update installation stays on the desktop host.") {
                        settingsRow("Desktop updates", value: "Host only")
                    }
                    settingsSection("Plugins", description: "Remote plugin widgets appear only when the host exposes them.") {
                        settingsRow("Plugin management", value: "Host controlled")
                    }
                    settingsSection("Terminal", description: "Terminal sessions require the local GPUix desktop process.") {
                        settingsRow("Terminal docks", value: "Desktop only")
                    }
                    settingsSection("Browser", description: "Browser pane and logged-in browser integrations run on the connected host.") {
                        BrowserIntegrationSettings(client: client).padding(13)
                    }
                    settingsSection("About", description: "A native GPUix control surface for Pi, visually adapted from the MIT-licensed T3 Code project.") {
                        settingsRow("Pi Code", value: "Alpha")
                        settingsRow("Contract", value: "ui-contract v\(contract.version)")
                    }
                    Color.clear.frame(height: 52)
                }
                .frame(maxWidth: WorkbenchLayoutMetrics.settingsMaxWidth(contract))
                .frame(maxWidth: .infinity)
                .padding(.top, mobile ? 18 : 28)
                .padding(.horizontal, mobile ? 12 : 28)
                .accessibilityIdentifier("settings-global")
            }
            .scrollBounceBehavior(.basedOnSize)
            .accessibilityIdentifier("settings-scroll")
        }
        .background(AppColors.background)
        .accessibilityIdentifier("settings-view")
    }

    private func settingsSection<Content: View>(_ title: String, description: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.workbench(size: 14, weight: .semibold)).foregroundStyle(AppColors.text)
            Text(description).font(.workbench(size: 11)).foregroundStyle(AppColors.muted).fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 0) {
                content()
            }
            .background(AppColors.card)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppColors.borderStrong, lineWidth: 1))
        }
    }

    private func settingsRow(_ label: String, value: String) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Text(label).font(.workbench(size: 12, weight: .medium)).foregroundStyle(AppColors.text)
            Spacer()
            Text(value).font(.workbench(size: 11)).foregroundStyle(AppColors.muted).lineLimit(1)
        }
        .padding(.horizontal, 13)
        .frame(minHeight: 46)
        .overlay(alignment: .bottom) { Divider().overlay(AppColors.border) }
    }
}

struct SessionsView: View {
    @ObservedObject var client: WorkspaceClient
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List(client.snapshot?.sessions ?? []) { session in
                Button { client.send(CommandFactory.withString("switchSession", key: "path", value: session.path), label: "Switch session"); dismiss() } label: { VStack(alignment: .leading) { Text(session.title); Text(session.cwd ?? session.path).font(.caption).foregroundStyle(.secondary) } }
            }
            .navigationTitle("Sessions")
            .toolbar { Button("Load more") { client.send(CommandFactory.simple("loadMoreSessions"), label: "Load more sessions") } }
        }
    }
}

struct DialogView: View {
    let dialog: ExtensionDialog
    @ObservedObject var client: WorkspaceClient
    @Environment(\.dismiss) private var dismiss
    @State private var value = ""

    var body: some View {
        NavigationStack {
            Form {
                if let message = dialog.message { Text(message) }
                if dialog.method == "select" { Picker(dialog.title, selection: $value) { ForEach(dialog.options ?? [], id: \.self) { Text($0).tag($0) } } }
                else if dialog.method == "input" || dialog.method == "editor" { TextField(dialog.placeholder ?? dialog.title, text: $value, axis: .vertical).lineLimit(3...10) }
                else { Text(dialog.method == "confirm" ? "Confirm this request." : "This dialog type has no native controls.") }
            }
            .navigationTitle(dialog.title)
            .onAppear { value = dialog.prefill ?? dialog.options?.first ?? "" }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { client.send(CommandFactory.respondToDialog(cancelled: true), label: "Cancel dialog"); dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("OK") { client.send(CommandFactory.respondToDialog(value: value, confirmed: true), label: "Respond to dialog"); dismiss() } }
            }
        }
    }
}

struct UnsupportedPanel: View {
    let title: String
    let message: String
    var body: some View { ContentUnavailableView(title, systemImage: "exclamationmark.triangle", description: Text(message)) }
}
