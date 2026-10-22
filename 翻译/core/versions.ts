import { fetch } from "scripting"

/** 历史版本条目 */
export type AppVersionEntry = {
  /** 版本号（bundle_version，如 2.1.0） */
  version: string
  /** 版本 ID（external_identifier） */
  versionId: string
  /** 该公开版本的更新说明（不代表某个重复版本号的独立构建）。 */
  notes?: string
}

const REQUEST_TIMEOUT = 10
/** 成功后 10 分钟内直接复用，不再请求；跨进程仍从共享 Storage 读取。 */
const CACHE_FRESH_MS = 10 * 60 * 1000
const versionsInFlight = new Map<string, Promise<AppVersionEntry[]>>()
/** 版本 ID 成功结果缓存：重复打开弹层/价格历史在 TTL 内直接复用。 */
const versionsCache = new Map<string, { at: number; entries: AppVersionEntry[] }>()

export type AppVersionNotes = { version: string; notes: string }
const notesInFlight = new Map<string, Promise<AppVersionNotes[]>>()
const notesCache = new Map<string, { at: number; entries: AppVersionNotes[] }>()

/** 商店客户端响应包含 pageData.versionHistory，桌面网页只有当前说明。 */
const STORE_UA = "AppStore/3.0 iOS/18.0 model/iPhone16,1 hwp/t8130 build/22A3354 (6; dt:201)"
const STORE_FRONTS: Record<string, string> = {
  us: "143441", hk: "143463", jp: "143462", cn: "143465", tw: "143470", kr: "143466",
  au: "143460", nz: "143461", ca: "143455", gb: "143444", ie: "143449", de: "143443",
  fr: "143442", it: "143450", es: "143454", nl: "143452", ch: "143459", se: "143456",
  no: "143457", dk: "143458", fi: "143447", in: "143467", my: "143473", th: "143475",
  ph: "143474", id: "143476", vn: "143471", br: "143503", mx: "143468", tr: "143480",
  ae: "143481", sa: "143479", il: "143491", pl: "143478", sg: "143464",
  pt: "143453", ru: "143469", be: "143446", at: "143445", za: "143472",
}

/** 规范化地区代码：未知地区整体回退美区，URL/Storefront/缓存保持同一商店。 */
function storefrontCode(region: string) {
  const requested = String(region || "").trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(STORE_FRONTS, requested) ? requested : "us"
}

/* ---------- 跨进程持久缓存 ----------
 * 版本号与历史说明变化很慢，但分享扩展每次分享都是新进程：只放内存会在下次
 * 打开时全部丢失，于是每次点版本号/查看新说明都要重新请求并闪一次加载。
 * 成功结果写入共享 Storage，新进程首帧可直接命中，10 分钟内的重复打开不再
 * 发网络请求；超过后先显示旧数据再后台校验。所有读写静默容错。 */
const DISK_CACHE_KEY = "lingo_app_version_cache_v1"
const DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DISK_CACHE_LIMIT = 8
/** 单条记录上限：历史说明可能很长，超限就不写盘，避免共享偏好在写大 JSON 时卡住。 */
const DISK_RECORD_LIMIT_BYTES = 256 * 1024
/** 整个缓存上限。 */
const DISK_STORE_LIMIT_BYTES = 768 * 1024

type DiskRecord<T> = { at: number; entries: T }
type DiskCache = {
  versions?: Record<string, DiskRecord<AppVersionEntry[]>>
  notes?: Record<string, DiskRecord<AppVersionNotes[]>>
}
/** 每次点击弹层都要读两次（版本 + 说明），进程内复用同一份解析结果。 */
let diskStore: DiskCache | null = null

function readDiskCache(): DiskCache {
  if (diskStore) return diskStore
  try {
    const value = Storage.get<DiskCache>(DISK_CACHE_KEY, { shared: true })
    diskStore = value && typeof value === "object" ? value : {}
  } catch {
    diskStore = {}
  }
  return diskStore
}

function trimDiskRecord<T>(record: Record<string, DiskRecord<T>>) {
  const keys = Object.keys(record).sort((a, b) => (record[b]?.at || 0) - (record[a]?.at || 0))
  for (const key of keys.slice(DISK_CACHE_LIMIT)) delete record[key]
}

function writeDiskRecord<T>(section: "versions" | "notes", key: string, value: DiskRecord<T>) {
  try {
    if (JSON.stringify(value).length > DISK_RECORD_LIMIT_BYTES) return
    const store = readDiskCache()
    const record = { ...((section === "versions" ? store.versions : store.notes) || {}) } as Record<string, DiskRecord<T>>
    record[key] = value
    trimDiskRecord(record)
    const next = { ...store, [section]: record }
    if (JSON.stringify(next).length > DISK_STORE_LIMIT_BYTES) return
    diskStore = next
    Storage.set(DISK_CACHE_KEY, next, { shared: true })
  } catch {}
}

function readDiskRecord<T>(section: "versions" | "notes", key: string): DiskRecord<T> | null {
  const store = readDiskCache()
  const record = (section === "versions" ? store.versions : store.notes)?.[key] as DiskRecord<T> | undefined
  if (!record || !Array.isArray(record.entries) || !Number.isFinite(record.at)) return null
  if (Date.now() - record.at > DISK_CACHE_TTL_MS) return null
  return { at: record.at, entries: record.entries }
}

/** 首帧读取：命中后无需等网络。分享扩展新进程也能直接显示上次的版本数据。 */
export function peekCachedAppVersions(appid: string): AppVersionEntry[] | null {
  const memory = versionsCache.get(appid)
  if (memory && Date.now() - memory.at < DISK_CACHE_TTL_MS) return memory.entries
  const disk = readDiskRecord<AppVersionEntry[]>("versions", appid)
  if (!disk) return null
  versionsCache.set(appid, disk)
  return disk.entries
}

/** 首帧读取历史说明；地区键与 fetchVersionHistoryNotes 完全一致。 */
export function peekCachedVersionNotes(appid: string, region = "us"): AppVersionNotes[] | null {
  const key = `${appid}:${storefrontCode(region)}`
  const memory = notesCache.get(key)
  if (memory && Date.now() - memory.at < DISK_CACHE_TTL_MS) return memory.entries
  const disk = readDiskRecord<AppVersionNotes[]>("notes", key)
  if (!disk) return null
  notesCache.set(key, disk)
  return disk.entries
}

/** 只读取指定应用的历史数组，不拿当前说明或推荐应用的说明填充旧版本。 */
export function parseVersionHistoryNotes(payload: any, appid: string): AppVersionNotes[] {
  const page = payload?.pageData
  if (String(page?.id ?? "") !== appid || !Array.isArray(page?.versionHistory)) {
    throw new Error("更新说明数据不完整，请重试。")
  }
  const byVersion = new Map<string, AppVersionNotes>()
  for (const item of page.versionHistory) {
    const version = typeof item?.versionString === "string" ? item.versionString.trim() : ""
    const notes = typeof item?.releaseNotes === "string" ? item.releaseNotes.trim() : ""
    if (version && notes && !byVersion.has(version)) byVersion.set(version, { version, notes })
  }
  return [...byVersion.values()]
}

/** 保留所有版本 ID，并补入 Apple 有说明、ID 接口暂未收录的版本。 */
export function mergeVersionNotes(entries: AppVersionEntry[], notes: AppVersionNotes[]): AppVersionEntry[] {
  const byVersion = new Map(notes.filter(item => item.version.trim() && item.notes.trim())
    .map(item => [item.version.trim(), item.notes.trim()]))
  const result = entries.map(entry => ({ ...entry, notes: byVersion.get(entry.version.trim()) || entry.notes }))
  const known = new Set(entries.map(entry => entry.version.trim()))
  for (const [version, text] of byVersion) {
    if (!known.has(version)) result.push({ version, versionId: "", notes: text })
  }
  return result.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))
}

/** 一次获取 Apple 当前可返回的全部历史说明；不截断、不需要登录。 */
export async function fetchVersionHistoryNotes(appid: string, region = "us"): Promise<AppVersionNotes[]> {
  if (!/^\d+$/.test(appid)) throw new Error("无效的应用 ID。")
  // 未知地区整体回退，URL/Storefront/重定向/缓存保持同一商店。
  const code = storefrontCode(region)
  const key = `${appid}:${code}`
  const saved = notesCache.get(key)
  if (saved && Date.now() - saved.at < CACHE_FRESH_MS) return saved.entries
  if (!saved) {
    const disk = readDiskRecord<AppVersionNotes[]>("notes", key)
    if (disk) {
      notesCache.set(key, disk)
      if (Date.now() - disk.at < CACHE_FRESH_MS) return disk.entries
    }
  }
  const existing = notesInFlight.get(key)
  if (existing) return existing
  const request = (async () => {
    const response = await fetch(
      `https://itunes.apple.com/${code}/app/id${appid}?mt=8`,
      {
        method: "GET",
        headers: {
          "User-Agent": STORE_UA,
          "Accept-Language": "en-US,en;q=0.9",
          "X-Apple-Store-Front": `${STORE_FRONTS[code] || STORE_FRONTS.us},29`,
        },
        timeout: 18,
        debugLabel: "Lingo Version History Notes",
        handleRedirect: async (next) => {
          const target = String(next.url || "")
          return new RegExp(`^https://(?:itunes|apps)\\.apple\\.com/${code}/app/`, "i").test(target) ? next : null
        },
      },
    )
    if (!response.ok) throw new Error(`更新说明查询失败（HTTP ${response.status}）。`)
    const entries = parseVersionHistoryNotes(await response.json(), appid)
    const record = { at: Date.now(), entries }
    notesCache.set(key, record)
    writeDiskRecord("notes", key, record)
    return entries
  })()
  notesInFlight.set(key, request)
  try { return await request } finally {
    if (notesInFlight.get(key) === request) notesInFlight.delete(key)
  }
}

async function fetchTimbrd(appid: string): Promise<AppVersionEntry[]> {
  const response = await fetch(
    `https://api.timbrd.com/apple/app-version/index.php?id=${appid}`,
    { method: "GET", timeout: REQUEST_TIMEOUT, debugLabel: "Lingo Timbrd Versions" },
  )
  if (!response.ok) throw new Error(`Timbrd HTTP ${response.status}`)
  const body = await response.json()
  const list = Array.isArray(body) ? body : []
  return list
    .reverse()
    .map((item: any): AppVersionEntry => ({
      versionId: String(item?.external_identifier ?? ""),
      version: String(item?.bundle_version ?? "").trim(),
    }))
    .filter((entry) => entry.version && entry.versionId)
}

async function fetchBilin(appid: string): Promise<AppVersionEntry[]> {
  const response = await fetch(
    `https://apis.bilin.eu.org/history/${appid}`,
    { method: "GET", timeout: REQUEST_TIMEOUT, debugLabel: "Lingo Bilin Versions" },
  )
  if (!response.ok) throw new Error(`Bilin HTTP ${response.status}`)
  const body = await response.json()
  const list = Array.isArray(body?.data) ? body.data : []
  return (list as any[])
    .map((item: any): AppVersionEntry => ({
      versionId: String(item?.external_identifier ?? ""),
      version: String(item?.bundle_version ?? "").trim(),
    }))
    .filter((entry) => entry.version && entry.versionId)
}

/** 版本源响应超过全长超时仍未返回：按失败处理（fetch 自身也有限时）。 */
class VersionQueryAborted extends Error {}
/** 首个源成功后，给另一个源留的汇合窗口：窗口内到达则择优，超时立即返回。 */
const VERSION_COLLECT_WINDOW_MS = 700

/**
 * 并发请求 Timbrd / Bilin 两个免登录版本源。
 * 提速：两源同时出发，取第一个返回非空数据的源；另一源只保留 0.7 秒
 * 汇合窗口作择优补充，超时/失败不再把等待者拖到全长超时——此前
 * Promise.allSettled 必须等两个源都结束，慢源会把弹层拖到 10 秒。
 * 成功结果内存 + 共享 Storage 双缓存：10 分钟内重复打开弹层不再请求，
 * 分享扩展下次冷启动也能直接命中。
 */
export async function fetchAppVersions(appid: string): Promise<AppVersionEntry[]> {
  const cached = versionsCache.get(appid)
  if (cached && Date.now() - cached.at < CACHE_FRESH_MS) return cached.entries
  if (!cached) {
    const disk = readDiskRecord<AppVersionEntry[]>("versions", appid)
    if (disk) {
      versionsCache.set(appid, disk)
      if (Date.now() - disk.at < CACHE_FRESH_MS) return disk.entries
    }
  }
  const existing = versionsInFlight.get(appid)
  if (existing) return existing

  const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new VersionQueryAborted("版本源响应超时")), ms)
      promise.then(
        value => { clearTimeout(timer); resolve(value) },
        error => { clearTimeout(timer); reject(error) },
      )
    })

  type AttemptOutcome = { index: number; entries: AppVersionEntry[]; error?: unknown }
  const pickBest = (a: AppVersionEntry[], b: AppVersionEntry[]) =>
    b.length > a.length || (b.length === a.length && (b[0]?.version || "") > (a[0]?.version || "")) ? b : a

  const request = (async () => {
    const attempts = [
      withTimeout(fetchTimbrd(appid), REQUEST_TIMEOUT * 1000),
      withTimeout(fetchBilin(appid), REQUEST_TIMEOUT * 1000),
    ].map((promise, index): Promise<AttemptOutcome> => promise.then(
      (entries): AttemptOutcome => {
        if (!entries.length) throw new Error("版本源未返回数据。")
        return { index, entries, error: undefined }
      },
      (error: unknown): AttemptOutcome => ({ index, entries: [], error }),
    ))

    // 阶段一：任一源返回非空数据即胜出；两个源都失败/为空时抛出便于重试。
    const winner = await new Promise<AttemptOutcome>((resolve, reject) => {
      let pending = attempts.length
      let lastError: unknown
      for (const attempt of attempts) {
        attempt.then(resolve, error => {
          pending -= 1
          lastError = error
          if (pending === 0) {
            reject(lastError instanceof Error ? lastError : new Error("版本查询接口均不可用，请稍后重试。"))
          }
        })
      }
    })

    // 阶段二：给另一个源 0.7 秒汇合窗口；窗口内到达则两源择优，否则立即返回。
    const collected: AppVersionEntry[][] = [winner.entries]
    const other = attempts[1 - winner.index]
    const otherArrived = await Promise.race([
      other.then(
        (outcome: AttemptOutcome) => outcome,
        () => null,
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), VERSION_COLLECT_WINDOW_MS)),
    ])
    if (otherArrived && otherArrived.entries.length) collected.push(otherArrived.entries)

    const best = collected.reduce(pickBest)
    const record = { at: Date.now(), entries: best }
    versionsCache.set(appid, record)
    writeDiskRecord("versions", appid, record)
    return best
  })()
  versionsInFlight.set(appid, request)
  try {
    return await request
  } finally {
    if (versionsInFlight.get(appid) === request) versionsInFlight.delete(appid)
  }
}
