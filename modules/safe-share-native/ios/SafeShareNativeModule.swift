import ExpoModulesCore
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Safe Share's local native module (V1_PLAN P6). The TypeScript engine stays the only cleaner; this module adds
/// the platform reader used to verify (PlatformReader.swift), the system photo picker that hands over originals
/// (PHPicker, no library permission) and a share sheet for several files.
public class SafeShareNativeModule: Module {
  private var picker: PickerSession?
  private var sharing = false

  public func definition() -> ModuleDefinition {
    Name("SafeShareNative")

    AsyncFunction("readPlatformMetadata") { (path: String, kind: String) async -> String in
      await PlatformReader.read(path: path, kind: kind)
    }

    // P7.5 (review S6): the copy that video and PDF outputs are patched in is created FRESH: data only, so it carries
    // neither the original's creation/modification dates nor its extended attributes (download URL, quarantine).
    // FileManager.copyItem (expo-file-system's File.copy) keeps both.
    AsyncFunction("copyFresh") { (from: String, to: String) throws in
      let src = URL(string: from)?.path ?? from
      let dst = URL(string: to)?.path ?? to
      try? FileManager.default.removeItem(atPath: dst)
      try FileManager.default.createDirectory(atPath: (dst as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      if copyfile(src, dst, nil, copyfile_flags_t(COPYFILE_DATA)) != 0 {
        let code = errno
        try? FileManager.default.removeItem(atPath: dst)
        throw NSError(domain: "SafeShareNative", code: Int(code), userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(code))])
      }
    }

    // Android-only helpers keep one JS interface; on iOS PHPicker always exists (iOS 14+).
    Function("isPhotoPickerAvailable") { () -> Bool in
      true
    }

    AsyncFunction("pickMedia") { (limit: Int, destDir: String, _: Bool, promise: Promise) in
      guard self.picker == nil else {
        promise.reject("E_BUSY", "The photo picker is already open")
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("E_NO_VIEW", "No view controller to present the picker from")
        return
      }
      // No PHPhotoLibrary in the configuration: the picker runs out of process and needs no library permission.
      var config = PHPickerConfiguration()
      config.filter = .any(of: [.images, .videos])
      config.selectionLimit = max(0, limit)
      // `.current` hands over the stored file (HEIC stays HEIC, videos are not transcoded) with its metadata.
      config.preferredAssetRepresentationMode = .current
      config.selection = .ordered
      let session = PickerSession(dest: PlatformReader.fileURL(destDir)) { [weak self] result in
        self?.picker = nil
        promise.resolve(result)
      }
      self.picker = session
      let vc = PHPickerViewController(configuration: config)
      vc.delegate = session
      presenter.present(vc, animated: true)
    }.runOnQueue(.main)

    AsyncFunction("shareFiles") { (uris: [String], _: [String], _: String, promise: Promise) in
      guard !self.sharing else {
        promise.reject("E_BUSY", "The share sheet is already open")
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("E_NO_VIEW", "No view controller to present the share sheet from")
        return
      }
      let urls = uris.map { PlatformReader.fileURL($0) }
      let vc = UIActivityViewController(activityItems: urls, applicationActivities: nil)
      var resolved = false
      vc.completionWithItemsHandler = { [weak self] _, completed, _, _ in
        guard !resolved else { return }
        resolved = true
        self?.sharing = false
        promise.resolve(completed)
      }
      if let pop = vc.popoverPresentationController {
        pop.sourceView = presenter.view
        pop.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 80, width: 1, height: 1)
      }
      self.sharing = true
      presenter.present(vc, animated: true)
    }.runOnQueue(.main)
  }
}

/// One PHPicker run: copies every picked item's original file into `dest` (inside the app's work folder) in pick order.
final class PickerSession: NSObject, PHPickerViewControllerDelegate {
  private let dest: URL
  private let done: ([[String: Any]]) -> Void

  init(dest: URL, done: @escaping ([[String: Any]]) -> Void) {
    self.dest = dest
    self.done = done
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    if results.isEmpty {
      done([])
      return
    }
    try? FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
    var out = [[String: Any]?](repeating: nil, count: results.count)
    let group = DispatchGroup()
    let lock = NSLock()
    for (i, r) in results.enumerated() {
      group.enter()
      copy(r.itemProvider, index: i) { item in
        lock.lock()
        out[i] = item
        lock.unlock()
        group.leave()
      }
    }
    group.notify(queue: .main) {
      self.done(out.map { $0 ?? ["error": "could not be read"] })
    }
  }

  /// The most original type the provider offers: a movie type (QuickTime first), else an image type other than a
  /// converted JPEG (same rule as the share extension, P5).
  private func typeFor(_ provider: NSItemProvider) -> String? {
    let ids = provider.registeredTypeIdentifiers
    func all(_ t: UTType) -> [String] { ids.filter { UTType($0)?.conforms(to: t) ?? false } }
    let movies = all(.movie)
    if !movies.isEmpty { return movies.first { UTType($0)?.conforms(to: .quickTimeMovie) ?? false } ?? movies[0] }
    let images = all(.image)
    if !images.isEmpty { return images.first { !(UTType($0)?.conforms(to: .jpeg) ?? false) } ?? images[0] }
    return ids.first
  }

  private func copy(_ provider: NSItemProvider, index: Int, completion: @escaping ([String: Any]) -> Void) {
    guard let typeId = typeFor(provider) else {
      completion(["error": "no file type"])
      return
    }
    // The system streams the file to a temporary URL that is valid only inside this handler.
    _ = provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, error in
      guard let url else {
        completion(["error": error?.localizedDescription ?? "no file"])
        return
      }
      let ext = url.pathExtension.isEmpty ? (UTType(typeId)?.preferredFilenameExtension ?? "") : url.pathExtension
      var base = provider.suggestedName ?? url.deletingPathExtension().lastPathComponent
      base = base.replacingOccurrences(of: "/", with: "_")
      if base.isEmpty { base = "file" }
      let name = ext.isEmpty ? base : "\(base).\(ext)"
      let target = self.dest.appendingPathComponent("\(index)-\(name)")
      do {
        if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
        try FileManager.default.copyItem(at: url, to: target)
        completion(["path": target.absoluteString, "name": name, "type": typeId])
      } catch {
        completion(["error": error.localizedDescription, "name": name])
      }
    }
  }
}
