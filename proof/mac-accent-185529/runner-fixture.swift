import AppKit
import Foundation

// Proof-only, ordinary unprotected window. No TCC prompts, private capture APIs,
// activation policy changes to other apps, desktop capture, or product code.
final class FixtureView: NSView {
    var phase = "magenta"
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(srgbRed: 31/255, green: 31/255, blue: 31/255, alpha: 1).setFill()
        bounds.fill()
        NSColor.white.setFill()
        NSRect(x: 300, y: 150, width: 200, height: 20).fill()
        let color = phase == "magenta"
            ? NSColor(srgbRed: 224/255, green: 0, blue: 112/255, alpha: 1)
            : NSColor(srgbRed: 0, green: 208/255, blue: 112/255, alpha: 1)
        color.setFill()
        NSRect(x: 580, y: 300, width: 32, height: 32).fill()
    }
}
let arguments = CommandLine.arguments
if arguments.count != 2 { exit(2) }
let root = URL(fileURLWithPath: arguments[1], isDirectory: true)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 640, height: 400),
                      styleMask: [.borderless], backing: .buffered, defer: false)
window.title = "OpenClaw runner diagnostic fixture"
window.isReleasedWhenClosed = false
window.isOpaque = true
window.backgroundColor = .black
window.hasShadow = false
let view = FixtureView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
window.contentView = view
window.orderFrontRegardless()
var published = ""
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    do {
        let url = root.appendingPathComponent("phase.txt")
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        guard let size = size, size.intValue <= 16 else { exit(3) }
        let phase = try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard ["magenta", "green"].contains(phase) else { exit(3) }
        if phase != published {
            view.phase = phase
            view.needsDisplay = true
            window.displayIfNeeded()
            // This is a draw-command acknowledgment, NOT a capture verdict.
            let receipt: [String: Any] = ["pid": getpid(), "windowID": window.windowNumber, "phase": phase]
            try JSONSerialization.data(withJSONObject: receipt).write(to: root.appendingPathComponent("fixture.json"), options: .atomic)
            published = phase
        }
    } catch { fputs("Fixture protocol failed\n", stderr); exit(3) }
}
// Backstop if the Node owner disappears; this process owns no children.
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { exit(4) }
app.run()
