// Fork-only targeted AX observer. Native compilation/runtime are qualification gates.
import AppKit
import ApplicationServices
import Dispatch
import Foundation
import Darwin

@MainActor
final class TargetedMenuProbe {
    let pid: Int32
    let executable: URL
    let app: AXUIElement
    let started = DispatchTime.now().uptimeNanoseconds
    let budgetNs: UInt64
    let fixture: Bool
    var visited = 0
    var stage = "start"

    init(pid: Int32, executable: URL, ping: Bool, fixture: Bool) throws {
        self.pid = pid
        self.executable = executable.resolvingSymlinksInPath()
        self.app = AXUIElementCreateApplication(pid)
        self.budgetNs = ping ? 1_000_000_000 : 3_000_000_000
        self.fixture = fixture
        try self.requireOwner()
        guard AXIsProcessTrusted() else { throw NSError(domain: "AXTrustMissing", code: 1) }
    }

    func fail(_ label: String, _ code: Int = 1) -> NSError {
        NSError(domain: "TargetedMenu." + label, code: code)
    }
    func mark(_ value: String) {
        self.stage = value
        if let data = try? JSONSerialization.data(withJSONObject: [
            "stage": value, "pid": self.pid, "visited": self.visited,
            "elapsedMs": self.elapsedMs,
        ]) {
            FileHandle.standardError.write(data)
            FileHandle.standardError.write(Data([10]))
        }
    }
    var elapsedMs: Double {
        Double(DispatchTime.now().uptimeNanoseconds - self.started) / 1_000_000
    }
    func checkBudget(_ node: AXUIElement) throws {
        let elapsed = DispatchTime.now().uptimeNanoseconds - self.started
        guard elapsed < self.budgetNs else { throw self.fail("deadline") }
        let remaining = Double(self.budgetNs - elapsed) / 1_000_000_000
        let result = AXUIElementSetMessagingTimeout(node, Float(min(0.2, remaining)))
        guard result == .success else { throw self.fail("messaging-timeout", Int(result.rawValue)) }
    }
    func requireOwner() throws {
        guard let running = NSRunningApplication(processIdentifier: self.pid), !running.isTerminated,
              running.executableURL?.resolvingSymlinksInPath() == self.executable,
              self.fixture || (!running.isHidden &&
                NSWorkspace.shared.frontmostApplication?.processIdentifier == self.pid)
        else { throw self.fail("owned-app-not-frontmost") }
    }
    func value(_ node: AXUIElement, _ name: String, optional: Bool = false) throws -> CFTypeRef? {
        try self.checkBudget(node)
        self.mark("read:" + name)
        var result: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(node, name as CFString, &result)
        if optional && (error == .attributeUnsupported || error == .noValue) { return nil }
        guard error == .success else { throw self.fail("read:" + name, Int(error.rawValue)) }
        return result
    }
    func role(_ node: AXUIElement) throws -> String {
        guard let role = try self.value(node, kAXRoleAttribute) as? String else { throw self.fail("role") }
        return role
    }
    func children(_ node: AXUIElement, allowPendingMenu: Bool = false) throws -> [AXUIElement] {
        try self.checkBudget(node)
        self.mark("children-count")
        var count: CFIndex = 0
        let error = AXUIElementGetAttributeValueCount(node, kAXChildrenAttribute as CFString, &count)
        if allowPendingMenu && (error == .noValue || error == .attributeUnsupported) { return [] }
        guard error == .success else { throw self.fail("children-count", Int(error.rawValue)) }
        guard count >= 0, count <= 64 else { throw self.fail("children-budget") }
        if count == 0 { return [] }
        try self.checkBudget(node)
        self.mark("children-values")
        var values: CFArray?
        let read = AXUIElementCopyAttributeValues(node, kAXChildrenAttribute as CFString, 0, count, &values)
        guard read == .success, let elements = values as? [AXUIElement], elements.count == count
        else { throw self.fail("children-values", Int(read.rawValue)) }
        return elements
    }
    func focusedWindow() throws -> AXUIElement {
        guard try self.role(self.app) == kAXApplicationRole,
              let value = try self.value(self.app, kAXFocusedWindowAttribute),
              CFGetTypeID(value) == AXUIElementGetTypeID()
        else { throw self.fail("focused-window") }
        let window = unsafeDowncast(value, to: AXUIElement.self) // CF type was checked above.
        guard try self.role(window) == kAXWindowRole,
              (try self.value(window, kAXMinimizedAttribute) as? Bool) == false
        else { throw self.fail("focused-window-not-visible") }
        return window
    }
    func visit() throws {
        self.visited += 1
        guard self.visited <= 80 else { throw self.fail("node-budget") }
    }
    func threadButton(_ window: AXUIElement) throws -> AXUIElement {
        var toolbars: [AXUIElement] = []
        func findToolbars(_ node: AXUIElement, _ depth: Int) throws {
            try self.visit()
            let role = try self.role(node)
            if role == kAXToolbarRole { toolbars.append(node); return }
            // No descent into split groups, scroll areas, outlines, tables or web content.
            guard depth < 3, role == kAXWindowRole || role == kAXGroupRole else { return }
            for child in try self.children(node) { try findToolbars(child, depth + 1) }
        }
        try findToolbars(window, 0)
        guard toolbars.count == 1 else { throw self.fail("toolbar-not-unique") }
        var buttons: [AXUIElement] = []
        func findThread(_ node: AXUIElement, _ depth: Int) throws {
            try self.visit()
            let role = try self.role(node)
            if ["AXMenuButton", kAXPopUpButtonRole, kAXButtonRole].contains(role) {
                let title = try self.value(node, kAXTitleAttribute, optional: true) as? String
                let description = try self.value(node, kAXDescriptionAttribute, optional: true) as? String
                let help = try self.value(node, kAXHelpAttribute, optional: true) as? String
                if (title == "Thread" || description == "Thread") && (help == nil || help == "Thread actions") {
                    buttons.append(node)
                }
                return
            }
            guard depth < 3, role == kAXToolbarRole || role == kAXGroupRole else { return }
            for child in try self.children(node) { try findThread(child, depth + 1) }
        }
        try findThread(toolbars[0], 0)
        guard buttons.count == 1,
              (try self.value(buttons[0], kAXEnabledAttribute) as? Bool) == true
        else { throw self.fail("thread-control-not-unique-enabled") }
        return buttons[0]
    }
    func actions(_ node: AXUIElement) throws -> [String] {
        try self.checkBudget(node)
        self.mark("action-names")
        var names: CFArray?
        let error = AXUIElementCopyActionNames(node, &names)
        guard error == .success, let names = names as? [String] else { throw self.fail("action-names", Int(error.rawValue)) }
        return names
    }
    @discardableResult
    func perform(_ node: AXUIElement, _ action: String) throws
        -> (pressedAt: Int64, pressedUptimeMs: Double, returnedAt: Int64, returnedUptimeMs: Double)
    {
        try self.requireOwner() // Check the live owned app immediately before an effect.
        guard try self.actions(node).contains(action) else { throw self.fail("unsupported-action") }
        try self.checkBudget(node)
        self.mark("perform:" + action)
        let pressedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let pressedUptimeMs = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
        let error = AXUIElementPerformAction(node, action as CFString)
        let returnedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let returnedUptimeMs = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
        guard error == .success else { throw self.fail("perform", Int(error.rawValue)) }
        return (pressedAt, pressedUptimeMs, returnedAt, returnedUptimeMs)
    }
    func openMenu(_ button: AXUIElement) throws -> AXUIElement {
        let actions = try self.actions(button)
        if actions.contains(kAXPressAction) { try self.perform(button, kAXPressAction) }
        else if actions.contains("AXShowMenu") { try self.perform(button, "AXShowMenu") }
        else { throw self.fail("thread-menu-cannot-open") }
        while true {
            let menus = try self.children(button, allowPendingMenu: true).filter { try self.role($0) == kAXMenuRole }
            if menus.count == 1 { return menus[0] }
            guard menus.isEmpty else { throw self.fail("thread-menu-ambiguous") }
            try self.checkBudget(button)
            Thread.sleep(forTimeInterval: 0.005)
        }
    }
    func item(_ menu: AXUIElement, _ title: String) throws -> AXUIElement {
        let matches = try self.children(menu).filter {
            try self.role($0) == kAXMenuItemRole && (self.value($0, kAXTitleAttribute, optional: true) as? String) == title
        }
        guard matches.count == 1,
              (try self.value(matches[0], kAXEnabledAttribute) as? Bool) == true
        else { throw self.fail("menu-item-not-unique-enabled") }
        return matches[0]
    }
    func run(_ action: String) throws -> [String: Any] {
        if action == "fixture" {
            // The immutable shared fixture is borderless/accessory and need not be key.
            // Only this read-only qualification path omits product frontmost/focus gates.
            guard self.fixture, try self.role(self.app) == kAXApplicationRole,
                  let windows = try self.value(self.app, kAXWindowsAttribute) as? [AXUIElement],
                  windows.count > 0, windows.count <= 16
            else { throw self.fail("fixture-window-query") }
            for window in windows {
                guard try self.role(window) == kAXWindowRole else { throw self.fail("fixture-window-role") }
            }
            try self.requireOwner()
            return ["schema": 1, "kind": "targeted-native-ax-fixture", "action": action,
                "pid": self.pid, "complete": true, "axTrusted": AXIsProcessTrusted(),
                "windowCount": windows.count, "elapsedMs": self.elapsedMs, "newThreadPresses": 0]
        }
        let window = try self.focusedWindow()
        var out: [String: Any] = ["schema": 1, "kind": "targeted-native-ax", "action": action,
            "pid": self.pid, "frontmost": true, "appRole": kAXApplicationRole,
            "windowRole": kAXWindowRole, "newThreadPresses": 0]
        if action != "ping" {
            let button = try self.threadButton(window)
            out["threadMenuCount"] = 1
            out["threadEnabled"] = true
            if action == "new" || action == "copy-key" {
                // Effects are limited to the disposable hosted runner for this candidate.
                let env = ProcessInfo.processInfo.environment
                guard env["GITHUB_ACTIONS"] == "true", env["RUNNER_ENVIRONMENT"] == "github-hosted",
                      env["GITHUB_REPOSITORY"] == "harjothkhara/openclaw"
                else { throw self.fail("hosted-effect-scope-required") }
                let menu = try self.openMenu(button)
                let item = try self.item(menu, action == "new" ? "New Thread" : "Copy Session Key")
                if action == "new" {
                    let timing = try self.perform(item, kAXPressAction)
                    out["pressedAt"] = timing.pressedAt
                    out["pressedUptimeMs"] = timing.pressedUptimeMs
                    out["returnedAt"] = timing.returnedAt
                    out["returnedUptimeMs"] = timing.returnedUptimeMs
                    out["clicked"] = true
                    out["newThreadPresses"] = 1
                } else {
                    try self.requireOwner()
                    let board = NSPasteboard.general
                    let sentinel = "NT186215-" + UUID().uuidString
                    board.clearContents()
                    guard board.setString(sentinel, forType: .string) else { throw self.fail("clipboard-sentinel") }
                    let before = board.changeCount
                    try self.perform(item, kAXPressAction)
                    // ChatPasteboard.copy clears and then writes; wait for the value, not only its first change.
                    while true {
                        try self.checkBudget(self.app)
                        self.mark("clipboard-value-pending")
                        if board.changeCount > before, let key = board.string(forType: .string),
                           !key.isEmpty, key != sentinel {
                            guard key.utf8.count <= 512 else { throw self.fail("clipboard-key-too-large") }
                            out["sentinel"] = sentinel
                            out["changeCountBefore"] = before
                            out["changeCountAfter"] = board.changeCount
                            out["key"] = key
                            break
                        }
                        Thread.sleep(forTimeInterval: 0.005)
                    }
                }
            }
        }
        out["elapsedMs"] = self.elapsedMs
        out["sampledUptimeMs"] = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
        out["visited"] = self.visited
        out["complete"] = true
        out["menuItemRouteVerified"] = action == "new" || action == "copy-key"
        return out
    }
}

@main
enum TargetedMenuMain {
    @MainActor
    static func main() {
        do { try self.run() } catch {
            let error = error as NSError
            let failure: [String: Any] = ["kind": "targeted-native-ax-error", "domain": error.domain, "code": error.code]
            if let data = try? JSONSerialization.data(withJSONObject: failure, options: [.sortedKeys]) {
                FileHandle.standardError.write(data)
                FileHandle.standardError.write(Data([10]))
            }
            exit(1)
        }
    }
    @MainActor
    static func run() throws {
        let args = CommandLine.arguments
        guard args.count == 4, let pid = Int32(args[1]), pid > 1, args[2].hasPrefix("/"),
              ["fixture", "ping", "probe", "new", "copy-key"].contains(args[3])
        else { throw NSError(domain: "TargetedMenuArguments", code: 1) }
        let probe = try TargetedMenuProbe(pid: pid, executable: URL(fileURLWithPath: args[2]),
            ping: args[3] == "ping" || args[3] == "fixture", fixture: args[3] == "fixture")
        let value = try probe.run(args[3])
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
