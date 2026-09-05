import Foundation

struct WorkbenchSnapshot: Decodable, Equatable {
    var workspacePath: String?
    var connection: String?
    var connectionMessage: String?
    var session: SessionState?
    var models: [PiModel]?
    var thinkingLevels: [String]?
    var messages: [PiMessage]?
    var messagesHasOlder: Bool?
    var messagesLoadingEarlier: Bool?
    var forkMessages: [PiForkMessage]?
    var sessions: [SessionSummary]?
    var sessionsLoading: Bool?
    var sessionsHasMore: Bool?
    var liveAssistant: LiveAssistant?
    var liveTools: [ToolRun]?
    var activity: String?
    var queue: QueueState?
    var stats: SessionStats?
    var notices: [Notice]?
    var threadLifecycle: [String: ThreadLifecycle]?
    var workspaceDiff: WorkspaceDiff?
    var statusItems: [String: String]?
    var widgets: [String: ExtensionWidget]?
    var dialog: ExtensionDialog?
    var dialogQueue: [ExtensionDialog]?
    var commands: [SlashCommand]?
    var uiRequest: WorkbenchUiRequest?
    var questionnaireSubmitting: String?
    var questionnaireCollapsed: String?
    var editorText: String?
    var editorImages: [SnapshotComposerImage]?
    var receipts: [MutationReceipt]?
    var windowTitle: String?
}

struct SessionState: Decodable, Equatable {
    var model: PiModel?
    var thinkingLevel: String?
    var isStreaming: Bool?
    var isCompacting: Bool?
    var steeringMode: String?
    var followUpMode: String?
    var sessionName: String?
    var sessionId: String?
    var sessionFile: String?
}

struct PiModel: Decodable, Equatable, Identifiable, Hashable { var id: String; var provider: String; var name: String?; var reasoning: Bool?; var label: String { name?.isEmpty == false ? name! : id }; var key: String { "\(provider)/\(id)" } }

struct PiMessage: Decodable, Equatable, Identifiable {
    var role: String; var content: MessageContent?; var customType: String?; var display: Bool?; var timestamp: Double?; var toolCallId: String?; var toolName: String?; var isError: Bool?; var command: String?; var output: String?; var exitCode: Int?
    var id: String { "\(timestamp ?? 0)-\(role)-\(toolCallId ?? String(contentText.prefix(20)))" }
    var contentText: String { content?.text ?? output ?? command ?? "" }
}

struct PiForkMessage: Decodable, Equatable, Identifiable { var entryId: String; var text: String; var id: String { entryId } }

enum MessageContent: Decodable, Equatable {
    case string(String), blocks([ContentBlock])
    init(from decoder: Decoder) throws { let c = try decoder.singleValueContainer(); if let s = try? c.decode(String.self) { self = .string(s) } else { self = .blocks((try? c.decode([ContentBlock].self)) ?? []) } }
    var text: String { switch self { case .string(let s): return s; case .blocks(let b): return b.map(\.textValue).filter { !$0.isEmpty }.joined(separator: "\n") } }
    var blocks: [ContentBlock] { switch self { case .string(let s): return [ContentBlock(type: "text", text: s, thinking: nil, id: nil, name: nil, arguments: nil)]; case .blocks(let b): return b } }
}

struct ContentBlock: Decodable, Equatable, Identifiable { var type: String?; var text: String?; var thinking: String?; var id: String?; var name: String?; var arguments: JSONValue?; var stableId: String { id ?? UUID().uuidString }; var textValue: String { text ?? thinking ?? name ?? "" } }
struct LiveAssistant: Decodable, Equatable, Identifiable { var id: String; var blocks: [LiveBlock] }
struct LiveBlock: Decodable, Equatable, Identifiable { var index: Int; var kind: String; var text: String; var id: Int { index } }
struct ToolRun: Decodable, Equatable, Identifiable { var id: String; var name: String; var args: JSONValue?; var argsText: String?; var output: String?; var details: JSONValue?; var status: String; var isError: Bool }
struct SessionSummary: Decodable, Equatable, Identifiable {
    var path: String
    var name: String?
    var cwd: String?
    var sessionTitle: String?
    var updatedAt: Double?
    var modifiedAt: Double?
    var messageCount: Int?
    var id: String { path }
    var title: String {
        if let name, !name.isEmpty { return name }
        if let sessionTitle, !sessionTitle.isEmpty { return sessionTitle }
        return URL(fileURLWithPath: path).lastPathComponent
    }
    var displayTitle: String { title }
    enum CodingKeys: String, CodingKey {
        case path, name, cwd, updatedAt, modifiedAt, messageCount
        case sessionTitle = "title"
    }
}

struct QueueState: Decodable, Equatable { var items: [QueuedInput]; var steering: [String]?; var followUp: [String]?; var paused: Bool; var pauseReason: String?; var dispatchingId: String?; var blockingActivity: String?; var blockingNote: String? }
struct QueuedInput: Decodable, Equatable, Identifiable { var id: String; var text: String; var images: [SnapshotComposerImage]; var createdAt: Double; var lane: String?; var paused: Bool?; var flow: FlowQueueMetadata? }
struct FlowQueueMetadata: Decodable, Equatable { var runId: String; var taskId: String; var title: String; var mode: String; var source: String; var scheduleId: String?; var taskIndex: Int; var taskCount: Int; var phase: String; var specId: String?; var dependsOn: [String]?; var lane: String?; var lanePath: String?; var attempt: Int?; var retries: Int? }

struct SnapshotComposerImage: Decodable, Equatable, Identifiable {
    var id: String; var type: String; var mimeType: String; var fileName: String; var size: Double; var data: SnapshotImageData
    var omittedDescription: String? { if case .omitted(let bytes) = data { return "omitted, \(bytes) bytes" }; return nil }
}

enum SnapshotImageData: Decodable, Equatable {
    case string(String), omitted(Int)
    init(from decoder: Decoder) throws { let c = try decoder.singleValueContainer(); if let s = try? c.decode(String.self) { self = .string(s) } else { let o = try c.decode(OmittedImageData.self); self = .omitted(o.bytes) } }
}
struct OmittedImageData: Decodable, Equatable { var omitted: Bool; var bytes: Int }

struct Notice: Decodable, Equatable, Identifiable { var id: Int; var kind: String; var message: String; var createdAt: Double }
struct ThreadLifecycle: Decodable, Equatable { var settledAt: Double?; var snoozedUntil: Double?; var unsettledAt: Double?; var readAt: Double?; var priority: Int?; var labels: [String]? }
struct SlashCommand: Decodable, Equatable, Identifiable { var name: String; var description: String?; var argumentHint: String?; var source: String; var id: String { name } }
struct WorkbenchUiRequest: Decodable, Equatable { var id: Int; var kind: String; var text: String? }

struct WorkspaceDiff: Decodable, Equatable { var status: String; var branch: String; var files: [WorkspaceDiffFile]; var additions: Int; var deletions: Int; var error: String? }
struct WorkspaceDiffFile: Decodable, Equatable, Identifiable { var path: String; var patch: String; var additions: Int; var deletions: Int; var id: String { path } }
struct ExtensionWidget: Decodable, Equatable, Identifiable { var key: String; var lines: [String]; var placement: String; var id: String { key } }
struct ExtensionDialog: Decodable, Equatable, Identifiable { var id: String; var method: String; var title: String; var message: String?; var options: [String]?; var placeholder: String?; var prefill: String? }
struct SessionStats: Decodable, Equatable { var userMessages: Int?; var assistantMessages: Int?; var toolCalls: Int?; var toolResults: Int?; var totalMessages: Int?; var cost: Double? }

struct MutationReceipt: Decodable, Equatable, Identifiable { var id: String; var sessionPath: String; var turn: Int; var startedAt: Double; var completedAt: Double; var files: [ReceiptFile]; var tools: [ReceiptToolCount]; var commit: String? }
struct ReceiptFile: Decodable, Equatable, Identifiable { var path: String; var status: String; var additions: Int; var deletions: Int; var patch: String?; var truncated: Bool?; var id: String { path } }
struct ReceiptToolCount: Decodable, Equatable, Identifiable { var name: String; var count: Int; var id: String { name } }

struct FlowRuntimeSnapshot: Decodable, Equatable { var schedules: [FlowSchedule]; var pending: [FlowLaunch]; var runs: [FlowRun]; var lastError: String? }
struct FlowSchedule: Decodable, Equatable, Identifiable { var id: String; var title: String; var prompts: [String]; var mode: String; var model: String?; var workspacePath: String; var timing: JSONValue; var enabled: Bool; var createdAt: Double; var updatedAt: Double; var nextRunAt: Double?; var lastRunAt: Double? }
struct FlowLaunch: Decodable, Equatable, Identifiable { var id: String; var title: String; var prompts: [String]; var mode: String; var model: String?; var workspacePath: String?; var source: String?; var createdAt: Double? }
struct FlowRun: Decodable, Equatable, Identifiable { var launch: FlowLaunch; var workspacePath: String; var tasks: [FlowTask]; var id: String { launch.id } }
struct FlowTask: Decodable, Equatable, Identifiable { var specId: String; var taskId: String; var index: Int; var attempt: Int; var status: String; var laneId: String?; var laneBranch: String?; var laneMerged: Bool?; var id: String { taskId } }
