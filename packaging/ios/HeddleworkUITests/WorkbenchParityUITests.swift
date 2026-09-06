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

    func testFixtureTranscriptGroupsWorkAndOpensAtLatest() throws {
        let app = XCUIApplication()
        app.launchEnvironment["HEEDLEWORK_RESET_CONNECTION"] = "1"
        app.launchEnvironment["HEEDLEWORK_UI_FIXTURE"] = "1"
        app.launchEnvironment["HEEDLEWORK_CONNECT_URL"] = "http://127.0.0.1:47311/?token=fixture"
        app.launch()

        let transcript = app.descendants(matching: .any)["transcript-list"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 6), "Fixture workspace should show the transcript")
        let work = app.descendants(matching: .any)["execution-trace-label"]
        XCTAssertTrue(work.waitForExistence(timeout: 4), "Work should collapse under a Worked/Working header")
        let workText = [work.label, work.value as? String, work.debugDescription].compactMap { $0 }.joined(separator: " ")
        XCTAssertTrue(workText.contains("Worked"), "Collapsed work header should say Worked, got \(workText)")
        XCTAssertFalse(app.staticTexts["fabric_exec"].exists, "Raw tool names must not appear as top-level transcript rows")
        XCTAssertTrue(app.staticTexts["Rendered heading"].waitForExistence(timeout: 3), "Opening a chat should keep the latest formatted answer in view")
        XCTAssertFalse(app.staticTexts["### Rendered heading"].exists, "Headings must render, not show raw markdown tokens")
        XCTAssertFalse(app.staticTexts["[Comment](https://example.com/comment)"].exists, "Links must render, not show raw markdown")
        XCTAssertTrue(app.descendants(matching: .any)["rich-markdown"].waitForExistence(timeout: 2) || app.staticTexts["Rendered heading"].exists)

        let screenshotDir = screenshotDirectory("ios-ui")
        save(app.screenshot(), as: "fixture-grouped-transcript.png", in: screenshotDir)

        if work.exists { work.tap() }
        save(app.screenshot(), as: "fixture-expanded-work.png", in: screenshotDir)

        let diff = app.buttons["toggle-diff"]
        if diff.waitForExistence(timeout: 2) {
            diff.tap()
            XCTAssertTrue(app.descendants(matching: .any)["diff-panel"].waitForExistence(timeout: 3))
            let header = app.descendants(matching: .any)["diff-file-header"]
            if header.waitForExistence(timeout: 2) { header.tap() }
            XCTAssertTrue(app.descendants(matching: .any)["diff-line"].waitForExistence(timeout: 2))
            save(app.screenshot(), as: "fixture-diff-lines.png", in: screenshotDir)
        }
    }

    func testHostTranscriptOpensAtLatestAndSwitchesSessions() throws {
        let app = XCUIApplication()
        app.launchEnvironment["HEEDLEWORK_RESET_CONNECTION"] = "1"
        guard let url = seededConnectURL() else {
            throw XCTSkip("CONNECT_URL not seeded; host-backed coverage needs the long-session fixture host")
        }
        app.launchEnvironment["HEEDLEWORK_CONNECT_URL"] = url
        let started = Date()
        app.launch()

        let transcript = app.descendants(matching: .any)["transcript-list"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 12), "Host workspace should show the transcript")
        XCTAssertLessThan(Date().timeIntervalSince(started), 8, "Latest transcript should be visible without a huge main-thread decode")

        let screenshotDir = screenshotDirectory("ios-ui")
        save(app.screenshot(), as: "host-alpha-open.png", in: screenshotDir)

        let alphaLatest = app.staticTexts["LATEST_ALPHA_ANSWER stays at the tail of the long thread."]
        let betaLatest = app.staticTexts["LATEST_BETA_ANSWER is the newest reply in the other thread."]
        let openedAlpha = alphaLatest.waitForExistence(timeout: 6)
        let openedBeta = !openedAlpha && betaLatest.waitForExistence(timeout: 2)
        XCTAssertTrue(openedAlpha || openedBeta, "Opening a host session should keep the latest assistant answer in view")
        if openedAlpha {
            XCTAssertTrue(app.descendants(matching: .any)["execution-trace-label"].waitForExistence(timeout: 4), "Host work should collapse under Worked/Working")
            XCTAssertFalse(app.staticTexts["edit-1"].exists, "Raw tool ids must not appear as top-level transcript rows")
        }
        save(app.screenshot(), as: "host-alpha-latest.png", in: screenshotDir)

        let currentLatest = openedAlpha ? alphaLatest : betaLatest
        if app.descendants(matching: .any)["load-earlier"].waitForExistence(timeout: 2) {
            app.descendants(matching: .any)["load-earlier"].tap()
            XCTAssertTrue(currentLatest.waitForExistence(timeout: 4), "Loading earlier messages must not yank the latest answer")
        }

        let sidebar = app.descendants(matching: .any)["toggle-left-sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 3), "Compact workbench should expose the sidebar toggle")
        sidebar.tap()
        let otherTitle = openedAlpha ? "Beta fixture thread" : "Alpha fixture thread"
        let other = app.staticTexts[otherTitle]
        XCTAssertTrue(other.waitForExistence(timeout: 6), "Host catalog should list the other fixture thread")
        other.tap()
        let switched = openedAlpha ? betaLatest : alphaLatest
        XCTAssertTrue(switched.waitForExistence(timeout: 8), "Switching sessions should open at the latest reply")
        save(app.screenshot(), as: "host-beta-latest.png", in: screenshotDir)
    }


    func testFixtureRendersMarkdownAndOpensTerminal() throws {
        let app = XCUIApplication()
        app.launchEnvironment["HEEDLEWORK_RESET_CONNECTION"] = "1"
        app.launchEnvironment["HEEDLEWORK_UI_FIXTURE"] = "1"
        app.launchEnvironment["HEEDLEWORK_CONNECT_URL"] = "http://127.0.0.1:47311/?token=fixture"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["transcript-list"].waitForExistence(timeout: 6))
        XCTAssertTrue(app.staticTexts["Rendered heading"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.staticTexts["### Rendered heading"].exists)
        let screenshotDir = screenshotDirectory("ios-ui")
        save(app.screenshot(), as: "fixture-markdown.png", in: screenshotDir)

        let terminal = app.buttons["toggle-terminal"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 3), "Terminal control should be available")
        terminal.tap()
        XCTAssertTrue(app.descendants(matching: .any)["terminal-panel"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts["hi"].waitForExistence(timeout: 3) || app.descendants(matching: .any)["terminal-screen"].exists)
        save(app.screenshot(), as: "fixture-terminal.png", in: screenshotDir)
        if app.buttons["terminal-close"].waitForExistence(timeout: 2) { app.buttons["terminal-close"].tap() }
    }

    func testFixtureSessionSwipeRevealsActions() throws {
        let app = XCUIApplication()
        app.launchEnvironment["HEEDLEWORK_RESET_CONNECTION"] = "1"
        app.launchEnvironment["HEEDLEWORK_UI_FIXTURE"] = "1"
        app.launchEnvironment["HEEDLEWORK_CONNECT_URL"] = "http://127.0.0.1:47311/?token=fixture"
        app.launch()

        let sidebar = app.descendants(matching: .any)["toggle-left-sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 6))
        sidebar.tap()
        let screenshotDir = screenshotDirectory("ios-ui")
        let identified = app.descendants(matching: .any)["sidebar-session-card-active"].firstMatch
        let titled = app.staticTexts["Fixture thread"].firstMatch
        let cell = app.cells.firstMatch
        let row = identified.exists ? identified : (titled.exists ? titled : cell)
        if !identified.waitForExistence(timeout: 3) && !titled.waitForExistence(timeout: 2) {
            try dumpHierarchy(app, as: "session-swipe-missing.txt")
            save(app.screenshot(), as: "fixture-session-swipe-missing.png", in: screenshotDir)
        }
        XCTAssertTrue(row.waitForExistence(timeout: 2), "Active session row should exist for swipe")
        row.swipeLeft()
        save(app.screenshot(), as: "fixture-session-swipe.png", in: screenshotDir)
        let settle = app.buttons["Settle"]
        XCTAssertTrue(settle.waitForExistence(timeout: 2) || app.buttons["Snooze"].waitForExistence(timeout: 1), "Trailing swipe should reveal Settle/Snooze, not delete")
        row.swipeRight()
        XCTAssertTrue(app.buttons["Open"].waitForExistence(timeout: 2) || row.exists)
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
