// Fork-only observer. No AX imports/actions, app test hooks, or foreign-window content.
import AppKit
import CoreGraphics
import Foundation

struct OwnedWindow: Codable {
    let id: UInt32
    let width: Double
    let height: Double
}

struct WindowReceipt: Codable {
    let pid: Int32
    let registered: Bool
    let executableMatches: Bool
    let hidden: Bool
    let frontmost: Bool
    let windows: [OwnedWindow]
    let activationAccepted: Bool?

    var ready: Bool {
        self.registered && self.executableMatches && !self.hidden && self.frontmost && self.windows.count == 1
    }

    var reason: String {
        if !self.registered { return "owned-process-not-registered" }
        if !self.executableMatches { return "owned-executable-unavailable" }
        if self.hidden { return "owned-app-hidden" }
        if self.windows.isEmpty { return "owned-onscreen-window-missing" }
        if self.windows.count != 1 { return "owned-onscreen-window-ambiguous" }
        if !self.frontmost { return "owned-app-not-frontmost" }
        return "owned-window-ready"
    }

    func json() throws -> Data {
        // Include computed fields explicitly; never export names/titles/foreign PIDs.
        let encoder = JSONEncoder()
        guard var object = try JSONSerialization.jsonObject(with: encoder.encode(self)) as? [String: Any]
        else { throw NSError(domain: "WindowReceiptEncoding", code: 1) }
        object["ready"] = self.ready
        object["reason"] = self.reason
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

func ownedWindows(_ infos: [[String: Any]], pid: Int32) -> [OwnedWindow] {
    infos.compactMap { info -> OwnedWindow? in
        guard info[kCGWindowOwnerPID as String] as? Int32 == pid,
              info[kCGWindowLayer as String] as? Int == 0,
              info[kCGWindowIsOnscreen as String] as? Bool == true,
              let alpha = info[kCGWindowAlpha as String] as? Double, alpha > 0,
              let id = info[kCGWindowNumber as String] as? UInt32,
              let fields = info[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: fields as CFDictionary),
              bounds.width >= 640, bounds.height >= 400
        else { return nil }
        return OwnedWindow(id: id, width: Double(bounds.width), height: Double(bounds.height))
    }
}

@main
enum WindowObserver {
    @MainActor
    static func main() throws {
        if CommandLine.arguments == [CommandLine.arguments[0], "--selftest"] {
            let window = OwnedWindow(id: 7, width: 960, height: 700)
            let good = WindowReceipt(pid: 42, registered: true, executableMatches: true,
                hidden: false, frontmost: true, windows: [window], activationAccepted: nil)
            guard good.ready, !WindowReceipt(pid: 42, registered: false, executableMatches: true,
                hidden: false, frontmost: true, windows: [window], activationAccepted: nil).ready,
                !WindowReceipt(pid: 42, registered: true, executableMatches: true,
                    hidden: false, frontmost: false, windows: [window], activationAccepted: nil).ready,
                !WindowReceipt(pid: 42, registered: true, executableMatches: true,
                    hidden: false, frontmost: true, windows: [], activationAccepted: nil).ready
            else { throw NSError(domain: "WindowObserverSelftest", code: 1) }
            let row: [String: Any] = [
                kCGWindowOwnerPID as String: NSNumber(value: Int32(42)),
                kCGWindowNumber as String: NSNumber(value: UInt32(7)),
                kCGWindowLayer as String: NSNumber(value: 0),
                kCGWindowAlpha as String: NSNumber(value: 1.0),
                kCGWindowIsOnscreen as String: NSNumber(value: true),
                kCGWindowBounds as String: ["X": 0, "Y": 0, "Width": 960, "Height": 700],
            ]
            var foreign = row; foreign[kCGWindowOwnerPID as String] = NSNumber(value: Int32(100))
            var offscreen = row; offscreen[kCGWindowIsOnscreen as String] = NSNumber(value: false)
            var transparent = row; transparent[kCGWindowAlpha as String] = NSNumber(value: 0.0)
            var overlay = row; overlay[kCGWindowLayer as String] = NSNumber(value: 25)
            var small = row; small[kCGWindowBounds as String] = ["X": 0, "Y": 0, "Width": 100, "Height": 100]
            guard ownedWindows([row, foreign, offscreen, transparent, overlay, small], pid: 42).count == 1
            else { throw NSError(domain: "WindowOwnershipSelftest", code: 1) }
            print("window observer pure-state controls passed; no GUI proof")
            return
        }
        guard CommandLine.arguments.count == 4,
              let pid = Int32(CommandLine.arguments[1]), pid > 1,
              ["inspect", "activate"].contains(CommandLine.arguments[3])
        else { throw NSError(domain: "WindowObserverArguments", code: 1) }
        let expected = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath()
        let app = NSRunningApplication(processIdentifier: pid)
        let actual = app?.executableURL?.resolvingSymlinksInPath()
        if let actual, actual != expected { throw NSError(domain: "WrongOwnedExecutable", code: 1) }
        let matches = actual == expected
        let activated = CommandLine.arguments[3] == "activate" && matches ? app?.activate(options: []) : nil
        guard let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0)
            as? [[String: Any]]
        else { throw NSError(domain: "WindowServerUnavailable", code: 1) }
        let windows = ownedWindows(all, pid: pid)
        let receipt = WindowReceipt(pid: pid, registered: app != nil && app?.isTerminated == false,
            executableMatches: matches, hidden: app?.isHidden ?? true,
            frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
            windows: windows, activationAccepted: activated)
        FileHandle.standardOutput.write(try receipt.json())
        print("")
    }
}
