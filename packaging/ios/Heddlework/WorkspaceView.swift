import SwiftUI
import PhotosUI
import UIKit

struct WorkspaceView: View {
    let link: ConnectLink
    let onDisconnect: () -> Void
    @StateObject private var client = WorkspaceClient()
    @State private var surface: WorkspaceSurface = .chat
    @State private var panel: DetailPanel?
    @State private var showingSessions = false
    @State private var contract = UIContract.load()
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showingSidebar = false
    @State private var terminalOpen = false
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if horizontalSizeClass == .compact {
                NavigationStack {
                    workspaceDetail
                }
            } else {
                NavigationSplitView(columnVisibility: $columnVisibility) {
                    SidebarView(client: client, surface: $surface, panel: $panel, columnVisibility: $columnVisibility, showingSessions: $showingSessions, contract: contract, onDisconnect: onDisconnect)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar(.hidden, for: .navigationBar)
                        .toolbar(removing: .sidebarToggle)
                        .background(AppColors.sidebar)
                } detail: { workspaceDetail }
            }
        }
        .task(id: link.hostURL.absoluteString + link.token) { client.connect(link) }
        .onDisappear { client.disconnect(clearState: false) }
        .onAppear {
            NotificationService.shared.refreshAuthorization()
            reportPresence()
        }
        .onChange(of: scenePhase) { _, phase in
            reportPresence(visibility: phase == .active ? "focused" : "hidden")
        }
        .onChange(of: client.snapshot?.session?.sessionFile) { _, _ in
            reportPresence()
        }
        .onChange(of: panel) { _, next in
            if next == .notifications { client.send(CommandFactory.simple("markNoticesRead"), label: "Mark notices read") }
        }
        .task {
            while !Task.isCancelled {
                reportPresence()
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
        .sheet(isPresented: $showingSidebar) { NavigationStack { SidebarView(client: client, surface: $surface, panel: $panel, columnVisibility: $columnVisibility, showingSessions: $showingSessions, contract: contract, onDisconnect: onDisconnect).navigationTitle("Heddlework") } }
        .sheet(isPresented: $showingSessions) { SessionsView(client: client) }
        .sheet(item: dialogBinding) { DialogView(dialog: $0, client: client) }
        .alert("Workspace", isPresented: Binding(get: { client.lastError != nil }, set: { if !$0 { client.dismissError() } })) {
            Button("OK") { client.dismissError() }
        } message: { Text(client.lastError ?? "") }
        .accessibilityIdentifier("workspace-root")
        .accessibilityValue(client.status.rawValue)
    }

    private var workspaceDetail: some View {
        Group {
            if panel == nil && surface == .settings {
                SettingsWorkspace(client: client, contract: contract, onClose: { surface = .chat }, onDisconnect: onDisconnect)
            } else if horizontalSizeClass == .compact {
                VStack(spacing: 0) {
                    HeaderView(client: client, surface: $surface, panel: $panel, showingSidebar: $showingSidebar, columnVisibility: $columnVisibility, terminalOpen: $terminalOpen, contract: contract)
                    if let panel {
                        DetailPanelView(panel: panel, client: client, contract: contract)
                    } else {
                        content
                    }
                }
            } else {
                GeometryReader { geo in
                    HStack(spacing: 0) {
                        VStack(spacing: 0) {
                            HeaderView(client: client, surface: $surface, panel: $panel, showingSidebar: $showingSidebar, columnVisibility: $columnVisibility, terminalOpen: $terminalOpen, contract: contract)
                            content
                        }
                        if let panel {
                            DetailPanelView(panel: panel, client: client, contract: contract)
                                .frame(width: panel == .notifications
                                    ? WorkbenchLayoutMetrics.notificationsPanelWidth(mainWidth: geo.size.width)
                                    : WorkbenchLayoutMetrics.standardPanelWidth(mainWidth: geo.size.width))
                                .overlay(alignment: .leading) { Rectangle().fill(AppColors.border).frame(width: 1) }
                                .accessibilityIdentifier("right-panel-host")
                        }
                    }
                }
            }
        }
        .background(AppColors.window.ignoresSafeArea())
        .foregroundStyle(AppColors.text)
        .buttonStyle(.plain)
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(removing: .sidebarToggle)
    }

    @ViewBuilder private var content: some View {
        if surface == .flows {
            FlowsWorkspace(client: client)
        } else {
            ChatWorkspace(client: client, terminalOpen: $terminalOpen)
        }
    }

    private var dialogBinding: Binding<ExtensionDialog?> {
        Binding(get: { client.snapshot?.dialog }, set: { _ in })
    }

    private func reportPresence(visibility: String? = nil) {
        let hidden = scenePhase != .active
        client.send(CommandFactory.reportPresence(
            clientId: NotificationService.shared.clientId,
            surface: "ios",
            visibility: visibility ?? (hidden ? "hidden" : "focused"),
            sessionPath: client.snapshot?.session?.sessionFile
        ), label: "Presence", quiet: true)
    }
}

struct SidebarView: View {
    @ObservedObject var client: WorkspaceClient
    @Binding var surface: WorkspaceSurface
    @Binding var panel: DetailPanel?
    @Binding var columnVisibility: NavigationSplitViewVisibility
    @Binding var showingSessions: Bool
    let contract: UIContract
    let onDisconnect: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var sessionSearch = ""
    @State private var projectScope = "__all-projects__"
    @State private var settledExpanded = false
    @State private var snoozePath: String?

    private var snapshot: WorkbenchSnapshot? { client.snapshot }
    private var allSessions: [SessionSummary] {
        (snapshot?.sessions ?? []).filter { ($0.messageCount ?? 1) > 0 }
    }
    private var projectOptions: [(value: String, label: String)] {
        var seen = [String: String]()
        for session in allSessions {
            let cwd = session.cwd ?? snapshot?.workspacePath ?? ""
            seen[cwd] = SessionCatalog.projectName(for: session)
        }
        return [("__all-projects__", "All projects")] + seen.map { ($0.key, $0.value) }.sorted { $0.1 < $1.1 }
    }
    private var filteredSessions: [SessionSummary] {
        let query = sessionSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return allSessions.filter { session in
            if projectScope != "__all-projects__" && (session.cwd ?? "") != projectScope { return false }
            if query.isEmpty { return true }
            return session.title.lowercased().contains(query) || (session.cwd ?? "").lowercased().contains(query) || session.path.lowercased().contains(query)
        }.sorted { ($0.modifiedAt ?? $0.updatedAt ?? 0) > ($1.modifiedAt ?? $1.updatedAt ?? 0) }
    }
    private func bucket(_ session: SessionSummary) -> LifecycleBucket {
        SessionLifecycle.bucket(session: session, lifecycle: snapshot?.threadLifecycle?[session.path])
    }
    private var activeSessions: [SessionSummary] { filteredSessions.filter { bucket($0) == .active } }
    private var snoozedSessions: [SessionSummary] { filteredSessions.filter { bucket($0) == .snoozed } }
    private var settledSessions: [SessionSummary] { filteredSessions.filter { bucket($0) == .settled } }
    private var renderedSettled: [SessionSummary] {
        settledExpanded ? settledSessions : settledSessions.filter { SessionCatalog.isCurrentSession($0, state: snapshot?.session) }
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("Heddlework")
                .font(.workbench(size: 12, weight: .semibold))
                .foregroundStyle(AppColors.muted)
                .frame(height: WorkbenchLayoutMetrics.headerHeight(contract))
                .accessibilityIdentifier("sidebar-brand")
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    surface = surface == .flows ? .chat : .flows
                    panel = nil
                    dismiss()
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.triangle.branch").font(.workbench(size: 13))
                        Text("Flows").font(.workbench(size: 12, weight: surface == .flows ? .semibold : .medium))
                        Spacer()
                    }
                    .foregroundStyle(surface == .flows ? AppColors.text : AppColors.muted)
                    .padding(.horizontal, 8)
                    .frame(height: 32)
                    .background(surface == .flows ? AppColors.sidebarActive : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                HStack(spacing: 4) {
                    HStack(spacing: 7) {
                        Image(systemName: "magnifyingglass").font(.workbench(size: 13)).foregroundStyle(AppColors.textFaint)
                        TextField("Search", text: $sessionSearch)
                            .font(.workbench(size: 12))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 32)
                    Button {
                        client.send(CommandFactory.simple("newSession"), label: "New session")
                        surface = .chat
                        panel = nil
                        dismiss()
                    } label: {
                        Image(systemName: "square.and.pencil").font(.workbench(size: 14)).foregroundStyle(AppColors.muted)
                    }
                    .frame(width: 30, height: 30)
                    .accessibilityLabel("New thread")
                }
                HStack(spacing: 5) {
                    Menu {
                        ForEach(projectOptions, id: \.value) { option in
                            Button(option.label) { projectScope = option.value }
                        }
                    } label: {
                        HStack(spacing: 7) {
                            Image(systemName: "folder").font(.workbench(size: 13)).foregroundStyle(AppColors.textFaint)
                            Text(projectOptions.first(where: { $0.value == projectScope })?.label ?? "All projects")
                                .font(.workbench(size: 12, weight: .medium))
                                .foregroundStyle(AppColors.muted)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.down").font(.workbench(size: 10)).foregroundStyle(AppColors.textFaint)
                        }
                        .padding(.horizontal, 8)
                        .frame(height: 32)
                    }
                    Image(systemName: "folder.badge.plus").font(.workbench(size: 14)).foregroundStyle(AppColors.textFaint).frame(width: 30, height: 30).accessibilityLabel("Add project on desktop")
                }
            }
            .padding(8)
            List {
                ForEach(activeSessions) { session in
                    NativeSessionCard(session: session, snapshot: snapshot, snoozeOpen: snoozePath == session.path, onOpen: { openSession(session) }, onSettle: { settle(session) }, onSnooze: { snoozePath = snoozePath == session.path ? nil : session.path }, onSchedule: { until in
                        snoozePath = nil
                        snooze(session, until: until)
                    })
                    .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .sessionSwipeActions(lifecycle: .active, onOpen: { openSession(session) }, onSettle: { settle(session) }, onSnooze: { snooze(session) }, onWake: {})
                    .contextMenu { sessionContextMenu(session, lifecycle: .active) }
                }
                if !snoozedSessions.isEmpty {
                    Section {
                        ForEach(snoozedSessions) { session in
                            CompactSessionRow(session: session, snapshot: snapshot, lifecycle: .snoozed, onOpen: { openSession(session) }, onWake: { wake(session) })
                                .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                                .sessionSwipeActions(lifecycle: .snoozed, onOpen: { openSession(session) }, onSettle: {}, onSnooze: {}, onWake: { wake(session) })
                                .contextMenu { sessionContextMenu(session, lifecycle: .snoozed) }
                        }
                    } header: {
                        sectionLabel("Snoozed (\(snoozedSessions.count))", accent: true)
                    }
                }
                if !settledSessions.isEmpty {
                    Section {
                        ForEach(renderedSettled) { session in
                            CompactSessionRow(session: session, snapshot: snapshot, lifecycle: .settled, onOpen: { openSession(session) }, onWake: { wake(session) })
                                .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                                .sessionSwipeActions(lifecycle: .settled, onOpen: { openSession(session) }, onSettle: {}, onSnooze: {}, onWake: { wake(session) })
                                .contextMenu { sessionContextMenu(session, lifecycle: .settled) }
                        }
                    } header: {
                        Button { settledExpanded.toggle() } label: {
                            HStack(spacing: 7) {
                                Text(settledExpanded ? "Settled" : "Settled (\(settledSessions.count))").font(.workbench(size: 10, weight: .medium)).foregroundStyle(AppColors.settledText)
                                Rectangle().fill(AppColors.settledDivider).frame(height: 1)
                                Image(systemName: settledExpanded ? "chevron.up" : "chevron.down").font(.workbench(size: 10)).foregroundStyle(AppColors.settledText)
                            }
                            .padding(.horizontal, 3)
                            .frame(height: 32)
                        }
                    }
                }
                if filteredSessions.isEmpty {
                    Text(sessionSearch.isEmpty ? "No threads in this project" : "No threads found")
                        .font(.workbench(size: 11))
                        .foregroundStyle(AppColors.textFaint)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                if snapshot?.sessionsHasMore == true {
                    Button("Load more") { client.send(CommandFactory.simple("loadMoreSessions"), label: "Load more sessions") }
                        .font(.workbench(size: 11))
                        .foregroundStyle(AppColors.textFaint)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 36)
            HStack(spacing: 2) {
                footerButton("gearshape", active: surface == .settings, label: "Settings", identifier: "sidebar-settings") { surface = surface == .settings ? .chat : .settings; panel = nil; dismiss() }
                footerButton("bell", active: panel == .notifications, label: "Notifications", identifier: "sidebar-notifications") { panel = .notifications; surface = .chat; dismiss() }
                footerButton("arrow.clockwise", active: false, label: "Refresh threads") { client.send(CommandFactory.simple("refreshSessions"), label: "Refresh sessions") }
                Spacer()
                Circle().fill(connectionColor).frame(width: 7, height: 7).padding(.trailing, 8)
            }
            .padding(.horizontal, 8)
            .frame(height: WorkbenchLayoutMetrics.sidebarFooterHeight)
            .accessibilityIdentifier("sidebar-footer")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(AppColors.sidebar)
        .accessibilityIdentifier("sidebar")
    }

    private func openSession(_ session: SessionSummary) {
        client.send(CommandFactory.withString("switchSession", key: "path", value: session.path), label: "Switch session")
        surface = .chat
        panel = nil
        columnVisibility = .detailOnly
        dismiss()
    }

    private func settle(_ session: SessionSummary) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        client.send(CommandFactory.withString("settleThread", key: "path", value: session.path), label: "Settle thread")
    }

    private func wake(_ session: SessionSummary) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        client.send(CommandFactory.withString("wakeThread", key: "path", value: session.path), label: "Wake thread")
    }

    private func snooze(_ session: SessionSummary, until: Double? = nil) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let deadline = until ?? (Date().addingTimeInterval(3_600).timeIntervalSince1970 * 1_000)
        client.send(CommandFactory.snoozeThread(path: session.path, snoozedUntil: deadline), label: "Snooze thread")
    }

    @ViewBuilder
    private func sessionContextMenu(_ session: SessionSummary, lifecycle: LifecycleBucket) -> some View {
        Button("Open") { openSession(session) }
        if lifecycle == .active {
            Button("Settle") { settle(session) }
            ForEach(SessionCatalog.snoozeOptions(), id: \.label) { option in
                Button("Snooze \(option.label)") { snooze(session, until: option.until) }
            }
        } else {
            Button("Wake") { wake(session) }
        }
    }

    private var connectionColor: Color {
        switch client.status {
        case .open: return AppColors.success
        case .connecting: return AppColors.warning
        default: return AppColors.error
        }
    }

    private func sectionLabel(_ text: String, accent: Bool) -> some View {
        HStack {
            Text(text).font(.workbench(size: 10)).foregroundStyle(accent ? AppColors.info : AppColors.textFaint)
            Rectangle().fill(accent ? AppColors.info.opacity(0.35) : AppColors.border).frame(height: 1)
        }
        .padding(.horizontal, 11)
        .frame(height: 28)
    }

    private func footerButton(_ systemName: String, active: Bool, label: String, identifier: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.workbench(size: 15))
                .foregroundStyle(active ? AppColors.text : AppColors.textFaint)
                .frame(width: 30, height: 30)
                .background(active ? AppColors.sidebarHover : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 7))
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier ?? label)
    }
}

private struct NativeSessionCard: View {
    let session: SessionSummary
    let snapshot: WorkbenchSnapshot?
    let snoozeOpen: Bool
    let onOpen: () -> Void
    let onSettle: () -> Void
    let onSnooze: () -> Void
    let onSchedule: (Double) -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 5) {
                        Image(systemName: "folder").font(.workbench(size: 11)).foregroundStyle(AppColors.textFaint)
                        Text(SessionCatalog.projectName(for: session)).font(.workbench(size: 10, weight: .medium)).foregroundStyle(AppColors.muted).lineLimit(1)
                        Spacer(minLength: 70)
                    }
                    Text(session.title).font(.workbench(size: 12, weight: SessionCatalog.isCurrentSession(session, state: snapshot?.session) ? .semibold : .medium)).foregroundStyle(SessionCatalog.isCurrentSession(session, state: snapshot?.session) ? AppColors.text : AppColors.muted).lineLimit(1)
                    HStack(spacing: 5) {
                        Image(systemName: "folder").font(.workbench(size: 9)).foregroundStyle(AppColors.textFaint)
                        Text(SessionCatalog.footerLabel(session: session)).font(.workbench(size: 9)).foregroundStyle(AppColors.textFaint).lineLimit(1)
                    }
                }
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text(SessionCatalog.relativeTime(from: session.modifiedAt ?? session.updatedAt))
                .font(.workbench(size: 9))
                .foregroundStyle(AppColors.textFaint)
                .padding(.top, 9)
                .padding(.trailing, 6)
        }
        .frame(height: WorkbenchLayoutMetrics.sessionCardHeight)
        .background(SessionCatalog.isCurrentSession(session, state: snapshot?.session) ? AppColors.sidebarActive : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(SessionCatalog.isCurrentSession(session, state: snapshot?.session) ? "sidebar-session-card-active" : "sidebar-session-card")
        .accessibilityLabel(session.title)
        .overlay(alignment: .topTrailing) {
            if snoozeOpen {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(SessionCatalog.snoozeOptions(), id: \.label) { option in
                        Button(option.label) { onSchedule(option.until) }
                            .font(.workbench(size: 11))
                            .foregroundStyle(AppColors.muted)
                    }
                }
                .padding(5)
                .frame(width: 204, alignment: .leading)
                .background(AppColors.sidebar)
                .clipShape(RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(AppColors.border, lineWidth: 1))
                .offset(y: 28)
                .padding(.trailing, 8)
            }
        }
    }
}

private struct CompactSessionRow: View {
    let session: SessionSummary
    let snapshot: WorkbenchSnapshot?
    let lifecycle: LifecycleBucket
    let onOpen: () -> Void
    let onWake: () -> Void

    var body: some View {
        HStack(spacing: 7) {
            Button(action: onOpen) {
                HStack(spacing: 7) {
                    Image(systemName: lifecycle == .snoozed ? "clock" : "square.and.pencil")
                        .font(.workbench(size: 12))
                        .foregroundStyle(lifecycle == .settled ? AppColors.settledIcon : AppColors.info)
                    Text(session.title)
                        .font(.workbench(size: 11))
                        .foregroundStyle(lifecycle == .settled ? AppColors.settledText : AppColors.textFaint)
                        .lineLimit(1)
                    Spacer()
                }
            }
            Text(metaLabel)
                .font(.workbench(size: 9))
                .foregroundStyle(lifecycle == .settled ? AppColors.settledMeta : AppColors.textFaint)
            Button(action: onWake) { Image(systemName: "checkmark").font(.workbench(size: 11)).foregroundStyle(lifecycle == .settled ? AppColors.settledIcon : AppColors.textFaint) }
                .frame(width: 22, height: 22)
                .accessibilityLabel("Wake")
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(height: WorkbenchLayoutMetrics.sessionCompactHeight)
        .padding(.horizontal, 8)
        .accessibilityIdentifier(lifecycle == .settled ? "sidebar-settled-row" : "sidebar-snoozed-row")
    }

    private var metaLabel: String {
        if lifecycle == .snoozed, let until = snapshot?.threadLifecycle?[session.path]?.snoozedUntil {
            return Date(timeIntervalSince1970: until / 1_000).formatted(date: .omitted, time: .shortened)
        }
        return SessionCatalog.relativeTime(from: session.modifiedAt ?? session.updatedAt)
    }
}

struct HeaderView: View {
    @ObservedObject var client: WorkspaceClient
    @Binding var surface: WorkspaceSurface
    @Binding var panel: DetailPanel?
    @Binding var showingSidebar: Bool
    @Binding var columnVisibility: NavigationSplitViewVisibility
    @Binding var terminalOpen: Bool
    let contract: UIContract
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var compact: Bool { horizontalSizeClass == .compact }
    private var projectName: String {
        if let cwd = client.snapshot?.workspacePath ?? (client.workspacePath.isEmpty ? nil : client.workspacePath) {
            return URL(fileURLWithPath: cwd).lastPathComponent
        }
        return "Heddlework"
    }

    var body: some View {
        HStack(spacing: compact ? 5 : 10) {
            Button {
                if compact { showingSidebar = true }
                else { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly }
            } label: { Image(systemName: "sidebar.left") }
                .font(.workbench(size: 15, weight: .medium))
                .foregroundStyle(AppColors.muted)
                .frame(width: 28, height: 28)
                .accessibilityLabel("Toggle sidebar")
                .accessibilityIdentifier("toggle-left-sidebar")

            HStack(spacing: 8) {
                if !compact {
                    Image(systemName: "folder").font(.workbench(size: 12)).foregroundStyle(AppColors.textFaint)
                    Text(projectName).font(.workbench(size: 12, weight: .medium)).foregroundStyle(AppColors.muted).lineLimit(1)
                    Text("/").font(.workbench(size: 12)).foregroundStyle(AppColors.textFaint)
                }
                Text(SessionCatalog.activeThreadTitle(snapshot: client.snapshot))
                    .font(.workbench(size: 12, weight: .semibold))
                    .foregroundStyle(AppColors.text)
                    .lineLimit(1)
                    .accessibilityIdentifier("chat-thread-title")
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Menu {
                Button("New thread") { client.send(CommandFactory.simple("newSession"), label: "New session") }
                    .disabled(client.status != .open || client.snapshot?.session?.isStreaming == true)
                Button("Open project · desktop only") {}.disabled(true)
                Button("Clone thread · desktop only") {}.disabled(true)
                Button("Compact context") { client.send(CommandFactory.simple("compact"), label: "Compact") }
                    .disabled(client.status != .open || (client.snapshot?.messages?.isEmpty ?? true))
                Button("Refresh sessions") { client.send(CommandFactory.simple("refreshSessions"), label: "Refresh sessions") }
                Button("Export transcript · desktop only") {}.disabled(true)
                Button("Surfaces") { panel = .surfaces; surface = .chat }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.workbench(size: 12, weight: .semibold))
                    if !compact { Text("Add action").font(.workbench(size: 11, weight: .medium)) }
                }
                .foregroundStyle(AppColors.text)
                .padding(.horizontal, compact ? 0 : 9)
                .frame(width: compact ? 30 : nil, height: 28)
                .background(AppColors.raised)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppColors.borderStrong, lineWidth: 1))
            }
            .accessibilityLabel("Add action")

            if !compact {
                headerHostButton("shippingbox", label: "Open")
                headerHostButton("square.and.arrow.down", label: "Export")
            }
            Button {
                terminalOpen.toggle()
            } label: {
                Image(systemName: "rectangle.bottomhalf.inset.filled")
                    .font(.workbench(size: 14))
                    .foregroundStyle(terminalOpen ? AppColors.text : AppColors.muted)
                    .frame(width: 30, height: 30)
            }
            .disabled(client.status != .open)
            .accessibilityLabel("Toggle terminal panel")
            .accessibilityIdentifier("toggle-terminal")

            Button {
                if panel == .diff { panel = nil }
                else {
                    panel = .diff
                    client.send(CommandFactory.simple("refreshWorkspaceDiff"), label: "Refresh changes")
                }
            } label: {
                Image(systemName: "rectangle.split.2x1").font(.workbench(size: 14)).foregroundStyle(panel == .diff ? AppColors.text : AppColors.muted).frame(width: 30, height: 30)
            }
            .accessibilityLabel("Toggle Diff panel")
            .accessibilityIdentifier("toggle-diff")
        }
        .padding(.horizontal, compact ? 8 : 12)
        .frame(height: WorkbenchLayoutMetrics.headerHeight(contract))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-header")
    }

    private func headerHostButton(_ systemName: String, label: String) -> some View {
        Button(action: {}) {
            HStack(spacing: 5) {
                Image(systemName: systemName).font(.workbench(size: 12))
                Text(label).font(.workbench(size: 11, weight: .medium))
            }
            .foregroundStyle(AppColors.text)
            .padding(.horizontal, 9)
            .frame(height: 28)
            .background(AppColors.raised)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppColors.borderStrong, lineWidth: 1))
        }
        .disabled(true)
        .accessibilityLabel("\(label), desktop only")
    }
}

struct ChatWorkspace: View {
    @ObservedObject var client: WorkspaceClient
    @Binding var terminalOpen: Bool
    @State private var draft = ""
    @State private var queue = false
    @State private var sessionKey = ""
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var mobile: Bool { horizontalSizeClass == .compact }
    private var currentSessionKey: String {
        client.snapshot?.session?.sessionFile ?? client.snapshot?.session?.sessionId ?? client.workspacePath
    }
    private var memoryHost: String { client.candidates.first ?? "" }

    var isEmptyChat: Bool {
        (client.snapshot?.messages ?? []).isEmpty && client.snapshot?.liveAssistant == nil && (client.snapshot?.liveTools ?? []).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            if isEmptyChat {
                EmptyChatView(client: client, draft: $draft, queue: $queue)
            } else {
                TranscriptView(snapshot: client.snapshot, client: client, mobile: mobile)
                ComposerView(client: client, draft: $draft, queue: $queue)
                    .padding(.horizontal, mobile ? 10 : 20)
                    .padding(.bottom, 10)
            }
            if terminalOpen {
                TerminalPanelView(client: client, onClose: { terminalOpen = false })
                    .frame(height: mobile ? 280 : 220)
                    .overlay(alignment: .top) { Rectangle().fill(AppColors.border).frame(height: 1) }
                    .transition(.move(edge: .bottom))
            }
        }
        .onAppear { restoreDraft() }
        .onChange(of: currentSessionKey) { _, _ in
            persistDraft()
            restoreDraft()
        }
        .onChange(of: draft) { _, _ in persistDraft() }
    }

    private func restoreDraft() {
        sessionKey = currentSessionKey
        draft = WorkspaceSessionMemory.shared.chrome(host: memoryHost, session: currentSessionKey).draft
    }

    private func persistDraft() {
        WorkspaceSessionMemory.shared.update(host: memoryHost, session: currentSessionKey) { chrome in
            chrome.draft = draft
        }
    }
}

struct EmptyChatView: View {
    @ObservedObject var client: WorkspaceClient
    @Binding var draft: String
    @Binding var queue: Bool
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var mobile: Bool { horizontalSizeClass == .compact }

    var body: some View {
        VStack(spacing: mobile ? 18 : 25) {
            Group {
                if mobile {
                    VStack(spacing: 5) {
                        Text("What should we build in")
                        HStack(spacing: 0) {
                            Text(workspaceName).underline()
                            Text("?")
                        }
                    }
                } else {
                    HStack(spacing: 0) {
                        Text("What should we build in ")
                        Text(workspaceName).underline()
                        Text("?")
                    }
                }
            }
            .font(.workbench(size: mobile ? 22 : 26, weight: .medium))
            .foregroundStyle(AppColors.text)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            ComposerView(client: client, draft: $draft, queue: $queue)
                .frame(maxWidth: WorkbenchLayoutMetrics.fallbackContentMax)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, mobile ? 12 : 20)
        .padding(.bottom, mobile ? 42 : 74)
    }

    private var workspaceName: String {
        if let path = client.snapshot?.workspacePath ?? (client.workspacePath.isEmpty ? nil : client.workspacePath) {
            let name = URL(fileURLWithPath: path).lastPathComponent
            if !name.isEmpty && name != "/" && name != "." { return name }
        }
        return "workspace"
    }
}

struct ComposerView: View {
    @ObservedObject var client: WorkspaceClient
    @Binding var draft: String
    @Binding var queue: Bool
    @State private var pickerItem: PhotosPickerItem?
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var mobile: Bool { horizontalSizeClass == .compact }
    private var branch: String { client.snapshot?.workspaceDiff?.branch.isEmpty == false ? client.snapshot!.workspaceDiff!.branch : "workspace" }

    var body: some View {
        ZStack(alignment: .bottom) {
            HStack(spacing: 6) {
                Image(systemName: "folder").font(.workbench(size: 12)).foregroundStyle(AppColors.contextIcon)
                if !mobile { Text("Local checkout").font(.workbench(size: 12)).foregroundStyle(AppColors.contextText) }
                Spacer()
                Image(systemName: "arrow.triangle.branch").font(.workbench(size: 11)).foregroundStyle(AppColors.contextIcon)
                Text(branch).font(.workbench(size: 12)).foregroundStyle(AppColors.contextText).lineLimit(1)
            }
            .padding(.horizontal, 13)
            .padding(.top, 20)
            .padding(.bottom, 4)
            .frame(height: WorkbenchLayoutMetrics.composerContextHeight)
            .background(AppColors.contextBar)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(AppColors.composerOutline, lineWidth: 1))
            .padding(.horizontal, WorkbenchLayoutMetrics.composerContextInset)
            .accessibilityIdentifier("composer-context-bar")

            composerSurface
                .padding(.bottom, WorkbenchLayoutMetrics.composerOverlap)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer-wrap")
    }

    private var composerSurface: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let notice = client.snapshot?.notices?.last(where: { $0.isLedger && $0.isUnread && ($0.reason == "failure" || $0.reason == "input" || $0.kind == "error") }) {
                Text(notice.message).font(.workbench(size: 11)).foregroundStyle(notice.kind == "error" ? AppColors.error : AppColors.warning).lineLimit(2)
            }
            TextField("Ask for changes, send follow-ups, or attach images", text: $draft, axis: .vertical)
                .font(.workbench(size: 14))
                .lineLimit(mobile ? 2...5 : 3...7)
                .textFieldStyle(.plain)
                .padding(.horizontal, mobile ? 13 : 16)
                .accessibilityIdentifier("composer")

            if !(client.snapshot?.editorImages?.isEmpty ?? true) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(client.snapshot?.editorImages ?? []) { image in
                            HStack { Text(image.fileName); if let omitted = image.omittedDescription { Text(omitted).foregroundStyle(.secondary) }; Button { client.send(CommandFactory.withString("removeEditorImage", key: "id", value: image.id), label: "Remove attachment") } label: { Image(systemName: "xmark.circle.fill") } }
                                .font(.caption).padding(8).background(AppColors.raised).clipShape(Capsule())
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }

            HStack(spacing: mobile ? 2 : 4) {
                Menu {
                    ForEach(client.snapshot?.models ?? []) { model in Button(model.label) { client.send(CommandFactory.setModel(provider: model.provider, id: model.id), label: "Set model") } }
                } label: { Label(modelLabel, systemImage: "sparkles") }
                    .font(.workbench(size: 12))
                    .disabled((client.snapshot?.models ?? []).isEmpty)

                if !mobile { Rectangle().fill(AppColors.borderStrong).frame(width: 1, height: 16) }

                Menu {
                    ForEach(client.snapshot?.thinkingLevels ?? ["off"], id: \.self) { level in Button(level) { client.send(CommandFactory.withString("setThinkingLevel", key: "level", value: level), label: "Set thinking") } }
                } label: { Text(client.snapshot?.session?.thinkingLevel ?? "off") }
                    .font(.workbench(size: 12))

                Button { queue.toggle() } label: { Image(systemName: queue ? "tray.full.fill" : "tray") }
                    .accessibilityLabel(queue ? "Queue enabled" : "Queue disabled")

                if client.snapshot?.queue?.paused == true { Button("Resume") { client.send(CommandFactory.simple("resumeQueue"), label: "Resume queue") } }
                Spacer()
                PhotosPicker(selection: $pickerItem, matching: .images) { Image(systemName: "paperclip") }
                    .disabled(client.status != .open)
                    .onChange(of: pickerItem) { _, item in Task { await attach(item) } }
                Button {
                    if client.snapshot?.session?.isStreaming == true { client.send(CommandFactory.simple("abort"), label: "Abort") }
                    else { let text = draft.trimmingCharacters(in: .whitespacesAndNewlines); guard !text.isEmpty else { return }; client.send(CommandFactory.submit(text: text, queue: queue), label: queue ? "Queue input" : "Submit"); draft = "" }
                } label: {
                    Image(systemName: client.snapshot?.session?.isStreaming == true ? "stop.fill" : "arrow.up")
                        .font(.workbench(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: WorkbenchLayoutMetrics.composerSend, height: WorkbenchLayoutMetrics.composerSend)
                        .background(client.snapshot?.session?.isStreaming == true ? Color(red: 0.84, green: 0.17, blue: 0.35) : AppColors.primary)
                        .clipShape(Circle())
                }
                .disabled(client.status != .open)
                .accessibilityLabel(client.snapshot?.session?.isStreaming == true ? "Stop" : "Send")
                .accessibilityIdentifier("send")
            }
            .font(.workbench(size: 12))
            .foregroundStyle(AppColors.muted)
            .padding(.horizontal, mobile ? 8 : 10)

            if !(client.snapshot?.queue?.items.isEmpty ?? true) { QueueStrip(client: client) }
        }
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(minHeight: mobile ? 120 : WorkbenchLayoutMetrics.composerMinHeight)
        .background(AppColors.composer)
        .clipShape(RoundedRectangle(cornerRadius: WorkbenchLayoutMetrics.composerRadius))
        .overlay(RoundedRectangle(cornerRadius: WorkbenchLayoutMetrics.composerRadius).stroke(AppColors.composerFrame, lineWidth: 1))
        .shadow(color: .black.opacity(0.08), radius: 18, y: 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer-surface")
    }
    private var modelLabel: String { client.snapshot?.session?.model?.label ?? "Model" }

    private func attach(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            let mime = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
            let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
            let image: [String: JSONValue] = [
                "type": .string("image"),
                "id": .string(UUID().uuidString),
                "data": .string(data.base64EncodedString()),
                "mimeType": .string(mime),
                "fileName": .string("ios-attachment.\(ext)"),
                "size": .number(Double(data.count))
            ]
            var command = CommandFactory.simple("addEditorImage")
            command["image"] = .object(image)
            client.send(command, label: "Attach image")
        } catch {
            client.reportError("Could not attach image: \(error.localizedDescription)")
        }
        pickerItem = nil
    }
}

struct QueueStrip: View {
    @ObservedObject var client: WorkspaceClient
    var body: some View {
        ScrollView(.horizontal) { HStack { ForEach(client.snapshot?.queue?.items ?? []) { item in Text(item.text).lineLimit(1).padding(8).background(AppColors.raised).clipShape(Capsule()) } } }
    }
}

private func icon(forSurface surface: WorkspaceSurface) -> String {
    switch surface { case .chat: return "bubble.left.and.bubble.right"; case .flows: return "point.3.connected.trianglepath.dotted"; case .settings: return "gearshape" }
}

private func icon(forPanel panel: DetailPanel) -> String {
    switch panel { case .notifications: return "bell"; case .surfaces: return "rectangle.3.group"; case .diff: return "plus.forwardslash.minus"; case .queue: return "tray.full"; case .triage: return "checklist"; case .receipts: return "receipt" }
}


private extension View {
    func sessionSwipeActions(lifecycle: LifecycleBucket, onOpen: @escaping () -> Void, onSettle: @escaping () -> Void, onSnooze: @escaping () -> Void, onWake: @escaping () -> Void) -> some View {
        self
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button("Open", action: onOpen).tint(.blue)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if lifecycle == .active {
                    Button("Snooze", action: onSnooze).tint(.orange)
                    Button("Settle", action: onSettle).tint(.gray)
                } else {
                    Button("Wake", action: onWake).tint(.green)
                }
            }
            .accessibilityAction(named: "Open", onOpen)
    }
}
