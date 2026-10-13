/**
 * ZcodeKnight — Black Knight Gateway
 * 作者 Author: YU123-ZZZ — https://github.com/YU123-ZZZ
 *
 * Upstream intel: the notes body must survive an empty release body.
 *
 * Field report 2026-10-13: "为啥 3.15.1 不显示介绍了". The GitHub release for
 * v3.15.1 was published with NO body, and the feed rendered an empty card — the
 * version was there and the description was not. These tests pin the fallback
 * chain (atom content → atom summary → official changelog) and the explicit
 * "empty" status that replaces a blank row.
 */
import { describe, it, expect } from "bun:test";
import { changelogSectionFor } from "./upstream-intel.js";

describe("the official changelog supplies text the release feed lacks", () => {
  /**
   * Shape taken from the live page (2026-10-13): each release renders as a
   * version chip, a date line, a download menu, a "Release vX" caption, and
   * only THEN the notes. Tag-stripping puts that chrome between the version and
   * the text, which is why an earlier version of this parser returned a 15-char
   * "section" (the date line) and looked like the release had no notes.
   */
  const CHANGELOG_HTML = `
    <html><body>
      <script>var noise = "<h1>v9.9.9 not a version</h1>";</script>
      <div class="release">
        <span>3.15.1</span><span>发布于 2026年10月12日</span>
        <div data-release-menu="true"><button>下载</button></div>
        <p>Release v3.15.1</p>
        <h3>新功能</h3>
        <p>邀请好友·免费蹬蹬，共得权益活动上线。</p>
        <h3>问题修复</h3>
        <p>修复内置浏览器网站权限默认放行的安全隐患。</p>
      </div>
      <div class="release">
        <span>3.14.5</span><span>发布于 2026年10月9日</span>
        <p>Release v3.14.5</p>
        <p>手动重置后，剩余重置机会的数量会保留显示。</p>
      </div>
    </body></html>
  `;

  it("returns the notes, not the release-block chrome", () => {
    const section = changelogSectionFor(CHANGELOG_HTML, "v3.15.1");
    expect(section).toContain("邀请好友");
    expect(section).toContain("问题修复");
    // The date line and the download menu are chrome, not notes.
    expect(section).not.toContain("发布于");
    expect(section).not.toMatch(/^下载$/m);
    expect(section).not.toContain("Release v3.15.1");
    // It must STOP at the next release.
    expect(section).not.toContain("手动重置后");
    expect(section).not.toContain("3.14.5");
  });

  it("starts with the notes themselves, not with chrome that precedes them", () => {
    // Pins the ORDER of the two steps (skip chrome → then cut at the next
    // version). Doing it the other way round lets the caption "Release v3.15.1"
    // — which contains a version token — act as the cut point, and the section
    // collapses to the date line. A mutation test (removing the chrome skip)
    // left the previous assertions green, so this pins the actual first line.
    const section = changelogSectionFor(CHANGELOG_HTML, "v3.15.1");
    const firstLine = section.split("\n")[0];
    expect(firstLine).toBe("新功能");
  });

  it("accepts a version written without the leading v", () => {
    const section = changelogSectionFor(CHANGELOG_HTML, "3.14.5");
    expect(section).toContain("手动重置后");
    expect(section).not.toContain("邀请好友");
  });

  it("returns an empty string for a version the page does not mention", () => {
    // Tolerant by design: a layout change yields "" (and the entry keeps its
    // explicit "no notes" state) rather than text attributed to the wrong
    // version.
    expect(changelogSectionFor(CHANGELOG_HTML, "v9.9.8")).toBe("");
  });

  it("ignores markup inside script tags", () => {
    const section = changelogSectionFor(CHANGELOG_HTML, "v3.15.1");
    expect(section).not.toContain("not a version");
  });

  it("decodes entities in the extracted text", () => {
    const html = `<span>1.2.3</span><span>发布于 2026年1月1日</span><p>A &amp; B &lt;tag&gt; &quot;quoted&quot;</p><span>1.2.2</span>`;
    expect(changelogSectionFor(html, "v1.2.3")).toBe('A & B <tag> "quoted"');
  });
});
