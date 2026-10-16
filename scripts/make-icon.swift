// Generates the app icon, adaptive-icon layers, splash glyph and favicon: a shield over a photo (V1_PLAN P7).
// Usage: swift scripts/make-icon.swift   (writes into assets/images/ and assets/expo.icon/Assets/; outputs are committed)
// Plain CoreGraphics, no dependencies.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()
let images = root.appendingPathComponent("assets/images")
let iconAssets = root.appendingPathComponent("assets/expo.icon/Assets")
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(colorSpace: space, components: [CGFloat((hex >> 16) & 255) / 255, CGFloat((hex >> 8) & 255) / 255, CGFloat(hex & 255) / 255, a])!
}

enum Look { case colour, mono }

/// New square canvas with a top-left origin. `opaque` = no alpha channel (the iOS store icon must have none).
func canvas(_ size: Int, opaque: Bool = false) -> CGContext {
  let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info)!
  ctx.translateBy(x: 0, y: CGFloat(size))
  ctx.scaleBy(x: 1, y: -1)
  return ctx
}

func save(_ ctx: CGContext, _ url: URL) {
  let image = ctx.makeImage()!
  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
  print("wrote \(url.path.replacingOccurrences(of: root.path + "/", with: ""))")
}

func resized(_ ctx: CGContext, to size: Int) -> CGContext {
  let out = canvas(size)
  out.interpolationQuality = .high
  out.translateBy(x: 0, y: CGFloat(size))
  out.scaleBy(x: 1, y: -1)
  out.draw(ctx.makeImage()!, in: CGRect(x: 0, y: 0, width: size, height: size))
  return out
}

func background(_ ctx: CGContext, _ size: CGFloat) {
  let gradient = CGGradient(colorsSpace: space, colors: [rgb(0x0A5FC4), rgb(0x3D98F5)] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: size, y: size), options: [])
}

func roundedRect(_ r: CGRect, _ radius: CGFloat) -> CGPath { CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil) }

/// The shield-over-photo glyph, drawn in a 1024 x 1024 design space and scaled into `box`.
/// Colour: white photo with a sky, sun and hills; white shield with a green check. Mono: white silhouette with cut-outs (Android themed icon).
func glyph(_ ctx: CGContext, in box: CGRect, _ look: Look) {
  ctx.saveGState()
  ctx.translateBy(x: box.minX, y: box.minY)
  ctx.scaleBy(x: box.width / 1024, y: box.height / 1024)

  let photo = CGRect(x: 120, y: 190, width: 620, height: 470)
  let shieldPath = CGMutablePath()
  // Shield centred at x = 660, top 330, bottom 830.
  shieldPath.move(to: CGPoint(x: 660, y: 330))
  shieldPath.addCurve(to: CGPoint(x: 850, y: 392), control1: CGPoint(x: 730, y: 372), control2: CGPoint(x: 790, y: 392))
  shieldPath.addLine(to: CGPoint(x: 850, y: 560))
  shieldPath.addCurve(to: CGPoint(x: 660, y: 830), control1: CGPoint(x: 850, y: 690), control2: CGPoint(x: 760, y: 780))
  shieldPath.addCurve(to: CGPoint(x: 470, y: 560), control1: CGPoint(x: 560, y: 780), control2: CGPoint(x: 470, y: 690))
  shieldPath.addLine(to: CGPoint(x: 470, y: 392))
  shieldPath.addCurve(to: CGPoint(x: 660, y: 330), control1: CGPoint(x: 530, y: 392), control2: CGPoint(x: 590, y: 372))
  shieldPath.closeSubpath()

  let check = CGMutablePath()
  check.move(to: CGPoint(x: 580, y: 590))
  check.addLine(to: CGPoint(x: 640, y: 654))
  check.addLine(to: CGPoint(x: 752, y: 520))

  if look == .colour {
    // Photo card
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 14), blur: 30, color: rgb(0x00234D, 0.35))
    ctx.addPath(roundedRect(photo, 46))
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.fillPath()
    ctx.restoreGState()
    // Picture inside the card
    let pic = photo.insetBy(dx: 30, dy: 30)
    ctx.saveGState()
    ctx.addPath(roundedRect(pic, 26))
    ctx.clip()
    ctx.setFillColor(rgb(0xBFE0FF))
    ctx.fill(pic)
    ctx.setFillColor(rgb(0xFFD25E))
    ctx.fillEllipse(in: CGRect(x: pic.minX + 70, y: pic.minY + 40, width: 90, height: 90))
    ctx.setFillColor(rgb(0x7DB6F0))
    let far = CGMutablePath()
    far.move(to: CGPoint(x: pic.minX, y: pic.maxY))
    far.addLine(to: CGPoint(x: pic.minX, y: pic.minY + 290))
    far.addLine(to: CGPoint(x: pic.minX + 150, y: pic.minY + 180))
    far.addLine(to: CGPoint(x: pic.minX + 300, y: pic.minY + 300))
    far.addLine(to: CGPoint(x: pic.minX + 430, y: pic.minY + 220))
    far.addLine(to: CGPoint(x: pic.maxX, y: pic.minY + 310))
    far.addLine(to: CGPoint(x: pic.maxX, y: pic.maxY))
    far.closeSubpath()
    ctx.addPath(far)
    ctx.fillPath()
    ctx.setFillColor(rgb(0x4B93E0))
    let near = CGMutablePath()
    near.move(to: CGPoint(x: pic.minX, y: pic.maxY))
    near.addLine(to: CGPoint(x: pic.minX, y: pic.minY + 340))
    near.addLine(to: CGPoint(x: pic.minX + 120, y: pic.minY + 290))
    near.addLine(to: CGPoint(x: pic.minX + 260, y: pic.minY + 360))
    near.addLine(to: CGPoint(x: pic.maxX - 120, y: pic.maxY))
    near.closeSubpath()
    ctx.addPath(near)
    ctx.fillPath()
    ctx.restoreGState()
    // Shield with a thick outline in the background colour so it separates from the photo, then a green check
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 16), blur: 34, color: rgb(0x00234D, 0.45))
    ctx.addPath(shieldPath)
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.fillPath()
    ctx.restoreGState()
    ctx.addPath(shieldPath)
    ctx.setStrokeColor(rgb(0x0A5FC4))
    ctx.setLineWidth(22)
    ctx.setLineJoin(.round)
    ctx.strokePath()
    ctx.addPath(shieldPath)
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.fillPath()
    ctx.addPath(check)
    ctx.setStrokeColor(rgb(0x1E8E3E))
    ctx.setLineWidth(58)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.strokePath()
  } else {
    // Monochrome: one white silhouette, detail cut out.
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.addPath(roundedRect(photo, 46))
    ctx.fillPath()
    ctx.setBlendMode(.clear)
    let pic = photo.insetBy(dx: 30, dy: 30)
    ctx.addPath(roundedRect(pic, 26))
    ctx.fillPath()
    ctx.setBlendMode(.normal)
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.fillEllipse(in: CGRect(x: pic.minX + 70, y: pic.minY + 40, width: 90, height: 90))
    let hills = CGMutablePath()
    hills.move(to: CGPoint(x: pic.minX, y: pic.maxY))
    hills.addLine(to: CGPoint(x: pic.minX, y: pic.minY + 300))
    hills.addLine(to: CGPoint(x: pic.minX + 150, y: pic.minY + 190))
    hills.addLine(to: CGPoint(x: pic.minX + 300, y: pic.minY + 310))
    hills.addLine(to: CGPoint(x: pic.minX + 430, y: pic.minY + 230))
    hills.addLine(to: CGPoint(x: pic.maxX, y: pic.minY + 320))
    hills.addLine(to: CGPoint(x: pic.maxX, y: pic.maxY))
    hills.closeSubpath()
    ctx.addPath(hills)
    ctx.fillPath()
    // Gap around the shield, then the shield with the check cut out
    ctx.setBlendMode(.clear)
    ctx.addPath(shieldPath)
    ctx.setLineWidth(46)
    ctx.setLineJoin(.round)
    ctx.setStrokeColor(rgb(0x000000))
    ctx.strokePath()
    ctx.setBlendMode(.normal)
    ctx.addPath(shieldPath)
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.fillPath()
    ctx.setBlendMode(.clear)
    ctx.addPath(check)
    ctx.setLineWidth(58)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.setStrokeColor(rgb(0x000000))
    ctx.strokePath()
    ctx.setBlendMode(.normal)
  }
  ctx.restoreGState()
}

/// The glyph's own extent in the design space is about x 120…850, y 190…830; centre it in `box`.
func centredGlyphBox(size: CGFloat, fraction: CGFloat) -> CGRect {
  let scale = size * fraction / 730  // 730 = glyph width in design units
  let w = 1024 * scale
  let cx = (120 + 850) / 2.0, cy = (190 + 830) / 2.0
  return CGRect(x: size / 2 - cx * scale, y: size / 2 - cy * scale, width: w, height: w)
}

// iOS / store icon: opaque, full bleed (iOS rounds the corners itself).
do {
  let ctx = canvas(1024, opaque: true)
  background(ctx, 1024)
  glyph(ctx, in: centredGlyphBox(size: 1024, fraction: 0.74), .colour)
  save(ctx, images.appendingPathComponent("icon.png"))
  save(resized(ctx, to: 48), images.appendingPathComponent("favicon.png"))
}

// Android adaptive layers (108 dp canvas, 66 % safe zone): foreground = glyph inside the safe zone, background = gradient, monochrome = silhouette.
do {
  let fg = canvas(1024)
  glyph(fg, in: centredGlyphBox(size: 1024, fraction: 0.62), .colour)
  save(fg, images.appendingPathComponent("android-icon-foreground.png"))
  let bg = canvas(1024, opaque: true)
  background(bg, 1024)
  save(bg, images.appendingPathComponent("android-icon-background.png"))
  let mono = canvas(1024)
  glyph(mono, in: centredGlyphBox(size: 1024, fraction: 0.62), .mono)
  save(mono, images.appendingPathComponent("android-icon-monochrome.png"))
}

// Splash: the glyph alone, transparent (the splash colour is the gradient's middle blue, set in app.config.ts).
do {
  let ctx = canvas(1024)
  glyph(ctx, in: centredGlyphBox(size: 1024, fraction: 0.9), .colour)
  save(ctx, images.appendingPathComponent("splash-icon.png"))
}

// iOS Icon Composer bundle (ios.icon): one transparent glyph layer over the bundle's own gradient fill.
do {
  let ctx = canvas(1024)
  glyph(ctx, in: centredGlyphBox(size: 1024, fraction: 0.74), .colour)
  try? FileManager.default.removeItem(at: iconAssets.appendingPathComponent("grid.png"))
  try? FileManager.default.removeItem(at: iconAssets.appendingPathComponent("expo-symbol 2.svg"))
  save(ctx, iconAssets.appendingPathComponent("glyph.png"))
}
