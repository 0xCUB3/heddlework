import XCTest
@testable import Heddlework

final class BrowserIntegrationTests: XCTestCase {
    func testDecodesIntegrationBroadcastAndClearedTask() throws {
        let data = Data(#"{"kind":"browserIntegrations","browserIntegrations":{"choices":[{"id":"aside","label":"Aside","available":true,"description":"Account access"}],"selectedId":"aside","profile":"u0","task":{"id":"one","integrationId":"aside","profile":"u0","prompt":"Read example.com","status":"review","output":"","expiresAt":1234},"error":null}}"#.utf8)
        let envelope = try JSONDecoder().decode(ServerEnvelope.self, from: data)
        XCTAssertEqual(envelope.browserIntegrations?.choices.first?.id, "aside")
        XCTAssertEqual(envelope.browserIntegrations?.profile, "u0")
        XCTAssertEqual(envelope.browserIntegrations?.task?.status, "review")
        let cleared = Data(#"{"kind":"browserIntegrations","browserIntegrations":{"choices":[],"selectedId":"builtin","profile":"","task":null,"error":null}}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(ServerEnvelope.self, from: cleared).browserIntegrations?.task)
    }
    func testBrowserApprovalCommandIsBoundToTaskId() throws {
        let command = CommandFactory.withString("approveBrowserTask", key: "id", value: "one")
        let data = try JSONEncoder().encode(ClientEnvelope.command(id: 3, command: command))
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let payload = try XCTUnwrap(envelope["command"] as? [String: String])
        XCTAssertEqual(payload["type"], "approveBrowserTask")
        XCTAssertEqual(payload["id"], "one")
    }
}
