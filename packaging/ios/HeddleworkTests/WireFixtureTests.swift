import XCTest
@testable import Heddlework

final class WireFixtureTests: XCTestCase {
    func testParityWelcomeFixtureDecodesActualWireFields() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "parity-welcome", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let envelope = try JSONDecoder().decode(ServerEnvelope.self, from: data)
        XCTAssertEqual(envelope.kind, "welcome")
        XCTAssertEqual(envelope.protocolVersion, 1)
        let raw = try XCTUnwrap(envelope.snapshot)
        let snapshot = try XCTUnwrap(decodeSnapshot(WorkbenchSnapshot.self, from: raw))
        XCTAssertEqual(snapshot.session?.model?.provider, "demo")
        XCTAssertEqual(snapshot.messages?.count, 4)
        XCTAssertEqual(snapshot.messages?.last?.role, "assistant")
        XCTAssertEqual(snapshot.forkMessages?.first?.text, "Queued test item")
        XCTAssertEqual(snapshot.queue?.items.first?.text, "ITEM ONE")
        XCTAssertEqual(snapshot.queue?.items.first?.images.count, 0)
        XCTAssertEqual(snapshot.commands?.first?.name, "settings")
        XCTAssertEqual(snapshot.editorImages?.count, 0)
        XCTAssertEqual(envelope.flows?.schedules.count, 0)
    }
}
