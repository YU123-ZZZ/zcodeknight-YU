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
import { changelogSectionFor, manifestToEntry, mergeClientEntry, type IntelEntry } from "./upstream-intel.js";

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

// The "官方实时情报" page froze at v3.15.1 while the installed client kept
// moving: the public GitHub repo stopped being the release vehicle, and real
// client versions ship through the official Electron update manifest. These
// rows pin the manifest→entry conversion and the dedupe merge.
describe("the live client channel (electron manifest)", () => {
  // Shape taken from the live endpoint (2026-10-24), trimmed.
  const MANIFEST_YAML = `version: 3.16.3
files:
    - url: https://cdn-zcode.z.ai/zcode/electron/releases/3.16.3/windows-x64/ZCode-3.16.3-win-x64.exe
      sha512: 13o4qvOqKiRT8XeMECr5kx1aGIxNp8v43naAoBKRx5lorBOaove3lOe2YqiI5SjO9djXz7/cfYfhsBbEJJuGZw==
      size: 190777144
path: https://cdn-zcode.z.ai/zcode/electron/releases/3.16.3/windows-x64/ZCode-3.16.3-win-x64.exe
releaseName: Release v3.16.3
releaseNotes: |-
    ## 新功能

    - 帮助菜单新增复制设备号功能，反馈问题更方便。
    - 登录链接无法自动打开时，可复制后手动完成登录。
`;

  it("converts the manifest YAML into the newest intel entry", () => {
    const entry = manifestToEntry(MANIFEST_YAML);
    expect(entry).not.toBeNull();
    expect(entry!.version).toBe("v3.16.3");
    expect(entry!.notes).toContain("复制设备号");
    expect(entry!.notes).toContain("Release v3.16.3");
    expect(entry!.url).toContain("ZCode-3.16.3-win-x64.exe");
    expect(entry!.notesSource).toBe("client-manifest");
    expect(entry!.source).toContain("官方更新通道");
    expect(entry!.source).toContain("182 MB");
  });

  it("returns null for a garbage/empty manifest instead of inventing an entry", () => {
    expect(manifestToEntry("")).toBeNull();
    expect(manifestToEntry("not: [valid")).toBeNull();
    expect(manifestToEntry("files: []")).toBeNull();
  });

  it("prepends the client entry and dedupes by version", () => {
    const ring: IntelEntry[] = [
      { version: "v3.15.1", date: "2026-10-10", notes: "", url: "https://github.com/zai-org/ZCode/releases/tag/v3.15.1" },
    ];
    const client = manifestToEntry(MANIFEST_YAML)!;
    const merged = mergeClientEntry(ring, client);
    expect(merged.length).toBe(2);
    expect(merged[0]!.version).toBe("v3.16.3");
    expect(merged[0]!.source).toContain("官方更新通道");

    // Once the public repo resumes publishing 3.16.3 itself, the two sources
    // would show the same release twice — dedupe by normalized version keeps
    // the GitHub ring's OWN entry (its canonical release URL/notes) and drops
    // only the manifest copy.
    const ringWithSame: IntelEntry[] = [
      { version: "3.16.3", date: "2026-10-20", notes: "upstream text", url: "" },
      ...ring,
    ];
    const deduped = mergeClientEntry(ringWithSame, client);
    expect(deduped.length).toBe(2);
    expect(deduped[0]!.notes).toBe("upstream text");
    expect(deduped.some((e) => e.notesSource === "client-manifest")).toBe(false);
  });

  it("leaves the ring untouched when the manifest fetch failed", () => {
    const ring: IntelEntry[] = [
      { version: "v3.15.1", date: "2026-10-10", notes: "", url: "" },
    ];
    expect(mergeClientEntry(ring, null)).toBe(ring);
  });
});
