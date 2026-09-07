import XCTest
@testable import Heddlework

final class WorkspaceProtocolTests: XCTestCase {
    func testWorkspaceSocketURLAddsWsPathAndToken() throws {
        let url = try XCTUnwrap(workspaceSocketURL(hostURL: "http://10.0.0.5:47311", token: "tok"))
        XCTAssertEqual(url.absoluteString, "ws://10.0.0.5:47311/ws?token=tok")
    }

    func testMergeCandidatesKeepsCurrentFirstAndDeduplicates() {
        XCTAssertEqual(mergeCandidates(current: "http://a/", advertised: ["http://a", "http://b/"]), ["http://a", "http://b"])
    }

    func testPatchRemovedClearsOptionalWireKeys() throws {
        let base: [String: JSONValue] = [
            "workspacePath": .string("/tmp/project"),
            "dialog": .object(["id": .string("d1"), "method": .string("input"), "title": .string("Name")]),
            "notices": .array([.object(["id": .number(1), "kind": .string("error"), "message": .string("old"), "createdAt": .number(10)])])
        ]
        let wire = Data(#"{"version":1,"changed":{"activity":"Ready"},"removed":["dialog","notices"]}"#.utf8)
        let patch = try JSONDecoder().decode(SnapshotPatch.self, from: wire)
        let next = mergeSnapshotJSON(base, patch: patch.changed, removing: patch.removed ?? [])
        XCTAssertNil(next["dialog"])
        XCTAssertNil(next["notices"])
        XCTAssertEqual(next["activity"], .string("Ready"))
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
}
