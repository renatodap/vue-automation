import SwiftUI
import VueCore
import VueDesignSystem

// MARK: - Scenes

/// The scene chips. Horizontal, so the room above it never has to move.
///
/// Horizontal scrolling is not the thing the brief objects to — scrolling *back
/// and forth vertically* to reach a control is. A row of chips keeps every scene
/// one tap away with the map still on screen.
struct SceneStrip: View {
    @Environment(AppModel.self) private var model
    @State private var capturing = false
    @State private var newName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.space2) {
            HStack {
                Text("SCENES")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(0.6)
                    .foregroundStyle(Palette.inkMuted)
                Spacer()
                Button("Save this look") { capturing = true }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Palette.accent)
            }
            .padding(.horizontal, Metrics.pagePadding)

            ScrollView(.horizontal) {
                HStack(spacing: Metrics.space2) {
                    ForEach(model.state.scenes) { scene in
                        SceneChip(scene: scene)
                    }
                }
                .padding(.horizontal, Metrics.pagePadding)
            }
            .scrollIndicators(.hidden)
        }
        .padding(.vertical, Metrics.space3)
        .alert("Save this look", isPresented: $capturing) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) { newName = "" }
            Button("Save") {
                let name = newName.trimmingCharacters(in: .whitespaces)
                newName = ""
                guard !name.isEmpty else { return }
                Task { await model.captureScene(named: name) }
            }
        } message: {
            // Snapshotting beats a form. The room has already been arranged by
            // eye; retyping those numbers into a dialog is both more work and
            // less accurate than reading what the lamps settled on.
            Text("Captures every reachable lamp exactly as it is right now.")
        }
    }
}

struct SceneChip: View {
    @Environment(AppModel.self) private var model
    let scene: LightScene
    @State private var pressed = false

    private var accent: Color {
        scene.accent.flatMap(Color.init(cssHex:)) ?? Palette.accent
    }

    var body: some View {
        Button {
            Task { await model.activate(scene) }
        } label: {
            HStack(spacing: Metrics.space2) {
                Circle().fill(accent).frame(width: 8, height: 8)
                Text(scene.label)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Palette.inkPrimary)
                    .lineLimit(1)
            }
            .padding(.horizontal, Metrics.space3)
            .frame(height: Metrics.minimumTapTarget)
            .background(Palette.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.border))
        }
        .buttonStyle(.plain)
        .scaleEffect(pressed ? 0.96 : 1)
        .animation(Motion.standard, value: pressed)
        .onLongPressGesture(minimumDuration: 0.4, pressing: { pressed = $0 }) {
            model.editingScene = scene
        }
        .accessibilityLabel(scene.label)
        .accessibilityHint("Activates this scene. Long press to edit what Siri calls it.")
    }
}

// MARK: - Master

/// All-on, all-off, and where the room is right now.
///
/// The numbers are readouts, not just decoration: with the map showing colour
/// and glow, this row is the exact value for anyone who wants one.
struct MasterBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: Metrics.space2) {
            Button {
                Task { await model.allOn() }
            } label: {
                Label("All on", systemImage: "sun.max.fill")
                    .font(.system(size: 14, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .frame(height: Metrics.minimumTapTarget)
                    .background(model.state.anyOn ? Palette.accentSubtle : Palette.accent,
                                in: RoundedRectangle(cornerRadius: Metrics.radiusMD))
                    .foregroundStyle(model.state.anyOn ? Palette.accent : Palette.onAccent)
            }
            .buttonStyle(.plain)
            .disabled(model.state.reachable.isEmpty)

            Button {
                Task { await model.allOff() }
            } label: {
                Label("All off", systemImage: "power")
                    .font(.system(size: 14, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .frame(height: Metrics.minimumTapTarget)
                    .background(Palette.neutralSurface,
                                in: RoundedRectangle(cornerRadius: Metrics.radiusMD))
                    .foregroundStyle(Palette.inkSecondary)
            }
            .buttonStyle(.plain)
            .disabled(!model.state.anyOn)
        }
        .padding(.horizontal, Metrics.pagePadding)
        .padding(.bottom, Metrics.space2)
        .overlay(alignment: .top) {
            Divider().overlay(Palette.border)
        }
        .padding(.top, Metrics.space3)
    }
}

// MARK: - The list alternative

/// The same capability as the map, without the map.
///
/// Selected automatically under VoiceOver and available to anyone from Settings.
/// It is not a fallback in the sense of being lesser — every action on the
/// canvas exists here, with standard controls that assistive technology already
/// knows how to drive.
struct LampList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(spacing: Metrics.space2) {
                ForEach(model.state.lamps) { lamp in
                    LampRow(lamp: lamp)
                }
            }
            .padding(.horizontal, Metrics.pagePadding)
            .padding(.vertical, Metrics.space2)
        }
        .frame(maxHeight: .infinity)
    }
}

struct LampRow: View {
    @Environment(AppModel.self) private var model
    let lamp: Lamp

    var body: some View {
        VStack(spacing: Metrics.space2) {
            HStack(spacing: Metrics.space3) {
                Button {
                    Task { await model.toggle(lamp) }
                } label: {
                    Image(systemName: lamp.reachable
                          ? (lamp.on ? "lightbulb.fill" : "lightbulb")
                          : "wifi.slash")
                        .font(.system(size: 19))
                        .foregroundStyle(lamp.on ? Color(lamp: lamp) : Palette.inkMuted)
                        .frame(width: Metrics.minimumTapTarget, height: Metrics.minimumTapTarget)
                }
                .buttonStyle(.plain)
                .disabled(!lamp.reachable)
                .accessibilityLabel(lamp.on ? "Turn off \(lamp.name)" : "Turn on \(lamp.name)")

                VStack(alignment: .leading, spacing: 1) {
                    // Never truncate a device name — wrap instead.
                    Text(lamp.name)
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.inkPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.inkMuted)
                }
                Spacer(minLength: 0)

                if lamp.reachable && lamp.on {
                    Button {
                        model.inspecting = lamp
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                            .foregroundStyle(Palette.inkMuted)
                            .frame(width: Metrics.minimumTapTarget, height: Metrics.minimumTapTarget)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Adjust \(lamp.name)")
                }
            }

            if lamp.reachable && lamp.on {
                BrightnessSlider(lamp: lamp)
            }
        }
        .padding(.horizontal, Metrics.space2)
        .padding(.vertical, Metrics.space1)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.radiusMD))
        .overlay(RoundedRectangle(cornerRadius: Metrics.radiusMD).strokeBorder(Palette.border))
        .opacity(lamp.reachable ? 1 : 0.5)
    }

    private var subtitle: String {
        guard lamp.reachable else { return "Unreachable — switch may be off" }
        guard lamp.on else { return "Off" }
        let k = lamp.kelvin.map { "\($0)K" } ?? "colour"
        return "\(lamp.brightness ?? 100)% · \(k)"
    }
}

/// Commits on release, not on every frame.
///
/// A slider fires continuously while dragging; forwarding each event floods a
/// Zigbee mesh that manages a few messages a second, and the lamp ends up
/// chasing a queue of stale values after the thumb has stopped.
struct BrightnessSlider: View {
    @Environment(AppModel.self) private var model
    let lamp: Lamp
    @State private var local: Double?

    var body: some View {
        let value = Binding<Double>(
            get: { local ?? Double(lamp.brightness ?? 60) },
            set: { local = $0 })

        HStack(spacing: Metrics.space2) {
            Image(systemName: "sun.min").font(.system(size: 11)).foregroundStyle(Palette.inkMuted)
            Slider(value: value, in: 1...100) { editing in
                if editing {
                    model.beginGesture(on: [lamp.entityId])
                } else {
                    let final = Int((local ?? Double(lamp.brightness ?? 60)).rounded())
                    local = nil
                    Task {
                        await model.setBrightness(final, on: [lamp.entityId], commit: true)
                        model.endGesture(on: [lamp.entityId])
                    }
                }
            }
            .tint(Color(lamp: lamp))
            Text("\(Int(value.wrappedValue.rounded()))%")
                .font(.system(size: 12).monospacedDigit())
                .foregroundStyle(Palette.inkMuted)
                .frame(width: 38, alignment: .trailing)
        }
        .padding(.bottom, Metrics.space2)
        .accessibilityElement()
        .accessibilityLabel("\(lamp.name) brightness")
        .accessibilityValue("\(Int(value.wrappedValue.rounded())) percent")
        .accessibilityAdjustableAction { direction in
            let step = direction == .increment ? 10 : -10
            let next = max(1, min(100, (lamp.brightness ?? 60) + step))
            Task { await model.setBrightness(next, on: [lamp.entityId], commit: true) }
        }
    }
}

extension Color {
    /// `#e8a54d` from the database. Returns nil rather than guessing, so a bad
    /// value falls back to the app's accent instead of rendering black.
    init?(cssHex: String) {
        var s = cssHex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(hex: v)
    }
}
