import XCTest
@testable import Heddlework

final class NotificationTests: XCTestCase {
    func testNoticeDecodesLedgerFieldsAndTreatsMissingChannelAsLedger() throws {
        let data = Data(#"{"id":7,"kind":"error","message":"Build failed","createdAt":10,"eventId":"failure:7","channel":"ledger","reason":"failure","sessionPath":"/tmp/a","sessionTitle":"Fix login"}"#.utf8)
        let notice = try JSONDecoder().decode(Notice.self, from: data)
        XCTAssertEqual(notice.id, 7)
        XCTAssertEqual(notice.eventId, "failure:7")
        XCTAssertTrue(notice.isLedger)
        XCTAssertTrue(notice.isUnread)
        XCTAssertEqual(notice.sessionTitle, "Fix login")

        let toast = try JSONDecoder().decode(Notice.self, from: Data(#"{"id":1,"kind":"info","message":"Link copied","createdAt":1,"channel":"toast"}"#.utf8))
        XCTAssertFalse(toast.isLedger)

        let legacy = try JSONDecoder().decode(Notice.self, from: Data(#"{"id":2,"kind":"warning","message":"old","createdAt":2}"#.utf8))
        XCTAssertTrue(legacy.isLedger)
    }

    func testPresenceAndNoticeCommandsUseHostShapes() {
        let presence = CommandFactory.reportPresence(clientId: "ios-1", surface: "ios", visibility: "hidden", sessionPath: "/tmp/a")
        XCTAssertEqual(presence["type"], .string("reportPresence"))
        XCTAssertEqual(presence["clientId"], .string("ios-1"))
        XCTAssertEqual(presence["surface"], .string("ios"))
        XCTAssertEqual(CommandFactory.activateNotice(id: 9)["type"], .string("activateNotice"))
        XCTAssertEqual(CommandFactory.dismissNotice(id: 9)["id"], .number(9))
        XCTAssertEqual(CommandFactory.simple("markNoticesRead")["type"], .string("markNoticesRead"))
    }

    func testNotificationsPanelWidthStaysCompact() {
        XCTAssertEqual(WorkbenchLayoutMetrics.notificationsPanelWidth(mainWidth: 1184), 422)
        XCTAssertEqual(WorkbenchLayoutMetrics.notificationsPanelWidth(mainWidth: 300), 300)
        XCTAssertEqual(WorkbenchLayoutMetrics.standardPanelWidth(mainWidth: 1184), 520)
    }
}
