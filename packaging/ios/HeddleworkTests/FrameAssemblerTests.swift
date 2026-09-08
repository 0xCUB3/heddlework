import XCTest
@testable import Heddlework

final class FrameAssemblerTests: XCTestCase {
    func testAssemblesChunkedWelcomeAndRaisesTheSocketLimit() throws {
        XCTAssertGreaterThan(workspaceWebSocketMaximumMessageSize, 1_048_576)
        let payload = Data(String(repeating: "x", count: 400_000).utf8)
        let id = "frame-1"
        let chunk = 12_000
        let parts = stride(from: 0, to: payload.count, by: chunk).map { start -> String in
            let end = min(start + chunk, payload.count)
            return String(data: payload.subdata(in: start..<end), encoding: .utf8)!
        }
        var assembler = FrameAssembler()
        var assembled: Data?
        for (index, part) in parts.enumerated() {
            let frame = try JSONEncoder().encode(TestFrame(kind: "frame", id: id, index: index, count: parts.count, data: part))
            assembled = try assembler.push(frame)
            if index < parts.count - 1 { XCTAssertNil(assembled) }
        }
        XCTAssertEqual(assembled, payload)
    }

    func testNonFramePassesThroughAndInterruptedStreamFails() throws {
        var assembler = FrameAssembler()
        let pong = Data(#"{"kind":"pong"}"#.utf8)
        XCTAssertEqual(try assembler.push(pong), pong)
        let first = try JSONEncoder().encode(TestFrame(kind: "frame", id: "a", index: 0, count: 2, data: "hello"))
        XCTAssertNil(try assembler.push(first))
        XCTAssertThrowsError(try assembler.push(pong))
    }

    func testWireEngineDecodesWelcomeOffTheMainThread() async throws {
        let snapshot: [String: JSONValue] = [
            "workspacePath": .string("/tmp/large"),
            "editorText": .string(String(repeating: "z", count: 80_000)),
            "messages": .array((0..<40).map { index in
                .object([
                    "role": .string(index % 2 == 0 ? "user" : "assistant"),
                    "content": .string(String(repeating: "m", count: 2_000)),
                    "timestamp": .number(Double(index)),
                ])
            }),
        ]
        let envelope = try JSONSerialization.data(withJSONObject: [
            "kind": "welcome",
            "protocol": 2,
            "workspacePath": "/tmp/large",
            "snapshot": snapshot.mapValues(\.any),
        ])
        let engine = WorkspaceWireEngine()
        let decoded = expectation(description: "decoded welcome")
        var onMain = true
        await engine.setPublisher { event in
            if case .welcome(_, let snapshot, _, _, _, _, _, _, let protocolVersion) = event {
                onMain = Thread.isMainThread
                XCTAssertEqual(protocolVersion, 2)
                XCTAssertEqual(snapshot.messages?.count, 40)
                XCTAssertEqual(snapshot.editorText?.count, 80_000)
                decoded.fulfill()
            }
        }
        try await engine.ingest(envelope)
        await fulfillment(of: [decoded], timeout: 5)
        XCTAssertFalse(onMain)
    }

    func testWireEngineAppliesLiveOpsWithoutReplacingMessages() async throws {
        let welcome = try JSONSerialization.data(withJSONObject: [
            "kind": "welcome",
            "protocol": 2,
            "workspacePath": "/tmp/live",
            "snapshot": [
                "workspacePath": "/tmp/live",
                "messages": [["role": "user", "content": "Prompt", "workbenchEntryId": "u1"]],
                "liveAssistant": ["id": "live", "blocks": [["index": 0, "kind": "text", "text": "He"]]],
            ],
        ])
        let patch = Data(#"{"kind":"patch","patch":{"version":1,"changed":{},"liveOps":[{"op":"append","target":"assistant","id":"live","blockIndex":0,"text":"llo"}],"contentRevision":4}}"#.utf8)
        let engine = WorkspaceWireEngine()
        let decoded = expectation(description: "live patch")
        decoded.expectedFulfillmentCount = 1
        await engine.setPublisher { event in
            if case .snapshot(let snapshot, let revision, let rows) = event {
                XCTAssertEqual(snapshot.messages?.count, 1)
                XCTAssertEqual(snapshot.messages?.first?.workbenchEntryId, "u1")
                XCTAssertEqual(snapshot.liveAssistant?.blocks.first?.text, "Hello")
                XCTAssertEqual(revision, 4)
                XCTAssertFalse(rows.isEmpty)
                decoded.fulfill()
            }
        }
        try await engine.ingest(welcome)
        try await engine.ingest(patch)
        await fulfillment(of: [decoded], timeout: 5)
    }
}

private struct TestFrame: Encodable {
    let kind: String
    let id: String
    let index: Int
    let count: Int
    let data: String
}
