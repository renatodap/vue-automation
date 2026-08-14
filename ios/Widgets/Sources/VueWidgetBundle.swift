import SwiftUI
import WidgetKit

/// Everything the extension vends: one Home Screen widget and two controls.
///
/// The controls are `Widget`s too — `ControlWidget` refines it — so Control
/// Center, the Lock Screen and the Action Button are all served out of this one
/// bundle, and all three run the same `ActivateSceneIntent` the app and Siri run.
@main
struct VueWidgetBundle: WidgetBundle {
    var body: some Widget {
        SceneGridWidget()
        SceneControl()
        AllLightsControl()
    }
}
