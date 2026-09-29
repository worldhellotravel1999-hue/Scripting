import { Button, Spacer, Text, VStack, useEffect, useState } from "scripting"
import { fetchPriceHistoryFast, historyPrice, regionDefinition, type PriceHistoryRecord } from "../core/price-history"

/**
 * 价格历史列与 App 内购买列共用同一套文字尺度：
 * 正文取应用介绍/更新正文字号（body 17pt）的 90%，列标题与附注按同一比例缩小，
 * 两列字号、字重、颜色一一对应，左右并排时不再一边大一边小。
 */
export const PRICE_COLUMN_TITLE_FONT = 13.8
export const PRICE_ROW_FONT = 15.3
export const PRICE_ROW_META_FONT = 13

export function PriceHistoryRows(props: {
  records: PriceHistoryRecord[]; limit: number; foregroundStyle?: any
  regionCode?: string
}) {
  const region = regionDefinition(props.regionCode || "us")
  if (!region) return <Spacer frame={{ width: 0, height: 0 }} />
  return <VStack alignment="leading" spacing={9} frame={{ maxWidth: "infinity", alignment: "leading" }}>
    {props.records.slice(0, props.limit).map(record => {
      const date = new Date(record.timestamp)
      return <VStack key={record.id} alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {/* 价格链强制单行：字多时自动紧缩/缩小，不折到第二行；排版列宽不动，只影响显示。 */}
        <Text font={PRICE_ROW_FONT} foregroundStyle={props.foregroundStyle} monospacedDigit
          lineLimit={1} minScaleFactor={0.5} allowsTightening
          fixedSize={{ horizontal: false, vertical: true }}>
          {`${historyPrice(record.from, region.currency, region.locale)} → ${historyPrice(record.to, region.currency, region.locale)} → ${record.cny || "¥—"}`}
        </Text>
        <Text font={PRICE_ROW_META_FONT} foregroundStyle="secondaryLabel" monospacedDigit
          lineLimit={1} minScaleFactor={0.5} allowsTightening
          fixedSize={{ horizontal: false, vertical: true }}>
          {`ID ${record.versionId || "—"} · v${record.version || "—"} · ${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`}
        </Text>
      </VStack>
    })}
  </VStack>
}

/** 地区由上方价格列表控制，key 在地区切换时重建，避免显示旧地区记录。 */
export function PriceHistorySection(props: {
  appid: string; regionCode: string; foregroundStyle?: any
}) {
  const [records, setRecords] = useState<PriceHistoryRecord[] | null>(null)
  const [error, setError] = useState("")
  const [token, setToken] = useState(0)
  const [limit, setLimit] = useState(5)
  const region = regionDefinition(props.regionCode)
  useEffect(() => {
    let cancelled = false
    setRecords(null)
    setError("")
    setLimit(5)
    // 两段式：首屏价格链先渲染，后台补齐版本 ID / 人民币后再替换；失败回退首屏。
    if (region) void fetchPriceHistoryFast(props.appid, { regionCode: props.regionCode }).then(handle => {
      if (cancelled) return
      setRecords(handle.records)
      void handle.completed.then(full => {
        if (!cancelled) setRecords(full)
      }).catch(() => {
        // 补齐失败保留首屏价格链，不报错。
      })
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [props.appid, props.regionCode, token])
  return <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
    <Text font={PRICE_COLUMN_TITLE_FONT} fontWeight="medium" foregroundStyle="secondaryLabel">价格历史</Text>
    {!region ? null : error ? <Button buttonStyle="plain" action={() => setToken(value => value + 1)}>
      <Text font={PRICE_ROW_META_FONT} foregroundStyle="secondaryLabel" fixedSize={{ horizontal: false, vertical: true }}>历史暂不可用 · 点按重试</Text>
    </Button> : records === null ?
      <Text font={PRICE_ROW_META_FONT} foregroundStyle="secondaryLabel">正在读取…</Text> :
      records.length === 0 ?
        <Text font={PRICE_ROW_META_FONT} foregroundStyle="secondaryLabel" fixedSize={{ horizontal: false, vertical: true }}>暂无价格变动记录</Text> :
        <VStack alignment="leading" spacing={10}>
          <PriceHistoryRows records={records} limit={limit} regionCode={props.regionCode} foregroundStyle={props.foregroundStyle} />
          {records.length > limit ? <Button buttonStyle="plain" action={() => setLimit(value => value + 10)}>
            <Text font={PRICE_ROW_META_FONT} foregroundStyle="secondaryLabel">更多历史</Text>
          </Button> : null}
        </VStack>}
  </VStack>
}
