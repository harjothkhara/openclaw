import AppKit
import Foundation

func count(_ path: String) throws -> (Int, Int) {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    guard let image = NSBitmapImageRep(data: data) else { throw NSError(domain: "PNG", code: 1) }
    var magenta = 0
    var green = 0
    for y in 0..<image.pixelsHigh {
        for x in 0..<image.pixelsWide {
            guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
            let r = color.redComponent, g = color.greenComponent, b = color.blueComponent
            if r > 0.45 && b > 0.25 && r > g * 1.6 && b > g * 1.4 { magenta += 1 }
            if g > 0.45 && g > r * 1.6 && g > b * 1.35 { green += 1 }
        }
    }
    return (magenta, green)
}

let before = try count(CommandLine.arguments[1])
let after = try count(CommandLine.arguments[2])
print("before magenta=\(before.0) green=\(before.1)")
print("after magenta=\(after.0) green=\(after.1)")
guard before.0 > after.0 + 30, after.1 > before.1 + 30 else {
    throw NSError(domain: "Accent pixels did not change", code: 2)
}
