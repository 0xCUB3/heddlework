import XCTest
@testable import Heddlework

@MainActor
final class SessionMemoryTests: XCTestCase {
    func testRemembersDraftAndFollowTailPerHostSession() {
        let defaults = UserDefaults(suiteName: "heddlework.session-memory-test")!
        defaults.removePersistentDomain(forName: "heddlework.session-memory-test")
        let memory = WorkspaceSessionMemory(defaults: defaults)
        memory.update(host: "http://host", session: "a") { chrome in
            chrome.draft = "keep me"
            chrome.followTail = false
            chrome.lastReadMessageId = "msg-1"
        }
        memory.update(host: "http://host", session: "b") { chrome in
            chrome.draft = "other"
            chrome.followTail = true
        }
        XCTAssertEqual(memory.chrome(host: "http://host", session: "a").draft, "keep me")
        XCTAssertEqual(memory.chrome(host: "http://host", session: "a").followTail, false)
        XCTAssertEqual(memory.chrome(host: "http://host", session: "b").followTail, true)
        memory.clearHost("http://host")
        XCTAssertEqual(memory.chrome(host: "http://host", session: "a").draft, "")
        XCTAssertTrue(memory.chrome(host: "http://host", session: "a").followTail)
    }
}
