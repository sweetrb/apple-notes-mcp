// apple-notes-permissions-window
//
// An optional setup window for apple-notes-mcp. It shows the permissions
// checklist that `apple-notes-mcp setup --permissions` prints, with an
// "Open Settings" button per missing grant and a "Re-check" button. It probes
// nothing itself: the TypeScript side runs every check and sends the results,
// so the window and the terminal report always agree. It never reads the Notes
// database, never sends Notes an Apple event, and never changes a setting.
//
// Protocol: JSON lines on stdin and stdout.
//   in:  {"type": "hello"}                  answer the handshake and exit, no UI
//   in:  {"type": "report", "report": {...}} show or refresh the checklist
//   out: {"type": "hello", "protocolVersion": 1, "sourceSha256": "..."}
//   out: {"type": "open", "id": "<item id>"}  the user asked to open that item's pane
//   out: {"type": "recheck"}                  the user asked for a fresh check
// The window closes when stdin ends; closing the window ends the process.
//
// Build (done by `apple-notes-mcp setup --permissions-window`, which also
// generates the one-line source-digest file that defines helperSourceSHA256
// and the Info.plist linked into __TEXT,__info_plist):
//   xcrun swiftc -O -parse-as-library -framework AppKit -framework SwiftUI \
//     -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
//     apple-notes-permissions-window.swift source-digest.swift -o apple-notes-permissions-window

import AppKit
import Foundation
import SwiftUI

let protocolVersion = 1

func send(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

struct Item: Identifiable {
    let id: String
    let title: String
    let status: String
    let required: Bool
    let detail: String
    let settingsPane: String?
    let hasSettings: Bool
    let fix: String?

    init?(_ object: [String: Any]) {
        guard let id = object["id"] as? String, let title = object["title"] as? String,
              let status = object["status"] as? String else { return nil }
        self.id = id
        self.title = title
        self.status = status
        required = object["required"] as? Bool ?? false
        detail = object["detail"] as? String ?? ""
        settingsPane = object["settingsPane"] as? String
        hasSettings = (object["settingsUrl"] as? String)?.hasPrefix("x-apple.systempreferences:") ?? false
        fix = object["fix"] as? String
    }

    var pending: Bool { status == "missing" || status == "unknown" }
}

final class Model: ObservableObject {
    @Published var items: [Item] = []
    @Published var ready = false
    @Published var launchingApp: String?
    @Published var checking = false

    func apply(_ report: [String: Any]) {
        items = (report["items"] as? [[String: Any]] ?? []).compactMap(Item.init)
        ready = report["ready"] as? Bool ?? false
        launchingApp = report["launchingApp"] as? String
        checking = false
    }

    func recheck() {
        checking = true
        send(["type": "recheck"])
    }

    func open(_ item: Item) {
        send(["type": "open", "id": item.id])
    }
}

struct StatusIcon: View {
    let status: String
    var body: some View {
        switch status {
        case "granted", "not_needed":
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case "missing":
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        default:
            Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange)
        }
    }
}

struct ChecklistView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Apple Notes MCP permissions").font(.title2).bold()
            Text(model.launchingApp.map { "Grants shown are for \($0), the app that launched this check." }
                ?? "Grants shown are for the process that launched this check.")
                .font(.callout).foregroundStyle(.secondary)
            ForEach(model.items) { item in
                HStack(alignment: .top, spacing: 10) {
                    StatusIcon(status: item.status).font(.title3)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.required ? item.title : "\(item.title) (optional)").font(.headline)
                        Text(item.detail).font(.callout).fixedSize(horizontal: false, vertical: true)
                        if item.pending, let fix = item.fix {
                            Text(fix).font(.caption).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }
                    Spacer(minLength: 8)
                    if item.pending && item.hasSettings {
                        Button("Open Settings") { model.open(item) }
                            .help(item.settingsPane ?? "")
                    }
                }
            }
            Divider()
            HStack {
                Text(model.ready ? "Every required permission is granted." : "Required permissions are missing.")
                    .font(.callout)
                Spacer()
                if model.checking { ProgressView().controlSize(.small) }
                Button("Re-check") { model.recheck() }
                    .keyboardShortcut("r")
                    .disabled(model.checking)
            }
        }
        .padding(20)
        .frame(width: 620)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = Model()
    var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 420),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Apple Notes MCP Permissions"
        window.contentView = NSHostingView(rootView: ChecklistView(model: model))
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// Reads JSON lines from stdin on a background thread and hands reports to the UI.
func readReports(into delegate: AppDelegate) {
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  message["type"] as? String == "report",
                  let report = message["report"] as? [String: Any] else { continue }
            DispatchQueue.main.async { delegate.model.apply(report) }
        }
        // The server side went away: nothing can re-check any more.
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}

@main
struct PermissionsWindow {
    static func main() {
        guard let first = readLine(strippingNewline: true),
              let data = first.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            exit(2)
        }
        if message["type"] as? String == "hello" {
            send(["type": "hello", "protocolVersion": protocolVersion, "sourceSha256": helperSourceSHA256])
            exit(0)
        }
        guard message["type"] as? String == "report", let report = message["report"] as? [String: Any] else {
            exit(2)
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        delegate.model.apply(report)
        readReports(into: delegate)
        app.run()
    }
}
