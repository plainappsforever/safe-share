import AVFoundation
import Foundation
import ImageIO
import PDFKit

/// The platform's own metadata readers (SPEC F4, D11 reader 3). They share no code with the TypeScript engine and are used
/// only to VERIFY a cleaned copy: ImageIO for images, AVFoundation for videos, PDFKit for PDFs. Output is a flat list of
/// {d: directory, t: tag, v: value} entries as JSON; `src/lib/platform-reader.ts` maps them to catalogue fields.
enum PlatformReader {
  struct ReadError: Error, CustomStringConvertible {
    let description: String
  }

  static func read(path: String, kind: String) async -> String {
    let url = fileURL(path)
    var out: [String: Any] = ["supported": true]
    var entries: [[String: String]] = []
    do {
      switch kind {
      case "image":
        out["reader"] = "ImageIO"
        try readImage(url, into: &entries)
      case "video":
        out["reader"] = "AVFoundation"
        try await readVideo(url, into: &entries)
      case "pdf":
        out["reader"] = "PDFKit"
        try readPdf(url, into: &entries)
      default:
        out["reader"] = "none"
        out["supported"] = false
      }
    } catch {
      out["error"] = "\(error)"
    }
    out["entries"] = entries
    guard let data = try? JSONSerialization.data(withJSONObject: out),
          let json = String(data: data, encoding: .utf8) else {
      return "{\"supported\":true,\"reader\":\"none\",\"entries\":[],\"error\":\"could not encode\"}"
    }
    return json
  }

  static func fileURL(_ path: String) -> URL {
    if path.hasPrefix("file://"), let u = URL(string: path) { return u }
    return URL(fileURLWithPath: path)
  }

  // MARK: ImageIO

  private static func readImage(_ url: URL, into entries: inout [[String: String]]) throws {
    let opts = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let src = CGImageSourceCreateWithURL(url as CFURL, opts) else {
      throw ReadError(description: "ImageIO could not open the file")
    }
    let count = CGImageSourceGetCount(src)
    if count == 0 { throw ReadError(description: "ImageIO found no image in the file") }
    if let type = CGImageSourceGetType(src) { entries.append(["d": "source", "t": "type", "v": type as String]) }
    if let container = CGImageSourceCopyProperties(src, nil) as? [String: Any] {
      flatten(container, dir: "container", into: &entries)
    }
    for i in 0..<min(count, 16) {
      if let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [String: Any] {
        flatten(props, dir: "image\(i)", into: &entries)
      }
      // ImageIO's unified metadata tree: XMP plus its own view of Exif/TIFF/GPS/IPTC under their XMP prefixes.
      if let md = CGImageSourceCopyMetadataAtIndex(src, i, nil) {
        let enumOpts = [kCGImageMetadataEnumerateRecursively: true] as CFDictionary
        var tags: [[String: String]] = []
        CGImageMetadataEnumerateTagsUsingBlock(md, nil, enumOpts) { path, tag in
          let value = CGImageMetadataTagCopyValue(tag)
          // Arrays and structures are listed again as their children; only leaf values are recorded.
          if let s = value as? String {
            tags.append(["d": "metadata\(i)", "t": path as String, "v": s])
          }
          return true
        }
        entries.append(contentsOf: tags)
      }
    }
  }

  // MARK: AVFoundation

  private static func readVideo(_ url: URL, into entries: inout [[String: String]]) async throws {
    let asset = AVURLAsset(url: url)
    let formats = try await asset.load(.availableMetadataFormats)
    for f in formats {
      for item in try await asset.loadMetadata(for: f) {
        entries.append(await entry(item, dir: "asset:\(f.rawValue)"))
      }
    }
    if let created = try await asset.load(.creationDate) {
      entries.append(await entry(created, dir: "asset:creationDate"))
    }
    for track in try await asset.load(.tracks) {
      for f in try await track.load(.availableMetadataFormats) {
        for item in try await track.loadMetadata(for: f) {
          entries.append(await entry(item, dir: "track\(track.trackID):\(f.rawValue)"))
        }
      }
    }
  }

  private static func entry(_ item: AVMetadataItem, dir: String) async -> [String: String] {
    var tag = item.identifier?.rawValue ?? ""
    if tag.isEmpty, let key = item.key { tag = "\(key)" }
    var value = ""
    if let s = try? await item.load(.stringValue) {
      value = s
    } else if let d = try? await item.load(.dateValue) {
      value = iso(d)
    } else if let n = try? await item.load(.numberValue) {
      value = n.stringValue
    } else if let data = try? await item.load(.dataValue) {
      value = "<\(data.count) bytes>"
    }
    return ["d": dir, "t": tag, "v": value]
  }

  // MARK: PDFKit

  private static func readPdf(_ url: URL, into entries: inout [[String: String]]) throws {
    guard let doc = PDFDocument(url: url) else { throw ReadError(description: "PDFKit could not open the file") }
    if doc.isLocked { throw ReadError(description: "PDFKit: the document is locked") }
    entries.append(["d": "document", "t": "pageCount", "v": String(doc.pageCount)])
    for (k, v) in doc.documentAttributes ?? [:] {
      entries.append(["d": "PDF", "t": "\(k.base)", "v": stringify(v)])
    }
  }

  // MARK: helpers

  private static func flatten(_ dict: [String: Any], dir: String, into entries: inout [[String: String]]) {
    for (k, v) in dict {
      if let sub = v as? [String: Any] {
        flatten(sub, dir: "\(dir).\(k)", into: &entries)
      } else {
        entries.append(["d": dir, "t": k, "v": stringify(v)])
      }
    }
  }

  private static func stringify(_ v: Any) -> String {
    switch v {
    case let s as String: return s
    case let n as NSNumber: return n.stringValue
    case let d as Date: return iso(d)
    case let data as Data: return "<\(data.count) bytes>"
    case let a as [Any]: return a.map { stringify($0) }.joined(separator: ", ")
    case let dict as [String: Any]: return dict.map { "\($0.key)=\(stringify($0.value))" }.sorted().joined(separator: "; ")
    default: return String(describing: v)
    }
  }

  private static func iso(_ d: Date) -> String {
    ISO8601DateFormatter().string(from: d)
  }
}
