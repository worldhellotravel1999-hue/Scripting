import { Button, HStack, Spacer, Text } from "scripting"
import type { AppStoreInfo } from "../core/appstore"
import { formatRating, formatReleaseDate } from "../core/appstore"
import { AnimText } from "./anim-text"

function CopyableRow(props: { title: string; value: string }) {
  const value = String(props.value || "—")
  return (
    <HStack
      spacing={10}
      padding={{ vertical: 2 }}
      contextMenu={{
        menuItems: (
          <Button
            title="复制"
            systemImage="doc.on.doc"
            action={() => Pasteboard.setString(value)}
          />
        ),
      }}
    >
      <Text foregroundStyle="secondaryLabel">{props.title}</Text>
      <Spacer />
      <AnimText
        lineLimit={1}
        truncationMode="middle"
        anim="interpolate"
        dur={0.35}
      >
        {value}
      </AnimText>
    </HStack>
  )
}

export function AppInfoRows(props: { info: AppStoreInfo }) {
  return (
    <>
      <CopyableRow title="开发者" value={props.info.sellerName || "—"} />
      <CopyableRow title="类别" value={props.info.primaryGenreName || "—"} />
      <CopyableRow title="版本" value={props.info.version || "—"} />
      <CopyableRow title="更新时间" value={formatReleaseDate(props.info.releaseDate)} />
      <CopyableRow title="评分" value={formatRating(props.info.averageUserRating, props.info.userRatingCount)} />
    </>
  )
}
