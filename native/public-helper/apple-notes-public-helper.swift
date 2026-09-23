// apple-notes-public-helper
//
// A small command-line helper for apple-notes-mcp that uses PUBLIC Apple
// frameworks only. It never opens the Notes database and never writes to the
// Notes group container: the TypeScript server reads the bytes it needs
// (read-only) and hands them over on stdin.
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
//
// Build (done by `apple-notes-mcp setup --public-helper`, which also generates
// the one-line source-digest file that defines helperSourceSHA256 and the
// Info.plist linked into __TEXT,__info_plist; PencilKit needs a bundle id):
//   xcrun swiftc -O -parse-as-library -framework AppKit -framework PencilKit \
//     -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
//     apple-notes-public-helper.swift source-digest.swift -o apple-notes-public-helper

import AppKit
import Foundation
import PencilKit

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

// MARK: - Dispatch

let actions = ["hello", "decode_drawing", "encode_drawing"]

func handle(_ request: [String: Any]) throws -> [String: Any] {
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
    default:
        throw HelperFailure(code: "unknown_action", message: "unknown action")
    }
}

@main
struct PublicHelper {
    static func main() {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        if input.count > maxInputBytes {
            fail(HelperFailure(code: "invalid_request", message: "request exceeds \(maxInputBytes) bytes"))
        }
        guard let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] else {
            fail(HelperFailure(code: "invalid_request", message: "stdin must be one JSON object"))
        }
        do {
            finish(try handle(request))
        } catch let failure as HelperFailure {
            fail(failure)
        } catch {
            fail(HelperFailure(code: "internal_error", message: error.localizedDescription))
        }
    }
}
