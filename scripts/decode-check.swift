// Decode check (A4): every file must still decode with the Mac's own frameworks.
//   images: ImageIO decodes frame 0; video: AVFoundation duration + one frame; PDF: PDFKit page count.
// Usage: swiftc -O scripts/decode-check.swift -o <tmp>/decode-check && <tmp>/decode-check <files...>
// Prints one line per file ("OK ..." / "FAIL ...") and exits 1 if any file fails.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import PDFKit

var failed = false
func report(_ ok: Bool, _ path: String, _ info: String) {
    print("\(ok ? "OK  " : "FAIL") \((path as NSString).lastPathComponent) \(info)")
    if !ok { failed = true }
}

for path in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: path)
    switch url.pathExtension.lowercased() {
    case "mp4", "mov", "m4v":
        let asset = AVURLAsset(url: url)
        let sem = DispatchSemaphore(value: 0)
        var info = "no result", ok = false
        Task {
            do {
                let duration = try await asset.load(.duration).seconds
                let gen = AVAssetImageGenerator(asset: asset)
                gen.appliesPreferredTrackTransform = true
                let (img, _) = try await gen.image(at: CMTime(seconds: min(0.5, duration / 2), preferredTimescale: 600))
                ok = duration > 0 && img.width > 0
                info = String(format: "duration %.2fs frame %dx%d", duration, img.width, img.height)
            } catch { info = "error \(error.localizedDescription)" }
            sem.signal()
        }
        sem.wait()
        report(ok, path, info)
    case "pdf":
        if let doc = PDFDocument(url: url), doc.pageCount > 0, doc.page(at: 0) != nil {
            report(true, path, "pages \(doc.pageCount)")
        } else { report(false, path, "PDFKit could not open") }
    default:
        if let src = CGImageSourceCreateWithURL(url as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
           CGImageSourceGetStatus(src) == .statusComplete {
            report(true, path, "\(img.width)x\(img.height) frames \(CGImageSourceGetCount(src))")
        } else { report(false, path, "ImageIO could not decode") }
    }
}
exit(failed ? 1 : 0)
