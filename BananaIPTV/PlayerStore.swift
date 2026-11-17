import Foundation

/// What the player remembers: where you stopped in films and episodes, and the
/// live channels you watched last. Only ids and positions, never stream links
/// (they contain the password). Same format as the Fire TV app.
final class PlayerStore {
    static let shared = PlayerStore()
    private let d = UserDefaults.standard
    private let lock = NSLock()
    private let maxResume = 200, maxRecent = 30

    private func resume() -> [String: [String: Any]] {
        guard let s = d.string(forKey: "banana.resume"), let data = s.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
        return o
    }
    private func setResume(_ o: [String: [String: Any]]) {
        if let data = try? JSONSerialization.data(withJSONObject: o), let s = String(data: data, encoding: .utf8) {
            d.set(s, forKey: "banana.resume")
        }
    }
    private func recent() -> [String] { d.stringArray(forKey: "banana.recentLive") ?? [] }

    func saveResume(key: String, posMs: Int64, durMs: Int64) {
        guard !key.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        var all = resume()
        let finished = durMs > 0 && posMs > durMs - 90_000 && Double(posMs) > Double(durMs) * 0.92
        if posMs < 30_000 && !finished { return }
        var e: [String: Any] = ["p": posMs, "d": durMs, "t": Int64(Date().timeIntervalSince1970 * 1000)]
        if finished { e["done"] = true }
        all[key] = e
        if all.count > maxResume,
           let oldest = all.min(by: { (($0.value["t"] as? NSNumber)?.int64Value ?? 0) < (($1.value["t"] as? NSNumber)?.int64Value ?? 0) })?.key {
            all.removeValue(forKey: oldest)
        }
        setResume(all)
    }

    func addRecentLive(_ id: String) {
        guard !id.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        var l = recent().filter { $0 != id }
        l.insert(id, at: 0)
        d.set(Array(l.prefix(maxRecent)), forKey: "banana.recentLive")
    }

    func stateJson() -> String {
        lock.lock(); defer { lock.unlock() }
        let o: [String: Any] = ["resume": resume(), "recentLive": recent()]
        guard let data = try? JSONSerialization.data(withJSONObject: o) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    func clear(_ what: String) {
        lock.lock(); defer { lock.unlock() }
        if what == "resume" || what == "all" { d.removeObject(forKey: "banana.resume") }
        if what == "recentLive" || what == "all" { d.removeObject(forKey: "banana.recentLive") }
    }

    func forget(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        var all = resume()
        all.removeValue(forKey: key)
        setResume(all)
    }
}
