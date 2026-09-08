import XCTest
import Combine
@testable import Heddlework

final class WorkspaceProtocolTests: XCTestCase {
    @MainActor
    func testTerminalFramesDoNotInvalidateWholeWorkspaceClient() {
        let client = WorkspaceClient()
        var clientPublishes = 0
        var framePublishes = 0
        let clientToken = client.objectWillChange.sink { clientPublishes += 1 }
        let frameToken = client.terminalFrames.objectWillChange.sink { framePublishes += 1 }
        defer { clientToken.cancel(); frameToken.cancel() }

        client.terminalFrames.set(RemoteTerminalFrame(id: "term", cols: 80, rows: 24, cursorX: 0, cursorY: 0, cursorVisible: true, title: nil, lines: ["hello"]))

        XCTAssertEqual(clientPublishes, 0)
        XCTAssertEqual(framePublishes, 1)
        XCTAssertEqual(client.terminalFrames["term"]?.lines, ["hello"])
    }

    func testWorkspaceSocketURLAddsWsPathAndToken() throws {
        let url = try XCTUnwrap(workspaceSocketURL(hostURL: "http://10.0.0.5:47311", token: "tok"))
        XCTAssertEqual(url.absoluteString, "ws://10.0.0.5:47311/ws?token=tok")
    }

    func testMergeCandidatesKeepsCurrentFirstAndDeduplicates() {
        XCTAssertEqual(mergeCandidates(current: "http://a/", advertised: ["http://a", "http://b/"]), ["http://a", "http://b"])
    }

    func testPatchRemovedClearsOptionalWireKeys() throws {
        let wire = Data(#"{"version":1,"changed":{"activity":"Ready"},"removed":["dialog","notices"]}"#.utf8)
        let patch = try JSONDecoder().decode(SnapshotPatch.self, from: wire)
        var snapshot = WorkbenchSnapshot()
        snapshot.dialog = ExtensionDialog(id: "d1", method: "input", title: "Name")
        snapshot.notices = [Notice(id: 1, kind: "error", message: "old", createdAt: 10)]
        snapshot.activity = "Working"
        let next = applySnapshotPatch(snapshot, patch: patch)
        XCTAssertNil(next.dialog)
        XCTAssertNil(next.notices)
        XCTAssertEqual(next.activity, "Ready")
    }

    func testInvalidChangedPayloadKeepsModeledFields() throws {
        var snapshot = WorkbenchSnapshot()
        snapshot.messages = [PiMessage(role: "user", content: .string("Hi"), workbenchEntryId: "e1")]
        snapshot.activity = "Ready"
        let wire = Data(#"{"version":1,"changed":{"messages":{"nope":true},"activity":"Working"}}"#.utf8)
        let patch = try JSONDecoder().decode(SnapshotPatch.self, from: wire)
        let next = applySnapshotPatch(snapshot, patch: patch)
        XCTAssertEqual(next.messages?.first?.workbenchEntryId, "e1")
        XCTAssertEqual(next.activity, "Working")
    }

    func testTrimLiveOpDropsPrefixBytes() throws {
        var snapshot = WorkbenchSnapshot()
        snapshot.liveAssistant = LiveAssistant(id: "live", blocks: [LiveBlock(index: 0, kind: "text", text: "abcdef")])
        let wire = Data(#"{"version":1,"changed":{},"liveOps":[{"op":"trim","target":"assistant","id":"live","blockIndex":0,"bytes":2},{"op":"append","target":"assistant","id":"live","blockIndex":0,"text":"gh"}]}"#.utf8)
        let patch = try JSONDecoder().decode(SnapshotPatch.self, from: wire)
        let next = applySnapshotPatch(snapshot, patch: patch)
        XCTAssertEqual(next.liveAssistant?.blocks.first?.text, "cdefgh")
        XCTAssertEqual(next.liveAssistant?.blocks.first?.textOffset, 2)
    }

    func testThreadLifecycleDecodesTitleSourceAndGeneratingAt() throws {
        let data = Data(#"{"settledAt":1,"titleSource":"auto","titleGeneratingAt":123.5,"priority":1}"#.utf8)
        let lifecycle = try JSONDecoder().decode(ThreadLifecycle.self, from: data)
        XCTAssertEqual(lifecycle.titleSource, "auto")
        XCTAssertEqual(lifecycle.titleGeneratingAt, 123.5)
        XCTAssertEqual(lifecycle.priority, 1)
        XCTAssertEqual(lifecycle.settledAt, 1)

        let manual = try JSONDecoder().decode(ThreadLifecycle.self, from: Data(#"{"titleSource":"manual"}"#.utf8))
        XCTAssertEqual(manual.titleSource, "manual")
        XCTAssertNil(manual.titleGeneratingAt)
    }

    func testWorkbenchSnapshotDecodesThreadTitles() throws {
        let data = Data(#"{"threadTitles":{"autoTitles":true,"titleModel":"openai/gpt-4o-mini","instructions":"Be brief"}}"#.utf8)
        let snapshot = try JSONDecoder().decode(WorkbenchSnapshot.self, from: data)
        XCTAssertEqual(snapshot.threadTitles?.autoTitles, true)
        XCTAssertEqual(snapshot.threadTitles?.titleModel, "openai/gpt-4o-mini")
        XCTAssertEqual(snapshot.threadTitles?.instructions, "Be brief")
    }

    func testWorkbenchSnapshotToleratesMissingThreadTitles() throws {
        let data = Data(#"{"activity":"Ready"}"#.utf8)
        let snapshot = try JSONDecoder().decode(WorkbenchSnapshot.self, from: data)
        XCTAssertNil(snapshot.threadTitles)
        XCTAssertEqual(snapshot.activity, "Ready")
    }

    func testPatchChangedCarriesThreadTitles() throws {
        let base: [String: JSONValue] = ["activity": .string("Ready")]
        let wire = Data(#"{"version":1,"changed":{"threadTitles":{"autoTitles":false,"titleModel":"demo/cheap"}}}"#.utf8)
        let patch = try JSONDecoder().decode(SnapshotPatch.self, from: wire)
        let next = mergeSnapshotJSON(base, patch: patch.changed, removing: patch.removed ?? [])
        XCTAssertEqual(next["threadTitles"], .object([
            "autoTitles": .bool(false),
            "titleModel": .string("demo/cheap"),
        ]))
        let snapshot = try XCTUnwrap(decodeSnapshot(WorkbenchSnapshot.self, from: next))
        XCTAssertEqual(snapshot.threadTitles?.autoTitles, false)
        XCTAssertEqual(snapshot.threadTitles?.titleModel, "demo/cheap")
    }

    func testGetTranscriptDetailCommandShape() {
        let command = CommandFactory.getTranscriptDetail(entryId: "entry-9")
        XCTAssertEqual(command["type"], .string("getTranscriptDetail"))
        XCTAssertEqual(command["entryId"], .string("entry-9"))
    }

    func testSameSessionFileAndToolCallIdentity() {
        XCTAssertTrue(sameSessionFile("/tmp/a.jsonl", "/tmp/a.jsonl"))
        XCTAssertTrue(sameSessionFile("/tmp/a.jsonl/", "/tmp/a.jsonl"))
        XCTAssertFalse(sameSessionFile("/tmp/a.jsonl", "/tmp/b.jsonl"))
        var message = PiMessage(role: "toolResult", content: .string("out"), workbenchEntryId: "hist-1")
        message.toolCallId = "call-1"
        XCTAssertTrue(messageMatchesTranscriptEntry(message, entryId: "hist-1"))
        XCTAssertTrue(messageMatchesTranscriptEntry(message, entryId: "call-1"))
        XCTAssertFalse(messageMatchesTranscriptEntry(message, entryId: "other"))
    }

    func testTypedLivePatchDoesNotRebuildUnchangedMessages() throws {
        var snapshot = WorkbenchSnapshot()
        snapshot.messages = [PiMessage(role: "user", content: .string("Hi"), workbenchEntryId: "e1")]
        snapshot.liveAssistant = LiveAssistant(id: "live", blocks: [LiveBlock(index: 0, kind: "text", text: "He")])
        snapshot.activity = "Ready"
        let originalMessages = snapshot.messages
        let wire = Data(#"{"version":1,"changed":{"activity":"Working"},"liveOps":[{"op":"append","target":"assistant","id":"live","blockIndex":0,"text":"llo"}]}"#.utf8)
        let patch = try JSONDecoder().decode(SnapshotPatch.self, from: wire)
        let next = applySnapshotPatch(snapshot, patch: patch)
        XCTAssertEqual(next.messages, originalMessages)
        XCTAssertEqual(next.messages?.first?.workbenchEntryId, "e1")
        XCTAssertEqual(next.liveAssistant?.blocks.first?.text, "Hello")
        XCTAssertEqual(next.activity, "Working")
        XCTAssertNil(patch.changed["messages"])
    }

    func testSetThreadTitleSettingsCommandShape() {
        let command = CommandFactory.setThreadTitleSettings(autoTitles: false, titleModel: "openai/gpt-4o-mini", instructions: "Short")
        XCTAssertEqual(command["type"], .string("setThreadTitleSettings"))
        XCTAssertEqual(command["settings"], .object([
            "autoTitles": .bool(false),
            "titleModel": .string("openai/gpt-4o-mini"),
            "instructions": .string("Short"),
        ]))
        XCTAssertEqual(CommandFactory.withString("regenerateThreadTitle", key: "path", value: "/tmp/a.jsonl")["type"], .string("regenerateThreadTitle"))
    }

    func testNativeQuestionParsesQuizShapeWithoutLeakingAnswers() throws {
        let args = JSONValue.object([
            "question": .string("Let $A=U\\Sigma V^*$ be invertible."),
            "details": .string("This jumps ahead deliberately."),
            "options": .array([
                .object(["label": .string("$b=u_n$"), "value": .string("un")]),
                .object(["label": .string("$b=u_1$"), "value": .string("u1")]),
            ]),
            "correctAnswer": .string("un"),
            "explanation": .string("Do not show this."),
        ])
        let tool = ToolRun(id: "quiz-1", name: "probe", args: args, status: "running", isError: false)
        let question = try XCTUnwrap(NativeQuestion.from(tool: tool))
        XCTAssertEqual(question.requestId, "quiz-1")
        XCTAssertEqual(question.stem, "Let $A=U\\Sigma V^*$ be invertible.")
        XCTAssertEqual(question.description, "This jumps ahead deliberately.")
        XCTAssertEqual(question.options.map(\.value), ["un", "u1"])
        XCTAssertTrue(question.allowUnknown)
        XCTAssertTrue(question.allowNote)
        XCTAssertFalse(question.allowCustom)
        XCTAssertFalse(question.stem.contains("Do not show"))
    }

    func testSubmitAskUserQuestionnaireCommandShape() {
        let command = CommandFactory.submitAskUserQuestionnaire(
            toolCallId: "quiz-1",
            answers: [["kind": .string("option"), "optionIndex": .number(0)]],
            note: "maybe the last singular vector"
        )
        XCTAssertEqual(command["type"], .string("submitAskUserQuestionnaire"))
        XCTAssertEqual(command["toolCallId"], .string("quiz-1"))
        XCTAssertEqual(command["note"], .string("maybe the last singular vector"))
    }
}
