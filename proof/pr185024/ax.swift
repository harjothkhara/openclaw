// Fork-only real-app test input/observation. No OpenClaw imports or bridge injection.
import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) throws -> Never {
    throw NSError(domain: message, code: 1)
}
func emit(_ result: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
func read(_ element: AXUIElement, _ key: String) throws -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, 0.75)
    var result: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, key as CFString, &result)
    if status == .attributeUnsupported || status == .noValue { return nil }
    guard status == .success else { try fail("AX read failed: \(key), \(status.rawValue)") }
    return result
}

let args = CommandLine.arguments
if args.count == 2, args[1] == "fixture" {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 600, height: 300),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Launch proof input qualification"
    let checkbox = NSButton(checkboxWithTitle: "Proof checkbox", target: nil, action: nil)
    checkbox.frame = NSRect(x: 40, y: 130, width: 240, height: 40)
    window.contentView?.addSubview(checkbox)
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    app.run()
} else {
    do {
        guard args.count >= 3, let pid = Int32(args[2]), pid > 1,
              let running = NSRunningApplication(processIdentifier: pid),
              let executable = running.executableURL?.resolvingSymlinksInPath().path
        else { try fail("Expected command and live owned PID") }
        let fixture = args.contains("--fixture")
        let expected = fixture
            ? URL(fileURLWithPath: args[0]).resolvingSymlinksInPath().path
            : "/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"
        guard executable == expected else { try fail("Target is not the task-owned executable") }
        guard AXIsProcessTrusted() else { try fail("Accessibility unavailable; do not bypass TCC") }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.75)
        if args[1] == "settings" {
            guard !fixture, running.activate(options: [.activateIgnoringOtherApps]) else {
                try fail("Could not activate owned app")
            }
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 43, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 43, keyDown: false)
            else { try fail("Could not create Settings shortcut") }
            down.flags = .maskCommand
            up.flags = .maskCommand
            down.postToPid(pid)
            up.postToPid(pid)
            try emit(["pid": pid, "action": "command-comma"])
            exit(0)
        }
        let windows = try read(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
        guard !windows.isEmpty else { try fail("Owned app has no windows") }
        let start = DispatchTime.now().uptimeNanoseconds
        var nodes = 0
        var rows: [[String: Any]] = []
        var matches: [AXUIElement] = []
        let label = args.count > 3 ? args[3] : ""
        let requestedRole = args.count > 4 ? args[4] : ""
        func walk(_ element: AXUIElement, depth: Int) throws {
            nodes += 1
            guard nodes <= 3000, depth <= 45,
                  DispatchTime.now().uptimeNanoseconds - start < 15_000_000_000
            else { try fail("AX observation exceeded its fixed budget") }
            let role = try read(element, kAXRoleAttribute) as? String ?? ""
            var row: [String: Any] = ["role": role, "depth": depth]
            if ["AXButton", "AXCheckBox", "AXSwitch", "AXLink", "AXStaticText", "AXWindow"].contains(role) {
                let title = try read(element, kAXTitleAttribute) as? String ?? ""
                let description = try read(element, kAXDescriptionAttribute) as? String ?? ""
                row["title"] = title
                row["description"] = description
                if role == "AXCheckBox" || role == "AXSwitch" {
                    row["value"] = try read(element, kAXValueAttribute)
                    row["enabled"] = try read(element, kAXEnabledAttribute)
                } else if role == "AXStaticText" {
                    row["text"] = try read(element, kAXValueAttribute) as? String
                }
                rows.append(row)
                if !label.isEmpty, (title == label || description == label),
                   requestedRole == role { matches.append(element) }
            }
            if let children = try read(element, kAXChildrenAttribute) as? [AXUIElement] {
                for child in children { try walk(child, depth: depth + 1) }
            }
        }
        for window in windows { try walk(window, depth: 0) }
        if args[1] == "press" {
            guard matches.count == 1 else { try fail("Expected exactly one \(requestedRole) named \(label); found \(matches.count)") }
            guard AXUIElementPerformAction(matches[0], kAXPressAction as CFString) == .success else {
                try fail("Owned control refused AXPress")
            }
            try emit(["pid": pid, "pressed": 1, "label": label, "role": requestedRole])
        } else {
            guard args[1] == "snapshot" else { try fail("Unknown observer command") }
            let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]] ?? []
            let owned = info.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) }
            let ids = owned.compactMap { row -> Int? in
                guard row[kCGWindowLayer as String] as? Int == 0 else { return nil }
                return row[kCGWindowNumber as String] as? Int
            }
            let sized = owned.compactMap { row -> (Int, Double)? in
                guard row[kCGWindowLayer as String] as? Int == 0,
                      let id = row[kCGWindowNumber as String] as? Int,
                      let bounds = row[kCGWindowBounds as String] as? NSDictionary,
                      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                      rect.width >= 600, rect.height >= 300 else { return nil }
                return (id, Double(rect.width * rect.height))
            }
            let captureId = sized.max { $0.1 < $1.1 }?.0
            try emit(["pid": pid, "nodes": nodes, "complete": true, "rows": rows,
                      "windowIds": ids, "captureWindowId": captureId as Any? ?? NSNull()])
        }
    } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(1)
    }
}
