import SwiftUI
import UIKit

struct TranscriptView: View {
    let snapshot: WorkbenchSnapshot?
    @ObservedObject var client: WorkspaceClient
    var mobile = false
    @State private var expandedTraceIds: Set<String> = []
    @State private var followTail = true
    @State private var sessionKey = ""
    @State private var restoringAnchor: String?
    @State private var pendingBottomMinY: CGFloat = 0
    @State private var pendingViewportMaxY: CGFloat = 0

    @State private var cachedRows: [TranscriptProjectionRow] = []
    @State private var cachedProjectionKey = ""

    private var rows: [TranscriptProjectionRow] { cachedRows }

    private var projectionKey: String {
        let lastLive = snapshot?.liveAssistant?.blocks.last?.text.count ?? 0
        let tools = snapshot?.liveTools?.map { "\($0.id):\($0.status)" }.joined(separator: ",") ?? ""
        let expanded = expandedTraceIds.sorted().joined(separator: ",")
        return "\(currentSessionKey)|\(snapshot?.messages?.count ?? 0)|\(lastLive)|\(tools)|\(snapshot?.session?.isStreaming == true ? "1" : "0")|\(expanded)"
    }

    private func refreshRows() {
        let key = projectionKey
        guard key != cachedProjectionKey || cachedRows.isEmpty else { return }
        cachedProjectionKey = key
        let next = snapshot.map { TranscriptProjection.projectWorkspace(snapshot: $0, expandedTraceIds: expandedTraceIds) } ?? []
        cachedRows = TranscriptProjection.reuseRows(cachedRows, next: next)
    }

    private var currentSessionKey: String {
        snapshot?.session?.sessionFile ?? snapshot?.session?.sessionId ?? snapshot?.workspacePath ?? ""
    }

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    LazyVStack(alignment: .center, spacing: mobile ? 10 : 12) {
                        if snapshot?.messagesHasOlder == true {
                            Button("Load earlier messages") { client.send(CommandFactory.simple("loadEarlierMessages"), label: "Load earlier messages") }
                                .font(.workbench(size: 12, weight: .medium))
                                .foregroundStyle(AppColors.primary)
                                .accessibilityIdentifier("load-earlier")
                        }
                        ForEach(rows) { row in
                            TranscriptRowView(row: row, expanded: expandedTraceIds.contains(traceId(of: row)), mobile: mobile, onToggle: { toggle(traceId(of: row)) }, onOpenDiff: openDiff)
                                .equatable()
                                .frame(maxWidth: WorkbenchLayoutMetrics.fallbackContentMax)
                                .frame(maxWidth: .infinity)
                                .id(row.id)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                            .background(
                                GeometryReader { geo in
                                    Color.clear.preference(
                                        key: TranscriptBottomPreference.self,
                                        value: geo.frame(in: .global).minY
                                    )
                                }
                            )
                    }
                    .padding(.horizontal, mobile ? 10 : 20)
                    .padding(.vertical, mobile ? 14 : 20)
                }
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(key: TranscriptViewportPreference.self, value: geo.frame(in: .global).maxY)
                    }
                )
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onPreferenceChange(TranscriptBottomPreference.self) { minY in
                    pendingBottomMinY = minY
                    applyFollowTailFromScroll()
                }
                .onPreferenceChange(TranscriptViewportPreference.self) { maxY in
                    pendingViewportMaxY = maxY
                    applyFollowTailFromScroll()
                }
                .accessibilityIdentifier("transcript-list")

                if !followTail {
                    Button {
                        followTail = true
                        proxy.scrollTo("bottom", anchor: .bottom)
                    } label: {
                        Label("Jump to latest", systemImage: "arrow.down")
                            .font(.workbench(size: 12, weight: .medium))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(AppColors.raised)
                            .clipShape(Capsule())
                    }
                    .padding(.trailing, 16)
                    .padding(.bottom, 12)
                    .accessibilityIdentifier("jump-to-latest")
                }
            }
            .onAppear {
                restoreChrome()
                refreshRows()
                if followTail { scrollToLatest(proxy) }
                else if let restoringAnchor { DispatchQueue.main.async { proxy.scrollTo(restoringAnchor, anchor: .top) } }
            }
            .onChange(of: projectionKey) { _, _ in
                refreshRows()
            }
            .onChange(of: currentSessionKey) { _, _ in
                persistChrome()
                restoreChrome()
                cachedRows = []
                cachedProjectionKey = ""
                refreshRows()
                if followTail { scrollToLatest(proxy) }
                else if let restoringAnchor { DispatchQueue.main.async { proxy.scrollTo(restoringAnchor, anchor: .top) } }
            }
            .onChange(of: tailSignature) { _, _ in
                refreshRows()
                if followTail { scrollToLatest(proxy) }
            }
            .onChange(of: followTail) { _, _ in persistChrome() }
            .onChange(of: expandedTraceIds) { _, _ in persistChrome() }
        }
    }

    private var tailSignature: String {
        let last = rows.last?.id ?? ""
        let tools = snapshot?.liveTools?.last?.id ?? ""
        let streaming = snapshot?.session?.isStreaming == true ? "1" : "0"
        return "\(currentSessionKey)|\(rows.count)|\(last)|\(tools)|\(streaming)"
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        sessionKey = currentSessionKey
        followTail = true
        restoringAnchor = nil
        DispatchQueue.main.async { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    private var memoryHost: String { client.candidates.first ?? "" }
    private var memorySession: String { currentSessionKey }

    private func restoreChrome() {
        let chrome = WorkspaceSessionMemory.shared.chrome(host: memoryHost, session: memorySession)
        followTail = chrome.followTail
        expandedTraceIds = Set(chrome.expandedTraceIds)
        restoringAnchor = chrome.followTail ? nil : chrome.lastReadMessageId
        sessionKey = currentSessionKey
    }

    private func applyFollowTailFromScroll() {
        guard pendingViewportMaxY > 0 else { return }
        let distance = pendingBottomMinY - pendingViewportMaxY
        if distance < 48 { followTail = true }
        else if distance > 96 { followTail = false }
    }

    private func persistChrome() {
        WorkspaceSessionMemory.shared.update(host: memoryHost, session: memorySession) { chrome in
            chrome.followTail = followTail
            chrome.expandedTraceIds = Array(expandedTraceIds)
            chrome.lastReadMessageId = rows.last(where: { $0.kind == .timelineItem })?.id
        }
    }

    private func toggle(_ id: String) {
        guard !id.isEmpty else { return }
        if expandedTraceIds.contains(id) { expandedTraceIds.remove(id) }
        else { expandedTraceIds.insert(id) }
    }

    private func traceId(of row: TranscriptProjectionRow) -> String {
        if row.kind == .traceHeader { return row.trace?.id ?? row.id }
        return row.traceId ?? row.id
    }

    private func openDiff() {
        client.send(CommandFactory.simple("refreshWorkspaceDiff"), label: "Refresh changes")
    }
}

struct TranscriptRowView: View, Equatable {
    let row: TranscriptProjectionRow
    let expanded: Bool
    var mobile = false
    var onToggle: () -> Void
    var onOpenDiff: () -> Void

    static func == (lhs: TranscriptRowView, rhs: TranscriptRowView) -> Bool {
        lhs.row == rhs.row && lhs.expanded == rhs.expanded && lhs.mobile == rhs.mobile
    }

    var body: some View {
        switch row.kind {
        case .timelineItem:
            if let item = row.item { TimelineLeafView(item: item, mobile: mobile) }
        case .traceHeader:
            if let trace = row.trace {
                WorkTraceHeaderView(trace: trace, expanded: expanded, onToggle: onToggle)
            }
        case .traceEntry:
            if let item = row.item { TraceEntryView(item: item) }
        case .traceNotices:
            VStack(alignment: .leading, spacing: 6) {
                ForEach(row.notices, id: \.id) { notice in
                    Text(notice.notice?.message ?? notice.text)
                        .font(.workbench(size: 11))
                        .foregroundStyle(AppColors.muted)
                }
            }
            .padding(.leading, 18)
        case .traceFiles:
            Button(action: onOpenDiff) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(row.paths.count) changed \(row.paths.count == 1 ? "file" : "files")")
                        .font(.workbench(size: 11, weight: .semibold))
                    ForEach(row.paths, id: \.self) { path in
                        Text(path).font(.workbench(size: 10, design: .monospaced)).foregroundStyle(AppColors.muted).lineLimit(1)
                    }
                }
            }
            .padding(.leading, 18)
            .accessibilityIdentifier("changed-files")
        case .traceContinuation:
            Text("Preparing \(row.remaining) more \(row.remaining == 1 ? "entry" : "entries")…")
                .font(.workbench(size: 10, design: .monospaced))
                .foregroundStyle(AppColors.textFaint)
                .padding(.leading, 18)
        }
    }
}

struct TimelineLeafView: View {
    let item: TimelineItem
    var mobile = false

    var body: some View {
        switch item.kind {
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                RichMarkdownView(source: displayText(item.text), streaming: item.streaming, style: .body)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 10)
                    .background(AppColors.raised)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, mobile ? 28 : 64)
            .accessibilityIdentifier("user-message")
        case .assistant:
            RichMarkdownView(source: displayText(item.text), streaming: item.streaming, style: .body)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("assistant-message")
        case .status:
            Text(displayText(item.text))
                .font(.workbench(size: 12))
                .foregroundStyle(item.tone == "error" ? AppColors.error : AppColors.muted)
        default:
            EmptyView()
        }
    }
}

struct WorkTraceHeaderView: View {
    let trace: WorkTrace
    let expanded: Bool
    var onToggle: () -> Void

    private var running: Bool {
        trace.items.isEmpty || trace.items.contains(where: TranscriptProjection.isActiveTraceEntry)
    }

    private var label: String {
        TranscriptProjection.workTraceLabel(trace, running: running, durationKnown: true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onToggle) {
                HStack(spacing: 7) {
                    Text(label)
                        .font(.workbench(size: 13))
                        .foregroundStyle(AppColors.muted)
                    Image(systemName: "chevron.right")
                        .font(.workbench(size: 10, weight: .semibold))
                        .foregroundStyle(AppColors.textFaint)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
            }
            .accessibilityIdentifier("execution-trace-label")
            .accessibilityValue(label)
            .accessibilityAddTraits(.isButton)

            if !expanded && running {
                let wave = TranscriptProjection.currentWorkWave(trace.items)
                ForEach(Array(wave.tools.suffix(8).enumerated()), id: \.element.id) { _, item in
                    HStack(spacing: 7) {
                        Text(item.tool?.isError == true ? "×" : item.tool?.status == "complete" ? "›" : "•")
                            .foregroundStyle(item.tool?.isError == true ? AppColors.error : AppColors.textFaint)
                        Text(item.tool?.name ?? "tool")
                            .font(.workbench(size: 10, design: .monospaced))
                            .foregroundStyle(AppColors.textFaint)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct TraceEntryView: View {
    let item: TimelineItem
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if item.kind == .thinking {
                DisclosureGroup("Thinking") {
                    Text(displayText(item.text)).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                }
                .font(.workbench(size: 12))
                .foregroundStyle(AppColors.muted)
            } else if item.kind == .tool, let tool = item.tool {
                DisclosureGroup {
                    Text(displayText(tool.output ?? tool.argsText ?? pretty(tool.args) ?? "No output yet"))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                    Button(copied ? "Copied" : "Copy") {
                        UIPasteboard.general.string = tool.output ?? tool.argsText ?? pretty(tool.args) ?? ""
                        copied = true
                    }
                    .font(.workbench(size: 11, weight: .medium))
                } label: {
                    HStack {
                        Text("\(tool.name) · \(tool.status)\(tool.isError ? " · error" : "")")
                        Spacer()
                    }
                }
                .font(.workbench(size: 12))
                .foregroundStyle(tool.isError ? AppColors.error : AppColors.muted)
            } else if item.kind == .assistant || item.kind == .contextInjection || item.kind == .compaction {
                Text(displayText(item.text))
                    .font(.workbench(size: 12))
                    .foregroundStyle(AppColors.muted)
                    .textSelection(.enabled)
            }
        }
        .padding(.leading, 18)
        .overlay(alignment: .leading) { Rectangle().fill(AppColors.borderStrong).frame(width: 1) }
    }

    private func pretty(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: value.any, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return nil }
        return text
    }
}

func displayText(_ text: String, limit: Int = 8_192) -> String {
    if text.count <= limit { return text }
    return String(text.prefix(limit)) + "\n…"
}


private struct TranscriptBottomPreference: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct TranscriptViewportPreference: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
