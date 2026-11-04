// Unit-probe boundary doubles only. The owner source is copied verbatim from
// immutable GitHub refs; launchctl is injected, so its process fallback must not run.
import Foundation

struct AppProfile: Sendable {
    static let current = Self()
    let isActive = false
    init(environment: [String: String] = [:]) {
        precondition(environment.isEmpty, "This unit probe models only the default profile")
    }
}
let launchdLabel = "ai.openclaw.mac"
enum CommandResolver {
    static func preferredPaths() -> [String] { ["/usr/bin", "/bin"] }
}
enum OpenClawEnv {
    static func path(_: String) -> String? { nil }
}
enum LogLocator {
    static let launchdLogPath = "/tmp/pr185024-owner-probe-unused.log"
}
enum BoundedProcess {
    struct Result: Sendable { let terminationStatus: Int32 }
    static func run(path: String, arguments: [String], timeout: TimeInterval) async throws -> Result {
        fatalError("The unit probe must use its injected launchctl runner")
    }
}
