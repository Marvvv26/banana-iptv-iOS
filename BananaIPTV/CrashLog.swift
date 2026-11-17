import Foundation
import UIKit

/// Crashes and interface errors, kept on the iPhone only (Settings › About › Diagnostics).
enum CrashLog {
    private static let maxBytes = 24 * 1024
    private static let lock = NSLock()
    private static var jsLogged = 0

    private static var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("diagnostics.txt")
    }

    static var appVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
    }

    static func install() {
        NSSetUncaughtExceptionHandler { e in
            CrashLog.write("CRASH", "\(e.name.rawValue): \(e.reason ?? "")\n" + e.callStackSymbols.prefix(25).joined(separator: "\n"))
        }
    }

    static func js(_ text: String) {
        lock.lock(); jsLogged += 1; let n = jsLogged; lock.unlock()
        if n <= 20 { write("JS ERROR", String(text.prefix(600))) }
    }

    static func write(_ kind: String, _ text: String) {
        lock.lock(); defer { lock.unlock() }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let entry = "=== \(kind)  \(f.string(from: Date()))  v\(appVersion) · \(UIDevice.current.model) · iOS \(UIDevice.current.systemVersion)\n\(text)\n\n"
        var all = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        all += entry
        if all.utf8.count > maxBytes { all = String(all.suffix(maxBytes / 2)) }
        try? all.write(to: file, atomically: true, encoding: .utf8)
    }

    static func read() -> String {
        lock.lock(); defer { lock.unlock() }
        return (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    }

    static func clear() {
        lock.lock(); defer { lock.unlock() }
        try? FileManager.default.removeItem(at: file)
    }
}
