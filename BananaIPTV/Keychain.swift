import Foundation
import Security

/// Provider passwords, stored in the iPhone's Keychain (this device only, never synced to iCloud).
enum Keychain {
    private static let service = "uk.banana.iptv.secrets"

    static func valid(_ id: String) -> Bool {
        id.range(of: "^[A-Za-z0-9_.-]{1,64}$", options: .regularExpression) != nil
    }

    private static func base(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: id]
    }

    @discardableResult
    static func set(_ id: String, _ value: String) -> Bool {
        guard valid(id) else { return false }
        SecItemDelete(base(id) as CFDictionary)
        var q = base(id)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ id: String) -> String? {
        guard valid(id) else { return nil }
        var q = base(id)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func delete(_ id: String) {
        guard valid(id) else { return }
        SecItemDelete(base(id) as CFDictionary)
    }

    static func all() -> [String: String] {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecReturnAttributes as String: true,
                                kSecMatchLimit as String: kSecMatchLimitAll]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let items = out as? [[String: Any]] else { return [:] }
        var res: [String: String] = [:]
        for it in items {
            if let id = it[kSecAttrAccount as String] as? String, let v = get(id) { res[id] = v }
        }
        return res
    }
}
