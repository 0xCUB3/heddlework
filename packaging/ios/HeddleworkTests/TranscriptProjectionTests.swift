import XCTest
@testable import Heddlework

final class TranscriptProjectionTests: XCTestCase {
    func testCollapsedWorkMatchesCanonicalHeaderAndFiles() {
        let items: [TimelineItem] = [
            TimelineItem(id: "user", kind: .user, text: "Prompt"),
            TimelineItem(id: "thinking", kind: .thinking, text: "Plan"),
            TimelineItem(id: "read", kind: .tool, tool: ToolRun(id: "read", name: "read", status: "complete", isError: false)),
            TimelineItem(id: "edit", kind: .tool, tool: ToolRun(id: "edit", name: "edit", args: .object(["path": .string("src/a.ts")]), status: "complete", isError: false)),
            TimelineItem(id: "answer", kind: .assistant, text: "Done"),
        ]
        let grouped = TranscriptProjection.groupWorkItems(items)
        XCTAssertEqual(grouped.map(\.kindName), ["user", "work-trace", "assistant"])
        XCTAssertEqual(grouped.map(\.id), ["user", "work-trace-edit", "answer"])
        let rows = TranscriptProjection.projectTranscriptRows(grouped, expandedTraceIds: [], traceLimits: [:])
        XCTAssertEqual(rows.map(\.kind), [.timelineItem, .traceHeader, .traceFiles, .timelineItem])
        XCTAssertEqual(rows.map(\.id), ["user", "work-trace-edit", "work-trace-edit:files", "answer"])
        let trace = grouped[1].workTrace!
        XCTAssertEqual(TranscriptProjection.workTraceLabel(trace, running: false, durationKnown: true), "Worked")
        XCTAssertEqual(trace.changedPaths, ["src/a.ts"])
    }

    func testLiveBoundaryKeepsStableId() {
        let items: [TimelineItem] = [
            TimelineItem(id: "user", kind: .user, text: "Prompt"),
            TimelineItem(id: "live-thinking", kind: .thinking, text: "Planning", streaming: true),
            TimelineItem(id: "live-tool", kind: .tool, tool: ToolRun(id: "live-tool", name: "read", status: "running", isError: false)),
        ]
        let grouped = TranscriptProjection.groupWorkItems(items, isStreaming: true)
        XCTAssertEqual(grouped.first(where: { $0.kindName == "work-trace" })?.id, "work-trace-after-user")
        XCTAssertEqual(TranscriptProjection.liveWorkTraceId(grouped, isStreaming: true), "work-trace-after-user")
    }

    func testFoldsIntermediateAssistantsAndKeepsFinalAnswer() {
        let items: [TimelineItem] = [
            TimelineItem(id: "user", kind: .user, text: "Prompt"),
            TimelineItem(id: "first", kind: .assistant, text: "I will inspect the repo."),
            TimelineItem(id: "read", kind: .tool, tool: ToolRun(id: "read", name: "read", status: "complete", isError: false)),
            TimelineItem(id: "second", kind: .assistant, text: "There is a session-switch path."),
            TimelineItem(id: "grep", kind: .tool, tool: ToolRun(id: "grep", name: "grep", status: "complete", isError: false)),
            TimelineItem(id: "final", kind: .assistant, text: "Here is the answer."),
        ]
        let grouped = TranscriptProjection.groupWorkItems(items)
        XCTAssertEqual(grouped.map(\.kindName), ["user", "work-trace", "assistant"])
        XCTAssertEqual(grouped[1].workTrace?.items.map(\.kind), [.assistant, .tool, .assistant, .tool])
        XCTAssertEqual(grouped.last?.id, "final")
    }

    func testTurnMetricsFoldIntoThatTurnsWorkTrace() {
        let items: [TimelineItem] = [
            TimelineItem(id: "user", kind: .user, text: "Prompt"),
            TimelineItem(id: "read", kind: .tool, tool: ToolRun(id: "read", name: "read", status: "complete", isError: false)),
            TimelineItem(id: "final", kind: .assistant, text: "Here is the answer."),
            TimelineItem(id: "metrics", kind: .contextInjection, text: "TPS 51.4 · TTFT 4.0s", source: "turn metrics"),
            TimelineItem(id: "user2", kind: .user, text: "Next"),
            TimelineItem(id: "metrics2", kind: .contextInjection, text: "TPS 10", source: "turn metrics"),
        ]
        let grouped = TranscriptProjection.groupWorkItems(items)
        XCTAssertEqual(grouped.map(\.kindName), ["user", "work-trace", "assistant", "user", "work-trace"])
        XCTAssertEqual(grouped[1].workTrace?.items.map(\.id), ["read", "metrics"])
        XCTAssertEqual(grouped[4].workTrace?.items.map(\.id), ["metrics2"])
    }

    func testFixtureSnapshotDoesNotDuplicateLiveTools() {
        let rows = TranscriptProjection.projectWorkspace(snapshot: UIFixture.snapshot)
        let kinds = rows.map(\.kind)
        XCTAssertTrue(kinds.contains(.traceHeader))
        XCTAssertEqual(rows.filter { $0.kind == .timelineItem && $0.item?.kind == .assistant }.count, 21)
        XCTAssertFalse(rows.contains { $0.kind == .timelineItem && ($0.item?.text.contains("fabric_exec") == true) })
        let headers = rows.filter { $0.kind == .traceHeader }
        XCTAssertEqual(headers.count, 1)
        XCTAssertEqual(TranscriptProjection.workTraceLabel(headers[0].trace!, running: false, durationKnown: true), "Worked for 1s")
    }

    func testElapsedFormattingMatchesCanonical() {
        XCTAssertEqual(TranscriptProjection.formatElapsedSeconds(1), "1s")
        XCTAssertEqual(TranscriptProjection.formatElapsedSeconds(61), "1m 1s")
        XCTAssertEqual(TranscriptProjection.formatElapsedSeconds(3600), "1h")
        XCTAssertEqual(TranscriptProjection.formatElapsedSeconds(9_360), "2h 36m")
    }

    func testCrossLanguageFixtureFile() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../tests/fixtures/transcript-projection.json")
            .standardizedFileURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("Run bun test tests/transcript-projection-fixtures.test.ts to write the shared fixture")
        }
        let data = try Data(contentsOf: url)
        let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let cases = try XCTUnwrap(payload?["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 4)
        let names = cases.compactMap { $0["name"] as? String }
        XCTAssertEqual(names, [
            "collapsed-work",
            "live-boundary",
            "fold-intermediate-assistants",
            "compaction-standalone",
            "notices-grouped",
            "tool-only",
            "thinking-only",
            "error-tool",
            "abort-status",
            "stream-handoff",
        ])
    }

    func testReuseKeepsUnchangedRowIdentity() {
        let items: [TimelineItem] = [
            TimelineItem(id: "user", kind: .user, text: "Prompt"),
            TimelineItem(id: "answer", kind: .assistant, text: "Done"),
        ]
        let grouped = TranscriptProjection.groupWorkItems(items)
        let first = TranscriptProjection.projectTranscriptRows(grouped, expandedTraceIds: [], traceLimits: [:])
        let second = TranscriptProjection.projectTranscriptRows(grouped, expandedTraceIds: [], traceLimits: [:])
        let reused = TranscriptProjection.reuseRows(first, next: second)
        XCTAssertEqual(reused.map(\.id), first.map(\.id))
        XCTAssertEqual(reused, first)
    }

    func testReuseReplacesOnlyTheChangedLiveRow() {
        let user = TimelineItem(id: "user", kind: .user, text: "Prompt")
        let first = TranscriptProjection.projectTranscriptRows(
            TranscriptProjection.groupWorkItems([user, TimelineItem(id: "live", kind: .assistant, text: "Hel", streaming: true)]),
            expandedTraceIds: [],
            traceLimits: [:]
        )
        let next = TranscriptProjection.projectTranscriptRows(
            TranscriptProjection.groupWorkItems([user, TimelineItem(id: "live", kind: .assistant, text: "Hello", streaming: true)]),
            expandedTraceIds: [],
            traceLimits: [:]
        )
        let reused = TranscriptProjection.reuseRows(first, next: next)
        XCTAssertEqual(reused.first, first.first)
        XCTAssertNotEqual(reused.last?.item?.text, first.last?.item?.text)
    }
}

final class DiffPatchTests: XCTestCase {
    func testParsesUnifiedDiffLinesWithoutWrappingMetadata() {
        let lines = DiffPatch.parse("""
        diff --git a/a.ts b/a.ts
        --- a/a.ts
        +++ b/a.ts
        @@ -1,3 +1,4 @@
         keep
        -old
        +new
         still
        """)
        XCTAssertEqual(lines.map(\.kind), [.fileHeader, .fileHeader, .fileHeader, .hunk, .context, .del, .add, .context])
        XCTAssertEqual(lines.first { $0.kind == .add }?.text, "+new")
        XCTAssertEqual(lines.first { $0.kind == .del }?.text, "-old")
    }
}
