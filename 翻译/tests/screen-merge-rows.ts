import { Script } from "scripting"
import { buildOCRBlocks, type OCRCandidate } from "../core/screen-ocr"
import { mergeLineBlocksForTest } from "../core/screen-overlay"

/**
 * 行合并回归（2026-10-19 漏译修复）：
 * - Vision 把一行拆成上下两块（后半块以逗号开头）必须合并成一行；
 * - 相邻两条更新日志（缝隙约 0.5 行高）**不能**被误并；
 * - 「·」开头的短行不能被当成噪声删除（见 screen-release-notes）。
 */
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures.push(`${name}${detail ? `：${detail}` : ""}`)
}

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const cand = (content: string, b: { x: number; y: number; width: number; height: number }): OCRCandidate =>
  ({ content, confidence: 0.5, boundingBox: b })

async function main() {
  // 一行被拆开：同上 top（约 0.6），后半块以逗号开头且水平紧邻。
  const split = buildOCRBlocks([
    cand("• Fixed bare keys dropped from INI '#larguments'", box(0.05, 0.34, 0.45, 0.05)),
    cand("， and YAML module argument placeholders in numeric fields", box(0.50, 0.335, 0.45, 0.05)),
  ])
  const splitRows = mergeLineBlocksForTest(split)
  console.log(`拆行合并：${splitRows.length} 行 → ${JSON.stringify(splitRows.map((row) => row.text))}`)
  check("拆成两块的一行应合并为一行", splitRows.length === 1, `${splitRows.length}`)
  check(
    "合并后标点前不多空格",
    !!splitRows[0] && splitRows[0].text.includes("'#larguments'， and YAML"),
    splitRows[0]?.text,
  )

  // 相邻两条：框不重叠、垂直缝隙约 0.02（真实截图 1240px 高时约 25px）——不能被合并。
  const adjacent = buildOCRBlocks([
    cand("• Fixed IPv6 availability not updating after switching networks", box(0.05, 0.60, 0.90, 0.05)),
    cand("• Fixed inaccurate protocol, policy, and failed", box(0.05, 0.53, 0.90, 0.05)),
  ])
  const adjacentRows = mergeLineBlocksForTest(adjacent)
  console.log(`相邻两行：${adjacentRows.length} 行`)
  check("相邻两条不应误并", adjacentRows.length === 2, `${adjacentRows.length}`)

  // 行首 · 短行保留（OCR 过滤层）。
  const filtered = buildOCRBlocks([
    cand("• Fixed inaccurate protocol, policy, and failed", box(0.05, 0.5, 0.9, 0.05)),
  ])
  check("行首 · 短行不被过滤", filtered.length === 1, `${filtered.length}`)

  if (failures.length) {
    console.log(`行合并回归失败 ${failures.length} 项：\n- ${failures.join("\n- ")}`)
    Script.exit("failed")
  }
  console.log("行合并回归通过")
  Script.exit("passed")
}

void main()
