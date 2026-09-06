import Foundation

@MainActor
final class WorkspaceClient: ObservableObject {
    enum Status: String { case connecting, open, closed }

    @Published private(set) var status: Status = .closed
    @Published private(set) var workspacePath = ""
    @Published private(set) var snapshot: WorkbenchSnapshot?
    @Published private(set) var flows: FlowRuntimeSnapshot?
    @Published private(set) var browserIntegrations: BrowserIntegrationSnapshot?
    @Published private(set) var sleepPrevention: SleepPreventionSnapshot?
    @Published private(set) var terminal: RemoteTerminalSnapshot?
    @Published private(set) var terminalFrames: [String: RemoteTerminalFrame] = [:]
    @Published private(set) var lastError: String?
    @Published private(set) var pendingCommands: [Int: String] = [:]
    @Published private(set) var candidates: [String] = []

    private var task: URLSessionWebSocketTask?
    private var url = ""
    private var token = ""
    private var wantOpen = false
    private var reconnectTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var commandId = 0
    private var generation = 0
    private var failures = 0
    private var backoff: UInt64 = 500_000_000
    private let encoder = JSONEncoder()
    private let minBackoff: UInt64 = 500_000_000
    private let maxBackoff: UInt64 = 10_000_000_000

    func connect(_ link: ConnectLink) {
        disconnect(clearState: false)
        url = link.hostURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        token = link.token
        candidates = [url]
        failures = 0
        backoff = minBackoff
        wantOpen = true
        if ProcessInfo.processInfo.environment["HEEDLEWORK_UI_FIXTURE"] == "1" {
            status = .open
            workspacePath = UIFixture.workspacePath
            snapshot = UIFixture.snapshot
            terminal = UIFixture.terminal
            terminalFrames = UIFixture.terminalFrames
            return
        }
        open()
    }

    func disconnect(clearState: Bool = true) {
        generation += 1
        wantOpen = false
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        pendingCommands.removeAll()
        status = .closed
        browserIntegrations = nil
        sleepPrevention = nil
        terminal = nil
        terminalFrames = [:]
        if clearState {
            workspacePath = ""
            snapshot = nil
            flows = nil
            lastError = nil
            WorkspaceSessionMemory.shared.clearHost(url)
        }
    }

    // quiet: true for background traffic (presence heartbeats) the user never initiated, so a reconnect window
    // never produces a modal error for it.
    func send(_ command: [String: JSONValue], label: String, quiet: Bool = false) {
        if ProcessInfo.processInfo.environment["HEEDLEWORK_UI_FIXTURE"] == "1" { return }
        guard status == .open, let task else {
            if !quiet { lastError = "Not connected. Reconnect before using \(label)." }
            return
        }
        commandId += 1
        let id = commandId
        let sendGeneration = generation
        pendingCommands[id] = label
        do {
            let data = try encoder.encode(ClientEnvelope.command(id: id, command: command))
            task.send(.data(data)) { [weak self, weak task] error in
                guard let error else { return }
                Task { @MainActor in
                    guard let self, self.generation == sendGeneration, self.task === task else { return }
                    self.pendingCommands.removeValue(forKey: id)
                    self.lastError = error.localizedDescription
                }
            }
        } catch { pendingCommands.removeValue(forKey: id); lastError = error.localizedDescription }
    }

    func unsupported(_ operation: String) { lastError = "\(operation) is not available in the native iOS workspace yet. Use the desktop reference for this operation." }
    func reportError(_ message: String) { lastError = message }
    func dismissError() { lastError = nil }

    func isCurrent(task: URLSessionWebSocketTask, generation: Int) -> Bool {
        self.task === task && self.generation == generation
    }

    private func open() {
        guard wantOpen, let socketURL = workspaceSocketURL(hostURL: url, token: token) else { return }
        receiveTask?.cancel()
        receiveTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        generation += 1
        let currentGeneration = generation
        status = .connecting
        let nextTask = URLSession.shared.webSocketTask(with: URLRequest(url: socketURL))
        nextTask.maximumMessageSize = workspaceWebSocketMaximumMessageSize
        task = nextTask
        nextTask.resume()
        sendHello(on: nextTask, generation: currentGeneration)
        receiveTask = Task.detached(priority: .userInitiated) { [weak self, weak nextTask] in
            guard let nextTask else { return }
            await Self.receiveLoop(client: self, task: nextTask, generation: currentGeneration)
        }
    }

    private func sendHello(on task: URLSessionWebSocketTask, generation: Int) {
        do {
            let data = try encoder.encode(ClientEnvelope.hello())
            task.send(.data(data)) { [weak self, weak task] error in
                if let error { Task { @MainActor in guard let self, self.generation == generation, self.task === task else { return }; self.lastError = error.localizedDescription } }
            }
        } catch { lastError = error.localizedDescription }
    }

    nonisolated private static func receiveLoop(client: WorkspaceClient?, task: URLSessionWebSocketTask, generation: Int) async {
        var assembler = FrameAssembler()
        let engine = WorkspaceWireEngine()
        await engine.setPublisher { event in
            guard let client else { return }
            await client.apply(event, generation: generation, task: task)
        }
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                guard let client, await MainActor.run(body: { client.isCurrent(task: task, generation: generation) }) else { return }
                guard let payload = try assembler.push(websocketMessageData(message)) else { continue }
                try await engine.ingest(payload)
            } catch {
                guard let client else { return }
                await client.handleCloseIfCurrent(error: error, generation: generation, task: task)
                return
            }
        }
    }

    fileprivate func apply(_ event: WorkspaceWireEvent, generation: Int, task: URLSessionWebSocketTask) {
        guard isCurrent(task: task, generation: generation) else { return }
        switch event {
        case .welcome(let workspacePath, let snapshot, let flows, let browserIntegrations, let sleepPrevention, let terminal, let hostUrls, let protocolVersion):
            guard protocolVersion == 1 else {
                lastError = "Unsupported host protocol \(protocolVersion ?? -1)"
                self.task?.cancel(with: .protocolError, reason: nil)
                return
            }
            self.workspacePath = workspacePath
            self.snapshot = snapshot
            self.flows = flows
            self.browserIntegrations = browserIntegrations
            self.sleepPrevention = sleepPrevention
            self.terminal = terminal
            lastError = nil
            status = .open
            candidates = mergeCandidates(current: url, advertised: hostUrls)
            failures = 0
            backoff = minBackoff
        case .snapshot(let snapshot):
            self.snapshot = snapshot
        case .flows(let flows):
            self.flows = flows
        case .browserIntegrations(let browserIntegrations):
            self.browserIntegrations = browserIntegrations
        case .sleepPrevention(let sleepPrevention):
            self.sleepPrevention = sleepPrevention
        case .terminal(let terminal):
            self.terminal = terminal
            let ids = Set((terminal?.sessions ?? []).map(\.id))
            terminalFrames = terminalFrames.filter { ids.contains($0.key) }
        case .terminalFrame(let frame):
            terminalFrames[frame.id] = frame
        case .result(let id, let ok, let error):
            if let id { pendingCommands.removeValue(forKey: id) }
            if ok == false { lastError = error ?? "Command failed" }
        case .error(let message):
            lastError = message
        case .attention(let event):
            NotificationService.shared.deliver(eventId: event.eventId, title: event.title, body: event.body, sessionPath: event.sessionPath)
        }
    }

    fileprivate func handleCloseIfCurrent(error: Error, generation: Int, task: URLSessionWebSocketTask) {
        guard isCurrent(task: task, generation: generation) else { return }
        handleClose(error: error)
    }

    private func handleClose(error: Error) {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        pendingCommands.removeAll()
        status = .closed
        browserIntegrations = nil
        sleepPrevention = nil
        terminal = nil
        terminalFrames = [:]
        lastError = error.localizedDescription
        failures += 1
        rotateIfStuck()
        scheduleReconnect()
    }

    private func rotateIfStuck() {
        guard failures >= 2, candidates.count > 1 else { return }
        let index = candidates.firstIndex(of: url) ?? 0
        url = candidates[(index + 1) % candidates.count]
        failures = 0
        backoff = minBackoff
    }

    private func scheduleReconnect() {
        guard wantOpen else { return }
        status = .connecting
        let delay = backoff
        let reconnectGeneration = generation
        backoff = min(backoff * 2, maxBackoff)
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: delay) } catch { return }
            await MainActor.run { guard let self, self.wantOpen, self.generation == reconnectGeneration, !Task.isCancelled else { return }; self.open() }
        }
    }
}

enum WorkspaceWireEvent: @unchecked Sendable {
    case welcome(workspacePath: String, snapshot: WorkbenchSnapshot, flows: FlowRuntimeSnapshot?, browserIntegrations: BrowserIntegrationSnapshot?, sleepPrevention: SleepPreventionSnapshot?, terminal: RemoteTerminalSnapshot?, hostUrls: [String]?, protocolVersion: Int?)
    case snapshot(WorkbenchSnapshot)
    case flows(FlowRuntimeSnapshot?)
    case browserIntegrations(BrowserIntegrationSnapshot?)
    case sleepPrevention(SleepPreventionSnapshot?)
    case terminal(RemoteTerminalSnapshot?)
    case terminalFrame(RemoteTerminalFrame)
    case result(id: Int?, ok: Bool?, error: String?)
    case error(String)
    case attention(AttentionEvent)
}

actor WorkspaceWireEngine {
    private var rawSnapshot: [String: JSONValue]?
    private var dirty = false
    private var flushScheduled = false
    private var flushGeneration = 0
    private var publisher: (@Sendable (WorkspaceWireEvent) async -> Void)?

    func setPublisher(_ publisher: @escaping @Sendable (WorkspaceWireEvent) async -> Void) {
        self.publisher = publisher
    }

    func ingest(_ data: Data) async throws {
        let envelope = try JSONDecoder().decode(ServerEnvelope.self, from: data)
        switch envelope.kind {
        case "welcome":
            flushGeneration += 1
            flushScheduled = false
            dirty = false
            guard let rawSnapshot = envelope.snapshot else {
                await publisher?(.error("Welcome message did not include a snapshot"))
                return
            }
            guard let decoded = decodeSnapshot(WorkbenchSnapshot.self, from: rawSnapshot) else {
                await publisher?(.error("Could not decode host workspace snapshot"))
                return
            }
            self.rawSnapshot = rawSnapshot
            await publisher?(.welcome(
                workspacePath: envelope.workspacePath ?? "",
                snapshot: decoded,
                flows: envelope.flows,
                browserIntegrations: envelope.browserIntegrations,
                sleepPrevention: envelope.sleepPrevention,
                terminal: envelope.terminal,
                hostUrls: envelope.hostUrls,
                protocolVersion: envelope.protocolVersion
            ))
        case "patch":
            guard var raw = rawSnapshot, let patch = envelope.patch else { return }
            raw = mergeSnapshotJSON(raw, patch: patch.changed, removing: patch.removed ?? [])
            rawSnapshot = raw
            dirty = true
            scheduleFlush()
        case "browserIntegrations":
            await publisher?(.browserIntegrations(envelope.browserIntegrations))
        case "sleepPrevention":
            await publisher?(.sleepPrevention(envelope.sleepPrevention))
        case "terminal":
            await publisher?(.terminal(envelope.terminal))
        case "terminalFrame":
            if let frame = envelope.terminalFrame { await publisher?(.terminalFrame(frame)) }
        case "flows":
            await publisher?(.flows(envelope.flows))
        case "result":
            await publisher?(.result(id: envelope.id, ok: envelope.ok, error: envelope.error))
        case "error":
            await publisher?(.error(envelope.message ?? "Host error"))
        case "attention":
            if let event = envelope.event { await publisher?(.attention(event)) }
        default:
            break
        }
    }

    private func scheduleFlush() {
        guard !flushScheduled else { return }
        flushScheduled = true
        let generation = flushGeneration
        Task {
            try? await Task.sleep(nanoseconds: workspacePatchPublishNanoseconds)
            await self.flush(generation)
        }
    }

    private func flush(_ generation: Int) async {
        guard generation == flushGeneration else { return }
        flushScheduled = false
        guard dirty else { return }
        dirty = false
        guard let raw = rawSnapshot else { return }
        guard let decoded = decodeSnapshot(WorkbenchSnapshot.self, from: raw) else {
            await publisher?(.error("Could not decode host snapshot patch"))
            return
        }
        await publisher?(.snapshot(decoded))
        if dirty { scheduleFlush() }
    }
}

func workspaceSocketURL(hostURL: String, token: String) -> URL? {
    var value = hostURL
    if value.hasPrefix("http:") { value = "ws:" + value.dropFirst(5) }
    if value.hasPrefix("https:") { value = "wss:" + value.dropFirst(6) }
    if !value.contains("://") { value = "ws://" + value }
    guard var components = URLComponents(string: value) else { return nil }
    let path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    components.path = path.isEmpty ? "/ws" : "/\(path)/ws"
    var items = components.queryItems ?? []
    if !token.isEmpty { items.removeAll { $0.name == "token" }; items.append(URLQueryItem(name: "token", value: token)) }
    components.queryItems = items
    return components.url
}

func mergeCandidates(current: String, advertised: [String]?) -> [String] {
    func clean(_ value: String) -> String { value.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    var seen = Set([clean(current)])
    var result = [clean(current)]
    for candidate in advertised ?? [] { let next = clean(candidate); if !seen.contains(next) { seen.insert(next); result.append(next) } }
    return result
}
