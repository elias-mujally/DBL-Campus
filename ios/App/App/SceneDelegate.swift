import UIKit
import WebKit
import Capacitor

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

final class DBLBridgeViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private static let maxExportBytes = 16 * 1024 * 1024
    private static let messageNames = ["dblPrint", "dblDownload", "dblSaveFile"]

    override func viewDidLoad() {
        super.viewDidLoad()
        if let userContentController = webView?.configuration.userContentController {
            let proxy = WeakScriptMessageHandler(delegate: self)
            for name in Self.messageNames {
                userContentController.removeScriptMessageHandler(forName: name)
                userContentController.add(proxy, name: name)
            }
        }
    }

    deinit {
        if let userContentController = webView?.configuration.userContentController {
            for name in Self.messageNames {
                userContentController.removeScriptMessageHandler(forName: name)
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        switch message.name {
        case "dblPrint":
            let title = sanitizeFilename(body["title"] as? String ?? "", fallback: "DBL_Campus_Document")
            presentNativePrint(title: title)
        case "dblDownload":
            guard let urlString = body["url"] as? String,
                  let url = URL(string: urlString),
                  url.scheme?.lowercased() == "https",
                  url.host != nil else { return }
            let fileName = sanitizeFilename(body["fileName"] as? String ?? "", fallback: "DBL_Campus_Attachment")
            downloadAndShare(url: url, fileName: fileName)
        case "dblSaveFile":
            guard let base64 = body["base64Data"] as? String,
                  !base64.isEmpty,
                  let data = Data(base64Encoded: base64),
                  data.count <= Self.maxExportBytes else { return }
            let fileName = sanitizeFilename(body["fileName"] as? String ?? "", fallback: "DBL_Campus_Export")
            writeAndShare(data: data, fileName: fileName)
        default:
            break
        }
    }

    private func sanitizeFilename(_ raw: String, fallback: String) -> String {
        let disallowed = CharacterSet(charactersIn: "/\\").union(.controlCharacters)
        let components = raw.components(separatedBy: disallowed)
        var cleaned = components.joined(separator: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        while cleaned.hasPrefix(".") {
            cleaned.removeFirst()
        }
        if cleaned.count > 140 {
            cleaned = String(cleaned.prefix(140))
        }
        return cleaned.isEmpty ? fallback : cleaned
    }

    private func presentNativePrint(title: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let webView = self.webView else { return }
            let printInfo = UIPrintInfo(dictionary: nil)
            printInfo.jobName = title
            printInfo.outputType = .general

            let controller = UIPrintInteractionController.shared
            controller.printInfo = printInfo
            controller.printFormatter = webView.viewPrintFormatter()
            controller.present(animated: true, completionHandler: nil)
        }
    }

    private func downloadAndShare(url: URL, fileName: String) {
        let task = URLSession.shared.downloadTask(with: url) { [weak self] tempUrl, response, error in
            guard let self = self,
                  error == nil,
                  let tempUrl = tempUrl,
                  let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else { return }
            let destination = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
            do {
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }
                try FileManager.default.moveItem(at: tempUrl, to: destination)
                self.presentShareSheet(for: destination)
            } catch {
                // Ignore file move failure
            }
        }
        task.resume()
    }

    private func writeAndShare(data: Data, fileName: String) {
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
        do {
            try data.write(to: destination, options: .atomic)
            presentShareSheet(for: destination)
        } catch {
            // Ignore write failure
        }
    }

    private func presentShareSheet(for fileUrl: URL) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let activity = UIActivityViewController(activityItems: [fileUrl], applicationActivities: nil)
            if let popover = activity.popoverPresentationController {
                popover.sourceView = self.view
                popover.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
            self.present(activity, animated: true, completion: nil)
        }
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = DBLBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
