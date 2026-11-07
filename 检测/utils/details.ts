import type { IPInfo } from "./ip"
import type { IPPureReport } from "./ippure"
import type { LookupResult } from "./lookup"

export type DetailRow = { label: string; value: string }

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim() !== "—" ? value.trim() : null
}

/** ASN 下方已经出现的网络名称不再重复列出。 */
export function networkDetails(info: IPInfo | null | undefined, displayedNetwork: string): DetailRow[] {
  const seen = new Set([displayedNetwork.trim().toLowerCase()])
  const rows: DetailRow[] = []
  for (const [label, raw] of [["运营商", info?.isp], ["所属机构", info?.org]]) {
    const value = text(raw)
    if (!value || seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    rows.push({ label: label!, value })
  }
  return rows
}

export function locationDetails(info: IPInfo | null | undefined): DetailRow[] {
  if (!info) return []
  const rows: DetailRow[] = []
  const continents: Record<string, string> = {
    AF: "非洲", AN: "南极洲", AS: "亚洲", EU: "欧洲", NA: "北美洲", OC: "大洋洲", SA: "南美洲",
  }
  const continent = continents[(info.continentCode || "").toUpperCase()] || text(info.continent)
  if (continent) rows.push({ label: "所在大洲", value: continent })
  const timezone = text(info.timezone)
  if (timezone) {
    // offset 是此归属时区的秒数；0 表示 UTC，不能当作缺失。
    const offset = info.offset
    const minutes = typeof offset === "number" && Number.isFinite(offset) && Math.abs(offset) <= 14 * 3600
      ? Math.trunc(Math.abs(offset) / 60) : null
    const utc = minutes === null ? "" : ` · UTC${offset! < 0 ? "−" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
    rows.push({ label: "归属时区", value: timezone + utc })
  }
  const postal = text(info.zip)
  if (postal) rows.push({ label: "参考邮编", value: postal })
  return rows
}

export function accessTypeLabel(
  info: IPInfo | null | undefined,
  reputation: LookupResult["reputation"] | undefined,
  pure: Pick<IPPureReport, "isResidential" | "networkType"> | null | undefined,
): string {
  const hosting = pure?.networkType === "hosting" ? true : reputation?.hosting ?? info?.hosting
  return pure?.isResidential === true ? "住宅 IP"
    : hosting === true ? "机房 IP"
    : info?.mobile === true ? "移动网络"
    : pure?.isResidential === false ? "非住宅 IP"
    : networkTypeLabel(reputation?.networkType)
      || (hosting === false ? "非机房标记" : "暂无分类")
}

export function networkTypeLabel(value: string | null | undefined): string | null {
  if (!value) return null
  const labels: Record<string, string> = {
    business: "商业网络", residential: "住宅网络", wireless: "无线网络", mobile: "移动网络",
    hosting: "托管机房", education: "教育网络", government: "政府网络", military: "军事网络",
  }
  return labels[value.toLowerCase()] || value
}

/** 使用 UTC 展示数据库记录时间，避免与归属时区或本机检测时间混淆。 */
export function detectionTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC"
}
