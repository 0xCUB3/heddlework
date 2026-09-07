import XCTest
@testable import Heddlework

final class HostIdentityTests: XCTestCase {
    func testDecodesFullPayload() throws {
        let json = Data(#"""
        {"id":"abc","name":"Studio","os":"darwin","arch":"arm64","machine":"mac-studio","version":"1.2.3","protocol":1}
        """#.utf8)
        let host = try JSONDecoder().decode(HostIdentity.self, from: json)
        XCTAssertEqual(host.id, "abc")
        XCTAssertEqual(host.name, "Studio")
        XCTAssertEqual(host.os, "darwin")
        XCTAssertEqual(host.arch, "arm64")
        XCTAssertEqual(host.machine, .macStudio)
        XCTAssertEqual(host.version, "1.2.3")
        XCTAssertEqual(host.protocolVersion, 1)
    }

    func testUnknownMachineFallsBackToServer() throws {
        let json = Data(#"""
        {"id":"abc","name":"Studio","os":"darwin","arch":"arm64","machine":"toaster","version":"9","protocol":1}
        """#.utf8)
        let host = try JSONDecoder().decode(HostIdentity.self, from: json)
        XCTAssertEqual(host.machine, .server)
    }

    func testServerEnvelopeDecodesOptionalHost() throws {
        let json = Data(#"""
        {"kind":"welcome","protocol":1,"workspacePath":"/tmp/project","snapshot":{"workspacePath":"/tmp/project"},"host":{"id":"studio-id","name":"Studio","os":"darwin","arch":"arm64","machine":"mac-studio","version":"9","protocol":1}}
        """#.utf8)
        let envelope = try JSONDecoder().decode(ServerEnvelope.self, from: json)
        XCTAssertEqual(envelope.host?.id, "studio-id")
        XCTAssertEqual(envelope.host?.machine, .macStudio)
        XCTAssertEqual(envelope.host?.protocolVersion, 1)
    }

    func testShortHostNameStripsDomainButKeepsHumanNames() {
        XCTAssertEqual(shortHostName("studio.local"), "studio")
        XCTAssertEqual(shortHostName("Alexander's MacBook Pro"), "Alexander's MacBook Pro")
        XCTAssertEqual(shortHostName("  "), "Unnamed host")
    }
}
