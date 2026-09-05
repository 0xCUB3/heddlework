import XCTest
@testable import Heddlework

final class ConnectLinkTests: XCTestCase {
    func testParsesHostConnectLink() throws {
        let link = try XCTUnwrap(ConnectLink(url: URL(string: "http://192.168.1.20:47311/?token=abc123")!))
        XCTAssertEqual(link.hostURL.absoluteString, "http://192.168.1.20:47311")
        XCTAssertEqual(link.token, "abc123")
    }

    func testAcceptsWebSocketLinkAndStripsWsPath() throws {
        let link = try XCTUnwrap(ConnectLink(url: URL(string: "wss://mac.example.net/ws?token=t")!))
        XCTAssertEqual(link.hostURL.absoluteString, "https://mac.example.net")
    }

    func testUnwrapsDeepLink() throws {
        let wrapped = "http://192.168.1.20:47311/?token=abc".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        let link = try XCTUnwrap(ConnectLink(url: URL(string: "heddlework://connect?url=\(wrapped)")!))
        XCTAssertEqual(link.hostURL.absoluteString, "http://192.168.1.20:47311")
        XCTAssertEqual(link.token, "abc")
        XCTAssertNil(ConnectLink(url: URL(string: "heddlework://connect")!))
    }

    func testRejectsLinkWithoutToken() {
        XCTAssertNil(ConnectLink(url: URL(string: "http://192.168.1.20:47311/")!))
    }

    func testWebSocketURLCarriesHostAndToken() throws {
        let scanned = try XCTUnwrap(ConnectLink(url: URL(string: "http://100.101.102.103:4817/?token=abcdefghijklmnopqrstuvwxyz0123456789-_")!))
        XCTAssertEqual(scanned.hostURL.host, "100.101.102.103")
        XCTAssertEqual(scanned.token, "abcdefghijklmnopqrstuvwxyz0123456789-_")
        let link = try XCTUnwrap(ConnectLink(url: URL(string: "http://10.0.0.5:47311/?token=t0k")!))
        let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(link.webSocketURL), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "ws")
        XCTAssertEqual(components.path, "/ws")
        XCTAssertEqual(components.queryItems?.first { $0.name == "token" }?.value, "t0k")
    }
}
