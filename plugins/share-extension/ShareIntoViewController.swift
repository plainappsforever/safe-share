// Safe Share's iOS share extension (SPEC F1, D16, D41). Replaces expo-sharing's template view controller
// (plugins/with-share-extension.js copies this file over it at prebuild).
//
// What it does, and deliberately nothing more (the extension has a small memory limit, RESEARCH §3.5):
//   1. copies every shared file, streamed by the system (loadFileRepresentation), into
//      <App Group>/SafeShareInbox/<uuid>/<name> — it never reads a file into memory and never cleans anything;
//   2. appends one payload per file to the App Group's UserDefaults (expo-sharing's format, so the app reads it with
//      getSharedPayloads()); earlier payloads that the app has not picked up yet are kept;
//   3. if this build may open the app (SafeShareOpensApp) it asks iOS to open `<scheme>://expo-sharing`. Apple does not
//      officially support this (R2). If it is switched off, not possible, or fails, the extension stays on screen and
//      says the files are saved: Safe Share picks them up the next time it is opened (the fallback path, always built).
import UIKit
import UniformTypeIdentifiers

private let INBOX_FOLDER = "SafeShareInbox"

class ShareIntoViewController: UIViewController {
  private let card = UIView()
  private let titleLabel = UILabel()
  private let messageLabel = UILabel()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let doneButton = UIButton(type: .system)
  private var started = false

  private func infoString(_ key: String) -> String? {
    Bundle.main.object(forInfoDictionaryKey: key) as? String
  }

  private var appName: String { infoString("SafeShareAppName") ?? "Safe Share" }
  private var opensApp: Bool { (Bundle.main.object(forInfoDictionaryKey: "SafeShareOpensApp") as? Bool) ?? false }

  // MARK: - UI

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor.black.withAlphaComponent(0.25)

    card.backgroundColor = .systemBackground
    card.layer.cornerRadius = 16
    card.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(card)

    titleLabel.font = .preferredFont(forTextStyle: .headline)
    titleLabel.adjustsFontForContentSizeCategory = true
    titleLabel.numberOfLines = 0
    titleLabel.textAlignment = .center
    titleLabel.text = appName
    titleLabel.accessibilityIdentifier = "share-ext-title"

    messageLabel.font = .preferredFont(forTextStyle: .body)
    messageLabel.adjustsFontForContentSizeCategory = true
    messageLabel.numberOfLines = 0
    messageLabel.textAlignment = .center
    messageLabel.text = "Preparing the files…"
    messageLabel.accessibilityIdentifier = "share-ext-message"

    doneButton.setTitle("Done", for: .normal)
    doneButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    doneButton.isHidden = true
    doneButton.accessibilityIdentifier = "share-ext-done"
    doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)

    spinner.startAnimating()

    let stack = UIStackView(arrangedSubviews: [titleLabel, spinner, messageLabel, doneButton])
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    card.addSubview(stack)

    NSLayoutConstraint.activate([
      card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      card.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      card.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 20),
      stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16),
      stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
    ])
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    receive()
  }

  private func show(_ message: String) {
    spinner.stopAnimating()
    spinner.isHidden = true
    messageLabel.text = message
    doneButton.isHidden = false
    UIAccessibility.post(notification: .screenChanged, argument: messageLabel)
  }

  @objc private func doneTapped() {
    extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
  }

  // MARK: - Receiving

  private func receive() {
    guard
      let groupId = infoString("AppGroupId"),
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId)
    else {
      show("\(appName) could not receive these files.")
      return
    }
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    let inbox = container.appendingPathComponent(INBOX_FOLDER, isDirectory: true)
    let box = ShareInbox(inbox: inbox, count: providers.count)
    let group = DispatchGroup()
    for (index, provider) in providers.enumerated() {
      group.enter()
      box.save(provider) { payload in
        box.set(index, payload)
        group.leave()
      }
    }
    group.notify(queue: .main) {
      let saved = box.saved
      if saved.isEmpty {
        self.show("\(self.appName) could not receive these files.")
        return
      }
      self.appendPayloads(saved, groupId: groupId)
      let savedMessage = saved.count == 1
        ? "Saved. Open \(self.appName) to check and clean it."
        : "\(saved.count) files saved. Open \(self.appName) to check and clean them."
      guard self.opensApp, let scheme = self.infoString("MainTargetUrlScheme"), let url = URL(string: "\(scheme)://expo-sharing") else {
        self.show(savedMessage)
        return
      }
      self.openHostApp(url) { opened in
        DispatchQueue.main.async {
          if opened {
            self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
          } else {
            self.show(savedMessage)
          }
        }
      }
    }
  }

  /// Keeps payloads the app has not picked up yet (e.g. two shares before opening the app).
  private func appendPayloads(_ added: [SharePayload], groupId: String) {
    guard let defaults = UserDefaults(suiteName: groupId) else { return }
    var all: [SharePayload] = []
    if let data = defaults.data(forKey: SHARE_INTO_DEFAULTS_KEY), let existing = try? JSONDecoder().decode([SharePayload].self, from: data) {
      all = existing
    }
    all.append(contentsOf: added)
    if let encoded = try? JSONEncoder().encode(all) {
      defaults.set(encoded, forKey: SHARE_INTO_DEFAULTS_KEY)
    }
  }

  // MARK: - Opening the app (R2: not officially supported by Apple; the caller falls back to the saved message)

  private func openHostApp(_ url: URL, completion: @escaping (Bool) -> Void) {
    var responder: UIResponder? = self
    while let current = responder {
      if let application = current as? UIApplication {
        application.open(url, options: [:], completionHandler: completion)
        return
      }
      responder = current.next
    }
    completion(false)
  }
}

/// File work for the extension, off the main thread (no UI, no main-actor state). Results are guarded by a lock.
final class ShareInbox: @unchecked Sendable {
  private let inbox: URL
  private let lock = NSLock()
  private var results: [SharePayload?]

  init(inbox: URL, count: Int) {
    self.inbox = inbox
    self.results = [SharePayload?](repeating: nil, count: count)
  }

  func set(_ index: Int, _ payload: SharePayload?) {
    lock.lock()
    results[index] = payload
    lock.unlock()
  }

  var saved: [SharePayload] {
    lock.lock()
    defer { lock.unlock() }
    return results.compactMap { $0 }
  }

  /// The most original file type the provider offers. Photos offers a converted JPEG next to the HEIC original (and
  /// often lists the JPEG first): any other image type wins over JPEG, QuickTime over MPEG-4, then PDF, then any file.
  private func typeFor(_ provider: NSItemProvider) -> (ShareType, String)? {
    let ids = provider.registeredTypeIdentifiers
    func all(conformingTo t: UTType) -> [String] {
      ids.filter { UTType($0)?.conforms(to: t) ?? false }
    }
    let movies = all(conformingTo: .movie)
    if !movies.isEmpty {
      return (.video, movies.first { UTType($0)?.conforms(to: .quickTimeMovie) ?? false } ?? movies[0])
    }
    let images = all(conformingTo: .image)
    if !images.isEmpty {
      return (.image, images.first { !(UTType($0)?.conforms(to: .jpeg) ?? false) } ?? images[0])
    }
    if let id = all(conformingTo: .pdf).first { return (.file, id) }
    if let id = all(conformingTo: .data).first { return (.file, id) }
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) { return (.file, UTType.fileURL.identifier) }
    return nil
  }

  func save(_ provider: NSItemProvider, completion: @escaping (SharePayload?) -> Void) {
    guard let (type, typeId) = typeFor(provider) else {
      completion(nil)
      return
    }
    let folder = inbox.appendingPathComponent(UUID().uuidString, isDirectory: true)
    // Streamed by the system into a temporary file that is valid only inside this handler: copy it before returning.
    provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, _ in
      if let url {
        completion(self.copy(url, name: url.lastPathComponent, type: type, typeId: typeId, into: folder))
        return
      }
      // Some apps only offer an in-memory item; small files only (the extension's memory is limited).
      provider.loadItem(forTypeIdentifier: typeId, options: nil) { item, _ in
        if let url = item as? URL {
          let scoped = url.startAccessingSecurityScopedResource()
          defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          completion(self.copy(url, name: url.lastPathComponent, type: type, typeId: typeId, into: folder))
        } else if let data = item as? Data {
          let ext = UTType(typeId)?.preferredFilenameExtension.map { ".\($0)" } ?? ""
          completion(self.write(data, name: (provider.suggestedName ?? "file") + ext, type: type, typeId: typeId, into: folder))
        } else {
          completion(nil)
        }
      }
    }
  }

  private func cleanName(_ name: String) -> String {
    let trimmed = name.replacingOccurrences(of: "/", with: "_").trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "file" : trimmed
  }

  private func mimeType(for url: URL, typeId: String) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? UTType(typeId)?.preferredMIMEType ?? "application/octet-stream"
  }

  private func copy(_ source: URL, name: String, type: ShareType, typeId: String, into folder: URL) -> SharePayload? {
    let destination = folder.appendingPathComponent(cleanName(name))
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try FileManager.default.copyItem(at: source, to: destination)
    } catch {
      return nil
    }
    return payload(destination, type: type, typeId: typeId)
  }

  private func write(_ data: Data, name: String, type: ShareType, typeId: String, into folder: URL) -> SharePayload? {
    let destination = folder.appendingPathComponent(cleanName(name))
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try data.write(to: destination)
    } catch {
      return nil
    }
    return payload(destination, type: type, typeId: typeId)
  }

  private func payload(_ file: URL, type: ShareType, typeId: String) -> SharePayload {
    let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? nil
    return SharePayload(
      type: type,
      value: file.absoluteString,
      mimeType: mimeType(for: file, typeId: typeId),
      metadata: ShareMetadata(originalName: file.lastPathComponent, size: size)
    )
  }

}
