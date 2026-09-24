// apple-notes-public-helper
//
// A small command-line helper for apple-notes-mcp that uses PUBLIC Apple
// frameworks only. It never opens the Notes database and never writes to the
// Notes group container: the TypeScript server reads the bytes it needs
// (read-only) and hands them over on stdin, or names an audio file that the
// helper opens for reading only.
//
// Protocol: one JSON object on stdin, one JSON object on stdout.
//   request:  {"protocol": 1, "action": "<name>", ...fields}
//   success:  {"status": "ok", ...}
//   failure:  {"status": "error", "code": "<code>", "message": "<text>"}
//
// Actions:
//   hello           protocol version, embedded source digest, action list
//   decode_drawing  PencilKit drawing bytes (base64) -> strokes
//   encode_drawing  strokes -> PencilKit drawing bytes (base64); used to build
//                   synthetic test fixtures, never to write to Notes
//   transcribe      on-device Speech transcription of one audio file
//
// Build (done by `apple-notes-mcp setup --public-helper`, which also generates
// the one-line source-digest file that defines helperSourceSHA256 and the
// Info.plist linked into __TEXT,__info_plist; PencilKit needs a bundle id):
//   xcrun swiftc -O -parse-as-library -framework AppKit -framework PencilKit \
//     -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
//     apple-notes-public-helper.swift source-digest.swift -o apple-notes-public-helper

import AVFoundation
import AppKit
import Foundation
import PencilKit
import Speech

let protocolVersion = 1
let maxInputBytes = 96 * 1024 * 1024
let maxStrokes = 20_000
let maxPoints = 1_000_000

// MARK: - Output

struct HelperFailure: Error {
    let code: String
    let message: String
}

func writeJSON(_ object: [String: Any]) {
    let data: Data
    if JSONSerialization.isValidJSONObject(object),
       let encoded = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        data = encoded
    } else {
        data = Data(#"{"code":"encode_failed","message":"response was not JSON-encodable","status":"error"}"#.utf8)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func finish(_ object: [String: Any]) -> Never {
    writeJSON(object)
    exit(object["status"] as? String == "ok" ? 0 : 1)
}

func fail(_ failure: HelperFailure) -> Never {
    finish(["status": "error", "code": failure.code, "message": failure.message])
}

/// Round to two decimals so large drawings stay compact on the wire.
func rounded(_ value: CGFloat) -> Double {
    (Double(value) * 100).rounded() / 100
}

// MARK: - Drawings

func rgba(_ color: NSColor) -> [String: Any] {
    let srgb = color.usingColorSpace(.sRGB) ?? color
    func channel(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
    return [
        "red": channel(srgb.redComponent),
        "green": channel(srgb.greenComponent),
        "blue": channel(srgb.blueComponent),
        "alpha": rounded(srgb.alphaComponent),
    ]
}

func decodeDrawing(_ request: [String: Any]) throws -> [String: Any] {
    guard let encoded = request["dataBase64"] as? String,
          let data = Data(base64Encoded: encoded)
    else { throw HelperFailure(code: "invalid_request", message: "dataBase64 is required") }
    if data.isEmpty { throw HelperFailure(code: "invalid_request", message: "drawing data is empty") }
    let includePoints = request["includePoints"] as? Bool ?? true

    let drawing: PKDrawing
    do {
        drawing = try PKDrawing(data: data)
    } catch {
        throw HelperFailure(
            code: "undecodable",
            message: "PencilKit could not read this drawing: \(error.localizedDescription)"
        )
    }

    var strokes: [[String: Any]] = []
    var pointBudget = maxPoints
    var truncated = false
    for stroke in drawing.strokes {
        if strokes.count >= maxStrokes || pointBudget <= 0 {
            truncated = true
            break
        }
        let path = stroke.path
        let transform = stroke.transform
        var points: [[String: Any]] = []
        var widthSum: CGFloat = 0
        var count = 0
        for point in path {
            count += 1
            widthSum += point.size.width
            if includePoints {
                if pointBudget <= 0 {
                    truncated = true
                    break
                }
                pointBudget -= 1
                let location = point.location.applying(transform)
                points.append([
                    "x": rounded(location.x),
                    "y": rounded(location.y),
                    "width": rounded(point.size.width),
                    "opacity": rounded(point.opacity),
                    "force": rounded(point.force),
                ])
            }
        }
        let bounds = stroke.renderBounds
        var entry: [String: Any] = [
            "inkType": stroke.ink.inkType.rawValue,
            "color": rgba(stroke.ink.color),
            "width": count > 0 ? rounded(widthSum / CGFloat(count)) : 0,
            "pointCount": count,
            "bounds": [
                "x": rounded(bounds.origin.x), "y": rounded(bounds.origin.y),
                "width": rounded(bounds.size.width), "height": rounded(bounds.size.height),
            ],
        ]
        if includePoints { entry["points"] = points }
        if !transform.isIdentity { entry["transformApplied"] = true }
        strokes.append(entry)
    }
    let bounds = drawing.bounds
    return [
        "status": "ok",
        "strokeCount": drawing.strokes.count,
        "strokes": strokes,
        "truncated": truncated,
        "bounds": [
            "x": rounded(bounds.origin.x), "y": rounded(bounds.origin.y),
            "width": rounded(bounds.size.width), "height": rounded(bounds.size.height),
        ],
    ]
}

func inkType(named name: String) -> PKInk.InkType {
    switch name {
    case "com.apple.ink.marker", "marker": return .marker
    case "com.apple.ink.pencil", "pencil": return .pencil
    default: return .pen
    }
}

func encodeDrawing(_ request: [String: Any]) throws -> [String: Any] {
    guard let specs = request["strokes"] as? [[String: Any]], !specs.isEmpty else {
        throw HelperFailure(code: "invalid_request", message: "strokes must be a non-empty array")
    }
    if specs.count > maxStrokes {
        throw HelperFailure(code: "invalid_request", message: "too many strokes")
    }
    var strokes: [PKStroke] = []
    let created = Date(timeIntervalSince1970: 0)
    for spec in specs {
        guard let rawPoints = spec["points"] as? [[String: Any]], rawPoints.count >= 2 else {
            throw HelperFailure(code: "invalid_request", message: "each stroke needs at least two points")
        }
        let width = CGFloat((spec["width"] as? NSNumber)?.doubleValue ?? 3)
        let color = spec["color"] as? [String: Any] ?? [:]
        func component(_ key: String, _ fallback: Double) -> CGFloat {
            CGFloat((color[key] as? NSNumber)?.doubleValue ?? fallback)
        }
        let ink = PKInk(
            inkType(named: spec["inkType"] as? String ?? "pen"),
            color: NSColor(
                srgbRed: component("red", 0) / 255,
                green: component("green", 0) / 255,
                blue: component("blue", 0) / 255,
                alpha: component("alpha", 1)
            )
        )
        let last = Double(rawPoints.count - 1)
        let controlPoints = rawPoints.enumerated().map { index, point in
            PKStrokePoint(
                location: CGPoint(
                    x: (point["x"] as? NSNumber)?.doubleValue ?? 0,
                    y: (point["y"] as? NSNumber)?.doubleValue ?? 0
                ),
                timeOffset: Double(index) / last,
                size: CGSize(width: width, height: width),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        strokes.append(PKStroke(ink: ink, path: PKStrokePath(controlPoints: controlPoints, creationDate: created)))
    }
    let data = PKDrawing(strokes: strokes).dataRepresentation()
    return ["status": "ok", "strokeCount": strokes.count, "dataBase64": data.base64EncodedString()]
}

// MARK: - Transcription
//
// On-device only. On macOS 26 and later, SpeechAnalyzer with SpeechTranscriber
// runs entirely on the Mac (its language model is a local asset). On older
// systems, SFSpeechRecognizer is used with requiresOnDeviceRecognition = true,
// and a locale without on-device support is refused rather than sent to a
// server. The helper stops at its own deadline and returns what it has with
// complete = false, so the caller can report a partial transcript.

/// Final transcript segments gathered so far; an actor so the deadline path can read them.
actor TranscriptCollector {
    private var segments: [String] = []
    func add(_ segment: String) { segments.append(segment) }
    func text() -> String { segments.joined(separator: " ") }
    func isEmpty() -> Bool { segments.isEmpty }
}

/// The newest partial result (legacy recognizer), guarded by a lock because the
/// recognizer calls back on its own queue.
final class LatestText: @unchecked Sendable {
    private let lock = NSLock()
    private var value = ""
    func set(_ text: String) { lock.withLock { value = text } }
    func get() -> String { lock.withLock { value } }
}

enum RaceOutcome {
    case completed
    case failed(Error)
    case timedOut
}

/// Resumes a continuation exactly once, whichever side of a race finishes first.
final class RaceGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<RaceOutcome, Never>?
    private var expired = false
    init(_ continuation: CheckedContinuation<RaceOutcome, Never>) { self.continuation = continuation }
    /// Called when the deadline passes, before `stop`: whatever `work` reports
    /// afterwards (usually a cancellation error) is a timeout, not a failure.
    func expire() { lock.withLock { expired = true } }
    func resume(_ outcome: RaceOutcome) {
        let (pending, final): (CheckedContinuation<RaceOutcome, Never>?, RaceOutcome) = lock.withLock {
            defer { continuation = nil }
            return (continuation, expired ? .timedOut : outcome)
        }
        pending?.resume(returning: final)
    }
}

/// Runs `work` against a deadline without waiting for it after the deadline:
/// some framework calls (asset downloads) ignore cancellation, and the process
/// exits right after it answers anyway. On timeout, `stop` runs first so a
/// cooperative `work` can hand back what it has.
func race(
    seconds: Double,
    work: @escaping @Sendable () async throws -> Void,
    stop: @escaping @Sendable () async -> Void
) async -> RaceOutcome {
    await withCheckedContinuation { continuation in
        let gate = RaceGate(continuation)
        Task {
            do {
                try await work()
                gate.resume(.completed)
            } catch {
                gate.resume(.failed(error))
            }
        }
        Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            gate.expire()
            await stop()
            gate.resume(.timedOut)
        }
    }
}

func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

// Speech Recognition access. The helper runs under an MCP server that nobody
// may be watching, so it never calls SFSpeechRecognizer.requestAuthorization:
// a system prompt would block the helper until the server killed it. It reads
// the current status instead and stops with `permission_required` when the
// engine it is about to use needs a grant that is missing.

/// The failure returned instead of prompting. The grant belongs to the app that
/// runs the MCP server (Claude, a terminal, ...), which macOS treats as responsible.
func permissionRequired(_ status: SFSpeechRecognizerAuthorizationStatus) -> HelperFailure {
    let settings = "System Settings > Privacy & Security > Speech Recognition"
    let detail: String
    switch status {
    case .denied:
        detail = "Speech Recognition access was denied for the app running this server. Turn it on in \(settings), then try again."
    case .restricted:
        detail = "Speech Recognition is restricted on this Mac (for example by a device management profile), so it cannot be used."
    default:
        detail = "Speech Recognition access has not been granted to the app running this server, and the server never shows the permission prompt. Allow the app in \(settings), then try again."
    }
    return HelperFailure(code: "permission_required", message: detail)
}

/// Stops before any Speech call when access is missing. The legacy recognizer
/// needs `.authorized`. SpeechAnalyzer (macOS 26+) runs on-device without a
/// grant and does not prompt, so there only an explicit refusal (`.denied` or
/// `.restricted`) stops it; that also covers a future macOS that gates it.
func checkSpeechAccess(requireGrant: Bool) throws {
    let status = SFSpeechRecognizer.authorizationStatus()
    if status == .authorized { return }
    if requireGrant || status == .denied || status == .restricted {
        throw permissionRequired(status)
    }
}

/// Maps a Speech error to a stable code. Permission is decided from the
/// explicit authorization status, never from the error's text.
func speechFailure(_ error: Error, requireGrant: Bool) -> HelperFailure {
    if let failure = error as? HelperFailure { return failure }
    do {
        try checkSpeechAccess(requireGrant: requireGrant)
    } catch let failure as HelperFailure {
        return failure
    } catch {}
    return HelperFailure(code: "transcription_failed", message: error.localizedDescription)
}

/// Makes sure the locale's on-device model is installed. A download starts only
/// when the caller opted in: otherwise a missing model is `asset_unavailable` at once.
@available(macOS 26, *)
func ensureSpeechAssets(_ transcriber: SpeechTranscriber, localeID: String, allowDownload: Bool) async throws {
    switch await AssetInventory.status(forModules: [transcriber]) {
    case .installed:
        return
    case .unsupported:
        throw HelperFailure(code: "unsupported_locale", message: "No on-device speech model for \(localeID)")
    case .downloading where !allowDownload:
        throw HelperFailure(
            code: "asset_unavailable",
            message: "macOS is still downloading the on-device speech model for \(localeID); try again shortly"
        )
    default:
        if !allowDownload {
            throw HelperFailure(
                code: "asset_unavailable",
                message: "The on-device speech model for \(localeID) is not installed. Retry with downloadAssets: true to let macOS download it."
            )
        }
    }
    guard let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
        return
    }
    let outcome = await race(seconds: 90, work: { try await installation.downloadAndInstall() }, stop: {})
    switch outcome {
    case .completed:
        return
    case .failed(let error):
        throw HelperFailure(
            code: "asset_unavailable",
            message: "Could not install the on-device speech model for \(localeID): \(error.localizedDescription)"
        )
    case .timedOut:
        throw HelperFailure(
            code: "asset_unavailable",
            message: "The on-device speech model for \(localeID) is still downloading; try again shortly"
        )
    }
}

@available(macOS 26, *)
func transcribeWithAnalyzer(
    file: AVAudioFile, localeID: String, deadline: Double, allowDownload: Bool
) async throws -> [String: Any] {
    try checkSpeechAccess(requireGrant: false)
    guard SpeechTranscriber.isAvailable else {
        throw HelperFailure(code: "speech_unavailable", message: "On-device transcription is not available on this Mac")
    }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeID)) else {
        throw HelperFailure(code: "unsupported_locale", message: "No on-device transcription for \(localeID)")
    }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    try await ensureSpeechAssets(transcriber, localeID: localeID, allowDownload: allowDownload)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collector = TranscriptCollector()
    let reader = Task {
        for try await result in transcriber.results where result.isFinal {
            let segment = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !segment.isEmpty { await collector.add(segment) }
        }
    }
    let outcome = await race(
        seconds: deadline,
        work: {
            _ = try await analyzer.analyzeSequence(from: file)
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            try await reader.value
        },
        stop: {
            await analyzer.cancelAndFinishNow()
            reader.cancel()
        }
    )
    var response: [String: Any] = ["status": "ok", "engine": "SpeechAnalyzer", "locale": locale.identifier(.bcp47)]
    switch outcome {
    case .completed:
        response["complete"] = true
    case .timedOut:
        response["complete"] = false
        response["stopReason"] = "deadline"
    case .failed(let error):
        await analyzer.cancelAndFinishNow()
        reader.cancel()
        let failure = speechFailure(error, requireGrant: false)
        if await collector.isEmpty() { throw failure }
        response["complete"] = false
        response["stopReason"] = failure.message
    }
    response["transcript"] = await collector.text()
    return response
}

/// Pre-macOS 26 path: SFSpeechRecognizer, forced on-device. It needs a Speech
/// Recognition grant, which is checked here and never requested.
func transcribeWithRecognizer(url: URL, localeID: String, deadline: Double) async throws -> [String: Any] {
    try checkSpeechAccess(requireGrant: true)
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeID)) else {
        throw HelperFailure(code: "unsupported_locale", message: "No speech recognizer for \(localeID)")
    }
    guard recognizer.supportsOnDeviceRecognition else {
        throw HelperFailure(code: "unsupported_locale", message: "No on-device recognition for \(localeID)")
    }
    recognizer.queue = OperationQueue()
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    let latest = LatestText()
    final class TaskBox: @unchecked Sendable { var task: SFSpeechRecognitionTask? }
    let box = TaskBox()
    let outcome = await race(
        seconds: deadline,
        work: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                var resumed = false
                box.task = recognizer.recognitionTask(with: request) { result, error in
                    if resumed { return }
                    if let result {
                        latest.set(result.bestTranscription.formattedString)
                        if result.isFinal {
                            resumed = true
                            continuation.resume()
                            return
                        }
                    }
                    if let error {
                        resumed = true
                        continuation.resume(throwing: error)
                    }
                }
            }
        },
        stop: { box.task?.cancel() }
    )
    // Partial results replace each other; the newest one is the transcript so far.
    let transcript = await latest.get()
    var response: [String: Any] = ["status": "ok", "engine": "SFSpeechRecognizer", "locale": localeID]
    switch outcome {
    case .completed:
        response["complete"] = true
    case .timedOut:
        response["complete"] = false
        response["stopReason"] = "deadline"
    case .failed(let error):
        let failure = speechFailure(error, requireGrant: true)
        if transcript.isEmpty { throw failure }
        response["complete"] = false
        response["stopReason"] = failure.message
    }
    response["transcript"] = transcript
    return response
}

func transcribe(_ request: [String: Any]) async throws -> [String: Any] {
    guard let path = request["path"] as? String, path.hasPrefix("/") else {
        throw HelperFailure(code: "invalid_request", message: "path must be an absolute file path")
    }
    let localeID = request["locale"] as? String ?? "en-US"
    let deadline = min(max((request["timeoutSeconds"] as? NSNumber)?.doubleValue ?? 300, 5), 3600)
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
        throw HelperFailure(code: "file_not_found", message: "The audio file does not exist")
    }
    let url = URL(fileURLWithPath: path)
    let file: AVAudioFile
    do {
        file = try AVAudioFile(forReading: url)
    } catch {
        throw HelperFailure(code: "unsupported_audio", message: "Could not read the audio: \(error.localizedDescription)")
    }
    let duration = file.fileFormat.sampleRate > 0 ? Double(file.length) / file.fileFormat.sampleRate : 0
    var response: [String: Any]
    if #available(macOS 26, *) {
        response = try await transcribeWithAnalyzer(
            file: file, localeID: localeID, deadline: deadline,
            allowDownload: request["downloadAssets"] as? Bool ?? false
        )
    } else {
        response = try await transcribeWithRecognizer(url: url, localeID: localeID, deadline: deadline)
    }
    response["durationSeconds"] = Int(duration.rounded())
    response["speechAuthorization"] = authorizationName(SFSpeechRecognizer.authorizationStatus())
    return response
}

// MARK: - Dispatch

let actions = ["hello", "decode_drawing", "encode_drawing", "transcribe"]

func handle(_ request: [String: Any]) async throws -> [String: Any] {
    guard (request["protocol"] as? NSNumber)?.intValue == protocolVersion else {
        throw HelperFailure(code: "protocol_mismatch", message: "expected protocol \(protocolVersion)")
    }
    switch request["action"] as? String {
    case "hello":
        return [
            "status": "ok",
            "protocolVersion": protocolVersion,
            "sourceSha256": helperSourceSHA256,
            "actions": actions,
        ]
    case "decode_drawing":
        return try decodeDrawing(request)
    case "encode_drawing":
        return try encodeDrawing(request)
    case "transcribe":
        return try await transcribe(request)
    default:
        throw HelperFailure(code: "unknown_action", message: "unknown action")
    }
}

@main
struct PublicHelper {
    static func main() async {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        if input.count > maxInputBytes {
            fail(HelperFailure(code: "invalid_request", message: "request exceeds \(maxInputBytes) bytes"))
        }
        guard let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] else {
            fail(HelperFailure(code: "invalid_request", message: "stdin must be one JSON object"))
        }
        do {
            finish(try await handle(request))
        } catch let failure as HelperFailure {
            fail(failure)
        } catch {
            fail(HelperFailure(code: "internal_error", message: error.localizedDescription))
        }
    }
}
