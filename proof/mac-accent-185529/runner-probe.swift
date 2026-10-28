import AppKit
import ApplicationServices
import CoreFoundation
import IOKit

func boolean(_ value: Any?) -> Bool? {
    guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return value.boolValue
}
func consoleObservation() -> [String: Any] {
    // Read-only projection of the repository's desktop-availability contract.
    // Never retain names, UIDs, session dictionaries, or unrelated window metadata.
    let root = IORegistryGetRootEntry(kIOMainPortDefault)
    guard root != 0 else { return ["state": "unknown"] }
    defer { IOObjectRelease(root) }
    guard let users = IORegistryEntryCreateCFProperty(root, "IOConsoleUsers" as CFString, nil, 0)?
        .takeRetainedValue() as? [[String: Any]] else { return ["state": "unknown"] }
    let console = users.filter { boolean($0["kCGSSessionOnConsoleKey"]) == true }
    guard console.count == 1, let user = console.first,
          let uid = user["kCGSSessionUserIDKey"] as? NSNumber,
          let loggedIn = boolean(user["kCGSessionLoginDoneKey"]) else { return ["state": "unknown"] }
    let sameUser = uid.uint32Value == getuid() && getuid() != 0
    let omitted = user["CGSSessionScreenIsLocked"] == nil
    let locked = boolean(user["CGSSessionScreenIsLocked"])
    let state = !loggedIn || !sameUser ? "locked" : omitted ? "unlocked" : locked.map { $0 ? "locked" : "unlocked" } ?? "unknown"
    return ["state": state, "onConsole": true, "loginDone": loggedIn, "sameUser": sameUser,
            "lockFlagOmitted": omitted, "locked": locked.map { $0 as Any } ?? NSNull()]
}
let a = CommandLine.arguments
var receipt: [String: Any] = ["observerPid": getpid(),
    "axTrusted": AXIsProcessTrusted(), "capturePreflight": CGPreflightScreenCaptureAccess(),
    "console": consoleObservation()]
var displays = [CGDirectDisplayID](repeating: 0, count: 16)
var count: UInt32 = 0
let displayResult = CGGetActiveDisplayList(16, &displays, &count)
receipt["display"] = ["queryResult": displayResult.rawValue, "activeCount": count,
                      "mainAsleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0]
if a.count == 3, let pid = Int32(a[1]), pid > 1,
   let id = UInt32(a[2]), id > 0, pid != getpid() {
    receipt["ownerPid"] = pid
    receipt["windowID"] = id
    let target = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(target, 2)
    var windows: CFTypeRef?
    // One targeted read, even when untrusted, to record the actual result rather than
    // treating AXIsProcessTrusted or screen-capture preflight as a cross-process verdict.
    let axResult = AXUIElementCopyAttributeValue(target, kAXWindowsAttribute as CFString, &windows)
    receipt["axQuery"] = ["error": axResult.rawValue, "windowCount": (windows as? [AXUIElement])?.count ?? 0]
    let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(id)) as? [[String: Any]]
    if let match = info?.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }),
       let owner = match[kCGWindowOwnerPID as String] as? NSNumber, owner.int32Value == pid,
       let bounds = match[kCGWindowBounds as String] as? NSDictionary,
       let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) {
        receipt["window"] = ["ownerMatches": true, "onScreen": boolean(match[kCGWindowIsOnscreen as String]) ?? false,
            "bounds": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]]
    } else { receipt["window"] = ["ownerMatches": false] }
} else if !(a.count == 2 && a[1] == "state") { exit(2) }
do {
    let data = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch { exit(3) }
