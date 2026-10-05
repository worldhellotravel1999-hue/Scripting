import {
  Button,
  HStack,
  Image,
  List,
  ProgressView,
  Section,
  TextField,
  useState,
} from "scripting"
import { fmtNum, fmtTime, tg } from "./api"
import { Banners, FieldBox, Hint, RowButton, SettingsRow } from "./components"
import type { PanelCtx } from "./ctx"

/**
 * 设置页：整页一张无题单卡（不分组、无分组标题，与首页/群详情同风格）。
 * 全部为彩色圆角图标行 + 行内控件（见 components.tsx::SettingsRow）：
 *  同步（一键刷新 / 每会话条数 / 按名字同步 / 加入群组）→ 显示条数 → API 凭证 → 数据与账号。
 * 批量退出 / 删除已移到群详情页卡片末尾（见 detail.tsx::BulkLeaveSection）。
 */

/**
 * 加入群组：输入邀请链接（t.me/+xxx）或公开 @用户名，走后端 join_chat 命令
 * （2026-10-05 从首页搬进设置页，样式与其它行一致）。
 */
function JoinChatRow({ p }: { p: PanelCtx }) {
  const [text, setText] = useState("")
  const [joining, setJoining] = useState(false)
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null)

  async function join() {
    const v = text.trim()
    if (v === "" || joining) return
    setJoining(true)
    setHint(null)
    try {
      const res = await tg("join_chat", { chat: v }, 120)
      if (res.ok) {
        const h = { ok: true, text: `已加入「${res.chat}」，回列表刷新可见` }
        setHint(h)
        setTimeout(() => setHint(cur => (cur?.text === h.text ? null : cur)), 5000)
        setText("")
        p.loadChats()
      } else {
        const h = { ok: false, text: res.error || "加入失败" }
        setHint(h)
        setTimeout(() => setHint(cur => (cur?.text === h.text ? null : cur)), 5000)
      }
    } finally {
      setJoining(false)
    }
  }

  return (
    <>
      <SettingsRow
        icon="plus.circle"
        color="#34C759"
        chevron={false}
        title="加入群组"
        trailing={
          <HStack spacing={6}>
            <FieldBox width={96}>
              <TextField
                title="邀请链接 / @用户名"
                value={text}
                onChanged={(v: string) => {
                  setText(v)
                  setHint(null)
                }}
                frame={{ maxWidth: "infinity" }}
              />
            </FieldBox>
            <RowButton
              title={joining ? "加入中…" : "加入"}
              color="#34C759"
              filled
              disabled={joining || text.trim() === ""}
              action={join}
            />
          </HStack>
        }
      />
      {hint ? <Hint tone={hint.ok ? "ok" : "error"} text={hint.text} /> : null}
    </>
  )
}

/**
 * 「显示条数」行（属于单卡的一部分，不再自带分组标题）：
 * 输入数字 → 点「写入缓存」才生效并落盘（重启脚本不回默认 50）。
 * 钳制：≥1 且不超过当前会话总数（会话未加载时不设上限）。
 */
function ListLimitRow({ p }: { p: PanelCtx }) {
  const total = (p.chats || []).length
  const [text, setText] = useState(String(Math.max(1, p.listLimit)))
  const [hint, setHint] = useState("")

  const handleInput = (v: string) => {
    setText(v.replace(/[^0-9]/g, "").slice(0, 6))
    setHint("")
  }

  function save() {
    if (text === "") {
      const msg = "请输入 ≥1 的数字"
      setHint(msg)
      setTimeout(() => setHint(cur => (cur === msg ? "" : cur)), 5000)
      return
    }
    let n = Number(text)
    if (!Number.isFinite(n) || n < 1) n = 1
    const capped = total > 0 && n > total
    if (capped) n = total
    p.setListLimit(n) // 落盘（view.tsx 写入 Storage）
    setText(String(n))
    const msg = capped
      ? `已写入缓存：显示 ${fmtNum(n)} 条（按会话总数封顶）`
      : `已写入缓存：显示 ${fmtNum(n)} 条，重启脚本仍生效`
    setHint(msg)
    // 提示临时展示，5 秒后自动消失
    setTimeout(() => setHint(cur => (cur === msg ? "" : cur)), 5000)
  }

  return (
    <>
      <SettingsRow
        icon="list.number"
        color="#2AABEE"
        chevron={false}
        title="显示条数"
        trailing={
          <HStack spacing={6}>
            <FieldBox width={48}>
              <TextField title="50" value={text} onChanged={handleInput} frame={{ maxWidth: "infinity" }} />
            </FieldBox>
            <RowButton title="写入缓存" action={save} />
          </HStack>
        }
      />
      {hint !== "" ? <Hint tone="ok" text={hint} /> : null}
    </>
  )
}

export function SettingsScreen({ p }: { p: PanelCtx }) {
  return (
    <List
      listStyle="plain"
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle="设置"
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        topBarTrailing: p.busy ? (
          <ProgressView />
        ) : (
          <Button action={() => p.loadStatus()}>
            <Image systemName="arrow.clockwise" frame={{ width: 17, height: 17 }} />
          </Button>
        ),
      }}
    >
      <Banners p={p} />

      {/* 整页一张无题单卡：所有设置行连续排列，不分子卡、无分组标题 */}
      <Section>
        {/* 同步 */}
        <SettingsRow
          icon="arrow.clockwise"
          color="#34C759"
          chevron={false}
          disabled={p.busy !== null}
          title={p.busy ? "刷新中…" : "刷新全部已同步会话"}
          action={p.doRefresh}
          trailing={p.busy ? <ProgressView /> : undefined}
        />
        <SettingsRow
          icon="gauge"
          color="#5856D6"
          chevron={false}
          title="每会话最多条数"
          trailing={
            <FieldBox width={90}>
              <TextField
                title="500"
                value={p.refreshLimit}
                onChanged={p.setRefreshLimit}
                frame={{ maxWidth: "infinity" }}
              />
            </FieldBox>
          }
        />
        <SettingsRow
          icon="list.number"
          color="#5856D6"
          chevron={false}
          title="本轮会话数上限"
          trailing={
            <FieldBox width={90}>
              <TextField
                title="20"
                value={p.refreshChatsCount}
                onChanged={p.setRefreshChatsCount}
                frame={{ maxWidth: "infinity" }}
              />
            </FieldBox>
          }
        />
        <SettingsRow
          icon="magnifyingglass"
          color="#2AABEE"
          chevron={false}
          title="按名字同步"
          trailing={
            <HStack spacing={6}>
              <FieldBox width={80}>
                <TextField
                  title="@用户名/群名"
                  value={p.syncChat}
                  onChanged={p.setSyncChat}
                  frame={{ maxWidth: "infinity" }}
                />
              </FieldBox>
              <RowButton
                title="同步"
                filled
                disabled={p.busy !== null}
                action={p.doSyncOne}
              />
            </HStack>
          }
        />
        {p.syncResult ? (
          <Hint
            tone="muted"
            text={`上次刷新 ${fmtTime(p.syncResult.at)} · 新增 ${fmtNum(p.syncResult.total)} 条${
              p.syncResult.capped?.length ? ` · ${p.syncResult.capped.length} 个首次截断` : ""
            }`}
          />
        ) : null}

        {/* 加入群组（邀请链接 / @用户名） */}
        <JoinChatRow p={p} />

        {/* 显示条数（写入缓存） */}
        <ListLimitRow p={p} />

        {/* API 凭证 */}
        <Hint
          tone={p.status?.default_api ? "warn" : "ok"}
          text={
            p.status?.default_api
              ? "当前使用公共凭证（易触发风控），建议填入自定义凭证"
              : "已使用自定义 API 凭证"
          }
        />
        <SettingsRow
          icon="number"
          color="#8E8E93"
          chevron={false}
          title="api_id"
          trailing={
            <FieldBox width={140}>
              <TextField
                title="12345678"
                value={p.apiId}
                onChanged={p.setApiId}
                frame={{ maxWidth: "infinity" }}
              />
            </FieldBox>
          }
        />
        <SettingsRow
          icon="lock"
          color="#8E8E93"
          chevron={false}
          title="api_hash"
          trailing={
            <FieldBox width={140}>
              <TextField
                title="32 位 hash"
                value={p.apiHash}
                onChanged={p.setApiHash}
                frame={{ maxWidth: "infinity" }}
              />
            </FieldBox>
          }
        />
        <SettingsRow
          icon="key.fill"
          color="#FF9500"
          chevron={false}
          disabled={p.busy !== null}
          title={p.status?.default_api ? "保存自定义凭证" : "更新凭证"}
          action={p.saveApi}
        />
        {p.status?.default_api ? null : (
          <SettingsRow
            icon="xmark.bin"
            color="#FF3B30"
            danger
            chevron={false}
            disabled={p.busy !== null}
            title="清除（恢复公共凭证）"
            action={p.clearApi}
          />
        )}

        {/* 数据与账号 */}
        <SettingsRow
          icon="person.crop.circle"
          color="#34C759"
          chevron={false}
          title="登录状态"
          value={p.authorized ? p.status?.me?.name || "已登录" : "未登录"}
        />
        <SettingsRow
          icon="wifi"
          color="#0A84FF"
          chevron={false}
          title="网络"
          value={p.status?.network_error ? "无法连接" : p.status ? "正常" : "检查中…"}
        />
        <SettingsRow
          icon="trash"
          color="#FF3B30"
          danger
          chevron={false}
          disabled={p.busy !== null}
          title="删除本地记录"
          trailing={
            <HStack spacing={6}>
              <FieldBox width={64}>
                <TextField
                  title="群名"
                  value={p.delChat}
                  onChanged={p.setDelChat}
                  frame={{ maxWidth: "infinity" }}
                />
              </FieldBox>
              <RowButton
                title="删除"
                color="#FF3B30"
                disabled={p.busy !== null}
                action={() => p.doDeleteChat()}
              />
            </HStack>
          }
        />
        <SettingsRow
          icon="power"
          color="#FF3B30"
          danger
          chevron={false}
          disabled={p.busy !== null}
          title="退出登录"
          action={p.doLogout}
        />
      </Section>
    </List>
  )
}
