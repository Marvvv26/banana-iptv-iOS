import UIKit
import WebKit

/// Hosts the shared Banana IPTV interface and answers its BananaNative calls.
final class WebViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private var web: WKWebView!
    private let schemeHandler = AppSchemeHandler()
    private let content = WKUserContentController()
    private static let home = URL(string: "banana://app/index.html")!

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    override func loadView() {
        view = UIView()
        view.backgroundColor = Theme.bg
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(schemeHandler, forURLScheme: "banana")
        cfg.userContentController = content
        cfg.allowsInlineMediaPlayback = true
        content.add(WeakHandler(self), name: "banana")

        web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = Theme.bg
        web.scrollView.backgroundColor = Theme.bg
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.showsVerticalScrollIndicator = false
        web.scrollView.showsHorizontalScrollIndicator = false
        web.allowsBackForwardNavigationGestures = false
        web.navigationDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        // Keep the interface clear of the notch / Dynamic Island in landscape.
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: g.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: g.trailingAnchor),
            web.topAnchor.constraint(equalTo: view.topAnchor),
            web.bottomAnchor.constraint(equalTo: g.bottomAnchor),
        ])
        refreshInitScript()
        web.load(URLRequest(url: Self.home))
    }

    // MARK: - snapshot for the page (secrets, player state, version)

    private func refreshInitScript() {
        content.removeAllUserScripts()
        let snapshot: [String: Any] = [
            "version": CrashLog.appVersion,
            "ext": externalPlayer(),
            "sec": Keychain.all(),
            "ps": PlayerStore.shared.stateJson(),
            "diag": CrashLog.read(),
        ]
        let bridge = (try? String(contentsOf: Bundle.main.url(forResource: "bridge", withExtension: "js")!, encoding: .utf8)) ?? ""
        let src = "window.__bananaInit = \(Self.jsLiteral(snapshot));\n" + bridge
        content.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    static func jsLiteral(_ obj: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed]),
              let s = String(data: data, encoding: .utf8) else { return "null" }
        return s.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    private func externalPlayer() -> String {
        if let u = URL(string: "vlc-x-callback://"), UIApplication.shared.canOpenURL(u) { return "VLC" }
        return ""
    }

    // MARK: - navigation: never leave the app's own page

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let u = action.request.url
        if u?.scheme == "banana" && u?.host == "app" {
            if action.targetFrame?.isMainFrame == true { refreshInitScript() }
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        CrashLog.write("WEB", "The interface stopped (iOS ended its process); reloaded.")
        refreshInitScript()
        webView.load(URLRequest(url: Self.home))
    }

    // MARK: - messages from the page

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let op = m["op"] as? String else { return }
        let str = { (k: String) in (m[k] as? String) ?? "" }
        switch op {
        case "play": play(str("json"))
        case "external": openExternal(str("url"))
        case "secretSet": Keychain.set(str("id"), str("value"))
        case "secretDel": Keychain.delete(str("id"))
        case "clearState": PlayerStore.shared.clear(str("what"))
        case "forget": PlayerStore.shared.forget(str("key"))
        case "clearDiag": CrashLog.clear()
        case "log": CrashLog.js(str("text"))
        default: break
        }
    }

    private func play(_ json: String) {
        guard presentedViewController == nil else { return }
        let p = PlayerViewController(json: json) { [weak self] in self?.playerClosed() }
        guard p.ok else { return }
        present(p, animated: false)
    }

    private func playerClosed() {
        let js = "window.BananaNative && BananaNative._setState(\(Self.jsLiteral(PlayerStore.shared.stateJson()))); window.bananaResume && window.bananaResume();"
        web.evaluateJavaScript(js, completionHandler: nil)
    }

    func openExternal(_ url: String) {
        guard url.hasPrefix("http://") || url.hasPrefix("https://") else { return }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let enc = url.addingPercentEncoding(withAllowedCharacters: allowed) ?? url
        if let u = URL(string: "vlc-x-callback://x-callback-url/stream?url=" + enc), UIApplication.shared.canOpenURL(u) {
            UIApplication.shared.open(u)
        } else {
            let a = UIAlertController(title: "VLC isn't installed",
                                      message: "Install VLC for Mobile from the App Store to open streams in it.", preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default))
            (presentedViewController ?? self).present(a, animated: true)
        }
    }
}

/// WKUserContentController keeps a strong reference to its handlers; this avoids a cycle.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
