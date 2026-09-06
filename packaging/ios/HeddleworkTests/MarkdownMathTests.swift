import XCTest
@testable import Heddlework

final class MarkdownMathTests: XCTestCase {
    func testDoesNotLeaveRawMarkdownTokens() {
        let source = """
        ### Rendered heading

        Paragraph with a [Comment](https://example.com/comment) and commit `abc1234`.

        - first item
        - second item
        """
        let prepared = MarkdownMath.prepare(source)
        XCTAssertEqual(prepared.blocks.count, 3)
        guard case .heading(let level, let heading) = prepared.blocks[0] else { return XCTFail("expected heading") }
        XCTAssertEqual(level, 3)
        XCTAssertEqual(inlineText(heading), "Rendered heading")
        guard case .paragraph(let paragraph) = prepared.blocks[1] else { return XCTFail("expected paragraph") }
        XCTAssertTrue(paragraph.contains { if case .link(let text, let url) = $0 { return text == "Comment" && url.contains("example.com") } else { return false } })
        XCTAssertTrue(paragraph.contains { if case .code(let code) = $0 { return code == "abc1234" } else { return false } })
        guard case .list(false, let items) = prepared.blocks[2] else { return XCTFail("expected list") }
        XCTAssertEqual(items.count, 2)
        XCTAssertFalse(inlineText(heading).contains("###"))
    }

    func testSkipsMathInsideCodeAndSegmentsInlineMath() {
        XCTAssertEqual(MarkdownMath.segmentMathMarkdown("use `$x^2$` here").map(describe), ["text:use `$x^2$` here"])
        let mixed = MarkdownMath.segmentMathMarkdown("a $E=mc^2$ b")
        XCTAssertEqual(mixed.map(describe), ["text:a ", "math:E=mc^2", "text: b"])
        let prepared = MarkdownMath.prepare("Energy is $E=mc^2$.")
        guard case .paragraph(let inlines) = prepared.blocks.first else { return XCTFail("paragraph") }
        XCTAssertTrue(inlines.contains { if case .math(let latex) = $0 { return latex == "E=mc^2" } else { return false } })
    }

    func testMalformedMathFallsBack() {
        XCTAssertNil(FormulaTypesetter.render("\\frac{1"))
        XCTAssertTrue(FormulaTypesetter.attributed("\\frac{1", display: false, fontSize: 14).characters.contains { $0 == "\\" })
        XCTAssertEqual(TeXRenderer.tryRender("E=mc^2") ?? "", "E=mc²")
    }

    func testCurrencyIsNotMath() {
        let segments = MarkdownMath.segmentMathMarkdown("costs $5 and $10 total")
        XCTAssertEqual(segments.map(describe), ["text:costs $5 and $10 total"])
    }

    private func inlineText(_ inlines: [MarkdownInline]) -> String {
        inlines.map {
            switch $0 {
            case .text(let text): return text
            case .strong(let children), .emphasis(let children): return inlineText(children)
            case .code(let code): return code
            case .link(let text, _): return text
            case .math(let latex): return latex
            }
        }.joined()
    }

    private func describe(_ segment: MathSegment) -> String {
        switch segment {
        case .text(let text): return "text:\(text)"
        case .math(let latex, _, _): return "math:\(latex)"
        }
    }
}

private extension TeXRenderer {
    static func tryRender(_ latex: String) -> String? {
        try? render(latex)
    }
}
