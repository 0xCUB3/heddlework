import Foundation

enum UIFixture {
    static let workspacePath = "/tmp/heddlework-ui-fixture"

    static var snapshot: WorkbenchSnapshot {
        var snapshot = WorkbenchSnapshot()
        snapshot.workspacePath = workspacePath
        snapshot.connection = "connected"
        snapshot.session = SessionState(
            model: PiModel(id: "demo", provider: "demo", name: "Demo"),
            thinkingLevel: "off",
            isStreaming: false,
            sessionName: "Fixture thread",
            sessionId: "fixture-session",
            sessionFile: "/tmp/heddlework-ui-fixture/session.jsonl"
        )
        snapshot.messagesHasOlder = true
        snapshot.messages = history
        snapshot.liveAssistant = nil
        snapshot.liveTools = []
        snapshot.workspaceDiff = WorkspaceDiff(
            status: "ready",
            branch: "main",
            files: [
                WorkspaceDiffFile(
                    path: "src/ui/transcript.tsx",
                    patch: unifiedDiff,
                    additions: 3,
                    deletions: 2
                )
            ],
            additions: 3,
            deletions: 2
        )
        snapshot.models = [PiModel(id: "demo", provider: "demo", name: "Demo")]
        snapshot.thinkingLevels = ["off", "medium"]
        snapshot.editorText = ""
        snapshot.editorImages = []
        snapshot.queue = QueueState(items: [], paused: false)
        snapshot.notices = []
        snapshot.sessions = [
            SessionSummary(path: "/tmp/heddlework-ui-fixture/session.jsonl", name: "Fixture thread", cwd: workspacePath, sessionTitle: "Fixture thread", updatedAt: Date().timeIntervalSince1970 * 1_000, modifiedAt: Date().timeIntervalSince1970 * 1_000, messageCount: history.count)
        ]
        return snapshot
    }

    private static var history: [PiMessage] {
        var messages: [PiMessage] = []
        for index in 0..<18 {
            messages.append(user("Earlier prompt \(index)", timestamp: Double(1_700_000_000_000 + index * 2_000), entry: "early-u-\(index)"))
            messages.append(assistantText("Earlier answer \(index) stays collapsed behind later work.", timestamp: Double(1_700_000_000_500 + index * 2_000), entry: "early-a-\(index)"))
        }
        messages.append(user("Inspect the repo and group the work.", timestamp: 1_700_000_100_000, entry: "u-work"))
        messages.append(PiMessage(
            role: "assistant",
            content: .blocks([
                ContentBlock(type: "thinking", thinking: "I will inspect the workspace, then run a tool."),
                ContentBlock(type: "toolCall", id: "fabric_exec", name: "fabric_exec", arguments: .object(["name": .string("locate-update")]))
            ]),
            timestamp: 1_700_000_101_000,
            workbenchEntryId: "a-work"
        ))
        messages.append(PiMessage(
            role: "toolResult",
            content: .string("{\"ok\":true,\"files\":[\"src/ui/transcript.tsx\"]}"),
            timestamp: 1_700_000_102_000,
            toolCallId: "fabric_exec",
            toolName: "fabric_exec",
            workbenchEntryId: "t-work"
        ))
        messages.append(assistantText("The transcript now groups tool work under a collapsible header. The final answer stays outside.", timestamp: 1_700_000_103_000, entry: "a-final"))
        messages.append(user("Show me the diff next.", timestamp: 1_700_000_200_000, entry: "u-diff"))
        messages.append(assistantText("Open Changes for the compact file header and line diff.", timestamp: 1_700_000_201_000, entry: "a-diff"))
        messages.append(user("Show formatted markdown.", timestamp: 1_700_000_300_000, entry: "u-md"))
        messages.append(assistantText("""
        ### Rendered heading

Paragraph with a [Comment](https://example.com/comment) and commit `abc1234`.

- first item
- second item

Inline math $E=mc^2$ and display:

$$
\\frac{a}{b} = 1
$$
""", timestamp: 1_700_000_301_000, entry: "a-md"))
        return messages
    }

    private static func user(_ text: String, timestamp: Double, entry: String) -> PiMessage {
        PiMessage(role: "user", content: .string(text), timestamp: timestamp, workbenchEntryId: entry)
    }

    private static func assistantText(_ text: String, timestamp: Double, entry: String) -> PiMessage {
        PiMessage(role: "assistant", content: .blocks([ContentBlock(type: "text", text: text)]), timestamp: timestamp, workbenchEntryId: entry)
    }

    private static let unifiedDiff = """
    diff --git a/src/ui/transcript.tsx b/src/ui/transcript.tsx
    --- a/src/ui/transcript.tsx
    +++ b/src/ui/transcript.tsx
    @@ -10,8 +10,9 @@
     import { NativeVirtualList } from './primitives.tsx'
    -const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 120
    +const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 88
     export function Transcript() {
    -  return <div>raw tools</div>
    +  return <NativeVirtualList alignment="bottom" />
     }
    """

    static var terminal: RemoteTerminalSnapshot {
        RemoteTerminalSnapshot(sessions: [
            RemoteTerminalSession(id: "fixture-term", name: "Fixture shell", title: "Fixture shell", cwd: workspacePath, cols: 40, rows: 12, status: "running", exitCode: nil)
        ], activeId: "fixture-term")
    }

    static var terminalFrames: [String: RemoteTerminalFrame] {
        [
            "fixture-term": RemoteTerminalFrame(id: "fixture-term", cols: 40, rows: 12, cursorX: 0, cursorY: 1, cursorVisible: true, title: "Fixture shell", lines: ["ready", "printf hi", "hi"])
        ]
    }
}
