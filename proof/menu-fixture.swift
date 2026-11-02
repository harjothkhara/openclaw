import AppKit
import SwiftUI

@MainActor
private func record(_ action: String, key: String) {
    let event: [String: Any] = [
        "action": action,
        "key": key,
        "pid": ProcessInfo.processInfo.processIdentifier,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

@main
struct MenuFixtureApp: App {
    var body: some Scene {
        WindowGroup("Native menu fixture") {
            MenuFixtureView()
                .frame(minWidth: 640, minHeight: 400)
        }
    }
}

private struct MenuFixtureView: View {
    @State private var sessionKey = "fixture/main"

    var body: some View {
        Text(sessionKey)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("New Thread") {
                            sessionKey = "fixture/new"
                            record("new", key: sessionKey)
                        }
                        Button("Copy Session Key") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(sessionKey, forType: .string)
                            record("copy-key", key: sessionKey)
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .help("Thread actions")
                }
            }
            .onAppear {
                NSApp.setActivationPolicy(.regular)
                DispatchQueue.main.async {
                    NSApp.windows.first?.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                    record("ready", key: sessionKey)
                }
            }
    }
}
