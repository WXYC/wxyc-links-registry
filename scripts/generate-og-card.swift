// generate-og-card.swift
//
// Renders the static 1200x630 WXYC wordmark OG card (variant A in the iOS
// repo's docs/ideas/on-tour-share-cards.html): "WXYC" in heavy monospace with
// the "YC" in station amber, over the dark card background, with the
// "89.3 FM - CHAPEL HILL" tag line beneath. This is the day-one og:image for
// every share page; the per-show generated poster (variant B) is a follow-up
// ticket.
//
// Build-time tool, macOS only (CoreGraphics + CoreText). The committed
// assets/og-card.png and src/og-card-data.ts are its outputs; re-run only when
// the card design changes:
//
//   swift scripts/generate-og-card.swift assets/og-card.png
//   node scripts/embed-og-card.mjs

import CoreGraphics
import CoreText
import Foundation
import ImageIO

let width = 1200
let height = 630

// Palette from the mockup: --page/#17181d card ground, --amber #ff8940,
// --ink-faint rgba(255,255,255,0.46).
let background = CGColor(red: 0x17 / 255.0, green: 0x18 / 255.0, blue: 0x1d / 255.0, alpha: 1)
let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
let amber = CGColor(red: 0xFF / 255.0, green: 0x89 / 255.0, blue: 0x40 / 255.0, alpha: 1)
let faint = CGColor(red: 1, green: 1, blue: 1, alpha: 0.46)

guard let context = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fatalError("Could not create CGContext")
}

context.setFillColor(background)
context.fill(CGRect(x: 0, y: 0, width: width, height: height))

/// Builds a kerned single-line attributed string in Menlo-Bold (the mockup's
/// ui-monospace stand-in that ships on every Mac).
func line(_ runs: [(String, CGColor)], size: CGFloat, tracking: CGFloat) -> CTLine {
    let font = CTFontCreateWithName("Menlo-Bold" as CFString, size, nil)
    let text = NSMutableAttributedString()
    for (string, color) in runs {
        text.append(NSAttributedString(string: string, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
            NSAttributedString.Key(kCTKernAttributeName as String): tracking,
        ]))
    }
    return CTLineCreateWithAttributedString(text)
}

/// Draws a CTLine horizontally centered at the given baseline, compensating
/// for the trailing kern the last glyph carries.
func drawCentered(_ ctLine: CTLine, baseline: CGFloat, tracking: CGFloat) {
    let lineWidth = CGFloat(CTLineGetTypographicBounds(ctLine, nil, nil, nil)) - tracking
    context.textPosition = CGPoint(x: (CGFloat(width) - lineWidth) / 2, y: baseline)
    CTLineDraw(ctLine, context)
}

// Wordmark: "WX" white + "YC" amber, mirroring the mockup's
// `WX<span class="fm">YC</span>` markup, scaled from the 30px/8.5px mock to
// the 1200x630 canvas.
let wordmarkSize: CGFloat = 150
let wordmarkTracking: CGFloat = 15
let tagSize: CGFloat = 42
let tagTracking: CGFloat = 10

let wordmark = line([("WX", white), ("YC", amber)], size: wordmarkSize, tracking: wordmarkTracking)
let tag = line([("89.3 FM · CHAPEL HILL", faint)], size: tagSize, tracking: tagTracking)

var wmAscent: CGFloat = 0
var wmDescent: CGFloat = 0
CTLineGetTypographicBounds(wordmark, &wmAscent, &wmDescent, nil)
var tagAscent: CGFloat = 0
var tagDescent: CGFloat = 0
CTLineGetTypographicBounds(tag, &tagAscent, &tagDescent, nil)

let gap: CGFloat = 34
let blockHeight = (wmAscent + wmDescent) + gap + (tagAscent + tagDescent)
let blockBottom = (CGFloat(height) - blockHeight) / 2

drawCentered(tag, baseline: blockBottom + tagDescent, tracking: tagTracking)
drawCentered(
    wordmark,
    baseline: blockBottom + (tagAscent + tagDescent) + gap + wmDescent,
    tracking: wordmarkTracking
)

guard let image = context.makeImage() else { fatalError("Could not render image") }

let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/og-card.png"
let url = URL(fileURLWithPath: outputPath)
try? FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true
)
guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("Could not open \(outputPath) for writing")
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("PNG write failed") }
print("Wrote \(outputPath) (\(width)x\(height))")
