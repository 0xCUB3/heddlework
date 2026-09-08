import Foundation

struct NativeQuestionOption: Equatable, Identifiable {
    var value: String
    var label: String
    var description: String?
    var id: String { value }
}

struct NativeQuestion: Equatable, Identifiable {
    var requestId: String
    var toolCallId: String?
    var toolName: String
    var stem: String
    var description: String?
    var options: [NativeQuestionOption]
    var multiSelect: Bool
    var allowCustom: Bool
    var allowUnknown: Bool
    var allowNote: Bool
    var kind: String
    var id: String { requestId }

    static func from(tool: ToolRun) -> NativeQuestion? {
        guard tool.status != "complete", let args = tool.args?.object else { return nil }
        if args["questions"] != nil { return nil }
        guard let stem = args["question"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !stem.isEmpty else { return nil }
        let graded = args["correctAnswer"] != nil || args["explanation"] != nil
        let authored = optionList(args["options"])
        let displayed = displayedLabels(tool.details)
        let options: [NativeQuestionOption]
        if displayed.isEmpty {
            options = authored
        } else {
            var remaining = authored
            options = displayed.map { label in
                if let index = remaining.firstIndex(where: { $0.label == label }) {
                    return remaining.remove(at: index)
                }
                return NativeQuestionOption(value: label, label: label)
            }
        }
        let multiSelect = args["multiSelect"]?.bool == true
        let text = options.isEmpty
        return NativeQuestion(
            requestId: tool.id,
            toolCallId: tool.id,
            toolName: tool.name,
            stem: stem,
            description: args["details"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines),
            options: options,
            multiSelect: multiSelect,
            allowCustom: !graded && !text,
            allowUnknown: graded,
            allowNote: graded,
            kind: text ? "text" : (multiSelect ? "multi-select" : "single-select")
        )
    }
}

private func optionList(_ value: JSONValue?) -> [NativeQuestionOption] {
    guard let array = value?.array else { return [] }
    var seen = Set<String>()
    var options: [NativeQuestionOption] = []
    for entry in array {
        guard let object = entry.object, let label = object["label"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else { continue }
        let rawValue = object["value"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        let optionValue = (rawValue?.isEmpty == false ? rawValue : nil) ?? label
        if seen.contains(optionValue) { continue }
        seen.insert(optionValue)
        options.append(NativeQuestionOption(value: optionValue, label: label, description: object["description"]?.string))
    }
    return options
}

private func displayedLabels(_ details: JSONValue?) -> [String] {
    let options = details?.object?["options"] ?? details?.object?["details"]?.object?["options"]
    guard let array = options?.array else { return [] }
    return array.compactMap { entry in
        if let label = entry.string?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return label }
        return entry.object?["label"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
    }.filter { !$0.isEmpty }
}

extension JSONValue {
    var object: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }
    var array: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }
    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }
    var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }
}
