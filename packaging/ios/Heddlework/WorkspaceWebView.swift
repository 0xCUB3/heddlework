import SwiftUI
import WebKit

// Hosts the built web client from the app bundle and points it at the chosen host.
struct WorkspaceWebView: UIViewRepresentable {
    let link: ConnectLink
    let onDisconnect: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onDisconnect: onDisconnect) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)
        configuration.allowsInlineMediaPlayback = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(context.coordinator, name: "heddlework")
        // Tell the client it runs inside the native shell so it can skip the PWA install hint.
        let bootstrap = WKUserScript(source: "window.heddleworkNative = { platform: 'ios' };", injectionTime: .atDocumentStart, forMainFrameOnly: true)
        configuration.userContentController.addUserScript(bootstrap)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.04, green: 0.04, blue: 0.04, alpha: 1)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: link.shellURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url?.query != link.shellURL.query {
            webView.load(URLRequest(url: link.shellURL))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let onDisconnect: () -> Void
        init(onDisconnect: @escaping () -> Void) { self.onDisconnect = onDisconnect }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            if let body = message.body as? String, body == "disconnect" { onDisconnect() }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.allow) }
            if url.scheme == BundleSchemeHandler.scheme { return decisionHandler(.allow) }
            // Anything outside the bundled client opens in Safari.
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }
    }
}
