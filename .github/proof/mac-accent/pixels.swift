import AppKit
import Foundation

func count(_ path: String) throws -> [String: Int] {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let image = NSBitmapImageRep(data: data), image.pixelsWide >= 300, image.pixelsHigh >= 250 else {
        throw NSError(domain: "Invalid chat-window PNG", code: 1)
    }
    var nonBlack = 0
    var nonWhite = 0
    var dark = 0
    var light = 0
    var magenta = 0
    var green = 0
    // Ignore the title bar and native sidebar. Protected chat content can be
    // black even while ordinary window chrome remains visible.
    let left = image.pixelsWide * 40 / 100
    let right = image.pixelsWide * 98 / 100
    let top = max(50, image.pixelsHigh * 10 / 100)
    let bottom = image.pixelsHigh * 98 / 100
    for y in top..<bottom {
        for x in left..<right {
            guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
            let r = color.redComponent, g = color.greenComponent, b = color.blueComponent
            if max(r, g, b) > 0.08 { nonBlack += 1 }
            if min(r, g, b) < 0.92 { nonWhite += 1 }
            let luminance = (r + g + b) / 3
            if luminance < 0.3 { dark += 1 }
            if luminance > 0.65 { light += 1 }
            if r > 0.45 && b > 0.25 && r > g * 1.6 && b > g * 1.4 { magenta += 1 }
            if g > 0.45 && g > r * 1.6 && g > b * 1.35 { green += 1 }
        }
    }
    return ["width": image.pixelsWide, "height": image.pixelsHigh,
            "sampleWidth": right - left, "sampleHeight": bottom - top,
            "nonBlack": nonBlack,
            "nonWhite": nonWhite, "dark": dark, "light": light,
            "magenta": magenta, "green": green]
}

let before = try count(CommandLine.arguments[1])
let after = try count(CommandLine.arguments[2])
let minimum = before["sampleWidth"]! * before["sampleHeight"]! / 100
let validImages = before["nonBlack"]! > minimum && after["nonBlack"]! > minimum
    && before["nonWhite"]! > minimum && after["nonWhite"]! > minimum
    && before["dark"]! > 40 && after["dark"]! > 40
    && before["light"]! > 40 && after["light"]! > 40
let changed = validImages && before["magenta"]! >= 40 && before["magenta"]! > before["green"]! * 2
    && after["green"]! >= 40 && after["green"]! > after["magenta"]! * 2
    && after["green"]! > before["green"]! + 30
let result: [String: Any] = ["validImages": validImages, "changed": changed,
                             "before": before, "after": after]
let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(decoding: json, as: UTF8.self))
