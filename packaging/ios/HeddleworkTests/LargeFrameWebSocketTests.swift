import Network
import XCTest
@testable import Heddlework

final class LargeFrameWebSocketTests: XCTestCase {
    func testURLSessionReceivesAWelcomeLargerThanTheDefaultCap() async throws {
        let payload = String(repeating: "w", count: 1_200_000)
        let welcome = try JSONSerialization.data(withJSONObject: [
            "kind": "welcome",
            "protocol": 1,
            "workspacePath": "/tmp/ios-large",
            "snapshot": [
                "workspacePath": "/tmp/ios-large",
                "editorText": payload,
                "messages": [[
                    "role": "user",
                    "content": String(repeating: "hello existing session ", count: 8_000),
                    "timestamp": 1,
                ]],
            ],
        ])
        XCTAssertGreaterThan(welcome.count, 1_048_576)

        let server = try LocalWebSocketServer()
        let port = try await server.start()
        defer { server.stop() }

        let url = try XCTUnwrap(URL(string: "ws://127.0.0.1:\(port)"))
        let task = URLSession.shared.webSocketTask(with: url)
        task.maximumMessageSize = workspaceWebSocketMaximumMessageSize
        task.resume()
        try await server.send(welcome)

        let message = try await task.receive()
        let data = websocketMessageData(message)
        XCTAssertEqual(data.count, welcome.count)
        let envelope = try JSONDecoder().decode(ServerEnvelope.self, from: data)
        XCTAssertEqual(envelope.kind, "welcome")
        let snapshot = try XCTUnwrap(decodeSnapshot(WorkbenchSnapshot.self, from: try XCTUnwrap(envelope.snapshot)))
        XCTAssertEqual(snapshot.editorText, payload)
        XCTAssertEqual(snapshot.messages?.count, 1)
        task.cancel(with: .goingAway, reason: nil)
    }

    func testURLSessionAssemblesFramedWelcomeLargerThanOneMegabyte() async throws {
        let payload = String(repeating: "p", count: 1_200_000)
        let welcome = try JSONSerialization.data(withJSONObject: [
            "kind": "welcome",
            "protocol": 1,
            "workspacePath": "/tmp/ios-framed",
            "snapshot": ["workspacePath": "/tmp/ios-framed", "editorText": payload],
        ])
        XCTAssertGreaterThan(welcome.count, 1_048_576)
        let json = try XCTUnwrap(String(data: welcome, encoding: .utf8))
        let chunk = 180_000
        var parts: [String] = []
        var start = json.startIndex
        while start < json.endIndex {
            let end = json.index(start, offsetBy: chunk, limitedBy: json.endIndex) ?? json.endIndex
            parts.append(String(json[start..<end]))
            start = end
        }

        let server = try LocalWebSocketServer()
        let port = try await server.start()
        defer { server.stop() }
        let url = try XCTUnwrap(URL(string: "ws://127.0.0.1:\(port)"))
        let task = URLSession.shared.webSocketTask(with: url)
        task.maximumMessageSize = workspaceWebSocketMaximumMessageSize
        task.resume()

        var assembler = FrameAssembler()
        var assembled: Data?
        for (index, part) in parts.enumerated() {
            let frame = try JSONEncoder().encode(LargeTestFrame(kind: "frame", id: "welcome", index: index, count: parts.count, data: part))
            XCTAssertLessThan(frame.count, 1_048_576)
            try await server.send(frame)
            let message = try await task.receive()
            assembled = try assembler.push(websocketMessageData(message))
            if index < parts.count - 1 { XCTAssertNil(assembled) }
        }
        let data = try XCTUnwrap(assembled)
        XCTAssertEqual(data.count, welcome.count)
        let engine = WorkspaceWireEngine()
        let decoded = expectation(description: "framed welcome")
        var onMain = true
        await engine.setPublisher { event in
            if case .welcome(_, let snapshot, _, _, _, _, _, _) = event {
                onMain = Thread.isMainThread
                XCTAssertEqual(snapshot.editorText, payload)
                decoded.fulfill()
            }
        }
        try await engine.ingest(data)
        await fulfillment(of: [decoded], timeout: 5)
        XCTAssertFalse(onMain)
        task.cancel(with: .goingAway, reason: nil)
    }
}

private struct LargeTestFrame: Encodable {
    let kind: String
    let id: String
    let index: Int
    let count: Int
    let data: String
}

private final class LocalWebSocketServer: @unchecked Sendable {
    private let listener: NWListener
    private var connection: NWConnection?

    init() throws {
        let parameters = NWParameters.tcp
        let webSocket = NWProtocolWebSocket.Options()
        webSocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocket, at: 0)
        listener = try NWListener(using: parameters, on: .any)
    }

    func start() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var resumed = false
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume()
                case .failed(let error):
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.connection = connection
                connection.start(queue: .global())
            }
            listener.start(queue: .global())
        }
        guard let port = listener.port?.rawValue else {
            throw NSError(domain: "LargeFrameWebSocketTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Listener did not bind a port"])
        }
        return port
    }

    func send(_ data: Data) async throws {
        for _ in 0..<100 {
            if let connection, connection.state == .ready {
                let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
                let context = NWConnection.ContentContext(identifier: "frame", metadata: [metadata])
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                    })
                }
                return
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw NSError(domain: "LargeFrameWebSocketTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "WebSocket client did not become ready"])
    }

    func stop() {
        connection?.cancel()
        listener.cancel()
    }
}
