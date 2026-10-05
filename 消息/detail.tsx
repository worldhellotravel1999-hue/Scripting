import {
  HStack,
  List,
  Picker,
  ProgressView,
  Section,
  Text,
  TextField,
  VStack,
  useState,
} from "scripting"
import { fmtNum, fmtTime, tg, TYPE_LABEL } from "./api"
import { Avatar, Banners, FieldBox, Hint, MsgRow, RowButton, SettingsRow } from "./components"
import { AiActionsSection } from "./ai_panel"
import { type PanelCtx } from "./ctx"

/**
 * 群详情页（点会话列表里的任意一个群进入）：
 *  1. 直接输入文本发送消息（以登录账号发出，相当于本地部署的 Telegram 客户端）
 *  2. 一键「同步消息」
 *  3. 点一下动作 → AI 分析该群消息（动作可自定义），分析结果可一键发回本群
 *  4. 查看本地最近消息 / 清除本地记录
 *  5. 卡片末尾：批量退出 / 批量删除（原在设置页，2026-10-05 移入本卡片）
 * 所有按钮都是直接动作，不再有二级菜单。
 */

/**
 * 批量退出 / 批量删除自己创建的频道群（预览用 p.chats，执行走 bulk_leave 命令）。
 * 与详情页同风格：分段选择 + 图标行 + 两步确认，无分组标题（属单卡一部分）。
 */
export function BulkLeaveSection({ p }: { p: PanelCtx }) {
  const [op, setOp] = useState("leave")
  const [scope, setScope] = useState("group")
  const [keyword, setKeyword] = useState("")
  const [armed, setArmed] = useState(false)
  const [running, setRunning] = useState(false)
  const [hint, setHint] = useState("")

  const kw = keyword.trim().toLowerCase()
  const matches = (p.chats || []).filter((c: any) => {
    const t = c.type
    if (scope === "group" && t !== "group" && t !== "supergroup") return false
    if (scope === "channel" && t !== "channel") return false
    if (op === "delete" && !c.creator) return false
    if (kw && !String(c.name ?? c.id).toLowerCase().includes(kw)) return false
    return true
  })

  const verb = op === "delete" ? "删除" : "退出"
  const names = matches.slice(0, 4).map((c: any) => c.name || c.id).join("、")
  const tail = matches.length > 4 ? ` 等 ${matches.length} 个` : ""

  async function run() {
    if (running || matches.length === 0) return
    if (!armed) {
      setArmed(true)
      setHint("")
      setTimeout(() => setArmed(false), 5000)
      return
    }
    setArmed(false)
    setRunning(true)
    setHint("")
    try {
      const res = await tg(
        "bulk_leave",
        { chats: matches.map((c: any) => c.id), action: op },
        600
      )
      if (res.ok) {
        const fails: any[] = res.failed || []
        const failText =
          fails.length > 0
            ? `；失败 ${fails.length} 个：${fails
                .slice(0, 3)
                .map((f: any) => `${f.name}（${f.error}）`)
                .join("、")}${fails.length > 3 ? "…" : ""}`
            : ""
        const msg = `完成：成功 ${(res.done || []).length} / ${res.processed}${failText}`
        setHint(msg)
        setTimeout(() => setHint(cur => (cur === msg ? "" : cur)), 5000)
        p.loadChats()
      } else {
        const msg = res.error || "执行失败"
        setHint(msg)
        setTimeout(() => setHint(cur => (cur === msg ? "" : cur)), 5000)
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Picker
        title="操作"
        value={op}
        onChanged={(v: string) => {
          setOp(v)
          setArmed(false)
          setHint("")
        }}
        pickerStyle="segmented"
      >
        <Text tag="leave">退出</Text>
        <Text tag="delete">删除我创建的</Text>
      </Picker>
      <Picker
        title="范围"
        value={scope}
        onChanged={(v: string) => {
          setScope(v)
          setArmed(false)
          setHint("")
        }}
        pickerStyle="segmented"
      >
        <Text tag="all">全部</Text>
        <Text tag="group">群组</Text>
        <Text tag="channel">频道</Text>
      </Picker>
      <SettingsRow
        icon="magnifyingglass"
        color="#8E8E93"
        chevron={false}
        title="名称包含"
        trailing={
          <HStack spacing={6}>
            <FieldBox width={100}>
              <TextField
                title="留空 = 全部"
                value={keyword}
                onChanged={setKeyword}
                frame={{ maxWidth: "infinity" }}
              />
            </FieldBox>
            <Text font="footnote" foregroundStyle="#8E8E93">{`${matches.length} 个`}</Text>
          </HStack>
        }
      />
      <SettingsRow
        icon={op === "delete" ? "trash" : "arrow.uturn.left"}
        color={op === "delete" ? "#FF3B30" : "#FF9500"}
        danger
        chevron={false}
        disabled={running || matches.length === 0 || p.busy !== null}
        title={
          running
            ? "处理中…"
            : armed
              ? `再点一次，确认${verb}`
              : `${verb} ${matches.length} 个匹配会话`
        }
        action={run}
        trailing={running ? <ProgressView /> : undefined}
      />
      {hint !== "" ? (
        <Hint tone={hint.startsWith("完成") ? "ok" : "error"} text={hint} />
      ) : matches.length > 0 ? (
        <Hint tone="muted" text={`将${verb}：${names}${tail}`} />
      ) : (
        <Hint
          tone="muted"
          text={p.chats === null ? "会话列表还没加载" : "没有匹配的会话"}
        />
      )}
    </>
  )
}

// ── 文本格式面板（仿 Telegram 输入框格式栏）：点按钮把对应 HTML 标签包住整段草稿，
// 再点一次同按钮取消；发送时后端按 HTML 解析成 Telegram 格式实体。
type FmtWrap = { label: string; open: string; close: string }

const FMT_ROW_1: FmtWrap[] = [
  { label: "引用", open: "<blockquote>", close: "</blockquote>" },
  { label: "遮罩", open: '<span class="tg-spoiler">', close: "</span>" },
  { label: "粗体", open: "<b>", close: "</b>" },
  { label: "斜体", open: "<i>", close: "</i>" },
  { label: "等宽", open: "<code>", close: "</code>" },
]

const FMT_ROW_2: FmtWrap[] = [
  { label: "删除线", open: "<s>", close: "</s>" },
  { label: "下划线", open: "<u>", close: "</u>" },
  { label: "代码", open: "<pre>", close: "</pre>" },
]

export function ChatDetailScreen({ p, chat }: { p: PanelCtx; chat: any }) {
  const chatName: string = chat.name || String(chat.id)
  const [syncRes, setSyncRes] = useState<any>(null)
  const [localMsgs, setLocalMsgs] = useState<any[] | null>(null)
  const [msgError, setMsgError] = useState("")
  const [msgLoading, setMsgLoading] = useState(false)
  const [showMsgs, setShowMsgs] = useState(false)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendHint, setSendHint] = useState<{ ok: boolean; text: string } | null>(null)
  const [recallCount, setRecallCount] = useState("2")
  const [recalling, setRecalling] = useState(false)
  const [recallArmed, setRecallArmed] = useState(false)
  const [recallHint, setRecallHint] = useState("")
  const [leaving, setLeaving] = useState(false)
  const [leaveArmed, setLeaveArmed] = useState(false)
  const [leaveHint, setLeaveHint] = useState("")
  const [destroying, setDestroying] = useState(false)
  const [destroyArmed, setDestroyArmed] = useState(false)
  const [destroyHint, setDestroyHint] = useState("")
  const [folderArmed, setFolderArmed] = useState(false)
  const [folderHint, setFolderHint] = useState("")
  const [showFormats, setShowFormats] = useState(false)
  const [formatHint, setFormatHint] = useState("")

  // 该会话是否已被移出「已同步」分组（纯本地，不影响「全部」）
  const excludedFromFolder = p.excludedChats.includes(String(chat.id))

  /** 两步确认后移出分组（只改本地分组显示，不碰 Telegram） */
  function handleExcludeFromFolder() {
    if (!folderArmed) {
      setFolderArmed(true)
      setFolderHint("")
      setTimeout(() => setFolderArmed(false), 4000)
      return
    }
    setFolderArmed(false)
    p.excludeChat(chat.id)
    const msg = "已移出「已同步」分组；「全部」里仍然可见"
    setFolderHint(msg)
    setTimeout(() => setFolderHint(cur => (cur === msg ? "" : cur)), 5000)
  }

  const local = (p.stats?.chats || []).find((c: any) => c.chat_name === chatName)

  async function handleSync() {
    const res = await p.syncOne(chat)
    if (res) {
      setSyncRes(res)
      // 同步结果提示临时展示，5 秒后自动消失
      setTimeout(() => setSyncRes((cur: any) => (cur === res ? null : cur)), 5000)
    }
  }

  async function handleSend() {
    const text = draft.trim()
    if (text === "" || sending) return
    setSending(true)
    setSendHint(null)
    try {
      const res = await tg(
        "send_message",
        { chat: chatName, chat_id: chat.id, text },
        90
      )
      if (res.ok) {
        setDraft("")
        const hint = {
          ok: true,
          text:
            res.sent > 1
              ? `已发送 ${res.sent} 条（超长自动分段）`
              : `已发送到「${res.chat || chatName}」`,
        }
        setSendHint(hint)
        setTimeout(() => setSendHint(cur => (cur?.text === hint.text ? null : cur)), 5000)
        if (showMsgs) loadLocalMessages()
        p.loadOverview()
      } else {
        const hint = { ok: false, text: res.error || "发送失败" }
        setSendHint(hint)
        setTimeout(() => setSendHint(cur => (cur?.text === hint.text ? null : cur)), 5000)
      }
    } finally {
      setSending(false)
    }
  }

  /** 格式面板：把标签包住整段草稿，再点一次取消（光标定位不可控，故整段处理）。 */
  function flashFormatHint(msg: string) {
    setFormatHint(msg)
    setTimeout(() => setFormatHint(cur => (cur === msg ? "" : cur)), 5000)
  }

  function applyWrap(f: FmtWrap) {
    if (draft.trim() === "") {
      flashFormatHint("先输入内容，再选格式")
      return
    }
    if (draft.startsWith(f.open) && draft.endsWith(f.close)) {
      setDraft(draft.slice(f.open.length, draft.length - f.close.length))
    } else {
      setDraft(f.open + draft + f.close)
    }
  }

  /** 链接：弹窗输入网址，整段变成可点链接；已是链接则取消。 */
  async function applyLink() {
    if (draft.trim() === "") {
      flashFormatHint("先输入内容，再选格式")
      return
    }
    if (draft.startsWith('<a href="') && draft.endsWith("</a>")) {
      const gt = draft.indexOf('">')
      if (gt > 0) {
        setDraft(draft.slice(gt + 2, draft.length - "</a>".length))
        return
      }
    }
    const input = await Dialog.prompt({
      title: "插入链接",
      message: "整段文字将变成可点击的链接",
      placeholder: "https://example.com",
      confirmLabel: "插入",
    })
    const url = (input || "").trim()
    if (url === "") return
    setDraft(`<a href="${url}">${draft}</a>`)
  }

  /** 日期：在末尾插入当前日期时间文本。 */
  function applyDate() {
    const d = new Date()
    const p2 = (n: number) => (n < 10 ? `0${n}` : String(n))
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    setDraft(draft === "" || /\s$/.test(draft) ? draft + stamp : `${draft} ${stamp}`)
  }

  /** 撤回我最新发出的 N 条（Telegram 删除自己消息 = 对所有人撤回，不限时长）。 */
  async function handleRecall() {
    const n = Math.round(Number(recallCount))
    if (recalling) return
    if (!Number.isFinite(n) || n < 1) {
      const msg = "请输入要撤回的条数（≥1）"
      setRecallHint(msg)
      setTimeout(() => setRecallHint(cur => (cur === msg ? "" : cur)), 5000)
      return
    }
    if (!recallArmed) {
      setRecallArmed(true)
      setRecallHint("")
      setTimeout(() => setRecallArmed(false), 4000)
      return
    }
    setRecallArmed(false)
    setRecalling(true)
    setRecallHint("")
    try {
      const res = await tg(
        "delete_messages",
        { chat: chatName, chat_id: chat.id, limit: Math.min(n, 50) },
        60
      )
      if (res.ok) {
        const msg = `已撤回 ${res.deleted} 条（本地记录同步删除）`
        setRecallHint(msg)
        setTimeout(() => setRecallHint(cur => (cur === msg ? "" : cur)), 5000)
        if (showMsgs) loadLocalMessages()
        p.loadOverview()
      } else {
        const msg = res.error || "撤回失败"
        setRecallHint(msg)
        setTimeout(() => setRecallHint(cur => (cur === msg ? "" : cur)), 5000)
      }
    } finally {
      setRecalling(false)
    }
  }

  /** 退出该会话（退群）：先点一次武装，4 秒内再点一次才真正执行。 */
  async function handleLeave() {
    if (leaving) return
    if (!leaveArmed) {
      setLeaveArmed(true)
      setLeaveHint("")
      setTimeout(() => setLeaveArmed(false), 4000)
      return
    }
    setLeaving(true)
    setLeaveArmed(false)
    try {
      const res = await tg("leave_chat", { chat: chatName, chat_id: chat.id }, 60)
      if (res.ok) {
        const msg = `${res.action}；返回列表后将不再显示（本地消息记录仍保留）`
        setLeaveHint(msg)
        setTimeout(() => setLeaveHint(cur => (cur === msg ? "" : cur)), 5000)
        p.loadChats()
      } else {
        const msg = res.error || "退出失败"
        setLeaveHint(msg)
        setTimeout(() => setLeaveHint(cur => (cur === msg ? "" : cur)), 5000)
      }
    } finally {
      setLeaving(false)
    }
  }

  /** 永久删除自己创建的频道/群（不可恢复）：同样两步确认。 */
  async function handleDestroy() {
    if (destroying) return
    if (!destroyArmed) {
      setDestroyArmed(true)
      setDestroyHint("")
      setTimeout(() => setDestroyArmed(false), 4000)
      return
    }
    setDestroying(true)
    setDestroyArmed(false)
    try {
      const res = await tg("destroy_chat", { chat: chatName, chat_id: chat.id }, 60)
      if (res.ok) {
        const msg = `${res.action}，不可恢复；返回列表后将不再显示`
        setDestroyHint(msg)
        setTimeout(() => setDestroyHint(cur => (cur === msg ? "" : cur)), 5000)
        p.loadChats()
      } else {
        const msg = res.error || "删除失败"
        setDestroyHint(msg)
        setTimeout(() => setDestroyHint(cur => (cur === msg ? "" : cur)), 5000)
      }
    } finally {
      setDestroying(false)
    }
  }

  async function loadLocalMessages() {
    if (msgLoading) return
    setMsgLoading(true)
    setMsgError("")
    try {
      const res = await tg("recent", { chat: chatName, hours: 168, limit: 50 }, 60)
      if (!res.ok) {
        setMsgError(res.error || "读取失败")
        setLocalMsgs([])
      } else {
        setLocalMsgs(res.messages || [])
      }
    } finally {
      setMsgLoading(false)
    }
  }

  function toggleMessages() {
    const next = !showMsgs
    withAnimation(Animation.smooth({ duration: 0.3 }), () => setShowMsgs(next))
    if (next && localMsgs === null) loadLocalMessages()
  }

  async function handleDelete() {
    await p.doDeleteChat(chatName)
    setLocalMsgs(null)
    setShowMsgs(false)
    setSyncRes(null)
  }

  return (
    <List
      listStyle="plain"
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle={chatName}
      navigationBarTitleDisplayMode="inline"
    >
      <Banners p={p} />

      <Section>
        <HStack spacing={12}>
          <Avatar name={chatName} size={52} src={chat.avatar} />
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font="title3" bold lineLimit={2}>
              {chatName}
            </Text>
            <Text font="caption" foregroundStyle="#8E8E93">
              {TYPE_LABEL[chat.type] || chat.type || "会话"}
              {chat.unread ? ` · 未读 ${chat.unread}` : ""}
            </Text>
            <Text font="caption" foregroundStyle={local ? "#34C759" : "#8E8E93"}>
              {local
                ? `本地已有 ${fmtNum(local.msg_count)} 条 · 最后 ${fmtTime(local.last_msg)}`
                : "尚未同步到本地"}
            </Text>
          </VStack>
        </HStack>

        {/* 输入 + 格式 + 发送同一行：输入框带浅灰圆角底，右侧胶囊按钮 */}
        <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "top" }}>
          <FieldBox>
            <TextField
              title="消息内容"
              prompt="输入要发送到本会话的内容…"
              value={draft}
              onChanged={setDraft}
              axis="vertical"
              lineLimit={{ min: 1, max: 6 }}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            />
          </FieldBox>
          <RowButton
            title="Aa"
            color={showFormats ? "#2AABEE" : "#8E8E93"}
            action={() => {
              withAnimation(Animation.smooth({ duration: 0.28 }), () =>
                setShowFormats(v => !v)
              )
              setFormatHint("")
            }}
          />
          <RowButton
            title={sending ? "发送中…" : "发送"}
            filled
            disabled={sending || draft.trim() === ""}
            action={handleSend}
          />
        </HStack>
        {/* 格式面板：与 Telegram 相同的十种格式，点一下包住整段，再点取消（展开带平滑动画） */}
        {showFormats ? (
          <VStack
            alignment="leading"
            spacing={6}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
            transition={Transition.move("bottom").combined(Transition.opacity())}
          >
            <HStack spacing={6}>
              {FMT_ROW_1.slice(0, 4).map(f => (
                <RowButton key={f.label} title={f.label} action={() => applyWrap(f)} />
              ))}
            </HStack>
            <HStack spacing={6}>
              <RowButton title={FMT_ROW_1[4].label} action={() => applyWrap(FMT_ROW_1[4])} />
              <RowButton title="链接" action={applyLink} />
              <RowButton title="日期" action={applyDate} />
            </HStack>
            <HStack spacing={6}>
              {FMT_ROW_2.map(f => (
                <RowButton key={f.label} title={f.label} action={() => applyWrap(f)} />
              ))}
            </HStack>
            {formatHint !== "" ? (
              <Hint tone="warn" text={formatHint} />
            ) : (
              <Hint tone="muted" text="点格式包住整段文字，再点一次取消；链接和日期点后按提示输入" />
            )}
          </VStack>
        ) : null}
        {sendHint ? <Hint tone={sendHint.ok ? "ok" : "error"} text={sendHint.text} /> : null}
        <SettingsRow
          icon="arrow.uturn.left"
          color="#FF9500"
          danger
          chevron={false}
          disabled={recalling}
          title={recalling ? "撤回中…" : "撤回我发出的"}
          trailing={
            <HStack spacing={6}>
              <FieldBox width={36}>
                <TextField
                  title="2"
                  value={recallCount}
                  onChanged={setRecallCount}
                  frame={{ maxWidth: "infinity" }}
                />
              </FieldBox>
              <RowButton
                title={recallArmed ? "确认撤回" : "撤回"}
                color="#FF3B30"
                filled={recallArmed}
                disabled={recalling}
                action={handleRecall}
              />
            </HStack>
          }
        />
        {recallHint !== "" ? (
          <Hint tone={recallHint.startsWith("已撤回") ? "ok" : "error"} text={recallHint} />
        ) : null}
        <SettingsRow
          icon="arrow.triangle.2.circlepath"
          color="#34C759"
          chevron={false}
          disabled={p.busy !== null}
          title={p.busy ? "同步中…" : "同步消息"}
          action={handleSync}
          trailing={p.busy ? <ProgressView /> : undefined}
        />
        {syncRes ? (
          <Hint
            tone={syncRes.ok ? "ok" : "error"}
            text={
              syncRes.ok
                ? `新增 ${fmtNum(syncRes.added)} 条消息`
                : `同步失败：${syncRes.error || "未知错误"}`
            }
          />
        ) : null}

        <AiActionsSection p={p} chat={chat} />

        <SettingsRow
          icon="text.alignleft"
          color="#5856D6"
          chevron={false}
          disabled={msgLoading}
          title={showMsgs ? "收起最近消息" : "查看最近 50 条"}
          action={toggleMessages}
          trailing={msgLoading ? <ProgressView /> : undefined}
        />
        {showMsgs ? (
          <SettingsRow
            icon="arrow.clockwise"
            color="#8E8E93"
            chevron={false}
            disabled={msgLoading}
            title="刷新本地消息"
            action={loadLocalMessages}
            transition={Transition.opacity()}
          />
        ) : null}
        {msgError !== "" ? (
          <Hint tone="error" text={msgError} />
        ) : null}
        {showMsgs && localMsgs !== null && localMsgs.length === 0 && msgError === "" ? (
          <Hint tone="muted" text="近 7 天没有本地消息，先点上方「同步消息」" />
        ) : null}
        {showMsgs && localMsgs !== null && localMsgs.length > 0 ? (
          <VStack
            alignment="leading"
            spacing={10}
            transition={Transition.move("bottom").combined(Transition.opacity())}
          >
            {localMsgs.map((m: any, i: number) => (
              <MsgRow
                key={`${m.id ?? i}`}
                m={m}
                onOpenUrl={url => Safari.openURL(url)}
              />
            ))}
          </VStack>
        ) : null}

        <SettingsRow
          icon="trash"
          color="#FF3B30"
          danger
          chevron={false}
          disabled={!local || p.busy !== null}
          title={local ? "清除该群本地记录" : "没有可清除的本地记录"}
          action={handleDelete}
        />

        <SettingsRow
          icon={excludedFromFolder ? "arrow.counterclockwise" : "folder.badge.minus"}
          color={excludedFromFolder ? "#34C759" : "#FF9500"}
          chevron={false}
          title={
            excludedFromFolder
              ? "恢复到「已同步」分组"
              : folderArmed
                ? "再点一次，移出该分组"
                : "从「已同步」分组移出"
          }
          action={() => {
            if (excludedFromFolder) {
              p.restoreChat(chat.id)
              const msg = "已恢复到「已同步」分组"
              setFolderHint(msg)
              setTimeout(() => setFolderHint(cur => (cur === msg ? "" : cur)), 5000)
            } else {
              handleExcludeFromFolder()
            }
          }}
        />
        {folderHint !== "" ? (
          <Hint tone={folderHint.startsWith("已移出") ? "warn" : "ok"} text={folderHint} />
        ) : excludedFromFolder ? (
          <Hint tone="muted" text="当前不在「已同步」分组里（仅本地分组，「全部」仍显示）" />
        ) : (
          <Hint tone="muted" text="只移出本分组显示，不退出群；「全部」里仍然可见" />
        )}

        {/* 移出记录管理（原在首页列表底部，2026-10-05 移入详情页）：
            有移出记录才显示；恢复 = 放回分组，清空 = 直接删掉存储数据避免越积越多 */}
        {p.excludedChats.length > 0 ? (
          <SettingsRow
            icon="arrow.counterclockwise"
            color="#8E8E93"
            chevron={false}
                        title="移出记录"
            value={String(p.excludedChats.length)}
            trailing={
              <HStack spacing={6}>
                <RowButton
                  title="恢复"
                  action={() => {
                    const n = p.excludedChats.length
                    p.restoreExcluded()
                    const msg = `已恢复 ${n} 个会话到「已同步」分组`
                    setFolderHint(msg)
                    setTimeout(() => setFolderHint(cur => (cur === msg ? "" : cur)), 5000)
                  }}
                />
                <RowButton
                  title="清空"
                  color="#FF3B30"
                  action={() => {
                    p.clearExcludedRecords()
                    const msg = "已清空移出记录（存储数据已删除）"
                    setFolderHint(msg)
                    setTimeout(() => setFolderHint(cur => (cur === msg ? "" : cur)), 5000)
                  }}
                />
              </HStack>
            }
          />
        ) : null}

        <SettingsRow
          icon="arrow.uturn.left"
          color="#8E8E93"
          danger
          chevron={false}
          disabled={leaving || p.busy !== null}
          title={
            leaving ? "退出中…" : leaveArmed ? "再点一次，确认退出" : "退出该会话（退群）"
          }
          action={handleLeave}
        />
        {leaveHint !== "" ? (
          <Hint tone={leaveHint.startsWith("已") ? "ok" : "error"} text={leaveHint} />
        ) : null}

        <SettingsRow
          icon="trash"
          color="#FF3B30"
          danger
          chevron={false}
          disabled={destroying || p.busy !== null}
          title={
            destroying
              ? "删除中…"
              : destroyArmed
                ? "再点一次，确认删除"
                : "永久删除（仅创建者）"
          }
          action={handleDestroy}
        />
        {destroyHint !== "" ? (
          <Hint tone={destroyHint.startsWith("已") ? "ok" : "error"} text={destroyHint} />
        ) : null}

        {/* 批量退出 / 删除：原在设置页底部，现并入本卡片末尾（同风格、无分组标题） */}
        <BulkLeaveSection p={p} />
      </Section>
    </List>
  )
}
