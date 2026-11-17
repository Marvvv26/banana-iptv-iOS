import Foundation
import WebKit

/// Serves the interface from the app bundle at banana://app/, and fetches
/// provider API data for it at banana://app/net?u=<url> (GET only, http/https only).
/// Doing those requests here avoids the browser's cross-site (CORS) limits,
/// exactly like the Fire TV app's /net proxy.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    private var live = Set<ObjectIdentifier>()   // tasks WebKit hasn't cancelled
    private var running: [ObjectIdentifier: URLSessionDataTask] = [:]
    private let root: URL? = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true).standardizedFileURL

    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 45
        c.timeoutIntervalForResource = 120
        c.httpShouldSetCookies = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpAdditionalHeaders = ["User-Agent": "BananaIPTV/1.0 (iPhone)", "Accept": "*/*"]
        return URLSession(configuration: c)
    }()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        live.insert(id)
        guard let url = task.request.url, url.host == "app" else { return reply(task, 404, "text/plain", Data("Not found".utf8)) }
        if url.path == "/net" {
            guard (task.request.httpMethod ?? "GET").uppercased() == "GET" else { return reply(task, 405, "text/plain", Data()) }
            let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "u" })?.value ?? ""
            guard let t = URL(string: target), let s = t.scheme?.lowercased(), s == "http" || s == "https" else {
                return reply(task, 400, "text/plain", Data("Bad URL".utf8))
            }
            let dt = session.dataTask(with: t) { [weak self] data, resp, err in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.running.removeValue(forKey: id)
                    if err != nil { return self.reply(task, 502, "text/plain", Data("Network error".utf8)) }
                    let h = resp as? HTTPURLResponse
                    let ct = (h?.value(forHTTPHeaderField: "Content-Type") ?? "text/plain")
                    self.reply(task, h?.statusCode ?? 502, ct, data ?? Data())
                }
            }
            running[id] = dt
            dt.resume()
            return
        }
        asset(task, path: url.path)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        live.remove(id)
        running.removeValue(forKey: id)?.cancel()
    }

    private func asset(_ task: WKURLSchemeTask, path: String) {
        guard let root = root else { return reply(task, 500, "text/plain", Data()) }
        let rel = path == "/" ? "index.html" : String(path.drop(while: { $0 == "/" }))
        let f = root.appendingPathComponent(rel).standardizedFileURL
        // never serve anything outside the bundled web folder
        guard f.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: f) else {
            return reply(task, 404, "text/plain", Data("Not found".utf8))
        }
        let types = ["html": "text/html; charset=utf-8", "js": "application/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
                     "svg": "image/svg+xml", "png": "image/png", "json": "application/json", "woff2": "font/woff2"]
        reply(task, 200, types[f.pathExtension.lowercased()] ?? "application/octet-stream", data)
    }

    private func reply(_ task: WKURLSchemeTask, _ code: Int, _ type: String, _ data: Data) {
        guard live.contains(ObjectIdentifier(task)), let url = task.request.url else { return }
        live.remove(ObjectIdentifier(task))
        let resp = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-store"])!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }
}
