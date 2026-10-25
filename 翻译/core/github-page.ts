import { formatGitHubReleaseDate, type GitHubReleaseInfo } from "./github"
import { githubAvatarURL } from "./github-url"
import { parseHTML } from "./linkedom"

/**
 * 把 GitHub Release 的正文 HTML 变成可翻译的网页。
 *
 * 关键取舍：不把正文拍平成一段段纯文本，而是保留 GitHub 原本的 DOM
 * （标题层级、列表、表格、引用、代码块、行内链接/加粗），只给每个文本
 * 节点套一个 <span data-lingo-i>。翻译完成后按 span 换文字，布局与
 * Release 页面一致；代码块、内联代码、图片、表格结构都不动。
 */
export type GitHubTextSegment = {
  index: number
  /** 去掉首尾空白后的原文，作为翻译输入与缓存对齐依据。 */
  text: string
  /** 原文本节点在 span 内保留的首尾空白，回填时原样加回。 */
  leading: string
  trailing: string
  /** 最近的块级祖先 ID；连续同一块的文本拼成一组送去翻译。 */
  block: number
}

export type GitHubTextGroup = {
  indices: number[]
  source: string
}

export type PreparedGitHubPage = {
  html: string
  segments: GitHubTextSegment[]
  groups: GitHubTextGroup[]
  sourceHash: string
  truncated: boolean
}

// 全文收集；请求大小与进度由 github-translation 分批控制，不丢弃长文尾部。
/** 一组内的原文长度上限；超过谷歌单次请求长度会破坏 ⟦n⟧ 对齐。 */
const MAX_GROUP_CHARS = 850

const SKIP_TAGS = new Set([
  "PRE", "CODE", "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE",
  "SVG", "MATH", "IFRAME", "OBJECT", "EMBED", "CANVAS",
])
const BLOCK_TAGS = new Set([
  "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH",
  "BLOCKQUOTE", "DT", "DD", "FIGCAPTION", "SUMMARY", "DIV", "SECTION",
  "ARTICLE", "BODY", "DETAILS",
])
const REMOVE_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT",
  "BUTTON", "SELECT", "TEXTAREA", "VIDEO", "AUDIO", "SOURCE", "TRACK",
  "CANVAS", "SVG", "MATH", "TEMPLATE", "LINK", "META", "BASE",
])

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
}

function escapeHTML(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char] || char)
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

function resolveURL(value: unknown, pageUrl: string) {
  const raw = String(value || "").trim()
  if (!raw) return ""
  if (/^(?:javascript|vbscript|data|file):/i.test(raw)) return ""
  if (raw.startsWith("#")) return raw
  if (raw.startsWith("//")) return `https:${raw}`
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^mailto:/i.test(raw)) return raw
  if (raw.startsWith("/")) return `https://github.com${raw}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw
  try {
    return new URL(raw, pageUrl).toString()
  } catch {
    return `https://github.com/${raw.replace(/^\.?\//, "")}`
  }
}

function sanitizeAttributes(element: any, pageUrl: string) {
  const tag = String(element.tagName || "").toUpperCase()
  for (const attribute of Array.from(element.attributes || []) as any[]) {
    const name = String(attribute.name || "").toLowerCase()
    if (
      name.startsWith("on") || name.startsWith("data-") || name.startsWith("aria-") ||
      name === "style" || name === "class" || name === "id" || name === "role" ||
      name === "tabindex" || name === "contenteditable" || name === "spellcheck" ||
      name === "draggable" || name === "align" || name === "valign" || name === "border" ||
      name === "cellpadding" || name === "cellspacing" || name === "dir" || name === "lang" ||
      name === "srcset" || name === "sizes" || name === "target" || name === "rel"
    ) {
      element.removeAttribute(attribute.name)
      continue
    }
    if (name === "href" || name === "src") {
      const resolved = resolveURL(attribute.value, pageUrl)
      if (resolved) element.setAttribute(attribute.name, resolved)
      else element.removeAttribute(attribute.name)
    }
  }
  if (tag === "IMG") {
    element.setAttribute("loading", "lazy")
    element.setAttribute("decoding", "async")
  }
}

function sanitizeTree(node: any, pageUrl: string) {
  for (const child of Array.from(node.childNodes || []) as any[]) {
    if (child.nodeType === 8) {
      node.removeChild(child)
      continue
    }
    if (child.nodeType !== 1) continue
    const tag = String(child.tagName || "").toUpperCase()
    if (REMOVE_TAGS.has(tag)) {
      node.removeChild(child)
      continue
    }
    sanitizeAttributes(child, pageUrl)
    if (tag === "IMG" && !child.getAttribute("src")) {
      node.removeChild(child)
      continue
    }
    sanitizeTree(child, pageUrl)
  }
}

function wrapTextNodes(document: any, root: any) {
  const segments: GitHubTextSegment[] = []
  let blockSeq = 0
  const blockIds = new Map<any, number>()
  const blockId = (node: any) => {
    if (!blockIds.has(node)) blockIds.set(node, blockSeq++)
    return blockIds.get(node)!
  }

  const visit = (node: any, block: any) => {
    for (const child of Array.from(node.childNodes || []) as any[]) {
      if (child.nodeType === 3) {
        const raw = String(child.nodeValue || "")
        if (!raw.trim()) continue
        // 纯标点/符号（列表里的 •、破折号）不送翻译，保留原样。
        if (!/[\p{L}\p{N}]/u.test(raw)) continue
        const trimmed = raw.trim()
        if (!trimmed) continue
        const currentBlock = blockId(block)
        const start = raw.indexOf(trimmed)
        const leading = start > 0 ? raw.slice(0, start) : ""
        const trailing = start >= 0 ? raw.slice(start + trimmed.length) : ""
        const index = segments.length
        const span = document.createElement("span")
        span.setAttribute("data-lingo-i", String(index))
        // 先保留原始文本（含空白）；翻译结果稍后由页面里的 __lingoSet 注入。
        span.textContent = raw
        child.parentNode.replaceChild(span, child)

        segments.push({
          index,
          text: trimmed.replace(/\s+/g, " "),
          leading,
          trailing,
          block: currentBlock,
        })
      } else if (child.nodeType === 1) {
        const tag = String(child.tagName || "").toUpperCase()
        if (SKIP_TAGS.has(tag)) continue
        visit(child, BLOCK_TAGS.has(tag) ? child : block)
      }
    }
  }

  visit(root, root)
  return { segments, truncated: false }
}

function groupSegments(segments: GitHubTextSegment[]) {
  const groups: GitHubTextGroup[] = []
  let current: GitHubTextSegment[] = []
  let currentLength = 0

  const flush = () => {
    if (!current.length) return
    let source = current[0].text
    for (let index = 1; index < current.length; index += 1) {
      source += `\n⟦${current[index].index}⟧\n${current[index].text}`
    }
    groups.push({ indices: current.map((item) => item.index), source })
    current = []
    currentLength = 0
  }

  for (const segment of segments) {
    const previous = current[current.length - 1]
    if (
      previous &&
      (segment.block !== previous.block || currentLength + segment.text.length > MAX_GROUP_CHARS)
    ) {
      flush()
    }
    current.push(segment)
    currentLength += segment.text.length + 8
  }
  flush()
  return groups
}

function titleSegment(title: string) {
  const text = title.trim()
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null
  return { index: -1, text, leading: "", trailing: "", block: -2 }
}

function assetListHTML(assets: GitHubReleaseInfo["assets"]) {
  if (!assets.length) return ""
  const rows = assets.map((asset) => `
      <li class="asset-row">
        <a class="asset-link" href="${escapeHTML(asset.url)}">
          <span class="asset-arrow">↓</span>
          <span class="asset-name">${escapeHTML(asset.name)}</span>
        </a>
        ${asset.size ? `<span class="asset-size">${escapeHTML(asset.size)}</span>` : ""}
      </li>`).join("")
  return `
    <section class="assets">
      <h2>Assets</h2>
      <ul class="asset-list">${rows}
      </ul>
    </section>`
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #59636e;
  --border: #d1d9e0;
  --link: #0969da;
  --code-bg: rgba(175, 184, 193, 0.24);
  --pre-bg: #f6f8fa;
  --stripe: #f6f8fa;
  --label: #1f883d;
  --label-fg: #ffffff;
  --notice-bg: #fff8c5;
  --notice-fg: #7d4e00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #9198a1;
    --border: #3d444d;
    --link: #4493f8;
    --code-bg: rgba(110, 118, 129, 0.4);
    --pre-bg: #151b23;
    --stripe: #151b23;
    --label: #238636;
    --label-fg: #ffffff;
    --notice-bg: #3b2e00;
    --notice-fg: #f0d47a;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  overflow-x: hidden;
  -webkit-tap-highlight-color: transparent;
}
a { color: var(--link); text-decoration: none; }
a:active { opacity: 0.62; }
.page {
  max-width: 980px;
  margin: 0 auto;
  padding: calc(52px + env(safe-area-inset-top)) 18px calc(126px + env(safe-area-inset-bottom));
}
.repo-header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  margin: 0 0 16px;
}
.repo-avatar-tile {
  position: relative;
  width: 32px;
  height: 32px;
  margin-top: 1px;
  flex: 0 0 auto;
  border-radius: 8px;
  overflow: hidden;
  background: var(--pre-bg);
}
.repo-avatar {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.repo-avatar-letter {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 14px;
  font-weight: 700;
}
.repo-heading { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.repo-title {
  min-width: 0;
  color: var(--fg);
  font-size: 20px;
  font-weight: 600;
  line-height: 1.25;
  word-break: break-word;
}
.repo-title a { color: var(--fg); }
.repo-title .slash { color: var(--muted); font-weight: 400; margin: 0 2px; }
.repo-visibility {
  display: inline-block;
  margin-left: 6px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 2em;
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  vertical-align: 1px;
  white-space: nowrap;
}
.repo-source {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.4;
}
.github-mark { width: 13px; height: 13px; flex: 0 0 auto; fill: currentColor; }
.source-link {
  min-width: 0;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slash { color: var(--muted); margin: 0 4px; }
.release-nav, .readme-nav {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 0;
  font-size: 14px;
  color: var(--muted);
}
.release-nav a, .readme-nav a { color: var(--link); }
.tag-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 1px 9px;
  border: 1px solid var(--border);
  border-radius: 2em;
  color: var(--muted);
  background: var(--bg);
  font-size: 12px;
  line-height: 20px;
  word-break: break-all;
}
.release-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}
.release-title {
  margin: 0;
  font-size: 32px;
  line-height: 1.22;
  font-weight: 600;
  letter-spacing: -0.01em;
  word-break: break-word;
}
.label {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 2em;
  background: var(--label);
  color: var(--label-fg);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
}
.repo-description {
  margin: 14px 0 22px;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.55;
  overflow-wrap: break-word;
}
.repo-description h2 {
  margin: 0 0 8px;
  font-size: 16px;
  line-height: 1.35;
  font-weight: 600;
}
.repo-description p { margin: 0; }
.release-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px 0 22px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 14px;
  line-height: 1.4;
}
.release-meta a { color: var(--muted); font-weight: 600; }
.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  flex: 0 0 auto;
  object-fit: cover;
  background: var(--pre-bg);
}
.avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}
.markdown-body { font-size: 16px; line-height: 1.62; word-wrap: break-word; }
.markdown-body > :first-child { margin-top: 0 !important; }
.markdown-body > :last-child { margin-bottom: 0 !important; }
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  margin: 1.4em 0 0.55em;
  font-weight: 600;
  line-height: 1.25;
}
.markdown-body h1, .markdown-body h2 {
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--border);
}
.markdown-body h1 { font-size: 2em; }
.markdown-body h2 { font-size: 1.5em; }
.markdown-body h3 { font-size: 1.25em; }
.markdown-body h4 { font-size: 1em; }
.markdown-body h5 { font-size: 0.875em; }
.markdown-body h6 { font-size: 0.85em; color: var(--muted); }
.markdown-body p { margin: 0 0 16px; }
.markdown-body ul, .markdown-body ol { margin: 0 0 16px; padding-left: 1.8em; }
.markdown-body li { margin: 0.25em 0; }
.markdown-body li > ul, .markdown-body li > ol { margin: 4px 0; }
.markdown-body li > p { margin: 0 0 8px; }
.markdown-body blockquote {
  margin: 0 0 16px;
  padding: 0 1em;
  color: var(--muted);
  border-left: 4px solid var(--border);
}
.markdown-body blockquote > :last-child { margin-bottom: 0; }
.markdown-body hr {
  height: 1px;
  margin: 24px 0;
  border: 0;
  background: var(--border);
}
.markdown-body code, .markdown-body kbd, .markdown-body samp {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 85%;
  padding: 0.18em 0.4em;
  border-radius: 6px;
  background: var(--code-bg);
}
.markdown-body pre {
  margin: 0 0 16px;
  padding: 14px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border-radius: 8px;
  background: var(--pre-bg);
  line-height: 1.45;
}
.markdown-body pre code {
  padding: 0;
  background: transparent;
  font-size: 13px;
  white-space: pre;
}
.markdown-body table {
  display: block;
  width: max-content;
  max-width: 100%;
  margin: 0 0 16px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border-spacing: 0;
  border-collapse: collapse;
}
.markdown-body th, .markdown-body td {
  padding: 6px 13px;
  border: 1px solid var(--border);
  vertical-align: top;
}
.markdown-body th { font-weight: 600; }
.markdown-body tr:nth-child(2n) { background: var(--stripe); }
.markdown-body img { max-width: 100%; height: auto; border-radius: 6px; }
.markdown-body details {
  margin: 0 0 16px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.markdown-body summary { cursor: pointer; font-weight: 600; }
.markdown-body .empty { color: var(--muted); }
.notice {
  margin: 18px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--notice-bg);
  color: var(--notice-fg);
  font-size: 13px;
  line-height: 1.45;
}
.assets {
  margin-top: 34px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}
.assets h2 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
.asset-list { list-style: none; margin: 0; padding: 0; }
.asset-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
}
.asset-row:last-child { border-bottom: 0; }
.asset-link { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.asset-name { word-break: break-all; }
.asset-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: 5px;
  background: var(--code-bg);
  color: var(--muted);
  font-size: 13px;
  font-weight: 700;
}
.asset-size { color: var(--muted); font-size: 12px; white-space: nowrap; }
.view-on {
  margin: 32px 0 0;
  font-size: 14px;
  color: var(--muted);
}
@media (max-width: 480px) {
  .page { padding-left: 15px; padding-right: 15px; }
  .release-title { font-size: 27px; }
  .markdown-body { font-size: 15.5px; }
}
`

const SCRIPT = `
(function () {
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-lingo-i]'));
  var originals = {};
  var translations = {};
  var mode = 'translated';
  nodes.forEach(function (el) {
    var i = el.getAttribute('data-lingo-i');
    originals[i] = el.textContent;
  });
  function apply() {
    nodes.forEach(function (el) {
      var i = el.getAttribute('data-lingo-i');
      var value = mode === 'original' ? originals[i] : (translations[i] != null ? translations[i] : originals[i]);
      if (el.textContent !== value) el.textContent = value;
    });
  }
  window.__lingoSet = function (map) {
    if (map && typeof map === 'object') {
      for (var key in map) {
        if (Object.prototype.hasOwnProperty.call(map, key)) translations[key] = String(map[key]);
      }
    }
    apply();
    return true;
  };
  window.__lingoMode = function (next) {
    mode = next === 'original' ? 'original' : 'translated';
    apply();
    return true;
  };
  window.__lingoCount = nodes.length;
  window.__lingoReady = true;
})();
`

export function prepareGitHubReleasePage(release: GitHubReleaseInfo): PreparedGitHubPage {
  const isProfile = release.kind === "profile"
  const isReadme = release.kind === "readme"
  const isRepositoryHome = isReadme && release.isRepositoryHome === true
  const pageUrl = release.contentBaseUrl || release.htmlUrl
  const { document } = parseHTML(`<!DOCTYPE html><html><body><div id="lingo-root"></div></body></html>`)
  const root = document.getElementById("lingo-root")
  if (!root) throw new Error("GitHub 正文页面解析失败。")
  root.innerHTML = release.bodyHtml || ""
  sanitizeTree(root, pageUrl)
  if (isReadme || isProfile) {
    const article = document.createElement("article")
    article.setAttribute("class", "markdown-body")
    article.innerHTML = String(root.innerHTML || "")
    root.innerHTML = ""
    const description = String(isProfile ? release.profileDescription || "" : release.repositoryDescription || "").trim()
    if ((isRepositoryHome || isProfile) && description) {
      const section = document.createElement("section")
      section.setAttribute("class", "repo-description")
      const heading = document.createElement("h2")
      heading.textContent = "About"
      section.appendChild(heading)
      const paragraph = document.createElement("p")
      paragraph.textContent = description
      section.appendChild(paragraph)
      root.appendChild(section)
    }
    root.appendChild(article)
  }
  const { segments, truncated } = wrapTextNodes(document, root)
  const bodyHTML = String(root.innerHTML || "")
  const groups = groupSegments(segments)

  const title = String(release.title || release.tag || release.repo || "").trim()
  const titleSeg = isRepositoryHome || isProfile ? null : titleSegment(title)
  let titleHTML = escapeHTML(title)
  if (titleSeg) {
    titleSeg.index = segments.length
    segments.push(titleSeg)
    groups.push({ indices: [titleSeg.index], source: titleSeg.text })
    titleHTML = `<span data-lingo-i="${titleSeg.index}">${escapeHTML(title)}</span>`
  }

  const date = formatGitHubReleaseDate(release.publishedAt)
  const authorName = release.author || ""
  const authorHTML = authorName
    ? `<a href="https://github.com/${encodeURIComponent(authorName)}">${escapeHTML(authorName)}</a>`
    : ""
  const avatarURL = release.ownerAvatarUrl || release.avatarUrl || githubAvatarURL(release.owner)
  const authorAvatarURL = release.avatarUrl || release.ownerAvatarUrl
  const avatarInitial = (release.owner || authorName || "?").slice(0, 1).toUpperCase()
  const authorInitial = (authorName || release.owner || "?").slice(0, 1).toUpperCase()
  // 页头头像：图像加载失败时下方的字母底仍然保留位置，不会出现空白块。
  const headerAvatarHTML = `<span class="repo-avatar-tile" aria-hidden="true"><span class="repo-avatar-letter">${escapeHTML(avatarInitial)}</span>${avatarURL ? `<img class="repo-avatar" src="${escapeHTML(avatarURL)}" alt="" loading="eager" decoding="async" onerror="this.remove()">` : ""}</span>`
  const authorAvatarHTML = authorAvatarURL
    ? `<img class="avatar" src="${escapeHTML(authorAvatarURL)}" alt="" loading="lazy" decoding="async">`
    : `<span class="avatar avatar-fallback">${escapeHTML(authorInitial)}</span>`
  const githubMarkHTML = `<svg class="github-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.54v-2.1c-3.1.67-3.75-1.32-3.75-1.32-.5-1.29-1.23-1.63-1.23-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.16 1.71 1.16.99 1.7 2.59 1.21 3.22.93.1-.72.39-1.21.7-1.49-2.48-.28-5.09-1.24-5.09-5.53 0-1.22.44-2.22 1.16-3-.12-.28-.5-1.42.11-2.96 0 0 .95-.3 3.05 1.15a10.6 10.6 0 0 1 5.55 0c2.1-1.45 3.05-1.15 3.05-1.15.61 1.54.23 2.68.11 2.96.72.78 1.16 1.78 1.16 3 0 4.3-2.61 5.25-5.1 5.52.4.35.75 1.03.75 2.08v3.09c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/></svg>`
  const ownerURL = `https://github.com/${encodeURIComponent(release.owner)}`
  const repoURL = release.repo ? `${ownerURL}/${encodeURIComponent(release.repo)}` : ""
  const headerTitleHTML = release.repo
    ? `<a href="${escapeHTML(ownerURL)}">${escapeHTML(release.owner)}</a><span class="slash">/</span><a href="${escapeHTML(repoURL)}">${escapeHTML(release.repo)}</a><span class="repo-visibility">Public</span>`
    : `<a href="${escapeHTML(ownerURL)}">${escapeHTML(release.owner)}</a>`
  const headerSourceURL = release.htmlUrl || repoURL || ownerURL
  const headerSourceLabel = headerSourceURL.replace(/^https?:\/\//i, "").replace(/\/$/, "")
  // 顶部恢复 GitHub 链接卡片的本体：所有者/仓库头像 + 名称 + 可点原链接，
  // 不再只留一行生链接。仓库页额外带 GitHub 的 Public 标签。
  const headerHTML = `<header class="repo-header">
      ${headerAvatarHTML}
      <div class="repo-heading">
        <div class="repo-title">${headerTitleHTML}</div>
        <div class="repo-source">${githubMarkHTML}<a class="source-link" href="${escapeHTML(headerSourceURL)}" title="${escapeHTML(headerSourceURL)}">${escapeHTML(headerSourceLabel)}</a></div>
      </div>
    </header>`
  const latestHTML = !isReadme && !isProfile && release.isLatest ? `<span class="label">Latest</span>` : ""

  const html = `<!DOCTYPE html>
<html lang="${escapeHTML("en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHTML(title || release.tag)}</title>
${avatarURL ? `<link rel="preload" as="image" href="${escapeHTML(avatarURL)}">` : ""}
<style>${STYLE}</style>
</head>
<body>
  <main class="page">
    ${headerHTML}
    ${isRepositoryHome || isProfile ? "" : `<nav class="${isReadme ? "readme-nav" : "release-nav"}">
      <a href="${escapeHTML(isReadme ? release.htmlUrl : `https://github.com/${release.owner}/${release.repo}/releases`)}">${isReadme ? "Repository" : "Releases"}</a>
      <span class="slash">/</span>
      <span class="tag-chip">${escapeHTML(isReadme ? release.readmeName || "README" : release.tag || title)}</span>
    </nav>`}
    ${isRepositoryHome || isProfile ? "" : `<div class="release-title-row">
      <h1 class="release-title">${titleHTML}</h1>
      ${latestHTML}
    </div>`}
    ${isProfile || isRepositoryHome ? "" : isReadme
      ? `<div class="release-meta">${escapeHTML(release.readmeName || "README")}</div>`
      : `<div class="release-meta">
      ${authorAvatarHTML}
      <span>${authorHTML}${authorHTML ? " " : ""}released this${date ? ` on ${escapeHTML(date)}` : ""}</span>
    </div>`}
    ${isProfile
      ? bodyHTML || `<article class="markdown-body"><p class="empty">No public profile README is available.</p></article>`
      : isReadme
        ? bodyHTML || `<article class="markdown-body"><p class="empty">此仓库未提供 README 正文。</p></article>`
        : `<article class="markdown-body">${bodyHTML || `<p class="empty">此版本未提供发布说明。</p>`}</article>`}
    ${isReadme || isProfile ? "" : assetListHTML(release.assets)}
    <p class="view-on"><a href="${escapeHTML(release.htmlUrl)}">View on GitHub →</a></p>
  </main>
  <script>${SCRIPT}</script>
</body>
</html>`

  const sourceHash = fnv1a(`${release.kind || "release"}\u0000${release.htmlUrl}\u0000${release.owner}\u0000${release.repo}\u0000${release.tag}\u0000${title}\u0000${avatarURL}\u0000${bodyHTML}`)
  return { html, segments, groups, sourceHash, truncated }
}
