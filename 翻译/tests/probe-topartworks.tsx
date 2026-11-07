import { VStack, Text, useEffect, useState, fetch } from "scripting"
import { captureAppRavenSession, getActiveAppRavenAccount, getUserAppRavenCollections } from "../core/appraven"

const GRAPHQL_URL = "https://appraven.net/appraven/graphql"
const UA = "AppRaven/2.2.11 (iPhone; iOS 26.0; Scale/3.00)"

async function rawQuery(query: string, variables: Record<string, unknown>, cookie: string): Promise<string> {
  try {
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        "apollographql-client-name": "net.appraven.app-apollo-ios",
        "apollographql-client-version": "2.2.11-2",
        "x-apollo-operation-type": "query",
        "x-apollo-operation-name": "Probe",
        Cookie: cookie,
      },
      body: JSON.stringify({ operationName: "Probe", query, variables }),
      timeout: 15,
      handleRedirect: async () => null,
    })
    const text = await response.text()
    return `status=${response.status} body=${text.slice(0, 600)}`
  } catch (reason) {
    return `fetch-error=${reason instanceof Error ? reason.message : String(reason)}`
  }
}

export default function ProbeTopArtworks() {
  const [lines, setLines] = useState<string[]>(["starting…"])
  useEffect(() => {
    void (async () => {
      const out: string[] = []
      try {
        const active = getActiveAppRavenAccount()
        out.push(`account=${active ? active.id : "NONE"}`)
        if (active) {
          const session = captureAppRavenSession(active.id)
          out.push(`session=${session ? "ok" : "null"}`)
          if (session) {
            const mine = await getUserAppRavenCollections(active.id, session)
            out.push(`collections=${mine.length}`)
            mine.forEach((c, i) => {
              const top = c.topArtworks
              out.push(`#${i} title="${c.title}" appCount=${c.appCount} topLen=${top ? top.length : "undefined"}`)
              ;(top || []).forEach((u, j) => out.push(`    [${j}] ${u.slice(0, 90)}`))
            })
            // 探测 topArtworks 是否支持参数（服务端默认返回几个）
            const baseVars = { userId: active.id, type: "CREATED", query: "", sort: { by: "LAST_ITEM_DATE" }, page: 0 }
            const plain = `query Probe($userId: ID!, $type: UserCollectionsType!, $query: String, $sort: CollectionSortInput!, $page: Int!) {
              user(id: $userId) { collections(type: $type, query: $query, sort: $sort, page: $page) { content { id title topArtworks } } } }`
            out.push("PLAIN: " + (await rawQuery(plain, baseVars, session.cookie)).slice(0, 500))
            const first3 = `query Probe($userId: ID!, $type: UserCollectionsType!, $query: String, $sort: CollectionSortInput!, $page: Int!) {
              user(id: $userId) { collections(type: $type, query: $query, sort: $sort, page: $page) { content { id title topArtworks(first: 5) } } } }`
            out.push("FIRST5: " + (await rawQuery(first3, baseVars, session.cookie)).slice(0, 500))
          }
        }
      } catch (reason) {
        out.push(`ERR ${reason instanceof Error ? reason.message : String(reason)}`)
      }
      console.log("PROBE-TOPARTWORKS\n" + out.join("\n"))
      setLines(out)
    })()
  }, [])
  return (
    <VStack spacing={2} padding={8} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      {lines.map((line, index) => (
        <Text key={`p-${index}`} font="caption2" lineLimit={4}>{line}</Text>
      ))}
    </VStack>
  )
}
