import { Script } from "scripting"
import {
  appRavenArtworkURL,
  parseAppRavenCollectionItemPage,
  parseAppRavenCollectionPage,
  parseAppRavenSetCookieHeaders,
  parseAppRavenCookieHeader,
  parseAppRavenGraphQLData,
  parseAppRavenITunesId,
  parseAppRavenMutationResult,
  parseAppRavenPage,
  parseAppRavenUser,
} from "../core/appraven"

const passed: string[] = []

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function equal<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function throws(task: () => unknown, message: string) {
  try {
    task()
  } catch {
    return
  }
  throw new Error(`expected throw: ${message}`)
}

function testInputAndArtworkParsing() {
  equal(parseAppRavenITunesId(" 001234 "), 1234, "iTunes ID normalization")
  throws(() => parseAppRavenITunesId(""), "empty iTunes ID")
  throws(() => parseAppRavenITunesId("12.5"), "fractional iTunes ID")
  throws(() => parseAppRavenITunesId("0"), "zero iTunes ID")

  equal(
    appRavenArtworkURL("https://example.test/{w}x{h}{c}.{f}", 512),
    "https://example.test/512x512bb.jpg",
    "artwork template",
  )
  equal(
    appRavenArtworkURL("https://example.test/100x100bb-60.jpg", 1024),
    "https://example.test/1024x1024bb.jpg",
    "artwork fixed URL",
  )
  equal(appRavenArtworkURL(undefined), undefined, "missing artwork")
  passed.push("输入校验和 artwork 模板归一")
}

function testGraphQLAndIdentityParsing() {
  equal(
    parseAppRavenGraphQLData({ data: { currentUser: { id: "u1" } } }),
    { currentUser: { id: "u1" } },
    "GraphQL data",
  )
  equal(parseAppRavenUser({ id: "u1", username: "alice", displayName: "Alice" }), {
    id: "u1",
    username: "alice",
    displayName: "Alice",
  }, "user shape")
  throws(() => parseAppRavenGraphQLData({ errors: [{ message: "unauthorized" }] }), "GraphQL errors")
  throws(() => parseAppRavenGraphQLData({ data: null }), "empty GraphQL data")
  throws(() => parseAppRavenUser({ username: "missing-id" }), "missing user ID")
  passed.push("GraphQL、用户身份和错误响应校验")
}

function testPaginationParsing() {
  equal(parseAppRavenPage<string>({ hasNext: true, content: ["a"] }), {
    hasNext: true,
    content: ["a"],
  }, "generic page")
  throws(() => parseAppRavenPage({ hasNext: "true", content: [] }), "invalid page flag")
  throws(() => parseAppRavenPage({ hasNext: false, content: "not-an-array" }), "invalid page content")

  const collections = parseAppRavenCollectionPage({
    hasNext: false,
    content: [{ id: "c1", title: "Favorites", appCount: 2, premiumOnly: false, topArtworks: ["https://art"] }],
  })
  equal(collections.content[0], {
    id: "c1",
    title: "Favorites",
    appCount: 2,
    premiumOnly: false,
    topArtworks: ["https://art"],
  }, "collection page")
  throws(() => parseAppRavenCollectionPage({ hasNext: false, content: [{ id: "c1", title: "Broken" }] }), "missing app count")

  const items = parseAppRavenCollectionItemPage({
    hasNext: false,
    content: [
      { id: "item1", type: "AUTHOR", app: { id: "app1", iTunesId: "123", title: "One" } },
      { id: "item2", app: { id: "app2", ITunesId: 456, artworkUrl: "https://art" } },
    ],
  })
  equal(items.content.map(item => item.app?.iTunesId), ["123", "456"], "iTunes ID casing normalization")
  throws(() => parseAppRavenCollectionItemPage({ hasNext: false, content: [{ id: "item1", app: { id: "app1", iTunesId: {} } }] }), "invalid item iTunes ID")
  passed.push("分页、合集和 iTunesId 大小写归一")
}

function testAuthenticationAndMutationParsing() {
  equal(parseAppRavenCookieHeader([
    { name: "session", value: "opaque" },
    { name: "other", value: "value" },
  ]), "session=opaque; other=value", "cookie header")
  equal(parseAppRavenCookieHeader([
    { name: "session", value: "opaque" },
    { name: "cleared", value: "" },
  ]), "session=opaque", "cookie header skips cleared cookies")

  throws(() => parseAppRavenCookieHeader([]), "empty cookie list")
  throws(() => parseAppRavenCookieHeader([{ name: "", value: "bad" }]), "cookie without a name")
  equal(parseAppRavenSetCookieHeaders([
    "remember-me=opaque123; Path=/; HttpOnly",
    "other=value; Path=/",
  ]), "remember-me=opaque123; other=value", "set-cookie header")
  throws(() => parseAppRavenSetCookieHeaders([]), "empty set-cookie list")
  equal(parseAppRavenMutationResult({ id: "mutation1" }, "删除结果"), { id: "mutation1" }, "mutation result")
  throws(() => parseAppRavenMutationResult({ id: "" }, "删除结果"), "empty mutation ID")
  throws(() => parseAppRavenMutationResult(null, "删除结果"), "missing mutation result")
  passed.push("Cookie 和 mutation 结果校验")
}

function run() {
  testInputAndArtworkParsing()
  testGraphQLAndIdentityParsing()
  testPaginationParsing()
  testAuthenticationAndMutationParsing()
  return passed
}

try {
  const result = run()
  console.log(JSON.stringify({ passed: result }))
  Script.exit({ passed: result })
} catch (reason) {
  const message = reason instanceof Error ? reason.message : String(reason)
  console.log(JSON.stringify({ failed: message, passed }))
  Script.exit({ failed: message, passed })
}
