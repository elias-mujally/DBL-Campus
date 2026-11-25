import UIKit
import WebKit
import Capacitor
import Security

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    init(delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}
private final class WeakScriptMessageHandlerWithReply: NSObject, WKScriptMessageHandlerWithReply {
    weak var delegate: WKScriptMessageHandlerWithReply?

    init(delegate: WKScriptMessageHandlerWithReply) {
        self.delegate = delegate
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let delegate = delegate else {
            replyHandler(nil, "Bridge unavailable")
            return
        }
        delegate.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
    }
}

final class DBLBridgeViewController: CAPBridgeViewController, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    private static let maxExportBytes = 16 * 1024 * 1024
    private static let messageNames = ["dblPrint", "dblDownload", "dblSaveFile"]
    private static let secureStorageMessageName = "dblSecureStorage"
    private static let keychainService = "edu.dbl.campus.session"
    private static let keychainAccount = "auth_token"
    private static let sessionQueue = DispatchQueue(label: "edu.dbl.campus.session.queue")

    override func viewDidLoad() {
        super.viewDidLoad()
        if let userContentController = webView?.configuration.userContentController {
            let proxy = WeakScriptMessageHandler(delegate: self)
            for name in Self.messageNames {
                userContentController.removeScriptMessageHandler(forName: name)
                userContentController.add(proxy, name: name)
            }
            let replyProxy = WeakScriptMessageHandlerWithReply(delegate: self)
            userContentController.removeScriptMessageHandler(forName: Self.secureStorageMessageName, contentWorld: .page)
            userContentController.addScriptMessageHandler(replyProxy, contentWorld: .page, name: Self.secureStorageMessageName)
        }
    }

    deinit {
        if let userContentController = webView?.configuration.userContentController {
            for name in Self.messageNames {
                userContentController.removeScriptMessageHandler(forName: name)
            }
            userContentController.removeScriptMessageHandler(forName: Self.secureStorageMessageName, contentWorld: .page)
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == Self.secureStorageMessageName else {
            replyHandler(nil, "Unsupported message")
            return
        }
        let origin = message.frameInfo.securityOrigin
        let isTrustedOrigin = message.frameInfo.isMainFrame
            && origin.host == "localhost"
            && (origin.`protocol` == "capacitor" || origin.`protocol` == "https")
        guard isTrustedOrigin else {
            replyHandler(nil, "Untrusted origin")
            return
        }
        guard let body = message.body as? [String: Any],
              let action = (body["action"] as? String)?.lowercased() else {
            replyHandler(nil, "Invalid secure storage payload")
            return
        }
        switch action {
       case "get":
            Self.sessionQueue.async { [weak self] in
                guard let self = self else {
                    DispatchQueue.main.async {
                        replyHandler(nil, "Bridge unavailable")
                    }
                    return
                }
                let token = self.readKeychainSessionToken()
                DispatchQueue.main.async {
                    replyHandler(token, nil)
                }
            }
        case "set":
            let token = body["token"] as? String ?? body["value"] as? String ?? ""
            Self.sessionQueue.async { [weak self] in
                guard let self = self else {
                    DispatchQueue.main.async {
                        replyHandler(nil, "Bridge unavailable")
                    }
                    return
                }
                let success: Bool
                if token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    success = self.clearKeychainSessionToken()
                } else {
                    success = self.saveKeychainSessionToken(token)
                }
                DispatchQueue.main.async {
                    replyHandler(success, nil)
                }
            }
        case "clear":
            Self.sessionQueue.async { [weak self] in
                guard let self = self else {
                    DispatchQueue.main.async {
                        replyHandler(nil, "Bridge unavailable")
                    }
                    return
                }
                let success = self.clearKeychainSessionToken()
                DispatchQueue.main.async {
                    replyHandler(success, nil)
                }
            }
        default:
            replyHandler(nil, "Unsupported secure storage action")
        }
    }

    private func saveKeychainSessionToken(_ token: String) -> Bool {
        guard let data = token.data(using: .utf8) else { return false }
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.keychainAccount
        ]
        SecItemDelete(baseQuery as CFDictionary)
        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        return status == errSecSuccess
    }

    private func readKeychainSessionToken() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8) else {
            return ""
        }
        return token
    }

    private func clearKeychainSessionToken() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.keychainAccount
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
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
