// Decode QR symbols out of a PNG, with Apple's Vision framework.
//
// This is the *independent* half of `tools/qa-qr.mjs`: the encoder in `src/net/qr.ts` is ours
// and a test that read it back with our own code would only prove the code agrees with itself.
// Vision is the decoder an iPhone camera uses, which is the decoder this product is actually
// aimed at — so a symbol that Vision reads off a rendered image is a symbol a guest can scan.
//
// Usage:  swift tools/lib/qr-decode.swift <file.png> [...]
// Prints one JSON line per file: {"file":"...","payloads":["..."]}
//
// Interpreted rather than compiled on purpose. `swiftc` writes a binary somebody then has to
// own, cache and invalidate; `swift <file>` costs about two seconds once per gate run and
// leaves nothing behind.

import Foundation
import Vision
import CoreImage

func payloads(of path: String) -> [String] {
    guard let img = CIImage(contentsOf: URL(fileURLWithPath: path)) else { return [] }
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    let handler = VNImageRequestHandler(ciImage: img, options: [:])
    do { try handler.perform([request]) } catch { return [] }
    let found = request.results ?? []
    return found.compactMap { $0.payloadStringValue }
}

var out: [String] = []
for path in CommandLine.arguments.dropFirst() {
    let list = payloads(of: path)
    let data = try! JSONSerialization.data(withJSONObject: ["file": path, "payloads": list])
    out.append(String(data: data, encoding: .utf8)!)
}
print(out.joined(separator: "\n"))
