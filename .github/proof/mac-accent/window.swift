import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let matches = windows.compactMap { item -> [String: Any]? in
    guard let owner = item[kCGWindowOwnerPID as String] as? Int, owner == pid,
          let title = item[kCGWindowName as String] as? String, title == "OpenClaw Chat",
          let id = item[kCGWindowNumber as String] as? Int,
          let bounds = item[kCGWindowBounds as String] as? [String: Any],
          let width = bounds["Width"] as? Int, let height = bounds["Height"] as? Int,
          width >= 300, height >= 250 else { return nil }
    return ["id": id, "title": title, "width": width, "height": height]
}
guard matches.count == 1 else {
    throw NSError(domain: "Expected one visible CGWindowList OpenClaw Chat window; found \(matches.count)", code: 1)
}
let data = try JSONSerialization.data(withJSONObject: matches[0], options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
