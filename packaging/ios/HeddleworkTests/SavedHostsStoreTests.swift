import XCTest
@testable import Heddlework

@MainActor
final class SavedHostsStoreTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suite = "heddlework.saved-hosts-test.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testMigratesLegacyConnectLink() throws {
        defaults.set("http://studio.local:4817/?token=abc", forKey: "heddlework.connectLink")
        let store = SavedHostsStore(defaults: defaults, environment: [:])
        XCTAssertNil(defaults.string(forKey: "heddlework.connectLink"))
        XCTAssertEqual(store.hosts.count, 1)
        let host = try XCTUnwrap(store.activeHost)
        XCTAssertEqual(host.name, "studio.local")
        XCTAssertEqual(host.token, "abc")
        XCTAssertEqual(host.url.absoluteString, "http://studio.local:4817")
        XCTAssertEqual(host.id, savedHostIdForUrl("http://studio.local:4817"))
        XCTAssertEqual(host.machine, .server)
    }

    func testRememberMergesUrlHashRowIntoIdentityRow() throws {
        let store = SavedHostsStore(defaults: defaults, environment: [:])
        let link = try XCTUnwrap(ConnectLink(url: URL(string: "http://studio.local:4817/?token=a")!))
        store.connect(link)
        XCTAssertEqual(store.hosts.count, 1)
        XCTAssertEqual(store.activeHost?.id, savedHostIdForUrl("http://studio.local:4817"))
        let identity = HostIdentity(id: "studio-id", name: "Studio", os: "darwin", arch: "arm64", machine: .macStudio, version: "1", protocolVersion: 1)
        store.remember(identity: identity, url: link.hostURL, token: link.token, hostUrls: ["http://100.64.0.2:4817"])
        XCTAssertEqual(store.hosts.count, 1)
        let host = try XCTUnwrap(store.activeHost)
        XCTAssertEqual(host.id, "studio-id")
        XCTAssertEqual(host.name, "Studio")
        XCTAssertEqual(host.machine, .macStudio)
        XCTAssertEqual(host.os, "darwin")
        XCTAssertEqual(host.hostUrls, ["http://studio.local:4817", "http://100.64.0.2:4817"])
    }

    func testRenameSetsCustomNameAndRememberKeepsIt() throws {
        let store = SavedHostsStore(defaults: defaults, environment: [:])
        let identity = HostIdentity(id: "studio-id", name: "Studio", os: "darwin", arch: "arm64", machine: .macStudio, version: "1", protocolVersion: 1)
        let url = URL(string: "http://studio.local:4817")!
        store.remember(identity: identity, url: url, token: "a", hostUrls: [])
        store.rename(id: "studio-id", name: "  Bench  box ")
        XCTAssertEqual(store.activeHost?.name, "Bench box")
        XCTAssertEqual(store.activeHost?.customName, true)
        store.remember(identity: identity, url: url, token: "a", hostUrls: [])
        XCTAssertEqual(store.activeHost?.name, "Bench box")
        XCTAssertEqual(store.activeHost?.customName, true)
    }

    func testOrdersByLastSeenAt() {
        let store = SavedHostsStore(defaults: defaults, environment: [:])
        let first = HostIdentity(id: "a", name: "Alpha", os: "darwin", arch: "arm64", machine: .laptop, version: "1", protocolVersion: 1)
        let second = HostIdentity(id: "b", name: "Bravo", os: "linux", arch: "x64", machine: .server, version: "1", protocolVersion: 1)
        store.remember(identity: first, url: URL(string: "http://a.local:1")!, token: "t", hostUrls: [])
        store.remember(identity: second, url: URL(string: "http://b.local:1")!, token: "t", hostUrls: [])
        XCTAssertEqual(store.hosts.map(\.id), ["b", "a"])
        store.remember(identity: first, url: URL(string: "http://a.local:1")!, token: "t", hostUrls: [])
        XCTAssertEqual(store.hosts.map(\.id), ["a", "b"])
    }

    func testEnvResetClearsPersistedHosts() {
        let store = SavedHostsStore(defaults: defaults, environment: [:])
        store.connect(ConnectLink(hostURL: URL(string: "http://a.local:1")!, token: "t"))
        XCTAssertEqual(store.hosts.count, 1)
        let reset = SavedHostsStore(defaults: defaults, environment: ["HEEDLEWORK_RESET_CONNECTION": "1"])
        XCTAssertTrue(reset.hosts.isEmpty)
        XCTAssertNil(reset.activeHost)
    }
}
