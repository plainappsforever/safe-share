// Writes the real-image fixtures with known hidden metadata (ImageIO, this Mac's own tools).
// Usage: swiftc -O scripts/fixtures/make-images.swift -o <tmp>/make-images && <tmp>/make-images test/fixtures
// Outputs: photo.jpg photo.heic photo.png nometa.jpg progressive.jpg photo.avif   (values are fixed so the manifest can name them)
// V1.5-1: `<tmp>/make-images <dir> v15` writes only photo.tiff (LZW), pages.tiff (2 pages, tiled) and base.gif (2 frames, no
// metadata; make-v15.mjs adds the GIF metadata blocks byte-wise because ImageIO writes none).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "test/fixtures"
let W = 320, H = 240

func makeImage() -> CGImage {
    let cs = CGColorSpace(name: CGColorSpace.displayP3)!
    let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    // Deterministic gradient plus a few blocks so JPEG/HEIC have real content.
    for y in 0..<H {
        for x in 0..<W {
            let r = CGFloat(x) / CGFloat(W), g = CGFloat(y) / CGFloat(H)
            let b = CGFloat(((x / 40) + (y / 40)) % 2) * 0.5 + 0.25
            ctx.setFillColor(CGColor(colorSpace: cs, components: [r, g, b, 1])!)
            ctx.fill(CGRect(x: x, y: y, width: 1, height: 1))
        }
    }
    return ctx.makeImage()!
}

let sensitiveProps: [CFString: Any] = [
    kCGImagePropertyOrientation: 6,
    kCGImagePropertyTIFFDictionary: [
        kCGImagePropertyTIFFMake: "FixtureCam",
        kCGImagePropertyTIFFModel: "FC-1",
        kCGImagePropertyTIFFArtist: "Jane Fixture",
        kCGImagePropertyTIFFCopyright: "(c) Jane Fixture 2025",
        kCGImagePropertyTIFFSoftware: "FixtureSoft 1.0",
    ] as [CFString: Any],
    kCGImagePropertyExifDictionary: [
        kCGImagePropertyExifDateTimeOriginal: "2025:06:14 09:30:15",
        kCGImagePropertyExifDateTimeDigitized: "2025:06:14 09:30:15",
        kCGImagePropertyExifOffsetTimeOriginal: "+02:00",
        kCGImagePropertyExifBodySerialNumber: "SN-FIXTURE-123",
        kCGImagePropertyExifLensModel: "Fixture Lens 24mm f/1.8",
        kCGImagePropertyExifLensSerialNumber: "LSN-FIXTURE-456",
        kCGImagePropertyExifExposureTime: 0.008,
        kCGImagePropertyExifFNumber: 1.8,
        kCGImagePropertyExifISOSpeedRatings: [200],
        kCGImagePropertyExifFocalLength: 24,
    ] as [CFString: Any],
    kCGImagePropertyGPSDictionary: [
        kCGImagePropertyGPSLatitude: 52.52,
        kCGImagePropertyGPSLatitudeRef: "N",
        kCGImagePropertyGPSLongitude: 13.4049,
        kCGImagePropertyGPSLongitudeRef: "E",
        kCGImagePropertyGPSAltitude: 34.0,
        kCGImagePropertyGPSAltitudeRef: 0,
        kCGImagePropertyGPSDateStamp: "2025:06:14",
        kCGImagePropertyGPSTimeStamp: "07:30:15",
    ] as [CFString: Any],
    kCGImagePropertyIPTCDictionary: [
        kCGImagePropertyIPTCByline: ["Jane Fixture"],
        kCGImagePropertyIPTCCity: "Berlin",
        kCGImagePropertyIPTCCaptionAbstract: "Fixture caption",
    ] as [CFString: Any],
]

func xmpMetadata() -> CGImageMetadata {
    let md = CGImageMetadataCreateMutable()
    let creator = CGImageMetadataTagCreate(kCGImageMetadataNamespaceDublinCore, kCGImageMetadataPrefixDublinCore,
                                           "creator" as CFString, .arrayOrdered, ["Jane Fixture XMP"] as CFArray)!
    CGImageMetadataSetTagWithPath(md, nil, "dc:creator" as CFString, creator)
    // Tags that ImageIO cannot fold into Exif/IPTC, so a real XMP packet is written.
    CGImageMetadataSetValueWithPath(md, nil, "xmp:CreatorTool" as CFString, "FixtureSoft XMP 2.0" as CFString)
    var err: Unmanaged<CFError>?
    CGImageMetadataRegisterNamespaceForPrefix(md, "http://safeshare.test/fixture/1.0/" as CFString, "fixture" as CFString, &err)
    CGImageMetadataSetValueWithPath(md, nil, "fixture:OwnerEmail" as CFString, "jane@fixture.test" as CFString)
    return md
}

func write(_ img: CGImage, type: UTType, name: String, props: [CFString: Any], xmp: Bool, quality: Double? = nil) {
    let url = URL(fileURLWithPath: outDir).appendingPathComponent(name)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
        print("FAILED to create destination for \(name)"); return
    }
    var options = props
    if let q = quality { options[kCGImageDestinationLossyCompressionQuality] = q }
    if xmp {
        CGImageDestinationAddImageAndMetadata(dest, img, xmpMetadata(), options as CFDictionary)
    } else {
        CGImageDestinationAddImage(dest, img, options as CFDictionary)
    }
    print(CGImageDestinationFinalize(dest) ? "wrote \(name)" : "FAILED to finalize \(name)")
}

let img = makeImage()
if CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "v15" {
    var tiffProps = sensitiveProps
    var tiffDict = sensitiveProps[kCGImagePropertyTIFFDictionary] as! [CFString: Any]
    tiffDict[kCGImagePropertyTIFFCompression] = 5  // LZW
    tiffDict[kCGImagePropertyTIFFHostComputer] = "Jane's MacBook Pro"
    tiffDict[kCGImagePropertyTIFFImageDescription] = "Fixture TIFF secret description"
    tiffProps[kCGImagePropertyTIFFDictionary] = tiffDict
    write(img, type: .tiff, name: "photo.tiff", props: tiffProps, xmp: true)
    // Two pages, the second tiled (scanner / fax style), each with its own description and the same GPS.
    let url = URL(fileURLWithPath: outDir).appendingPathComponent("pages.tiff")
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.tiff.identifier as CFString, 2, nil)!
    var p1 = tiffProps
    p1[kCGImagePropertyOrientation] = 1
    var d1 = tiffDict
    d1[kCGImagePropertyTIFFImageDescription] = "Fixture page one secret"
    p1[kCGImagePropertyTIFFDictionary] = d1
    CGImageDestinationAddImage(dest, img, p1 as CFDictionary)
    var p2 = p1
    var d2 = d1
    d2[kCGImagePropertyTIFFImageDescription] = "Fixture page two secret"
    d2[kCGImagePropertyTIFFTileWidth] = 64
    d2[kCGImagePropertyTIFFTileLength] = 64
    p2[kCGImagePropertyTIFFDictionary] = d2
    CGImageDestinationAddImage(dest, img, p2 as CFDictionary)
    print(CGImageDestinationFinalize(dest) ? "wrote pages.tiff" : "FAILED pages.tiff")
    // GIF: two frames, 0.1 s each, loop forever.
    let gurl = URL(fileURLWithPath: outDir).appendingPathComponent("base.gif")
    let gdest = CGImageDestinationCreateWithURL(gurl as CFURL, UTType.gif.identifier as CFString, 2, nil)!
    CGImageDestinationSetProperties(gdest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
    let small = img.cropping(to: CGRect(x: 0, y: 0, width: 64, height: 48))!
    let small2 = img.cropping(to: CGRect(x: 100, y: 100, width: 64, height: 48))!
    for frame in [small, small2] {
        CGImageDestinationAddImage(gdest, frame, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.1]] as CFDictionary)
    }
    print(CGImageDestinationFinalize(gdest) ? "wrote base.gif" : "FAILED base.gif")
    exit(0)
}
write(img, type: .jpeg, name: "photo.jpg", props: sensitiveProps, xmp: true, quality: 0.85)
write(img, type: .heic, name: "photo.heic", props: sensitiveProps, xmp: true, quality: 0.7)
write(img, type: .png, name: "photo.png", props: sensitiveProps, xmp: true)
// Progressive JPEG (P2): several scans with Huffman tables between them.
var progressiveProps = sensitiveProps
progressiveProps[kCGImagePropertyJFIFDictionary] = [kCGImagePropertyJFIFIsProgressive: true]
write(img, type: .jpeg, name: "progressive.jpg", props: progressiveProps, xmp: true, quality: 0.85)
// AVIF (P3): same metadata through ImageIO's AVIF encoder ("public.avif"). ImageIO writes the Exif
// Orientation 6 but an irot of 0, and displays the AVIF unrotated (measured 2026-09-30).
write(img, type: UTType("public.avif")!, name: "photo.avif", props: sensitiveProps, xmp: true, quality: 0.7)
// "Nothing sensitive" case: no Exif/GPS/IPTC/XMP at all (ICC only).
write(img, type: .jpeg, name: "nometa.jpg", props: [:], xmp: false, quality: 0.85)
