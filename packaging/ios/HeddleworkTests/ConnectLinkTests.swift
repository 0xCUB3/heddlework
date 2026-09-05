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

    func testShellURLCarriesHostAndToken() throws {
        let link = try XCTUnwrap(ConnectLink(url: URL(string: "http://10.0.0.5:47311/?token=t0k")!))
        let components = try XCTUnwrap(URLComponents(url: link.shellURL, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "heddlework-app")
        XCTAssertEqual(components.path, "/index.html")
        XCTAssertEqual(components.queryItems?.first { $0.name == "host" }?.value, "http://10.0.0.5:47311")
        XCTAssertEqual(components.queryItems?.first { $0.name == "token" }?.value, "t0k")
    }
}
