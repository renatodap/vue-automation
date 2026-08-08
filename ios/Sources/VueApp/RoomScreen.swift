import SwiftUI
import VueCore
import VueDesignSystem
import VueRepositories

/// The whole app, on one screen that never scrolls vertically.
///
/// Four rows: title, the room, the scene strip, the master bar. Everything done
/// daily is reachable without moving the view, which is the entire point —
/// scrolling back and forth to dim a lamp is the thing this replaces.
public struct RoomScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @AppStorage("vue.useList") private var preferList = false

    public init() {}

    private var usesList: Bool { preferList || voiceOver }

    public var body: some View {
        @Bindable var model = model

        VStack(spacing: 0) {
            header

            if usesList {
                // Not a degraded mode — an equal one. VoiceOver cannot drag a
                // canvas, and the map means nothing before placement is set.
                LampList()
            } else {
                RoomCanvas()
            }

            SceneStrip()
            MasterBar()
        }
        .background(Palette.background.ignoresSafeArea())
        .overlay(alignment: .top) { noticeBanner }
        .sheet(item: $model.inspecting) { LampDetailSheet(lamp: $0) }
        .sheet(item: $model.editingScene) { SceneEditorSheet(scene: $0) }
        .sheet(isPresented: $model.showingSettings) { SettingsSheet() }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Living Room")
                    .font(.system(size: 25, weight: .semibold))
                    .foregroundStyle(Palette.inkPrimary)
                Text(statusLine)
                    .font(.system(size: 13))
                    .foregroundStyle(statusColor)
                    .lineLimit(1)
            }
            Spacer(minLength: Metrics.space3)
            Button { model.showingSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 17))
                    .foregroundStyle(Palette.inkMuted)
                    .frame(width: Metrics.minimumTapTarget, height: Metrics.minimumTapTarget)
            }
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, Metrics.pagePadding)
        .padding(.top, Metrics.space2)
    }

    private var statusLine: String {
        switch model.status {
        case .loading: "Connecting…"
        case .live: model.state.summary
        case .stale: model.state.summary + " · offline"
        case let .down(message): message
        }
    }

    private var statusColor: Color {
        switch model.status {
        case .stale, .down: Palette.warning
        default: Palette.inkMuted
        }
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice = model.notice {
            Text(notice)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.onAccent)
                .padding(.horizontal, Metrics.space4)
                .padding(.vertical, Metrics.space2)
                .background(Palette.accent, in: Capsule())
                .padding(.top, Metrics.space2)
                .transition(.move(edge: .top).combined(with: .opacity))
                .animation(Motion.adaptive(Motion.standard, reduceMotion: reduceMotion),
                           value: model.notice)
        }
    }
}

// MARK: - The map

/// Where each lamp physically sits, normalized over the plate.
///
/// Read off a photograph of the room. Defaults only — the point is that the app
/// is useful before anyone opens a placement editor, not that these are right
/// forever.
enum Placement {
    static let defaults: [String: CGPoint] = [
        "light.abajour": CGPoint(x: 0.215, y: 0.795),
        "light.floor_lamp": CGPoint(x: 0.215, y: 0.445),
        "light.shelf_lamp": CGPoint(x: 0.185, y: 0.235),
        "light.tv_lamp": CGPoint(x: 0.795, y: 0.435),
    ]

    /// Anything unplaced lands on a tidy arc rather than on top of something
    /// else. A new bulb appearing in the middle of the sofa is confusing; a new
    /// bulb in a row along the bottom reads as "not placed yet".
    static func point(for lamp: Lamp, index: Int, of total: Int) -> CGPoint {
        if let known = defaults[lamp.entityId] { return known }
        let spread = min(0.8, Double(max(total, 1)) * 0.18)
        let start = 0.5 - spread / 2
        let step = total > 1 ? spread / Double(total - 1) : 0
        return CGPoint(x: start + step * Double(index), y: 0.93)
    }
}

struct RoomCanvas: View {
    @Environment(AppModel.self) private var model

    /// The plate's own aspect ratio. Placement is normalized against the IMAGE,
    /// so this has to be known rather than inferred from the container.
    private static let plateAspect: CGFloat = 896.0 / 1200.0

    var body: some View {
        GeometryReader { geo in
            // Where the plate actually lands after `.fit` letterboxes it.
            //
            // Positioning lamps against `geo.size` is wrong and looks almost
            // right, which is worse: the further the container's aspect is from
            // the plate's, the further every lamp drifts from the furniture it
            // is supposed to be sitting on.
            let fitted = Self.fit(Self.plateAspect, in: geo.size)

            ZStack {
                Image("room-plate", bundle: .module)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .opacity(0.92)
                    .accessibilityHidden(true)

                ForEach(Array(model.state.lamps.enumerated()), id: \.element.entityId) { index, lamp in
                    let p = Placement.point(for: lamp, index: index, of: model.state.lamps.count)
                    LampMarker(lamp: lamp)
                        .position(x: fitted.minX + fitted.width * p.x,
                                  y: fitted.minY + fitted.height * p.y)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            // Dragging empty floor drives every lamp at once. This is the
            // gesture that removes the most work: warming or dimming the whole
            // room without a mode switch or a trip to a master panel.
            .contentShape(Rectangle())
            .roomControl(targets: model.state.reachable.map(\.entityId))
        }
        .padding(.horizontal, Metrics.space2)
        .frame(maxHeight: .infinity)
    }

    /// The rect an aspect-fitted image occupies inside a container.
    static func fit(_ aspect: CGFloat, in size: CGSize) -> CGRect {
        guard size.width > 0, size.height > 0, aspect > 0 else { return .zero }
        let containerAspect = size.width / size.height
        let fittedSize = containerAspect > aspect
            ? CGSize(width: size.height * aspect, height: size.height)   // pillarboxed
            : CGSize(width: size.width, height: size.width / aspect)     // letterboxed
        return CGRect(
            x: (size.width - fittedSize.width) / 2,
            y: (size.height - fittedSize.height) / 2,
            width: fittedSize.width, height: fittedSize.height)
    }
}

/// One lamp: a dot in its real colour, with a glow that tracks brightness.
struct LampMarker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let lamp: Lamp

    private var colour: Color { Color(lamp: lamp) }
    private var level: Double { Double(lamp.brightness ?? 0) / 100 }

    var body: some View {
        ZStack {
            if lamp.on && lamp.reachable {
                // The glow IS the brightness readout. You should be able to see
                // what the room is doing without reading a number.
                Circle()
                    .fill(RadialGradient(
                        colors: [colour.opacity(0.55 * level + 0.15), colour.opacity(0)],
                        center: .center, startRadius: 2, endRadius: 46 + 34 * level))
                    .frame(width: 150, height: 150)
                    .allowsHitTesting(false)
            }

            Circle()
                .fill(lamp.on && lamp.reachable ? colour : Color.clear)
                .overlay {
                    Circle().strokeBorder(
                        lamp.reachable ? colour.opacity(lamp.on ? 0 : 0.65) : Palette.inkMuted,
                        style: StrokeStyle(lineWidth: 2, dash: lamp.reachable ? [] : [3, 3]))
                }
                .frame(width: 26, height: 26)
                .shadow(color: lamp.on ? colour.opacity(0.6) : .clear, radius: 8)
        }
        // A 26pt dot is not a 44pt target. The hit area is invisible and large.
        .frame(width: 62, height: 62)
        .contentShape(Circle())
        .roomControl(targets: lamp.reachable ? [lamp.entityId] : [])
        .onLongPressGesture(minimumDuration: 0.4) {
            guard lamp.reachable else { return }
            model.inspecting = lamp
        }
        .animation(Motion.adaptive(Motion.standard, reduceMotion: reduceMotion), value: lamp.on)
        .animation(Motion.adaptive(Motion.standard, reduceMotion: reduceMotion), value: lamp.brightness)
        .accessibilityElement()
        .accessibilityLabel(lamp.name)
        .accessibilityValue(lamp.reachable
            ? (lamp.on ? "On, \(lamp.brightness ?? 0) percent" : "Off")
            : "Unreachable")
        .accessibilityAddTraits(.isButton)
    }
}

/// Tap to toggle, drag vertically for brightness, horizontally for warmth.
///
/// A `ViewModifier` rather than a `Gesture`. A `Gesture` is not a view context —
/// `@State` and `@Environment` inside one do not participate in the update
/// graph, so the axis would reset on every frame and the model reference would
/// be a fresh empty one. This is the shape that actually works.
///
/// One gesture rather than three, because SwiftUI resolves competing gestures by
/// guessing and the guesses are not stable. Deciding the axis ourselves, once,
/// from the first few points of movement, is predictable.
struct RoomControl: ViewModifier {
    @Environment(AppModel.self) private var model
    let targets: [String]
    /// Nil until the drag has travelled far enough to mean something. Once set
    /// it stays set for the rest of the drag — an axis that can flip under the
    /// thumb feels broken.
    @State private var axis: Axis?
    @State private var lastCommit = Date.distantPast
    /// The room's values when the finger went down. Deltas apply to these, not
    /// to live state, or the drag compounds against its own writes and the lamp
    /// runs away.
    @State private var anchorBrightness = 0
    @State private var anchorKelvin = 0

    enum Axis { case brightness, warmth }

    /// Below this, a drag is a tap.
    private let slop: CGFloat = 10

    func body(content: Content) -> some View {
        content.gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in handleChange(value) }
                .onEnded { value in handleEnd(value) })
    }

    private func handleChange(_ value: DragGesture.Value) {
        guard !targets.isEmpty else { return }
        let dx = value.translation.width
        let dy = value.translation.height

        if axis == nil {
            guard max(abs(dx), abs(dy)) > slop else { return }
            axis = abs(dy) >= abs(dx) ? .brightness : .warmth
            anchorBrightness = model.state.averageBrightness
            anchorKelvin = model.state.averageKelvin
            model.beginGesture(on: targets)
        }

        // Throttle to roughly four a second. Zigbee manages a handful of
        // messages a second; forwarding every frame leaves the lamp chasing a
        // queue of stale values seconds after the thumb stopped.
        let now = Date()
        let commit = now.timeIntervalSince(lastCommit) > 0.25
        if commit { lastCommit = now }

        Task { @MainActor in
            switch axis {
            case .brightness:
                // Up is brighter. 220pt of travel spans the full range.
                let level = anchorBrightness + Int((-dy / 220) * 100)
                await model.setBrightness(max(1, min(100, level)), on: targets, commit: commit)
            case .warmth:
                let range = model.state.kelvinRange
                let span = Double(range.upperBound - range.lowerBound)
                let k = anchorKelvin + Int((dx / 260) * span)
                await model.setKelvin(max(range.lowerBound, min(range.upperBound, k)),
                                      on: targets, commit: commit)
            case nil:
                break
            }
        }
    }

    private func handleEnd(_ value: DragGesture.Value) {
        guard !targets.isEmpty else { return }
        let settled = axis
        let dx = value.translation.width
        let dy = value.translation.height
        axis = nil
        lastCommit = .distantPast

        Task { @MainActor in
            defer { model.endGesture(on: targets) }
            switch settled {
            case .brightness:
                // Final value, unthrottled, so the lamp lands exactly where the
                // thumb left it rather than wherever the last throttled tick was.
                let level = anchorBrightness + Int((-dy / 220) * 100)
                await model.setBrightness(max(1, min(100, level)), on: targets, commit: true)
            case .warmth:
                let range = model.state.kelvinRange
                let span = Double(range.upperBound - range.lowerBound)
                let k = anchorKelvin + Int((dx / 260) * span)
                await model.setKelvin(max(range.lowerBound, min(range.upperBound, k)),
                                      on: targets, commit: true)
            case nil:
                // Never moved: it was a tap. Only meaningful on a single lamp —
                // a tap on empty floor should do nothing, because "toggle
                // everything" by accident is a bad surprise in a dark room.
                if targets.count == 1,
                   let lamp = model.state.lamps.first(where: { $0.entityId == targets[0] }) {
                    await model.toggle(lamp)
                }
            }
        }
    }
}

extension View {
    /// Tap-to-toggle and drag-to-adjust, over one or many lamps.
    func roomControl(targets: [String]) -> some View {
        modifier(RoomControl(targets: targets))
    }
}
