import XCTest

final class WorkbenchParityUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testConnectFormExposesLinkField() throws {
        let app = XCUIApplication()
        app.launchEnvironment["HEEDLEWORK_RESET_CONNECTION"] = "1"
        app.launch()

        let field = connectField(in: app)
        if !field.waitForExistence(timeout: 8) {
            try dumpHierarchy(app, as: "connect-form-missing.txt")
        }
        XCTAssertTrue(field.waitForExistence(timeout: 1), "Expected the connect-link field on a reset launch")
        XCTAssertTrue(app.descendants(matching: .any)["connect-form"].exists || app.staticTexts["Heddlework"].exists)
        XCTAssertTrue(app.buttons["connect-submit"].exists)
        XCTAssertTrue(app.buttons["connect-scan-qr"].exists)
    }

    func testConnectsAndExercisesCoreSurfaces() throws {
        let app = XCUIApplication()
        app.launchEnvironment["HEEDLEWORK_RESET_CONNECTION"] = "1"
        guard let url = seededConnectURL() else {
            throw XCTSkip("CONNECT_URL not seeded; connect form coverage is in testConnectFormExposesLinkField")
        }
        app.launchEnvironment["HEEDLEWORK_CONNECT_URL"] = url
        app.launch()

        let started = Date()
        let composer = firstExisting(in: app, identifiers: ["composer-surface", "composer-wrap", "workspace-root"], timeout: 12)
        if composer == nil {
            try dumpHierarchy(app, as: "composer-missing.txt")
            save(app.screenshot(), as: "composer-missing.png", in: screenshotDirectory("ios-ui"))
        }
        XCTAssertNotNil(composer, "Expected the workbench composer after a seeded connect URL")
        XCTAssertLessThan(Date().timeIntervalSince(started), 8, "Composer should appear without waiting on a huge snapshot decode on the main thread")

        let send = app.descendants(matching: .any)["send"]
        XCTAssertTrue(send.waitForExistence(timeout: 4) || app.buttons["Send"].waitForExistence(timeout: 1))
        let toggleStarted = Date()
        let sidebar = app.descendants(matching: .any)["toggle-left-sidebar"]
        if sidebar.waitForExistence(timeout: 2) {
            sidebar.tap()
        } else if app.buttons["Toggle sidebar"].waitForExistence(timeout: 1) {
            app.buttons["Toggle sidebar"].tap()
        }
        XCTAssertLessThan(Date().timeIntervalSince(toggleStarted), 2, "Sidebar toggle should stay responsive after a large welcome")

        let screenshotDir = screenshotDirectory("ios-ui")
        save(app.screenshot(), as: "iphone-or-device-chat.png", in: screenshotDir)

        let settings = app.buttons["sidebar-settings"]
        if settings.waitForExistence(timeout: 4) {
            settings.tap()
            XCTAssertTrue(app.descendants(matching: .any)["settings-view"].waitForExistence(timeout: 4))
            save(app.screenshot(), as: "settings.png", in: screenshotDir)
            let done = app.buttons["settings-done"]
            if done.waitForExistence(timeout: 2) { done.tap() }
        }

        let field = app.textFields["composer"]
        if field.waitForExistence(timeout: 4) {
            field.tap()
            if app.keyboards.firstMatch.waitForExistence(timeout: 3) {
                field.typeText("Parity ping from XCUITest")
                if send.exists { send.tap() } else { app.buttons["Send"].tap() }
                save(app.screenshot(), as: "after-send.png", in: screenshotDir)
            } else {
                save(app.screenshot(), as: "composer-no-keyboard.png", in: screenshotDir)
            }
        }

        if app.buttons["toggle-diff"].waitForExistence(timeout: 3) {
            app.buttons["toggle-diff"].tap()
            save(app.screenshot(), as: "diff-panel.png", in: screenshotDir)
        }
    }

    private func firstExisting(in app: XCUIApplication, identifiers: [String], timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            for identifier in identifiers {
                let element = app.descendants(matching: .any)[identifier]
                if element.waitForExistence(timeout: 0.2) { return element }
            }
        }
        return nil
    }

    private func connectField(in app: XCUIApplication) -> XCUIElement {
        let identified = app.descendants(matching: .any)["connect-link"]
        if identified.exists { return identified }
        let labeled = app.textFields["connect-link"]
        if labeled.exists { return labeled }
        return app.descendants(matching: .any)["connect-link"]
    }

    private func seededConnectURL() -> String? {
        let url = ProcessInfo.processInfo.environment["CONNECT_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        return url?.isEmpty == false ? url : nil
    }

    private func dumpHierarchy(_ app: XCUIApplication, as name: String) throws {
        try app.debugDescription.write(toFile: "/tmp/heddlework-\(name)", atomically: true, encoding: .utf8)
    }

    private func screenshotDirectory(_ leaf: String) -> URL {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("screenshots", isDirectory: true)
            .appendingPathComponent(leaf, isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func save(_ screenshot: XCUIScreenshot, as name: String, in directory: URL) {
        try? screenshot.pngRepresentation.write(to: directory.appendingPathComponent(name))
    }
}
