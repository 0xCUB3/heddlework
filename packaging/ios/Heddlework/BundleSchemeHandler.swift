import WebKit
import UniformTypeIdentifiers

// Serves dist/web out of the app bundle under heddlework-app://app so the client has a stable origin.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "heddlework-app"
    static let origin = URL(string: "heddlework-app://app")!

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let name = String(path.dropFirst())
        guard let fileURL = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "web") ?? Bundle.main.url(forResource: name, withExtension: nil),
              let data = try? Data(contentsOf: fileURL) else {
            let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(response)
            task.didReceive(Data("Not found".utf8))
            task.didFinish()
            return
        }
        let type = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? Self.fallbackMime(for: fileURL.pathExtension)
        let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func fallbackMime(for ext: String) -> String {
        switch ext {
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "html": return "text/html"
        case "svg": return "image/svg+xml"
        case "webmanifest", "json": return "application/json"
        case "map": return "application/json"
        default: return "application/octet-stream"
        }
    }
}
