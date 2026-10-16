// Writes doc.pdf: one text page with Info dictionary Author/Creator/Title/Subject/Keywords (CoreGraphics).
// Usage: swiftc -O scripts/fixtures/make-pdf.swift -o <tmp>/make-pdf && <tmp>/make-pdf test/fixtures
import CoreGraphics
import CoreText
import Foundation

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "test/fixtures"
let url = URL(fileURLWithPath: outDir).appendingPathComponent("doc.pdf")
var box = CGRect(x: 0, y: 0, width: 300, height: 200)
let info: [CFString: Any] = [
    kCGPDFContextAuthor: "Jane Fixture",
    kCGPDFContextCreator: "FixtureWriter 1.0",
    kCGPDFContextTitle: "Fixture Secret Report",
    kCGPDFContextSubject: "Fixture subject",
    kCGPDFContextKeywords: "fixture, secret",
]
guard let ctx = CGContext(url as CFURL, mediaBox: &box, info as CFDictionary) else { fatalError("no pdf context") }
ctx.beginPDFPage(nil)
let text = NSAttributedString(string: "Safe Share fixture document",
                              attributes: [NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 16, nil)])
ctx.textPosition = CGPoint(x: 20, y: 100)
CTLineDraw(CTLineCreateWithAttributedString(text), ctx)
ctx.endPDFPage()
ctx.closePDF()
print("wrote doc.pdf")
