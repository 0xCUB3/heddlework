import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count >= 2 else {
    fputs("usage: decode-qr <image>\n", stderr)
    exit(2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url),
      let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cgImage = rep.cgImage else {
    fputs("could not load image\n", stderr)
    exit(1)
}

let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("vision failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}

let payloads = (request.results ?? []).compactMap(\.payloadStringValue)
if payloads.isEmpty {
    fputs("no qr\n", stderr)
    exit(1)
}
// Vision can write framework diagnostics to stdout on CI VMs (ANE compilation warnings), so mark the payload lines.
for payload in payloads {
    print("QR:\(payload)")
}
