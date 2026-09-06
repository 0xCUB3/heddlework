import Foundation
import UserNotifications
import UIKit

@MainActor
final class NotificationService: ObservableObject {
    static let shared = NotificationService()

    @Published private(set) var authorized = false
    private var fired = Set<String>()
    private let clientKey = "heddlework.clientId"

    var clientId: String {
        if let existing = UserDefaults.standard.string(forKey: clientKey), !existing.isEmpty { return existing }
        let id = "ios-" + UUID().uuidString
        UserDefaults.standard.set(id, forKey: clientKey)
        return id
    }

    func refreshAuthorization() {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            Task { @MainActor in
                self?.authorized = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            }
        }
    }

    func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
            Task { @MainActor in self?.authorized = granted }
        }
    }

    func deliver(eventId: String, title: String, body: String, sessionPath: String?) {
        guard !fired.contains(eventId) else { return }
        fired.insert(eventId)
        guard authorized, UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let sessionPath { content.userInfo["sessionPath"] = sessionPath }
        let request = UNNotificationRequest(identifier: eventId, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
