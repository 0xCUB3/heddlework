import SwiftUI
import UIKit

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
    private var notices: [Notice] {
        Array((client.snapshot?.notices ?? []).filter(\.isLedger).reversed())
    }
    var body: some View {
        List {
            ForEach(notices) { notice in
                Button {
                    client.send(CommandFactory.activateNotice(id: notice.id), label: "Open notice")
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Circle()
                            .fill(notice.isUnread ? (notice.kind == "error" ? AppColors.error : notice.kind == "warning" ? AppColors.warning : AppColors.success) : AppColors.textFaint)
                            .frame(width: 8, height: 8)
                            .padding(.top, 6)
                        VStack(alignment: .leading, spacing: 2) {
                            if let title = notice.sessionTitle, !title.isEmpty {
                                Text(title).font(.workbench(size: 11, weight: .semibold)).foregroundStyle(AppColors.text).lineLimit(1)
                            }
                            Text(notice.message).font(.workbench(size: 12)).foregroundStyle(AppColors.muted).lineLimit(2)
                        }
                        Spacer(minLength: 8)
                        Text(Date(timeIntervalSince1970: notice.createdAt / 1000).formatted(date: .omitted, time: .shortened))
                            .font(.workbench(size: 9))
                            .foregroundStyle(AppColors.textFaint)
                    }
                    .padding(.vertical, 4)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button("Dismiss", role: .destructive) {
                        client.send(CommandFactory.dismissNotice(id: notice.id), label: "Dismiss notice")
                    }
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
            if notices.isEmpty {
                Text("Completions, failures, and requests for input land here.")
                    .font(.workbench(size: 12))
                    .foregroundStyle(AppColors.muted)
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("notification-panel")
        .toolbar { Button("Clear") { client.send(CommandFactory.simple("clearNotices"), label: "Clear notices") } }
    }
}

struct DiffPanel: View {
    @ObservedObject var client: WorkspaceClient
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private var mobile: Bool { horizontalSizeClass == .compact }
    private var diff: WorkspaceDiff? { client.snapshot?.workspaceDiff }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(diff?.branch.isEmpty == false ? diff!.branch : "Changes")
                        .font(.workbench(size: 14, weight: .semibold))
                    Text(summary)
                        .font(.workbench(size: 11))
                        .foregroundStyle(AppColors.muted)
                }
                Spacer()
                Button("Refresh") { client.send(CommandFactory.simple("refreshWorkspaceDiff"), label: "Refresh changes") }
                    .font(.workbench(size: 12, weight: .medium))
            }
            .padding(.horizontal, mobile ? 12 : 14)
            .padding(.top, 10)
            .accessibilityIdentifier("diff-panel-header")

            if let error = diff?.error, !error.isEmpty {
                Text(error).font(.workbench(size: 12)).foregroundStyle(AppColors.error).padding(.horizontal, mobile ? 12 : 14)
            }

            List(diff?.files ?? []) { file in
                DiffFileCard(file: file, compact: mobile)
                    .listRowInsets(EdgeInsets(top: 6, leading: mobile ? 10 : 12, bottom: 6, trailing: mobile ? 10 : 12))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
        }
        .accessibilityIdentifier("diff-panel")
    }

    private var summary: String {
        let files = diff?.files.count ?? 0
        let additions = diff?.additions ?? 0
        let deletions = diff?.deletions ?? 0
        return "\(files) \(files == 1 ? "file" : "files")  +\(additions)  -\(deletions)"
    }
}

struct DiffFileCard: View {
    let file: WorkspaceDiffFile
    var compact = false
    @State private var expanded = false
    @State private var copied = false
    private var lines: [DiffLine] { DiffPatch.parse(file.patch) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.workbench(size: 10, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                        Text(file.path)
                            .font(.workbench(size: 12, weight: .medium, design: .monospaced))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                .accessibilityIdentifier("diff-file-header")
                Spacer(minLength: 0)
                Text("+\(file.additions)")
                    .font(.workbench(size: 11, design: .monospaced))
                    .foregroundStyle(AppColors.success)
                Text("-\(file.deletions)")
                    .font(.workbench(size: 11, design: .monospaced))
                    .foregroundStyle(AppColors.error)
                Button(copied ? "Copied" : "Copy") {
                    UIPasteboard.general.string = file.patch
                    copied = true
                }
                .font(.workbench(size: 11, weight: .medium))
            }
            if expanded {
                ScrollView(.horizontal, showsIndicators: true) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(lines) { line in
                            Text(line.text)
                                .font(.system(size: compact ? 11 : 12, design: .monospaced))
                                .foregroundStyle(color(for: line.kind))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(background(for: line.kind))
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                                .accessibilityIdentifier("diff-line")
                        }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppColors.border, lineWidth: 1))
                .accessibilityIdentifier("diff-hunks")
            }
        }
        .padding(.vertical, 4)
    }

    private func color(for kind: DiffLine.Kind) -> Color {
        switch kind {
        case .add: return AppColors.success
        case .del: return AppColors.error
        case .hunk, .fileHeader, .meta: return AppColors.textFaint
        case .context: return AppColors.text
        }
    }

    private func background(for kind: DiffLine.Kind) -> Color {
        switch kind {
        case .add: return AppColors.success.opacity(0.12)
        case .del: return AppColors.error.opacity(0.12)
        default: return Color.clear
        }
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
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button("Steer") { client.send(CommandFactory.withString("steerQueuedInput", key: "id", value: item.id), label: "Steer queued input") }
                        Button(item.paused == true ? "Unpause" : "Pause") { client.send(CommandFactory.withString("toggleQueuedInputPause", key: "id", value: item.id), label: "Toggle queued pause") }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Edit") { editingItem = item; editText = item.text }.tint(.blue)
                        Button("Lane") { client.send(CommandFactory.moveQueuedInputToLane(id: item.id, lane: item.lane == "steer" ? "followUp" : "steer"), label: "Move queued lane") }.tint(.purple)
                        Button("Up") { client.send(CommandFactory.moveQueuedInput(id: item.id, targetIndex: max(0, index - 1)), label: "Move queued input") }.tint(.gray)
                        Button(role: .destructive) { client.send(CommandFactory.withString("removeQueuedInput", key: "id", value: item.id), label: "Remove queued input") } label: { Text("Remove") }
                    }
                    .contextMenu {
                        Button("Steer") { client.send(CommandFactory.withString("steerQueuedInput", key: "id", value: item.id), label: "Steer queued input") }
                        Button("Edit") { editingItem = item; editText = item.text }
                        Button("Remove", role: .destructive) { client.send(CommandFactory.withString("removeQueuedInput", key: "id", value: item.id), label: "Remove queued input") }
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
    @ObservedObject private var notifications = NotificationService.shared
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
                    settingsSection("Power", description: "Controls idle sleep on the connected host computer, not this iPhone or iPad.") {
                        if let sleep = client.sleepPrevention {
                            settingsRow("Stay awake", value: sleepWhenLabel(sleep.policy.when))
                            Picker("Stay awake", selection: Binding(
                                get: { sleep.policy.when },
                                set: { client.send(CommandFactory.setSleepPreventionPolicy(when: $0, keepDisplayAwake: sleep.policy.keepDisplayAwake), label: "Host sleep policy") }
                            )) {
                                Text("Off").tag("off")
                                Text("While working").tag("whileWorking")
                                Text("While open").tag("whileAppOpen")
                            }
                            .padding(.horizontal, 13)
                            .frame(minHeight: 46)
                            Toggle(isOn: Binding(
                                get: { sleep.policy.keepDisplayAwake },
                                set: { client.send(CommandFactory.setSleepPreventionPolicy(when: sleep.policy.when, keepDisplayAwake: $0), label: "Host display wake") }
                            )) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Keep display awake").font(.workbench(size: 12, weight: .medium)).foregroundStyle(AppColors.text)
                                    Text(sleep.displaySupported ? "Host screen only. Lid close and Sleep still win." : "Display stay-awake is not available on this host.").font(.workbench(size: 9)).foregroundStyle(AppColors.textFaint)
                                }
                            }
                            .disabled(!sleep.displaySupported)
                            .padding(.horizontal, 13)
                            .frame(minHeight: 54)
                            settingsRow("Host status", value: sleepStatusLabel(sleep))
                            settingsRow("Now", value: sleep.reason)
                            settingsRow("Limits", value: sleep.limits)
                        } else {
                            settingsRow("Host power", value: "Connect to an updated host to control idle sleep on that computer.")
                        }
                    }
                    settingsSection("Interface", description: "Application-wide presentation and navigation defaults.") {
                        settingsRow("Appearance", value: "System")
                        settingsRow("Text font", value: "Helvetica Neue")
                        settingsRow("Code font", value: "Menlo")
                    }
                    settingsSection("Remote access", description: "Connection details for this device.") {
                        settingsRow("Host", value: client.candidates.joined(separator: ", "))
                        settingsRow("Tailnet HTTPS", value: "Turn this on in the Mac app under Settings → Remote access. This device cannot change Tailscale Serve.")
                        Toggle(isOn: Binding(
                            get: { notifications.authorized },
                            set: { enabled in if enabled { notifications.requestAuthorization() } }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Alerts").font(.workbench(size: 12, weight: .medium)).foregroundStyle(AppColors.text)
                                Text("Works while this app can reach the Mac. Offline Mac or a killed app needs a push relay, which is not configured.").font(.workbench(size: 9)).foregroundStyle(AppColors.textFaint)
                            }
                        }
                        .padding(.horizontal, 13)
                        .frame(minHeight: 54)
                    }
                    settingsSection("Updates", description: "Update installation stays on the desktop host.") {
                        settingsRow("Desktop updates", value: "Host only")
                    }
                    settingsSection("Plugins", description: "Remote plugin widgets appear only when the host exposes them.") {
                        settingsRow("Plugin management", value: "Host controlled")
                    }
                    settingsSection("Terminal", description: "Opens a host shell on the connected Mac. This device only sends keystrokes.") {
                        settingsRow("Host terminal", value: client.terminal == nil ? "Unavailable on this host" : "Ready")
                        settingsRow("Build", value: AppBuildInfo.label)
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
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Settle") { client.send(CommandFactory.withString("settleThread", key: "path", value: session.path), label: "Settle thread") }.tint(.gray)
                        Button("Snooze") {
                            let until = Date().addingTimeInterval(3_600).timeIntervalSince1970 * 1_000
                            client.send(CommandFactory.snoozeThread(path: session.path, snoozedUntil: until), label: "Snooze thread")
                        }.tint(.orange)
                    }
                    .contextMenu {
                        Button("Open") { client.send(CommandFactory.withString("switchSession", key: "path", value: session.path), label: "Switch session"); dismiss() }
                        Button("Settle") { client.send(CommandFactory.withString("settleThread", key: "path", value: session.path), label: "Settle thread") }
                    }
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

private func sleepWhenLabel(_ when: String) -> String {
    switch when {
    case "off": return "Off"
    case "whileAppOpen": return "While Heddlework is open"
    default: return "While working"
    }
}

private func sleepStatusLabel(_ sleep: SleepPreventionSnapshot) -> String {
    switch sleep.status {
    case "active": return "Holding idle sleep"
    case "unsupported": return "Unavailable on this host"
    case "error": return "Failed: \(sleep.error ?? sleep.reason)"
    default: return "Not holding"
    }
}
