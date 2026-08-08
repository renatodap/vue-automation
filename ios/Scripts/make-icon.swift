// Renders the Vue Lights app icon: a lamp's glow against a dark room.
//
// Drawn rather than generated. An icon is geometry — the mark has to stay
// centred and hold its proportions from 1024px down to the 40px Spotlight size,
// and nothing about that survives a diffusion model. It is also the app's own
// visual language: every lamp on the room map is exactly this, a dot in its real
// colour with a glow that tracks brightness.
//
//   swift Scripts/make-icon.swift App/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let side = 1024
let f = CGFloat(side)

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(
        red: CGFloat((hex >> 16) & 0xff) / 255,
        green: CGFloat((hex >> 8) & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255,
        alpha: a)
}

// Straight out of globals.css, so the icon and the app are the same object.
let bgTop = rgb(0x1D1A15)
let bgBottom = rgb(0x100E0B)
let amber = rgb(0xE8A54D)

let space = CGColorSpaceCreateDeviceRGB()

// noneSkipLast: no alpha channel at all. The App Store rejects an icon with
// one, and the rejection arrives after a full upload rather than at build time.
guard let ctx = CGContext(
    data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
    space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
else { fatalError("could not create the bitmap context") }

// Ground.
if let bg = CGGradient(colorsSpace: space, colors: [bgTop, bgBottom] as CFArray,
                       locations: [0, 1]) {
    ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: f),
                           end: CGPoint(x: 0, y: 0), options: [])
}

let centre = CGPoint(x: f / 2, y: f * 0.52)

// The glow. Three stops rather than two: a linear falloff reads as a flat disc,
// and the whole point of the mark is that light has no edge.
if let glow = CGGradient(
    colorsSpace: space,
    colors: [rgb(0xE8A54D, 0.55), rgb(0xE8A54D, 0.16), rgb(0xE8A54D, 0)] as CFArray,
    locations: [0, 0.45, 1]) {
    ctx.drawRadialGradient(
        glow, startCenter: centre, startRadius: f * 0.05,
        endCenter: centre, endRadius: f * 0.46, options: [])
}

// The source itself — small, so the glow is the subject and the dot is only its
// origin. At 40px this collapses to a warm point, which is correct.
ctx.setFillColor(amber)
ctx.fillEllipse(in: CGRect(
    x: centre.x - f * 0.105, y: centre.y - f * 0.105,
    width: f * 0.21, height: f * 0.21))

// A shade over the top: one arc, struck rather than filled, reading as the lamp
// the light comes out of. Kept to a single stroke so it survives downscaling.
ctx.setStrokeColor(rgb(0xF5F1E8, 0.92))
ctx.setLineWidth(f * 0.038)
ctx.setLineCap(.round)
ctx.addArc(center: centre, radius: f * 0.235,
           startAngle: .pi * 0.12, endAngle: .pi * 0.88, clockwise: false)
ctx.strokePath()

guard let image = ctx.makeImage() else { fatalError("could not render") }

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "AppIcon.png")
guard let dest = CGImageDestinationCreateWithURL(
    out as CFURL, UTType.png.identifier as CFString, 1, nil)
else { fatalError("could not open \(out.path) for writing") }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("could not write the PNG") }
print("wrote \(out.path)")
