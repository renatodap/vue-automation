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
            UndoBar()
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

            // Every lamp's centre, in this canvas's coordinate space.
            //
            // Computed once here and handed down rather than measured per
            // marker: a lamp being dragged has to know where its SIBLINGS are to
            // find a drop target, and a view cannot ask another view where it
            // ended up.
            let centres = Self.centres(model.state.lamps, in: fitted)

            ZStack {
                Image("room-plate", bundle: .module)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .opacity(0.92)
                    .accessibilityHidden(true)

                ForEach(model.state.lamps) { lamp in
                    LampMarker(lamp: lamp, centres: centres)
                        .position(centres[lamp.entityId] ?? .zero)
                }

                if let carry = model.carry,
                   let source = model.state.lamps.first(where: { $0.entityId == carry.source }) {
                    CarryChip(lamp: source)
                        .position(carry.location)
                        .allowsHitTesting(false)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .coordinateSpace(name: RoomCanvas.space)
            // Dragging empty floor drives every lamp at once. This is the
            // gesture that removes the most work: warming or dimming the whole
            // room without a mode switch or a trip to a master panel.
            .contentShape(Rectangle())
            .roomControl(targets: model.state.reachable.map(\.entityId), lamp: nil, centres: [:])
        }
        .padding(.horizontal, Metrics.space2)
        .frame(maxHeight: .infinity)
    }

    /// Named so a drag can report its location in the same space the lamp
    /// centres were computed in. A drag reported in `.local` and hit-tested
    /// against canvas coordinates misses by the marker's own offset, which is
    /// close enough to work sometimes — the worst kind of wrong.
    static let space = "vue.room"

    static func centres(_ lamps: [Lamp], in fitted: CGRect) -> [String: CGPoint] {
        Dictionary(uniqueKeysWithValues: lamps.enumerated().map { index, lamp in
            let p = Placement.point(for: lamp, index: index, of: lamps.count)
            return (lamp.entityId, CGPoint(
                x: fitted.minX + fitted.width * p.x,
                y: fitted.minY + fitted.height * p.y))
        })
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

/// The lamp that follows your finger while you drag it onto another.
struct CarryChip: View {
    let lamp: Lamp

    var body: some View {
        HStack(spacing: Metrics.space1) {
            Circle().fill(Color(lamp: lamp)).frame(width: 10, height: 10)
            Text(lamp.name)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Palette.inkPrimary)
                .lineLimit(1)
        }
        .padding(.horizontal, Metrics.space2)
        .padding(.vertical, Metrics.space1)
        .background(Palette.elevated, in: Capsule())
        .overlay(Capsule().strokeBorder(Palette.accentBorder))
        .shadow(color: .black.opacity(0.4), radius: 8, y: 2)
        .offset(y: -34)
    }
}

/// One lamp: a dot in its real colour, with a glow that tracks brightness.
struct LampMarker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let lamp: Lamp
    let centres: [String: CGPoint]

    private var colour: Color { Color(lamp: lamp) }
    private var level: Double { Double(lamp.brightness ?? 0) / 100 }
    /// This lamp is about to receive another lamp's settings.
    private var isDropTarget: Bool { model.carry?.target == lamp.entityId }
    private var isBeingCarried: Bool { model.carry?.source == lamp.entityId }

    var body: some View {
        ZStack {
            // The drop-target ring. It has to be unmistakable: the whole
            // interaction is "let go HERE", and a subtle highlight on a 26pt dot
            // in a dark room is not an answer to that.
            if isDropTarget {
                Circle()
                    .strokeBorder(Palette.accent, lineWidth: 3)
                    .frame(width: 54, height: 54)
                    .transition(.scale.combined(with: .opacity))
            }
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
        .opacity(isBeingCarried ? 0.35 : 1)
        // Every lamp gesture, in ONE recogniser. Tap, double-tap, drag to
        // adjust, hold, and hold-then-drag to copy — see `RoomControl` for why
        // splitting these across several SwiftUI gestures does not work.
        .roomControl(
            targets: lamp.reachable ? [lamp.entityId] : [],
            lamp: lamp,
            centres: centres)
        .animation(Motion.adaptive(Motion.standard, reduceMotion: reduceMotion), value: lamp.on)
        .animation(Motion.adaptive(Motion.standard, reduceMotion: reduceMotion), value: lamp.brightness)
        .animation(Motion.adaptive(Motion.sheet, reduceMotion: reduceMotion), value: isDropTarget)
        .accessibilityElement()
        .accessibilityLabel(lamp.name)
        .accessibilityValue(lamp.reachable
            ? (lamp.on ? "On, \(lamp.brightness ?? 0) percent" : "Off")
            : "No power — switched off at the lamp")
        .accessibilityAddTraits(.isButton)
        // VoiceOver cannot drag a dot onto another dot. Every gesture above has
        // a named equivalent here, because a capability that only exists as a
        // gesture does not exist for everyone.
        .accessibilityActions {
            Button("Adjust") { model.inspecting = lamp }
            Button("Only this lamp") { Task { await model.solo(lamp) } }
            Button("Match every lamp to this") { Task { await model.matchAll(to: lamp) } }
        }
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
    /// The lamp this modifier is attached to, or nil for the floor.
    let lamp: Lamp?
    /// Every lamp's centre, so a carried lamp can find what it is over.
    let centres: [String: CGPoint]

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
    /// Every lamp's own brightness at touch-down, for proportional scaling.
    @State private var anchors: [String: Int] = [:]
    @State private var ticker = DetentTicker()

    /// Set by a timer 0.4s after touch-down if nothing else has claimed the
    /// gesture. From then on the drag carries the lamp instead of adjusting it.
    @State private var armed = false
    @State private var armTask: Task<Void, Never>?
    @State private var carrying = false

    /// For double-tap. Static because it has to survive this modifier's own
    /// state being torn down between two taps on the same lamp.
    @State private var lastTapAt = Date.distantPast

    enum Axis { case brightness, warmth }

    /// Below this, a drag is a tap.
    private let slop: CGFloat = 10

    func body(content: Content) -> some View {
        // ONE `DragGesture(minimumDistance: 0)` carries tap, double-tap,
        // hold, hold-and-drag, and both adjustment axes.
        //
        // The temptation is to write five gestures and let SwiftUI arbitrate.
        // It does not arbitrate, it guesses, and the guesses are not stable
        // across builds — a `.onLongPressGesture` next to a zero-distance
        // `DragGesture` on the same view is a coin flip over which one sees the
        // touch. `minimumDistance: 0` also means `onChanged` fires at
        // touch-DOWN, which is what makes the hold timer possible here at all.
        content.gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .named(RoomCanvas.space))
                .onChanged { value in handleChange(value) }
                .onEnded { value in handleEnd(value) })
    }

    private func handleChange(_ value: DragGesture.Value) {
        guard !targets.isEmpty else { return }
        let dx = value.translation.width
        let dy = value.translation.height

        // Touch-down. Start the hold timer; a lamp held still becomes carryable.
        if axis == nil, !carrying, armTask == nil {
            anchors = model.brightnessAnchors(for: targets)
            armTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled, axis == nil else { return }
                armed = true
                Haptics.thud()
            }
        }

        if carrying {
            updateCarry(to: value.location)
            return
        }

        if axis == nil {
            guard max(abs(dx), abs(dy)) > slop else { return }
            // Held first, then moved: this is a copy, not an adjustment. Only
            // a real lamp can be carried — the floor has nothing to copy from.
            if armed, let lamp, lamp.reachable {
                carrying = true
                model.carry = AppModel.Carry(
                    source: lamp.entityId, location: value.location, target: nil)
                updateCarry(to: value.location)
                return
            }
            armTask?.cancel()
            armTask = nil
            axis = abs(dy) >= abs(dx) ? .brightness : .warmth
            anchorBrightness = model.state.averageBrightness
            anchorKelvin = model.state.averageKelvin
            ticker.reset()
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
                await driveBrightness(dy: dy, commit: commit)
            case .warmth:
                let k = warmth(dx: dx)
                ticker.track(k / 100, every: 5)
                await model.setKelvin(k, on: targets, commit: commit)
            case nil:
                break
            }
        }
    }

    /// One lamp moves absolutely; the whole room scales proportionally.
    ///
    /// Dragging the floor to "40%" and flattening four lamps onto one number is
    /// the classic mistake — it destroys whatever shape the room had, and the
    /// shape is the reason somebody arranged it. Scaling keeps the
    /// relationships and only changes the overall level.
    @MainActor
    private func driveBrightness(dy: CGFloat, commit: Bool) async {
        // Up is brighter. 220pt of travel spans the full range.
        let level = max(1, min(100, anchorBrightness + Int((-dy / 220) * 100)))
        ticker.track(level)
        if targets.count > 1, anchorBrightness > 0 {
            await model.scaleBrightness(
                factor: Double(level) / Double(anchorBrightness),
                from: anchors, commit: commit)
        } else {
            await model.setBrightness(level, on: targets, commit: commit)
        }
    }

    private func warmth(dx: CGFloat) -> Int {
        let range = model.state.kelvinRange
        let span = Double(range.upperBound - range.lowerBound)
        let k = anchorKelvin + Int((dx / 260) * span)
        return max(range.lowerBound, min(range.upperBound, k))
    }

    /// Which lamp is under the finger, if any.
    ///
    /// Nearest-within-a-radius rather than a hit test on the 26pt dot: the
    /// finger is over the dot it is aiming at, but the touch point is wherever
    /// the pad of the thumb landed, and requiring pixel accuracy to drop makes
    /// the whole interaction feel like it does not work.
    private func updateCarry(to location: CGPoint) {
        guard var carry = model.carry else { return }
        let hit = centres
            .filter { $0.key != carry.source }
            .filter { id, _ in
                model.state.lamps.first { $0.entityId == id }?.reachable == true
            }
            .map { ($0.key, hypot($0.value.x - location.x, $0.value.y - location.y)) }
            .filter { $0.1 < 46 }
            .min { $0.1 < $1.1 }?.0

        if hit != carry.target, hit != nil { Haptics.detent() }
        carry.location = location
        carry.target = hit
        model.carry = carry
    }

    private func handleEnd(_ value: DragGesture.Value) {
        // An unreachable lamp has no targets, but it must still answer a tap.
        // Silence here is what makes a dead bulb read as a dead app — this is
        // the most common non-normal state in the room and it deserves a
        // sentence, not a grey dot.
        guard !targets.isEmpty else {
            if let lamp, !lamp.reachable {
                Task { @MainActor in await model.toggle(lamp) }
            }
            return
        }
        armTask?.cancel()
        armTask = nil
        let settled = axis
        let wasArmed = armed
        let wasCarrying = carrying
        let drop = model.carry?.target
        let dx = value.translation.width
        let dy = value.translation.height
        axis = nil
        armed = false
        carrying = false
        model.carry = nil
        lastCommit = .distantPast
        ticker.reset()

        Task { @MainActor in
            if wasCarrying {
                guard let source = lamp, let drop,
                      let target = model.state.lamps.first(where: { $0.entityId == drop })
                else {
                    // Dropped on nothing. Say so rather than leave the user
                    // wondering whether it silently worked.
                    Haptics.warn()
                    model.flash("Drop it on another lamp to copy its look")
                    return
                }
                await model.copySettings(from: source, to: [target])
                return
            }

            defer { model.endGesture(on: targets) }
            switch settled {
            case .brightness:
                // Final value, unthrottled, so the lamp lands exactly where the
                // thumb left it rather than wherever the last throttled tick was.
                await driveBrightness(dy: dy, commit: true)
            case .warmth:
                await model.setKelvin(warmth(dx: dx), on: targets, commit: true)
            case nil:
                await handleTap(heldStill: wasArmed)
            }
        }
    }

    @MainActor
    private func handleTap(heldStill: Bool) async {
        // Held without moving: open the detail sheet. Same gesture that starts
        // a copy, resolved by whether the finger travelled — which is exactly
        // how dragging a Home Screen icon works, so it is already learned.
        if heldStill {
            if let lamp, lamp.reachable { model.inspecting = lamp }
            return
        }

        guard let lamp else {
            // A tap on empty floor does nothing — "toggle everything" by
            // accident is a bad surprise in a dark room — but a DOUBLE tap on
            // the floor is unambiguous, and "all off" is the one command worth
            // reaching without aiming.
            if Date.now.timeIntervalSince(lastTapAt) < 0.35 {
                lastTapAt = .distantPast
                await model.allOff()
            } else {
                lastTapAt = .now
            }
            return
        }

        // Second tap on the same lamp inside the window: solo it.
        //
        // The first tap has already toggled, deliberately — delaying every
        // single tap by 350ms to find out whether a second one is coming makes
        // the common case feel broken to save the rare one.
        if Date.now.timeIntervalSince(lastTapAt) < 0.35 {
            lastTapAt = .distantPast
            await model.solo(lamp)
        } else {
            lastTapAt = .now
            await model.toggle(lamp)
        }
    }
}

extension View {
    /// Every room gesture, in one recogniser.
    ///
    /// - `lamp`: nil for the floor, which can be adjusted and double-tapped but
    ///   not carried.
    /// - `centres`: where the other lamps are, for finding a drop target.
    func roomControl(targets: [String], lamp: Lamp?, centres: [String: CGPoint]) -> some View {
        modifier(RoomControl(targets: targets, lamp: lamp, centres: centres))
    }
}
