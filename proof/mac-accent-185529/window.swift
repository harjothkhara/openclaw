// Fork-only read/capture helper. No OpenClaw imports or state injection.
import AppKit
import ApplicationServices
import Foundation

func require(_ ok: Bool, _ why: String) throws {
    if !ok { throw NSError(domain: why, code: 1) }
}
func emit(_ value: [String: Any]) throws {
    print(String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self))
}
func attr(_ node: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(node, name as CFString, &value)
    if result == .attributeUnsupported || result == .noValue { return nil }
    try require(result == .success, "Unreadable AX attribute: " + name)
    return value
}
func rect(_ node: AXUIElement) throws -> CGRect {
    guard let position = try attr(node, kAXPositionAttribute), let size = try attr(node, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
    else { throw NSError(domain: "Missing AX geometry", code: 1) }
    var point = CGPoint.zero, dimensions = CGSize.zero
    try require(AXValueGetValue(position as! AXValue, .cgPoint, &point), "Invalid AX point")
    try require(AXValueGetValue(size as! AXValue, .cgSize, &dimensions), "Invalid AX size")
    return CGRect(origin: point, size: dimensions)
}
func box(_ r: CGRect) -> [String: Double] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
func readBox(_ d: [String: Any]) throws -> CGRect {
    guard let x = d["x"] as? Double, let y = d["y"] as? Double,
          let w = d["width"] as? Double, let h = d["height"] as? Double else {
        throw NSError(domain: "Bad box", code: 1)
    }
    return CGRect(x: x, y: y, width: w, height: h)
}
func inspect(_ pid: pid_t, command: String) throws -> [String: Any] {
    try require(AXIsProcessTrusted(), "Accessibility unavailable; do not bypass TCC")
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 2)
    guard let windows = try attr(app, kAXWindowsAttribute) as? [AXUIElement] else {
        throw NSError(domain: "No AX windows", code: 1)
    }
    var chats: [AXUIElement] = []
    for w in windows {
        if try attr(w, kAXTitleAttribute) as? String == "OpenClaw Chat" { chats.append(w) }
    }
    try require(chats.count == 1, "No unique native Chat window for owned PID")
    let window = chats[0], bounds = try rect(window)
    try require(bounds.width >= 640 && bounds.height >= 400, "Chat bounds too small")
    var count = 0, sends: [AXUIElement] = [], editors: [AXUIElement] = [], talks: [AXUIElement] = []
    var talkActive = false
    func walk(_ e: AXUIElement, _ depth: Int) throws {
        count += 1
        try require(count <= 2500 && depth <= 30, "Incomplete AX traversal")
        let role = try attr(e, kAXRoleAttribute) as? String
        try require(role != nil && role != "AXWebArea", "Not an exclusively native Chat tree")
        switch try attr(e, kAXIdentifierAttribute) as? String {
        case "chat-send-message": sends.append(e)
        case "chat-realtime-control": talks.append(e)
        case "chat-talk-activity": talkActive = true
        default: break
        }
        if role == kAXTextAreaRole {
            var settable = DarwinBoolean(false)
            let result = AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable)
            if result == .success && settable.boolValue { editors.append(e) }
        }
        if let children = try attr(e, kAXChildrenAttribute) as? [AXUIElement] {
            for child in children { try walk(child, depth + 1) }
        }
    }
    try walk(window, 0)
    try require(editors.count == 1 && sends.count <= 1 && talks.count <= 1, "Ambiguous native controls")
    let value = try attr(editors[0], kAXValueAttribute) as? String
    try require(value != nil, "Unreadable draft")
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let owned = list.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) }
    let candidates = owned.filter { ($0[kCGWindowName as String] as? String) == "OpenClaw Chat" && ($0[kCGWindowLayer as String] as? Int) == 0 }
    try require(candidates.count == 1, "No unique on-screen CG Chat window; check capture permission")
    let candidate = candidates[0]
    guard let raw = candidate[kCGWindowBounds as String] as? NSDictionary,
          let cg = CGRect(dictionaryRepresentation: raw as CFDictionary), let id = candidate[kCGWindowNumber as String] as? Int else {
        throw NSError(domain: "Missing CG geometry", code: 1)
    }
    try require(abs(bounds.minX-cg.minX) <= 2 && abs(bounds.minY-cg.minY) <= 2 &&
                abs(bounds.width-cg.width) <= 2 && abs(bounds.height-cg.height) <= 2, "AX/CG bounds disagree")
    // Ignore the tiny status item, never a 440-point Talk panel or another app window.
    var visibleWindows = 0
    for w in owned {
        guard let b = w[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: b as CFDictionary) else {
            throw NSError(domain: "Unreadable owned window bounds", code: 1)
        }
        if r.width >= 100 && r.height >= 80 { visibleWindows += 1 }
    }
    let onlyChat = windows.count == 1 && visibleWindows == 1
    var talkLabel = "", talkEnabled = false
    if let talk = talks.first {
        talkLabel = (try attr(talk, kAXDescriptionAttribute) as? String) ?? ""
        if talkLabel.isEmpty { talkLabel = (try attr(talk, kAXTitleAttribute) as? String) ?? "" }
        talkEnabled = (try attr(talk, kAXEnabledAttribute) as? Bool) == true
    }
    var result: [String: Any] = ["pid":Int(pid),"title":"OpenClaw Chat","windowId":id,"bounds":box(cg),
        "complete":true,"native":true,"nodes":count,"onlyChat":onlyChat,"talkActive":talkActive,
        "talkLabel":talkLabel,"talkEnabled":talkEnabled,"draftEmpty":value == "",
        "sharingState":candidate[kCGWindowSharingState as String] as? Int ?? -1]
    if command == "talk-inspect" { return result }
    if command == "talk-on" || command == "talk-off" {
        try require(value == "" && talks.count == 1 && talkEnabled, "Talk requires an empty connected native composer")
        let starting = command == "talk-on"
        try require(talkLabel == (starting ? "Start realtime chat" : "Stop realtime chat"), "Unexpected Talk toggle state")
        if starting { try require(onlyChat && !talkActive, "Talk must start from Chat only") }
        try require(AXUIElementPerformAction(talks[0], kAXPressAction as CFString) == .success, "Native Talk press failed")
        result["pressed"] = command
        return result
    }
    try require(onlyChat && !talkActive, "Only native Chat with Talk disabled may be measured")
    if command == "draft" {
        try require(value == "" && talkLabel == "Start realtime chat", "Draft must follow disabled Talk")
        try require(AXUIElementSetAttributeValue(editors[0], kAXValueAttribute as CFString,
                    "Accent proof draft; never send" as CFString) == .success, "Cannot set native draft")
        result["draftSet"] = true
        return result // Rendering is asynchronous; inspect in a later invocation.
    }
    try require(sends.count == 1, "Missing unique send control")
    let send = try rect(sends[0])
    try require(bounds.contains(send) && send.width >= 16 && send.height >= 16, "Send control outside Chat")
    result["button"] = box(send)
    result["sendEnabled"] = (try attr(sends[0], kAXEnabledAttribute) as? Bool) == true
    result["draftVisible"] = value == "Accent proof draft; never send"
    return result
}
func pixels(_ file: String, geometry: String) throws -> [String: Any] {
    let data = try Data(contentsOf: URL(fileURLWithPath: file))
    try require(data.count <= 20 * 1024 * 1024, "Capture file budget exceeded")
    guard let image = NSBitmapImageRep(data: data),
          let g = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: geometry))) as? [String: Any],
          let wb = g["bounds"] as? [String: Any], let sb = g["button"] as? [String: Any] else {
        throw NSError(domain: "Missing capture/geometry", code: 1)
    }
    let window = try readBox(wb), button = try readBox(sb)
    let sx = Double(image.pixelsWide) / window.width, sy = Double(image.pixelsHigh) / window.height
    try require(sx >= 1 && sx <= 3 && abs(sx-sy) < 0.01, "Capture scale/shadow mismatch")
    let buttonPixels = CGRect(x: (button.minX-window.minX)*sx, y: (button.minY-window.minY)*sy,
                              width: button.width*sx, height: button.height*sy)
    let content = CGRect(x: Double(image.pixelsWide)*0.4, y: max(80*sy, Double(image.pixelsHigh)*0.12),
                         width: Double(image.pixelsWide)*0.58,
                         height: Double(image.pixelsHigh)*0.98-max(80*sy, Double(image.pixelsHigh)*0.12))
    func count(_ region: CGRect) throws -> [String: Int] {
        let x0 = Int(ceil(region.minX)), y0 = Int(ceil(region.minY)), x1 = Int(floor(region.maxX)), y1 = Int(floor(region.maxY))
        try require(x0 >= 0 && y0 >= 0 && x1 <= image.pixelsWide && y1 <= image.pixelsHigh && x1 > x0 && y1 > y0, "Invalid capture crop")
        var out = ["total":0,"opaque":0,"nonBlack":0,"nonWhite":0,"dark":0,"light":0,"magenta":0,"green":0]
        for y in y0..<y1 { for x in x0..<x1 {
            guard let c = image.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { throw NSError(domain: "Unreadable pixel", code: 1) }
            let r=c.redComponent, g=c.greenComponent, b=c.blueComponent, l=(r+g+b)/3
            out["total"]! += 1
            if c.alphaComponent >= 0.99 { out["opaque"]! += 1 }
            if max(r,g,b) > 0.08 { out["nonBlack"]! += 1 }
            if min(r,g,b) < 0.92 { out["nonWhite"]! += 1 }
            if l < 0.3 { out["dark"]! += 1 }; if l > 0.65 { out["light"]! += 1 }
            if r > 0.45 && b > 0.25 && r > g*1.6 && b > g*1.4 { out["magenta"]! += 1 }
            if g > 0.45 && g > r*1.6 && g > b*1.35 { out["green"]! += 1 }
        } }
        return out
    }
    return ["width":image.pixelsWide,"height":image.pixelsHigh,"content":try count(content),"button":try count(buttonPixels)]
}
func selftest(_ directory: String) throws -> [String: Any] {
    let root = URL(fileURLWithPath: directory, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let geometry = root.appendingPathComponent("geometry.json")
    // Smallest geometry accepted by the live oracle keeps the synthetic check bounded.
    let data: [String: Any] = ["bounds":box(CGRect(x:100,y:100,width:640,height:400)),
                              "button":box(CGRect(x:680,y:400,width:32,height:32))]
    try JSONSerialization.data(withJSONObject:data).write(to:geometry)
    var result: [String: Any] = [:]
    for name in ["magenta","green","black","white"] {
        guard let image = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:640,pixelsHigh:400,
            bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,
            bytesPerRow:0,bitsPerPixel:0) else { throw NSError(domain:"Fixture allocation failed",code:1) }
        for y in 0..<400 { for x in 0..<640 {
            var color: NSColor = name == "white" ? .white : .black
            if name == "magenta" || name == "green" {
                color = (y >= 150 && y < 170 && x >= 300 && x < 500) ? .white : NSColor(white:0.12,alpha:1)
                if x >= 580 && x < 612 && y >= 300 && y < 332 {
                    color = name == "magenta" ? NSColor(red:224.0/255,green:0,blue:112.0/255,alpha:1) : NSColor(red:0,green:208.0/255,blue:112.0/255,alpha:1)
                }
            }
            // White titlebar over black content must remain invalid.
            if name == "black" && y < 60 { color = .white }
            image.setColor(color, atX:x, y:y)
        } }
        let file = root.appendingPathComponent(name+".png")
        guard let png = image.representation(using:.png,properties:[:]) else { throw NSError(domain:"Fixture encode failed",code:1) }
        try png.write(to:file)
        result[name] = try pixels(file.path, geometry:geometry.path)
    }
    return result
}
do {
    let a = CommandLine.arguments
    switch a.count > 1 ? a[1] : "" {
    case "selftest":
        try require(a.count == 3, "Expected fresh fixture directory")
        try emit(selftest(a[2]))
    case "preflight":
        try require(AXIsProcessTrusted(), "Accessibility permission missing")
        try require(CGPreflightScreenCaptureAccess(), "Screen Recording permission missing")
        try emit(["axTrusted":true,"captureAllowed":true])
    case "inspect", "draft", "talk-inspect", "talk-on", "talk-off":
        try require(a.count == 3, "Expected owned PID")
        guard let pid = Int32(a[2]), pid > 1 else { throw NSError(domain:"Invalid PID",code:1) }
        try emit(inspect(pid, command:a[1]))
    case "pixels":
        try require(a.count == 4, "Expected capture and geometry")
        try emit(pixels(a[2], geometry:a[3]))
    default: throw NSError(domain:"Unknown helper command",code:1)
    }
} catch { fputs("Capture guard failed: \(error.localizedDescription)\n", stderr); exit(1) }
