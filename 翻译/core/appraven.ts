import { fetch, type Response } from "scripting"

const GRAPHQL_URL = "https://appraven.net/appraven/graphql"
const DEFAULT_USER_AGENT = "AppRaven/2.2.11 (com.appraven.app; build:22; iOS 17.5.0) Alamofire/5.9.1"
const ACCOUNT_STORAGE_KEY = "lingo_appraven_accounts_v1"
const COOKIE_KEY_PREFIX = "lingo_appraven_cookie_v1_"
const RECENT_COLLECTIONS_STORAGE_KEY = "lingo_appraven_recent_collections_v1"
const COLLECTION_ORDER_STORAGE_KEY = "lingo_appraven_collection_order_v1"
const COLLECTION_ITEM_ORDER_STORAGE_KEY = "lingo_appraven_collection_item_order_v1"
const MAX_PAGES = 200
const MAX_RECENT_COLLECTIONS = 20
const MAX_ORDER_ENTRIES = 200

type AccountRecord = {
  id: string
  displayName: string
  username: string
  iconSmall?: string
  iconMedium?: string
}

/** AppRaven 图片基址（官网 JS 包 An.imagesUrl = serverUrl + "/images"）。 */
export const APPRAVEN_IMAGES_URL = "https://appraven.net/appraven/images"
/** AppRaven 用户头像目录（官网 Sn.userIcon = "/user/icons/"）。 */
export const APPRAVEN_USER_ICON_PATH = "/user/icons/"
/** AppRaven 默认头像（官网 mediaById(null, userIcon) 回退 "default"）。 */
export const APPRAVEN_DEFAULT_USER_ICON_URL = `${APPRAVEN_IMAGES_URL}${APPRAVEN_USER_ICON_PATH}default.jpg`

/** 拼出 AppRaven 用户头像 URL：mediaById(id, "/user/icons/") = imagesUrl + path + (id ?? "default") + ".jpg"。 */
export function appRavenUserIconURL(iconId: string | null | undefined): string {
  const normalized = typeof iconId === "string" ? iconId.trim() : ""
  return `${APPRAVEN_IMAGES_URL}${APPRAVEN_USER_ICON_PATH}${normalized || "default"}.jpg`
}

type AccountStore = {
  accounts: AccountRecord[]
  activeId: string | null
}

type JsonObject = Record<string, unknown>

export type AppRavenSession = {
  accountId: string
  cookie: string
}

export type AppRavenPage<T> = {
  hasNext: boolean
  content: T[]
}

export type AppRavenCookie = {
  name: string
  value: string
}

export type AppRavenCollection = {
  id: string
  title: string
  appCount: number
  premiumOnly?: boolean
  user?: { id: string; displayName?: string }
  topArtworks?: string[]
}

export type AppRavenCollectionItem = {
  id: string
  type?: string
  comment?: string
  app?: {
    id: string
    iTunesId?: string
    title?: string
    artworkUrl?: string
    priceTier?: number
    hasInAppPurchases?: boolean
  }
}

export type AppRavenUser = {
  id: string
  username?: string
  displayName?: string
  iconSmall?: string
  iconMedium?: string
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`)
  return value.trim()
}

function optionalString(value: JsonObject, key: string, label: string): string | undefined {
  const item = value[key]
  if (item === undefined || item === null) return undefined
  if (typeof item !== "string") throw new Error(`${label}字段无效`)
  return item
}

function cookieKey(id: string) {
  return `${COOKIE_KEY_PREFIX}${encodeURIComponent(id)}`
}

function readStore(): AccountStore {
  try {
    const raw = Storage.get(ACCOUNT_STORAGE_KEY, { shared: true })
    if (!isRecord(raw)) return { accounts: [], activeId: null }
    const accounts = Array.isArray(raw.accounts)
      ? raw.accounts.filter((item): item is AccountRecord =>
        isRecord(item)
          && typeof item.id === "string"
          && !!item.id.trim()
          && typeof item.displayName === "string"
          && typeof item.username === "string"
          && (item.iconSmall === undefined || typeof item.iconSmall === "string")
          && (item.iconMedium === undefined || typeof item.iconMedium === "string"))
      : []
    const activeId = typeof raw.activeId === "string" && accounts.some(item => item.id === raw.activeId)
      ? raw.activeId
      : null
    return { accounts, activeId }
  } catch {
    return { accounts: [], activeId: null }
  }
}

function writeStore(store: AccountStore) {
  let succeeded = false
  try {
    succeeded = Storage.set(ACCOUNT_STORAGE_KEY, store, { shared: true })
  } catch (reason) {
    throw new Error(`无法保存 AppRaven 账号：${reason instanceof Error ? reason.message : String(reason)}`)
  }
  if (!succeeded) throw new Error("无法保存 AppRaven 账号：共享存储写入失败")
}

function readCookie(accountId: string): string {
  try {
    return Keychain.get(cookieKey(accountId))?.trim() || ""
  } catch {
    return ""
  }
}

function resolveSession(session: AppRavenSession | null | undefined): AppRavenSession | null {
  if (session === null) return null
  if (session !== undefined) {
    const accountId = requireText(session.accountId, "AppRaven session.accountId")
    const cookie = requireText(session.cookie, "AppRaven session.cookie")
    return { accountId, cookie }
  }
  return captureAppRavenSession()
}

export function captureAppRavenSession(accountId?: string): AppRavenSession {
  const store = readStore()
  const requestedId = accountId === undefined ? store.activeId : requireText(accountId, "AppRaven 账号 ID")
  if (!requestedId) throw new Error("未登录 AppRaven")
  const account = store.accounts.find(item => item.id === requestedId)
  if (!account) throw new Error("未找到 AppRaven 账号")
  const cookie = readCookie(account.id)
  if (!cookie) throw new Error("AppRaven 会话已失效或未保存")
  return { accountId: account.id, cookie }
}

export function getSavedAppRavenAccounts(): AccountRecord[] {
  return readStore().accounts
}

export function getActiveAppRavenAccount(): AccountRecord | null {
  const store = readStore()
  return store.accounts.find(item => item.id === store.activeId) || null
}

export function isAppRavenLoggedOut() {
  const account = getActiveAppRavenAccount()
  return !account || !readCookie(account.id)
}

export function switchAppRavenAccount(id: string) {
  const accountId = requireText(id, "AppRaven 账号 ID")
  const store = readStore()
  if (!store.accounts.some(item => item.id === accountId) || !readCookie(accountId)) return false
  writeStore({ ...store, activeId: accountId })
  return true
}

export function logoutAppRaven() {
  const store = readStore()
  writeStore({ ...store, activeId: null })
}

export function removeAppRavenAccount(id: string) {
  const accountId = requireText(id, "AppRaven 账号 ID")
  const store = readStore()
  const nextStore = {
    accounts: store.accounts.filter(item => item.id !== accountId),
    activeId: store.activeId === accountId ? null : store.activeId,
  }
  writeStore(nextStore)
  let removed = false
  try {
    removed = Keychain.remove(cookieKey(accountId))
  } catch (reason) {
    throw new Error(`无法删除 AppRaven 会话：${reason instanceof Error ? reason.message : String(reason)}`)
  }
  if (!removed) throw new Error("无法删除 AppRaven 会话")
}

function saveAccount(account: AccountRecord, cookie: string) {
  const normalizedCookie = requireText(cookie, "AppRaven 会话 Cookie")
  const previousCookie = readCookie(account.id)
  const previousStore = readStore()
  let saved = false
  try {
    saved = Keychain.set(cookieKey(account.id), normalizedCookie, { accessibility: "first_unlock_this_device" })
  } catch (reason) {
    throw new Error(`无法安全保存 AppRaven 会话：${reason instanceof Error ? reason.message : String(reason)}`)
  }
  if (!saved) throw new Error("无法安全保存 AppRaven 会话，请检查设备钥匙串权限")

  const index = previousStore.accounts.findIndex(item => item.id === account.id)
  const accounts = [...previousStore.accounts]
  if (index >= 0) accounts[index] = account
  else accounts.push(account)
  try {
    writeStore({ accounts, activeId: account.id })
  } catch (reason) {
    try {
      if (previousCookie) Keychain.set(cookieKey(account.id), previousCookie, { accessibility: "first_unlock_this_device" })
      else Keychain.remove(cookieKey(account.id))
    } catch {}
    throw reason
  }
}

export function parseAppRavenMutationResult(value: unknown, label = "AppRaven mutation 结果"): { id: string } {
  if (!isRecord(value)) throw new Error(`${label}无效`)
  return { id: requireText(value.id, `${label} ID`) }
}

export function parseAppRavenCookieHeader(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("登录成功但未获取到会话 Cookie")
  const valid = value.filter((item): item is AppRavenCookie =>
    isRecord(item) && typeof item.name === "string" && !!item.name.trim() && typeof item.value === "string" && !!item.value)
  if (valid.length === 0) throw new Error("登录成功但未获取到会话 Cookie")
  return valid.map(item => `${item.name}=${item.value}`).join("; ")
}

function parseAppRavenSingleSetCookie(value: string): { name: string; value: string } | null {
  const segment = String(value || "").split(";")[0] || ""
  const eq = segment.indexOf("=")
  if (eq <= 0) return null
  const name = segment.slice(0, eq).trim()
  const cookieValue = segment.slice(eq + 1).trim()
  if (!name || !cookieValue) return null
  return { name, value: cookieValue }
}

export function parseAppRavenSetCookieHeaders(values: unknown): string {
  if (!Array.isArray(values) || values.length === 0) throw new Error("登录成功但未获取到会话 Cookie")
  const header = values
    .filter((item): item is string => typeof item === "string")
    .map(parseAppRavenSingleSetCookie)
    .filter((item): item is { name: string; value: string } => !!item)
    .map(item => `${item.name}=${item.value}`)
    .join("; ")
  if (!header) throw new Error("登录成功但未获取到会话 Cookie")
  return header
}

export function parseAppRavenGraphQLData(value: unknown): JsonObject {
  if (!isRecord(value)) throw new Error("AppRaven 返回了无效响应")
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    const first = value.errors[0]
    const message = isRecord(first) && typeof first.message === "string" ? first.message : "AppRaven 返回了错误"
    throw new Error(message)
  }
  if (!isRecord(value.data)) throw new Error("AppRaven 返回了空数据")
  return value.data
}

export function parseAppRavenUser(value: unknown): AppRavenUser {
  if (!isRecord(value)) throw new Error("AppRaven 用户响应无效")
  const id = requireText(value.id, "AppRaven 用户 ID")
  const username = optionalString(value, "username", "AppRaven 用户")
  const displayName = optionalString(value, "displayName", "AppRaven 用户")
  const iconSmall = optionalString(value, "iconSmall", "AppRaven 用户")
  const iconMedium = optionalString(value, "iconMedium", "AppRaven 用户")
  return {
    id,
    ...(username === undefined ? {} : { username }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(iconSmall === undefined ? {} : { iconSmall }),
    ...(iconMedium === undefined ? {} : { iconMedium }),
  }
}

export function parseAppRavenPage<T>(value: unknown, label = "AppRaven 分页响应"): AppRavenPage<T> {
  if (!isRecord(value) || typeof value.hasNext !== "boolean" || !Array.isArray(value.content)) {
    throw new Error(`${label}无效`)
  }
  return { hasNext: value.hasNext, content: value.content as T[] }
}

function parseCollection(value: unknown, index: number): AppRavenCollection {
  if (!isRecord(value)) throw new Error(`AppRaven 合集第 ${index + 1} 项无效`)
  const id = requireText(value.id, `AppRaven 合集第 ${index + 1} 项 ID`)
  const title = requireText(value.title, `AppRaven 合集第 ${index + 1} 项标题`)
  if (typeof value.appCount !== "number" || !Number.isFinite(value.appCount) || value.appCount < 0) {
    throw new Error(`AppRaven 合集第 ${index + 1} 项数量无效`)
  }
  const premiumOnly = value.premiumOnly
  if (premiumOnly !== undefined && premiumOnly !== null && typeof premiumOnly !== "boolean") {
    throw new Error(`AppRaven 合集第 ${index + 1} 项 premiumOnly 无效`)
  }
  let user: AppRavenCollection["user"]
  if (value.user !== undefined && value.user !== null) {
    if (!isRecord(value.user)) throw new Error(`AppRaven 合集第 ${index + 1} 项用户无效`)
    const userId = requireText(value.user.id, `AppRaven 合集第 ${index + 1} 项用户 ID`)
    const displayName = optionalString(value.user, "displayName", "AppRaven 合集用户")
    user = { id: userId, ...(displayName === undefined ? {} : { displayName }) }
  }
  let topArtworks: string[] | undefined
  if (value.topArtworks !== undefined && value.topArtworks !== null) {
    if (!Array.isArray(value.topArtworks) || value.topArtworks.some(item => typeof item !== "string")) {
      throw new Error(`AppRaven 合集第 ${index + 1} 项封面无效`)
    }
    topArtworks = value.topArtworks as string[]
  }
  return {
    id,
    title,
    appCount: value.appCount,
    ...(typeof premiumOnly === "boolean" ? { premiumOnly } : {}),
    ...(user ? { user } : {}),
    ...(topArtworks ? { topArtworks } : {}),
  }
}

export function parseAppRavenCollectionPage(value: unknown): AppRavenPage<AppRavenCollection> {
  const page = parseAppRavenPage<unknown>(value, "AppRaven 合集分页响应")
  return { hasNext: page.hasNext, content: page.content.map(parseCollection) }
}

function parseCollectionItem(value: unknown, index: number): AppRavenCollectionItem {
  if (!isRecord(value)) throw new Error(`AppRaven 合集项目第 ${index + 1} 项无效`)
  const id = requireText(value.id, `AppRaven 合集项目第 ${index + 1} 项 ID`)
  const type = optionalString(value, "type", "AppRaven 合集项目")
  const comment = optionalString(value, "comment", "AppRaven 合集项目")
  let app: AppRavenCollectionItem["app"]
  if (value.app !== undefined && value.app !== null) {
    if (!isRecord(value.app)) throw new Error(`AppRaven 合集项目第 ${index + 1} 项 App 无效`)
    const appId = requireText(value.app.id, `AppRaven 合集项目第 ${index + 1} 项 App ID`)
    const iTunesId = value.app.iTunesId ?? value.app.ITunesId
    if (iTunesId !== undefined && iTunesId !== null && typeof iTunesId !== "string" && typeof iTunesId !== "number") {
      throw new Error(`AppRaven 合集项目第 ${index + 1} 项 iTunes ID 无效`)
    }
    const title = optionalString(value.app, "title", "AppRaven 合集项目 App")
    const artworkUrl = optionalString(value.app, "artworkUrl", "AppRaven 合集项目 App")
    const priceTier = value.app.priceTier
    if (priceTier !== undefined && priceTier !== null && (typeof priceTier !== "number" || !Number.isFinite(priceTier))) {
      throw new Error(`AppRaven 合集项目第 ${index + 1} 项价格无效`)
    }
    const hasInAppPurchases = value.app.hasInAppPurchases
    if (hasInAppPurchases !== undefined && hasInAppPurchases !== null && typeof hasInAppPurchases !== "boolean") {
      throw new Error(`AppRaven 合集项目第 ${index + 1} 项内购标记无效`)
    }
    app = {
      id: appId,
      ...(iTunesId === undefined || iTunesId === null ? {} : { iTunesId: String(iTunesId) }),
      ...(title === undefined ? {} : { title }),
      ...(artworkUrl === undefined ? {} : { artworkUrl }),
      ...(typeof priceTier === "number" ? { priceTier } : {}),
      ...(typeof hasInAppPurchases === "boolean" ? { hasInAppPurchases } : {}),
    }
  }
  return { id, ...(type === undefined ? {} : { type }), ...(comment === undefined ? {} : { comment }), ...(app ? { app } : {}) }
}

export function parseAppRavenCollectionItemPage(value: unknown): AppRavenPage<AppRavenCollectionItem> {
  const page = parseAppRavenPage<unknown>(value, "AppRaven 合集项目分页响应")
  return { hasNext: page.hasNext, content: page.content.map(parseCollectionItem) }
}

function assertPageCanContinue(hasNext: boolean, nextPage: number) {
  if (hasNext && nextPage >= MAX_PAGES) throw new Error("AppRaven 分页超过安全上限，结果可能被截断")
}

function requestHeaders(operationName: string, operationType: "query" | "mutation", session: AppRavenSession | null) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": DEFAULT_USER_AGENT,
    "apollographql-client-name": "net.appraven.app-apollo-ios",
    "apollographql-client-version": "2.2.11-2",
    "x-apollo-operation-type": operationType,
    "x-apollo-operation-name": operationName,
  }
  if (session) headers.Cookie = session.cookie
  return headers
}

async function gql(
  operationName: string,
  operationType: "query" | "mutation",
  query: string,
  variables: Record<string, unknown>,
  session: AppRavenSession | null,
  authRequest = false,
): Promise<JsonObject> {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: requestHeaders(operationName, operationType, session),
    body: JSON.stringify({ operationName, query, variables }),
    timeout: 30,
    handleRedirect: async () => null,
    ...(authRequest ? {} : { debugLabel: `AppRaven ${operationName}` }),
  })
  if (!response.ok) throw new Error(`AppRaven 请求失败（HTTP ${response.status}）`)
  return parseAppRavenGraphQLData(await response.json())
}

function responseCookieHeader(response: Response): string {
  try {
    const cookies = response.cookies
    if (Array.isArray(cookies) && cookies.length > 0) {
      const valid = cookies.filter(cookie =>
        !!cookie && typeof cookie.name === "string" && !!cookie.name.trim()
          && typeof cookie.value === "string" && !!cookie.value)
      if (valid.length > 0) {
        return valid.map(cookie => `${cookie.name}=${cookie.value}`).join("; ")
      }
    }
  } catch {}
  let setCookieHeaders: unknown[] = []
  try {
    const headers = (response as unknown as { headers?: unknown }).headers as
      | { getSetCookie?: () => unknown; get?: (name: string) => string | null } | undefined
    const getSetCookie = headers?.getSetCookie
    if (typeof getSetCookie === "function") {
      const values = getSetCookie.call(headers)
      if (Array.isArray(values)) setCookieHeaders = values
    } else if (headers && typeof headers.get === "function") {
      const merged = headers.get("set-cookie")
      if (merged) setCookieHeaders = [merged]
    }
  } catch {}
  return parseAppRavenSetCookieHeaders(setCookieHeaders)
}

async function requestCurrentUser(session: { cookie: string }, expectedAccountId?: string): Promise<AppRavenUser> {
  const data = await gql(
    "GetCurrentUser",
    "query",
    `query GetCurrentUser {
      currentUser { id username displayName iconSmall iconMedium }
    }`,
    {},
    { accountId: expectedAccountId || "cookie-login", cookie: session.cookie },
    true,
  )
  if (data.currentUser === null || data.currentUser === undefined) throw new Error("未登录 AppRaven")
  const user = parseAppRavenUser(data.currentUser)
  if (expectedAccountId !== undefined && user.id !== expectedAccountId) {
    throw new Error("AppRaven 会话账号与请求账号不一致")
  }
  return user
}

export async function loginAppRaven(principal: string, password: string): Promise<AppRavenUser> {
  const normalizedPrincipal = requireText(principal, "AppRaven 账号")
  if (typeof password !== "string" || !password) throw new Error("AppRaven 密码不能为空")
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: requestHeaders("Login", "mutation", null),
    body: JSON.stringify({
      operationName: "Login",
      query: `mutation Login($principal: String!, $password: String!) {
        login(principal: $principal, password: $password) {
          id
          username
          displayName
          iconSmall
          iconMedium
        }
      }`,
      variables: { principal: normalizedPrincipal, password },
    }),
    timeout: 30,
    handleRedirect: async () => null,
  })
  if (!response.ok) throw new Error(`登录失败（HTTP ${response.status}）`)
  const data = parseAppRavenGraphQLData(await response.json())
  if (data.login === null || data.login === undefined) throw new Error("登录失败，请检查账号或密码")
  const user = parseAppRavenUser(data.login)
  saveAccount({
    id: user.id,
    displayName: user.displayName || "",
    username: user.username || normalizedPrincipal,
    ...(user.iconSmall === undefined ? {} : { iconSmall: user.iconSmall }),
    ...(user.iconMedium === undefined ? {} : { iconMedium: user.iconMedium }),
  }, responseCookieHeader(response))
  return user
}

export async function loginAppRavenCookie(cookie: string): Promise<AppRavenUser> {
  const normalizedCookie = requireText(cookie, "AppRaven Cookie")
  const user = await requestCurrentUser({ cookie: normalizedCookie })
  saveAccount({
    id: user.id,
    displayName: user.displayName || "",
    username: user.username || "AppRaven 账号",
    ...(user.iconSmall === undefined ? {} : { iconSmall: user.iconSmall }),
    ...(user.iconMedium === undefined ? {} : { iconMedium: user.iconMedium }),
  }, normalizedCookie)
  return user
}

export async function getCurrentAppRavenUser(session?: AppRavenSession | null): Promise<AppRavenUser> {
  const captured = resolveSession(session)
  if (!captured) throw new Error("未登录 AppRaven")
  return requestCurrentUser(captured, captured.accountId)
}

/** 登录后后台刷新头像：拉取最新 iconSmall/iconMedium 并写回账号存储（静默失败）。 */
export async function refreshAppRavenAccountIcon(accountId: string, session?: AppRavenSession | null): Promise<boolean> {
  const requestedId = requireText(accountId, "AppRaven 账号 ID")
  const captured = resolveSession(session)
  if (!captured) return false
  let user: AppRavenUser
  try {
    user = await requestCurrentUser(captured, requestedId)
  } catch {
    return false
  }
  if (user.iconSmall === undefined && user.iconMedium === undefined) return false
  try {
    const store = readStore()
    const index = store.accounts.findIndex(item => item.id === requestedId)
    if (index < 0) return false
    const current = store.accounts[index]
    if (current.iconSmall === user.iconSmall && current.iconMedium === user.iconMedium) return true
    const next = [...store.accounts]
    next[index] = {
      ...current,
      ...(user.iconSmall === undefined ? {} : { iconSmall: user.iconSmall }),
      ...(user.iconMedium === undefined ? {} : { iconMedium: user.iconMedium }),
    }
    writeStore({ ...store, accounts: next })
    return true
  } catch {
    return false
  }
}

export function parseAppRavenITunesId(value: unknown): number {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim()
  if (!/^\d+$/.test(text)) throw new Error("iTunes ID 必须是正整数")
  const number = Number(text)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("iTunes ID 必须是正整数")
  return number
}

export function appRavenArtworkURL(url: string | null | undefined, size = 1024): string | undefined {
  if (!url) return undefined
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Artwork 尺寸无效")
  const dimension = `${size}x${size}bb.jpg`
  if (url.includes("{w}x{h}{c}.{f}")) return url.replace("{w}x{h}{c}.{f}", dimension)
  return url.replace(/\d+x\d+bb(?:-\d+)?\.\w+/i, dimension)
}

export async function getAppRavenAppIdFromITunesId(itunesId: string, session?: AppRavenSession | null): Promise<string> {
  const captured = resolveSession(session)
  const data = await gql(
    "GetAppDetailForCollections",
    "query",
    `query GetAppDetailForCollections($iTunesId: Long!) {
      appByITunesId(iTunesId: $iTunesId) { id }
    }`,
    { iTunesId: parseAppRavenITunesId(itunesId) },
    captured,
  )
  if (!isRecord(data.appByITunesId)) throw new Error("AppRaven 中没有找到这个 App")
  const id = requireText(data.appByITunesId.id, "AppRaven App ID")
  return id
}

async function getUserCollectionsAtSession(userId: string, session: AppRavenSession): Promise<AppRavenCollection[]> {
  const all: AppRavenCollection[] = []
  let page = 0
  while (true) {
    const data = await gql(
      "GetUserCollections",
      "query",
      `query GetUserCollections($userId: ID!, $type: UserCollectionsType!, $query: String, $sort: CollectionSortInput!, $page: Int!) {
        user(id: $userId) {
          collections(type: $type, query: $query, sort: $sort, page: $page) {
            hasNext
            content { id title appCount premiumOnly suggestionCount watchCount score user { id displayName } topArtworks }
          }
        }
      }`,
      { userId, type: "CREATED", query: "", sort: { by: "LAST_ITEM_DATE" }, page },
      session,
    )
    if (!isRecord(data.user) || !isRecord(data.user.collections)) throw new Error("AppRaven 用户合集响应无效")
    const result = parseAppRavenCollectionPage(data.user.collections)
    all.push(...result.content)
    if (!result.hasNext) return all
    page += 1
    assertPageCanContinue(result.hasNext, page)
  }
}

export async function getUserAppRavenCollections(userId: string, session?: AppRavenSession | null): Promise<AppRavenCollection[]> {
  const captured = resolveSession(session)
  if (!captured) throw new Error("读取用户合集需要登录 AppRaven")
  const requestedUserId = requireText(userId, "AppRaven 用户 ID")
  if (requestedUserId !== captured.accountId) throw new Error("AppRaven 用户 ID 与会话账号不一致")
  return getUserCollectionsAtSession(requestedUserId, captured)
}

async function getCollectionsContainingAppAtSession(appId: string, session: AppRavenSession | null): Promise<AppRavenCollection[]> {
  const all: AppRavenCollection[] = []
  let page = 0
  while (true) {
    const data = await gql(
      "GetCollectionsContainingApp",
      "query",
      `query GetCollectionsContainingApp($id: ID!, $query: String, $sort: CollectionSortInput!, $page: Int!) {
        app(id: $id) {
          collections(query: $query, sort: $sort, page: $page) {
            hasNext
            content { id title appCount premiumOnly suggestionCount watchCount score user { id displayName } topArtworks }
          }
        }
      }`,
      { id: appId, query: "", sort: { by: "SCORE" }, page },
      session,
    )
    if (!isRecord(data.app) || !isRecord(data.app.collections)) throw new Error("AppRaven App 合集响应无效")
    const result = parseAppRavenCollectionPage(data.app.collections)
    all.push(...result.content)
    if (!result.hasNext) return all
    page += 1
    assertPageCanContinue(result.hasNext, page)
  }
}

export async function getCollectionsContainingApp(appId: string, session?: AppRavenSession | null): Promise<AppRavenCollection[]> {
  const captured = resolveSession(session)
  const requestedAppId = requireText(appId, "AppRaven App ID")
  return getCollectionsContainingAppAtSession(requestedAppId, captured)
}

/**
 * 查询给定合集列表中哪些包含该 App（按 AUTHOR 条目判定）。
 * 与展开视图、加/减 mutation 同源（types: [AUTHOR]），替代语义不符的
 * app(id).collections（实测含非成员合集/慢/间歇 500，会造成“未加入却显示已加入”）。
 * 每个合集独立分页查找（找到即停），并行执行；任一合集查询失败则整体抛错，
 * 由调用方保留旧状态而不是写入不完整结果。
 */
export async function getJoinedAppRavenCollectionIds(
  appId: string,
  collectionIds: string[],
  session?: AppRavenSession | null,
): Promise<Set<string>> {
  const captured = resolveSession(session)
  const requestedAppId = requireText(appId, "AppRaven App ID")
  const joined = new Set<string>()
  let firstError: unknown = null
  await Promise.all(collectionIds.map(async collectionId => {
    try {
      let page = 0
      let hasNext = true
      while (hasNext && page < MAX_PAGES) {
        const result = await getCollectionItemsAtSession(collectionId, page, captured)
        if (result.content.some(item => item.app?.id === requestedAppId)) {
          joined.add(collectionId)
          return
        }
        hasNext = result.hasNext
        page += 1
      }
    } catch (reason) {
      if (firstError === null) firstError = reason
    }
  }))
  if (firstError !== null) throw firstError
  return joined
}

export async function addAppToAppRavenCollection(appId: string, collectionId: string, session?: AppRavenSession | null) {
  const captured = resolveSession(session)
  if (!captured) throw new Error("加入 AppRaven 合集需要登录")
  const requestedAppId = requireText(appId, "AppRaven App ID")
  const requestedCollectionId = requireText(collectionId, "AppRaven 合集 ID")
  const data = await gql(
    "AddAppToCollection",
    "mutation",
    `mutation AddAppToCollection($appId: ID!, $collectionId: ID!, $item: CollectionItemInput!) {
      addAppToCollection(appId: $appId, collectionId: $collectionId, item: $item) { id }
    }`,
    { appId: requestedAppId, collectionId: requestedCollectionId, item: { type: "AUTHOR" } },
    captured,
  )
  const result = parseAppRavenMutationResult(data.addAppToCollection, "AppRaven 添加结果")
  if (!result.id) {
    throw new Error("合集没有返回添加结果")
  }
}

async function getCollectionItemsAtSession(collectionId: string, page: number, session: AppRavenSession | null): Promise<AppRavenPage<AppRavenCollectionItem>> {
  const data = await gql(
    "GetCollectionItems",
    "query",
    `query GetCollectionItems($id: ID!, $types: [CollectionItemType!]!, $query: String, $page: Int!) {
      collection(id: $id) {
        items(types: $types, query: $query, page: $page) {
          hasNext
          content { id type comment app { id ITunesId title artworkUrl priceTier hasInAppPurchases } }
        }
      }
    }`,
    { id: collectionId, types: ["AUTHOR"], query: "", page },
    session,
  )
  if (!isRecord(data.collection) || !isRecord(data.collection.items)) throw new Error("AppRaven 合集项目响应无效")
  return parseAppRavenCollectionItemPage(data.collection.items)
}

export async function removeAppRavenCollectionItemById(collectionId: string, itemId: string, session?: AppRavenSession | null) {
  const captured = resolveSession(session)
  if (!captured) throw new Error("移除 AppRaven 合集项目需要登录")
  const requestedCollectionId = requireText(collectionId, "AppRaven 合集 ID")
  const requestedItemId = requireText(itemId, "AppRaven 合集项目 ID")
  const data = await gql(
    "RemoveItemFromCollection",
    "mutation",
    `mutation RemoveItemFromCollection($itemId: ID!, $collectionId: ID!) {
      removeItemFromCollection(itemId: $itemId, collectionId: $collectionId) { id }
    }`,
    { itemId: requestedItemId, collectionId: requestedCollectionId },
    captured,
  )
  parseAppRavenMutationResult(data.removeItemFromCollection, "AppRaven 删除结果")
  return true
}

export async function removeAppFromAppRavenCollection(collectionId: string, appId: string, session?: AppRavenSession | null) {
  const captured = resolveSession(session)
  if (!captured) throw new Error("移除 AppRaven 合集项目需要登录")
  const requestedCollectionId = requireText(collectionId, "AppRaven 合集 ID")
  const requestedAppId = requireText(appId, "AppRaven App ID")
  let page = 0
  let itemId: string | null = null
  while (true) {
    const result = await getCollectionItemsAtSession(requestedCollectionId, page, captured)
    const found = result.content.find(item => item.app?.id === requestedAppId)
    if (found) {
      itemId = found.id
      break
    }
    if (!result.hasNext) break
    page += 1
    assertPageCanContinue(result.hasNext, page)
  }
  if (!itemId) return false

  const data = await gql(
    "RemoveItemFromCollection",
    "mutation",
    `mutation RemoveItemFromCollection($itemId: ID!, $collectionId: ID!) {
      removeItemFromCollection(itemId: $itemId, collectionId: $collectionId) { id }
    }`,
    { itemId, collectionId: requestedCollectionId },
    captured,
  )
  if (!isRecord(data.removeItemFromCollection)) {
    // AppRaven 删除接口有时返回空对象；条目定位成功后继续视为已处理，由 UI 刷新确认。
    return true
  }
  try {
    parseAppRavenMutationResult(data.removeItemFromCollection, "AppRaven 删除结果")
  } catch {
    return true
  }
  return true
}

export async function getAppRavenCollectionItems(collectionId: string, page = 0, session?: AppRavenSession | null): Promise<AppRavenPage<AppRavenCollectionItem>> {
  const captured = resolveSession(session)
  const requestedCollectionId = requireText(collectionId, "AppRaven 合集 ID")
  if (!Number.isSafeInteger(page) || page < 0 || page >= MAX_PAGES) throw new Error("AppRaven 分页页码无效")
  return getCollectionItemsAtSession(requestedCollectionId, page, captured)
}

type RecentCollectionsStore = Record<string, string[]>

function readRecentCollections(): RecentCollectionsStore {
  try {
    const raw = Storage.get(RECENT_COLLECTIONS_STORAGE_KEY, { shared: true })
    if (!isRecord(raw)) return {}
    const result: RecentCollectionsStore = {}
    for (const key of Object.keys(raw)) {
      const values = raw[key]
      if (Array.isArray(values) && values.every(item => typeof item === "string" && !!item.trim())) {
        result[key] = values.slice(0, MAX_RECENT_COLLECTIONS) as string[]
      }
    }
    return result
  } catch {
    return {}
  }
}

function writeRecentCollections(value: RecentCollectionsStore) {
  let succeeded = false
  try {
    succeeded = Storage.set(RECENT_COLLECTIONS_STORAGE_KEY, value, { shared: true })
  } catch (reason) {
    throw new Error(`无法保存 AppRaven 最近合集：${reason instanceof Error ? reason.message : String(reason)}`)
  }
  if (!succeeded) throw new Error("无法保存 AppRaven 最近合集：共享存储写入失败")
}

export function getRecentAppRavenCollections(accountId: string): string[] {
  const id = requireText(accountId, "AppRaven 账号 ID")
  const store = readRecentCollections()
  return store[id] ? [...store[id]] : []
}

export function recordRecentAppRavenCollection(accountId: string, collectionId: string) {
  const account = requireText(accountId, "AppRaven 账号 ID")
  const collection = requireText(collectionId, "AppRaven 合集 ID")
  const store = readRecentCollections()
  const previous = store[account] || []
  store[account] = [collection, ...previous.filter(item => item !== collection)].slice(0, MAX_RECENT_COLLECTIONS)
  writeRecentCollections(store)
}

type OrderStore = Record<string, string[]>

function readOrderStore(key: string): OrderStore {
  try {
    const raw = Storage.get(key, { shared: true })
    if (!isRecord(raw)) return {}
    const result: OrderStore = {}
    for (const storeKey of Object.keys(raw)) {
      const values = raw[storeKey]
      if (Array.isArray(values) && values.every(item => typeof item === "string" && !!item.trim())) {
        result[storeKey] = values.slice(0, MAX_ORDER_ENTRIES) as string[]
      }
    }
    return result
  } catch {
    return {}
  }
}

function writeOrderStore(key: string, value: OrderStore, label: string) {
  let succeeded = false
  try {
    succeeded = Storage.set(key, value, { shared: true })
  } catch (reason) {
    throw new Error(`无法保存${label}：${reason instanceof Error ? reason.message : String(reason)}`)
  }
  if (!succeeded) throw new Error(`无法保存${label}：共享存储写入失败`)
}

function collectionOrderKey(accountId: string) {
  return requireText(accountId, "AppRaven 账号 ID")
}

function collectionItemOrderKey(accountId: string, collectionId: string) {
  return `${requireText(accountId, "AppRaven 账号 ID")}:${requireText(collectionId, "AppRaven 合集 ID")}`
}

/** 外层合集手动排序：只记本地顺序，不改服务端。 */
export function getAppRavenCollectionOrder(accountId: string): string[] {
  const store = readOrderStore(COLLECTION_ORDER_STORAGE_KEY)
  return [...(store[collectionOrderKey(accountId)] || [])]
}

export function setAppRavenCollectionOrder(accountId: string, orderedIds: string[]) {
  const key = collectionOrderKey(accountId)
  const store = readOrderStore(COLLECTION_ORDER_STORAGE_KEY)
  const cleaned = orderedIds.filter(id => typeof id === "string" && !!id.trim()).slice(0, MAX_ORDER_ENTRIES)
  if (cleaned.length === 0) {
    delete store[key]
  } else {
    store[key] = cleaned
  }
  writeOrderStore(COLLECTION_ORDER_STORAGE_KEY, store, "AppRaven 合集排序")
}

/** 合集内 App 手动排序：只记本地顺序，不改服务端。 */
export function getAppRavenCollectionItemOrder(accountId: string, collectionId: string): string[] {
  const store = readOrderStore(COLLECTION_ITEM_ORDER_STORAGE_KEY)
  return [...(store[collectionItemOrderKey(accountId, collectionId)] || [])]
}

export function setAppRavenCollectionItemOrder(accountId: string, collectionId: string, orderedIds: string[]) {
  const key = collectionItemOrderKey(accountId, collectionId)
  const store = readOrderStore(COLLECTION_ITEM_ORDER_STORAGE_KEY)
  const cleaned = orderedIds.filter(id => typeof id === "string" && !!id.trim()).slice(0, MAX_ORDER_ENTRIES)
  if (cleaned.length === 0) {
    delete store[key]
  } else {
    store[key] = cleaned
  }
  writeOrderStore(COLLECTION_ITEM_ORDER_STORAGE_KEY, store, "AppRaven 合集内容排序")
}
