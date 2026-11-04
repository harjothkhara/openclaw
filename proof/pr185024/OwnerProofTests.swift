import Foundation
import Testing
@testable import OwnerProof

@MainActor
struct OwnerProofTests {
    @Test func failedBootstrapIsNotApplied() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let plist = directory.appendingPathComponent("login.plist")
        let manager = LaunchAgentManager(plistURL: plist) { arguments in
            switch arguments.first {
            case "print": 113
            case "bootstrap": 5
            default: 0
            }
        }
        let applied = await manager.set(
            enabled: true, bundlePath: "/Applications/OpenClaw.app", profile: .current).value
        #expect(!applied)
        #expect(!FileManager.default.fileExists(atPath: plist.path))
    }

    @Test func failedInspectionPreservesExistingPlist() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let plist = directory.appendingPathComponent("login.plist")
        let original = try LaunchAgentManager.plistContents(
            bundlePath: "/Applications/Existing.app", preferredPaths: ["/usr/bin"])
        try original.write(to: plist)
        let manager = LaunchAgentManager(plistURL: plist) { _ in 5 }
        let applied = await manager.set(
            enabled: true, bundlePath: "/Applications/OpenClaw.app", profile: .current).value
        #expect(!applied)
        #expect(try Data(contentsOf: plist) == original)
    }
}
