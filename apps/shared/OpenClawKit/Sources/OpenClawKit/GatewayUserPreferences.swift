import Foundation

public enum GatewayUserPreferences {
    /// Strict #rrggbb validation (leading "#" optional); canonical lowercase "#rrggbb".
    public static func normalizedAccentHex(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmedNonEmpty else { return nil }
        let hex = (trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed).lowercased()
        guard hex.count == 6, hex.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        return "#\(hex)"
    }

    /// A saved "theme" preference suppresses the operator color even though it has no hex value.
    public static func gatewayAccentHex(preference: String?, seamColor: String?) -> String? {
        if preference == "theme" { return nil }
        return self.normalizedAccentHex(preference) ?? self.normalizedAccentHex(seamColor)
    }

    /// Only an available profile preference may override the caller's Gateway accent.
    public static func decodeProfileAccentHex(_ data: Data) throws -> String? {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["status"] as? String == "ok"
        else { return nil }
        let entries = json["entries"] as? [String: Any]
        return self.normalizedAccentHex(entries?["ui.accent"] as? String)
    }
}
