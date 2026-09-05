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
}
