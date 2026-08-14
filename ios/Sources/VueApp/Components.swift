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

/// Tap to apply. Hold to *try*.
///
/// The hold is the interesting one: the room changes while your thumb is down
/// and snaps back when you lift it, so a scene can be compared against what is
/// already there without committing to it and then having to rebuild the room
/// by hand. It is the closest thing to "hover" a light switch can have.
///
/// Built on the undo snapshot rather than on a preview endpoint: capture,
/// activate, restore. No new route, and the restore path is the same one the
/// undo bar uses, so there is one thing to get right instead of two.
struct SceneChip: View {
    @Environment(AppModel.self) private var model
    let scene: LightScene
    @State private var pressed = false
    @State private var previewing = false
    @State private var previewTask: Task<Void, Never>?

    private var accent: Color {
        scene.accent.flatMap(Color.init(cssHex:)) ?? Palette.accent
    }

    var body: some View {
        HStack(spacing: Metrics.space2) {
            Circle().fill(accent).frame(width: 8, height: 8)
            Text(scene.label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Palette.inkPrimary)
                .lineLimit(1)
            if previewing {
                Image(systemName: "eye.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.accent)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(.horizontal, Metrics.space3)
        .frame(height: Metrics.minimumTapTarget)
        .background(previewing ? Palette.accentSubtle : Palette.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(previewing ? Palette.accentBorder : Palette.border))
        .contentShape(Capsule())
        .scaleEffect(pressed ? 0.96 : 1)
        .animation(Motion.standard, value: pressed)
        .animation(Motion.standard, value: previewing)
        // One gesture again, for the same reason as on the canvas: a Button
        // plus a long-press plus a preview timer is three recognisers arguing
        // over one thumb.
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in beginPress() }
                .onEnded { value in endPress(moved: value.translation.height.magnitude > 24) })
        .accessibilityLabel(scene.label)
        .accessibilityHint("Activates this scene. Hold to preview it, swipe up to edit what Siri calls it.")
        .accessibilityActions {
            Button("Edit Siri names") { model.editingScene = scene }
        }
    }

    private func beginPress() {
        guard !pressed else { return }
        pressed = true
        previewTask = Task { @MainActor in
            // Long enough that a normal tap never trips it, short enough that
            // "hold to see it" is discoverable by accident.
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled else { return }
            previewing = true
            await model.beginPreview(scene)
        }
    }

    private func endPress(moved: Bool) {
        pressed = false
        previewTask?.cancel()
        previewTask = nil
        let wasPreviewing = previewing
        previewing = false

        Task { @MainActor in
            if wasPreviewing {
                // Released after a preview: put the room back. Committing here
                // instead would make "let me look at it" indistinguishable from
                // "apply it", which defeats the point.
                await model.endPreview(keep: false)
                return
            }
            if moved {
                model.editingScene = scene
                return
            }
            await model.activate(scene)
        }
    }
}

// MARK: - Undo

/// One tap back to how the room was.
///
/// It occupies a grid row rather than floating over the canvas: a toast that
/// covers a lamp while you are deciding whether you liked the change is in the
/// way of the only evidence you have. The row collapses to nothing when there
/// is nothing to undo, so the layout does not jump for a control that is
/// usually absent.
struct UndoBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let undo = model.undoState {
                Button {
                    Task { await model.revert() }
                } label: {
                    HStack(spacing: Metrics.space2) {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 12, weight: .semibold))
                        // Names what it will reverse. "Undo" on its own makes
                        // the user guess, and guessing wrong in a dark room
                        // means doing it all again.
                        Text("Undo “\(undo.label)”")
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Palette.accent)
                    .padding(.horizontal, Metrics.space3)
                    .frame(height: 38)
                    .frame(maxWidth: .infinity)
                    .background(Palette.accentSubtle,
                                in: RoundedRectangle(cornerRadius: Metrics.radiusMD))
                    .overlay(RoundedRectangle(cornerRadius: Metrics.radiusMD)
                        .strokeBorder(Palette.accentBorder))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, Metrics.pagePadding)
                .padding(.bottom, Metrics.space2)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(Motion.adaptive(Motion.sheet, reduceMotion: reduceMotion),
                   value: model.undoState)
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
                .accessibilityLabel(lamp.on ? "Turn off \(lamp.name)" : "Turn on \(lamp.name)")

                VStack(alignment: .leading, spacing: 1) {
                    // Never truncate a device name — wrap instead.
                    Text(lamp.name)
                        .font(.system(size: 14))
                        .foregroundStyle(Palette.inkPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(lamp.statusLine)
                        .font(.system(size: 12))
                        .foregroundStyle(lamp.reachable ? Palette.inkMuted : Palette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)

                if lamp.reachable {
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
        // The list is the VoiceOver surface, so the canvas gestures need named
        // equivalents here too.
        .accessibilityActions {
            if lamp.reachable {
                Button("Only this lamp") { Task { await model.solo(lamp) } }
                Button("Match every lamp to this") { Task { await model.matchAll(to: lamp) } }
            }
        }
        .padding(.horizontal, Metrics.space2)
        .padding(.vertical, Metrics.space1)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.radiusMD))
        .overlay(RoundedRectangle(cornerRadius: Metrics.radiusMD).strokeBorder(Palette.border))
        // Dimmed, but not to the point of looking disabled-and-therefore-broken.
        // The row still responds — tapping it explains what is wrong.
        .opacity(lamp.reachable ? 1 : 0.72)
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
