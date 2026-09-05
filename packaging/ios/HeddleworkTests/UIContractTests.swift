import XCTest
@testable import Heddlework

final class UIContractTests: XCTestCase {
    func testDecodesCanonicalLightAndDarkColors() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let url = testFile.deletingLastPathComponent().appendingPathComponent("../../../src/workbench/ui-contract.json").standardizedFileURL
        let data = try Data(contentsOf: url)
        let contract = try JSONDecoder().decode(UIContract.self, from: data)
        XCTAssertEqual(contract.colors?.light.window, "#FDFDFD")
        XCTAssertEqual(contract.colors?.dark.window, "#0A0A0A")
        XCTAssertEqual(contract.surfaces.map(\.id), ["chat", "flows", "settings"])
        XCTAssertEqual(
            contract.settings.map(\.id),
            ["runtime", "interface", "remote-access", "updates", "plugins", "terminal", "browser", "about"]
        )
        XCTAssertEqual(UIContract.fallback.settings.map(\.id), contract.settings.map(\.id))
    }

    func testAttachmentCommandUsesSupportedHostShape() {
        let image: [String: JSONValue] = ["type": .string("image"), "id": .string("i"), "data": .string("AA=="), "mimeType": .string("image/png"), "fileName": .string("x.png"), "size": .number(1)]
        var command = CommandFactory.simple("addEditorImage")
        command["image"] = .object(image)
        XCTAssertEqual(command["type"], .string("addEditorImage"))
        XCTAssertEqual(command["image"], .object(image))
    }

    func testLayoutMetricsMatchCanonicalContract() {
        let contract = UIContract.fallback
        XCTAssertEqual(WorkbenchLayoutMetrics.sidebarWidth(contract), 256)
        XCTAssertEqual(WorkbenchLayoutMetrics.headerHeight(contract), 52)
        XCTAssertEqual(WorkbenchLayoutMetrics.contentMaxWidth(contract), 768)
        XCTAssertEqual(WorkbenchLayoutMetrics.settingsMaxWidth(contract), 720)
        XCTAssertEqual(WorkbenchLayoutMetrics.standardPanelWidth(mainWidth: 1184), 520)
        XCTAssertEqual(WorkbenchLayoutMetrics.composerRadius, 22)
        XCTAssertEqual(WorkbenchLayoutMetrics.composerMinHeight, 148)
        XCTAssertEqual(WorkbenchLayoutMetrics.composerSend, 34)
        XCTAssertEqual(WorkbenchLayoutMetrics.composerContextHeight, 48)
        XCTAssertEqual(WorkbenchLayoutMetrics.sessionCardHeight, 78)
        XCTAssertEqual(WorkbenchLayoutMetrics.sessionCompactHeight, 36)
        XCTAssertEqual(WorkbenchLayoutMetrics.sidebarFooterHeight, 46)
    }

    func testCanonicalPaletteIncludesComposerTokens() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../src/workbench/ui-contract.json").standardizedFileURL
        let contract = try JSONDecoder().decode(UIContract.self, from: try Data(contentsOf: url))
        XCTAssertEqual(contract.colors?.light.composer, "#FFFFFF")
        XCTAssertEqual(contract.colors?.light.contextBar, "#F0F0F2")
        XCTAssertEqual(contract.colors?.light.composerFrame, "#DCDCE1")
        XCTAssertEqual(contract.colors?.light.composerOutline, "#D4D4D9")
        XCTAssertEqual(contract.layout?.sidebarWidth, 256)
    }

    func testSessionSummaryPrefersNameThenTitleWithoutPromptBodies() throws {
        let data = Data(#"{"path":"/session.jsonl","name":"Fix login","cwd":"/workspace","title":"Fallback title","modifiedAt":2,"messageCount":4}"#.utf8)
        let session = try JSONDecoder().decode(SessionSummary.self, from: data)
        XCTAssertEqual(session.title, "Fix login")
        XCTAssertEqual(session.displayTitle, "Fix login")
        XCTAssertEqual(session.modifiedAt, 2)
        XCTAssertEqual(SessionCatalog.projectName(for: session), "workspace")
        XCTAssertEqual(SessionLifecycle.bucket(session: session, lifecycle: nil, now: Date(timeIntervalSince1970: 10)), .active)
    }

    func testWelcomeProtocolVersionIsOnWire() throws {
        let data = Data(#"{"kind":"welcome","protocol":1,"workspacePath":"/w","snapshot":{},"flows":{"schedules":[],"pending":[],"runs":[]}}"#.utf8)
        let envelope = try JSONDecoder().decode(ServerEnvelope.self, from: data)
        XCTAssertEqual(envelope.protocolVersion, 1)
    }
}
