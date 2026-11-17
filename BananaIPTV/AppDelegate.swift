import UIKit
import AVFoundation

enum Theme {
    static let bg = UIColor(red: 11 / 255, green: 15 / 255, blue: 26 / 255, alpha: 1)
    static let accent = UIColor(red: 251 / 255, green: 146 / 255, blue: 60 / 255, alpha: 1)
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        CrashLog.install()
        // Sound plays even with the ring/silent switch on, like any video app.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.backgroundColor = Theme.bg
        w.rootViewController = WebViewController()
        w.makeKeyAndVisible()
        window = w
        return true
    }

    func application(_ application: UIApplication,
                     supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        .landscape
    }
}
