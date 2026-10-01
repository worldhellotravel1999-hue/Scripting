import { Button, HStack, Image, LazyVStack, ProgressView, RoundedRectangle, ScrollView, Text, VStack, useEffect, useRef, useState } from "scripting"
import { AnimTextGlassBadge } from "./glass-badge"
import { fetchAppVersions, fetchVersionHistoryNotes, mergeVersionNotes, type AppVersionEntry, type AppVersionNotes } from "../core/versions"

/** 版本 ID 和历史说明独立加载；任一来源成功即可查看，失败允许重试。 */
function useAppVersions(appid: string, region: string, version: string, currentNotes?: string) {
  const key = `${appid}:${region}`
  const [versions, setVersions] = useState<{ key: string; entries: AppVersionEntry[]; error: boolean } | null>(null)
  const [history, setHistory] = useState<{ key: string; entries: AppVersionNotes[]; error: string } | null>(null)
  const [token, setToken] = useState(0)
  useEffect(() => {
    let cancelled = false
    setVersions(null)
    setHistory(null)
    void fetchAppVersions(appid).then(
      entries => { if (!cancelled) setVersions({ key, entries, error: false }) },
      () => { if (!cancelled) setVersions({ key, entries: [], error: true }) },
    )
    void fetchVersionHistoryNotes(appid, region).then(
      entries => { if (!cancelled) setHistory({ key, entries, error: "" }) },
      () => { if (!cancelled) setHistory({ key, entries: [], error: "更新说明查询失败" }) },
    )
    return () => { cancelled = true }
  }, [appid, region, token])
  const base = versions?.key === key ? versions.entries : null
  const fetched = history?.key === key ? history : null
  const notes = [...(fetched?.entries || [])]
  // Lookup 正文与它自己的版本号成对回退，绝不填给其它历史版本。
  if (version.trim() && currentNotes?.trim() && !notes.some(item => item.version === version.trim())) {
    notes.push({ version: version.trim(), notes: currentNotes.trim() })
  }
  const merged = mergeVersionNotes(base || [], notes)
  return {
    entries: merged.length ? merged : base === null || fetched === null ? null : [],
    notesLoading: fetched === null,
    notesError: fetched?.error || "",
    versionsError: versions?.key === key && versions.error,
    versionsLoading: base === null,
    retry: () => setToken(value => value + 1),
  }
}

/**
 * 头部版本徽章菜单：默认显示当前版本号徽章，
 * 点击弹出可滚动的自定义版本列表，每行固定单行；点按行可复制版本号 / 版本 ID。
 * 面板高度随条目数收缩（只有一个版本时就是一行高），超出上限时才在内部滚动。
 * 版本行与操作列表都在同一弹层内渲染，避免原生 Menu 接管文字颜色。
 * 搜索页传 grayBackground=true：改成圆角长方形（淡黑灰底、无描边、无圆点），文字淡灰 secondaryLabel；
 * 分享页不传，保持原蓝色玻璃胶囊。
 */
export function VersionBadgeMenu(props: {
  appid: string
  /** 徽章与列表高亮显示的版本号；查看历史说明时同步为那个版本。 */
  version: string
  displayVersion?: string
  region?: string
  currentNotes?: string
  onSelectNotes?: (entry: AppVersionNotes) => void
  grayBackground?: boolean
  foregroundStyle?: any
}) {
  const region = props.region || "us"
  const { entries, notesLoading, notesError, versionsLoading, versionsError, retry } = useAppVersions(props.appid, region, props.version, props.currentNotes)
  const [isPresented, setIsPresented] = useState(false)
  /** 阅读态独立于版本列表；关闭弹层不清除主卡片已选的译文。 */
  const [viewedNotes, setViewedNotes] = useState<AppVersionNotes | null>(null)
  /** 当前打开的版本操作菜单；用自绘弹层保证菜单文字可使用卡片主题色。 */
  const [activeEntry, setActiveEntry] = useState<AppVersionEntry | null>(null)
  /** 原文快照 1 秒后自动关闭；手动关闭时取消待触发的定时器。 */
  const autoCloseRef = useRef<ReturnType<typeof setTimeout>>()
  /** 徽章显示所选版本；未选择或没有可用版本号时回退商店当前版本。 */
  const displayVersion = props.displayVersion?.trim() || props.version.trim()
  const currentVersion = displayVersion
  const panelWidth = Math.min(260, Device.screen.width - 32)
  /** 面板最大高度：条目多时到这个高度后在内部滚动 */
  const maxPanelHeight = Math.min(500, Device.screen.height * 0.6)
  /**
   * 面板高度自适应内容（ImageRenderer 实测）：
   * 版本行 44.33pt（17pt 单行文本 + 上下 12pt 内边距），取 44.5 留亚像素余量；
   * 加载 / 失败态实测约 52pt，取 53 避免裁切。
   * 修复：只有两个版本号时不再显示固定 500pt 高的全高面板。
   */
  const VERSION_ROW_HEIGHT = 44.5
  const STATUS_ROW_HEIGHT = 53
  /** 原文行高估算；长文由弹层滚动完整阅读。 */
  const NOTES_LINE_HEIGHT = 22
  const NOTES_CHARS_PER_LINE = 26
  const noteLinesFor = (text: string) =>
    Math.max(1, Math.ceil(text.length / NOTES_CHARS_PER_LINE) + text.split("\n").length)
  useEffect(() => () => {
    if (autoCloseRef.current) clearTimeout(autoCloseRef.current)
  }, [])
  useEffect(() => { setViewedNotes(null); setActiveEntry(null) }, [props.appid, region])
  const expandedNotes = viewedNotes?.notes || ""
  const activeNotes = activeEntry?.notes?.trim() || ""
  const activeActionCount = activeEntry
    ? 1 + (activeNotes ? 1 : 0) + (activeEntry.versionId ? 2 : 0)
    : 0
  const contentHeight = viewedNotes
    ? noteLinesFor(expandedNotes) * NOTES_LINE_HEIGHT + 24
    : activeEntry
      ? activeActionCount * VERSION_ROW_HEIGHT
      : entries?.length ? entries.length * VERSION_ROW_HEIGHT : STATUS_ROW_HEIGHT
  const showNotesStatus = !viewedNotes && !activeEntry && !!entries?.length && (notesLoading || versionsLoading || !!notesError || versionsError)
  const panelHeight = Math.min(maxPanelHeight, contentHeight + (showNotesStatus ? 36 : 0))

  async function copyText(text: string) {
    await Pasteboard.setString(text)
    try { HapticFeedback.lightImpact() } catch {}
    setIsPresented(false)
    setActiveEntry(null)
  }

  const gray = props.grayBackground === true
  const label = gray ? (
    <HStack
      spacing={6}
      padding={{ horizontal: 10, vertical: 5 }}
      background={<RoundedRectangle fill={{ light: "rgba(0,0,0,0.05)", dark: "rgba(0,0,0,0.22)" }} cornerRadius={7} />}
      clipShape={{ type: "rect", cornerRadius: 7, style: "continuous" }}
    >
      <Text font="caption" fontWeight="semibold" foregroundStyle={props.foregroundStyle || "secondaryLabel"}>
        {currentVersion ? `v${currentVersion}` : "版本"}
      </Text>
    </HStack>
  ) : (
    <AnimTextGlassBadge style="info" showDot font="caption" fontWeight="semibold" anim="numericText" foregroundStyle={props.foregroundStyle}>
      {currentVersion ? `v${currentVersion}` : "版本"}
    </AnimTextGlassBadge>
  )

  const loadingItems = (
    <ProgressView progressViewStyle="circular" padding={16} frame={{ maxWidth: "infinity" }} />
  )

  const versionItems = viewedNotes || activeEntry ? [] : (entries ?? []).map((entry) => (
    <Button
      key={`vm-${entry.versionId}-${entry.version}`}
      buttonStyle="plain"
      action={() => setActiveEntry(entry)}
    >
      <VStack spacing={0} padding={{ horizontal: 16, vertical: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
        <Text
          font={17}
          fontWeight={entry.version === currentVersion ? "semibold" : undefined}
          foregroundStyle={props.foregroundStyle || "label"}
          monospacedDigit
          lineLimit={1}
          minScaleFactor={0.5}
          allowsTightening
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {entry.versionId ? `ID ${entry.versionId} • V${entry.version}` : `V${entry.version}`}
        </Text>
      </VStack>
    </Button>
  ))

  const actionItems = activeEntry ? (
    <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
      {activeNotes ? (
        <Button
          buttonStyle="plain"
          action={() => {
            const selected = { version: activeEntry.version, notes: activeNotes }
            setViewedNotes(selected)
            setActiveEntry(null)
            props.onSelectNotes?.(selected)
            if (autoCloseRef.current) clearTimeout(autoCloseRef.current)
            autoCloseRef.current = setTimeout(() => {
              autoCloseRef.current = undefined
              setIsPresented(false)
              setViewedNotes(null)
            }, 1000)
          }}
        >
          <Text padding={{ horizontal: 16, vertical: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }} foregroundStyle={props.foregroundStyle || "label"}>查看新说明</Text>
        </Button>
      ) : null}
      <Button buttonStyle="plain" action={() => copyText(activeEntry.version)}>
        <Text padding={{ horizontal: 16, vertical: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }} foregroundStyle={props.foregroundStyle || "label"}>复制版本号</Text>
      </Button>
      {activeEntry.versionId ? (
        <Button buttonStyle="plain" action={() => copyText(activeEntry.versionId)}>
          <Text padding={{ horizontal: 16, vertical: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }} foregroundStyle={props.foregroundStyle || "label"}>复制版本 ID</Text>
        </Button>
      ) : null}
      {activeEntry.versionId ? (
        <Button buttonStyle="plain" action={() => copyText(`${activeEntry.version} (${activeEntry.versionId})`)}>
          <Text padding={{ horizontal: 16, vertical: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" as any }} foregroundStyle={props.foregroundStyle || "label"}>复制全部（版本号 + ID）</Text>
        </Button>
      ) : null}
    </VStack>
  ) : null

  const failedItems = (
    <Button buttonStyle="plain" action={retry}>
      <Image systemName="arrow.clockwise" font={17} foregroundStyle="secondaryLabel" padding={16} frame={{ maxWidth: "infinity" }} />
    </Button>
  )

  return (
    <Button
      buttonStyle="plain"
      action={() => {
        setViewedNotes(null)
        setActiveEntry(null)
        setIsPresented(true)
      }}
      popover={{
        isPresented,
        onChanged: presented => {
          if (!presented && autoCloseRef.current) {
            clearTimeout(autoCloseRef.current)
            autoCloseRef.current = undefined
          }
          setIsPresented(presented)
          if (!presented) { setViewedNotes(null); setActiveEntry(null) }
        },
        presentationCompactAdaptation: "popover",
        content: (
          <VStack spacing={0} frame={{ width: panelWidth, height: panelHeight }}>
            {viewedNotes ? (
              <ScrollView key="version-notes-reader" axes="vertical" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
                <Text
                  font={14}
                  foregroundStyle={props.foregroundStyle || "label"}
                  multilineTextAlignment="leading"
                  padding={{ horizontal: 16, vertical: 12 }}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}
                >
                  {expandedNotes}
                </Text>
              </ScrollView>
            ) : (
            <ScrollView key="version-list" axes="vertical" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
              <LazyVStack spacing={0} alignment="leading" frame={{ maxWidth: "infinity" }}>
                {entries === null ? loadingItems : activeEntry ? actionItems : entries.length ? versionItems : failedItems}
                {showNotesStatus ? (
                  <HStack frame={{ maxWidth: "infinity", height: 36 }}>
                    {notesLoading || versionsLoading ? <ProgressView progressViewStyle="circular" /> : null}
                    {notesLoading || versionsLoading ? null : (versionsError ? null : (
                      <Button title="重试更新说明" buttonStyle="plain" foregroundStyle="systemOrange" action={retry} />
                    ))}
                  </HStack>
                ) : null}
              </LazyVStack>
            </ScrollView>
            )}
          </VStack>
        ),
      }}
    >
      {label}
    </Button>
  )
}
