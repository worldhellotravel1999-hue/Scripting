import {
  Button,
  Image,
  List,
  ProgressView,
  Section,
  useState,
} from "scripting"
import { fmtNum, tg } from "./api"
import { Banners, SettingsRow } from "./components"
import type { PanelCtx } from "./ctx"

/**
 * 设置页：整页一张无题单卡（不分组、无分组标题，与首页/群详情同风格）。
 * 2026-10-05 改版：行内不再放「输入框 + 按钮」，改为**点整行（含彩色图标）
 * 弹 Dialog 输入/确认**，当前值以灰色 value 展示，说明文字全部收进弹窗
 * （点击才显示）。
 * 2026-10-06：5 秒操作结果提示改为**行内小字**（直接显示在本行空白处），
 * 不再在行下另起 Hint 气泡；重复的「上次刷新」提示行删除（顶部 Banners 已有）。
 * 批量退出 / 删除在群详情页卡片末尾（见 detail.tsx::BulkLeaveSection）。
 */

/**
 * 加入群组：点行弹窗输入邀请链接（t.me/+xxx）或公开 @用户名，
 * 走后端 join_chat 命令（2026-10-05 改为弹窗交互，行内不再放输入框+按钮）。
 */
function JoinChatRow({ p }: { p: PanelCtx }) {
  const [joining, setJoining] = useState(false)
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null)

  function flashHint(h: { ok: boolean; text: string }) {
    setHint(h)
    setTimeout(() => setHint(cur => (cur?.text === h.text ? null : cur)), 5000)
  }

  async function join(v: string) {
    if (joining) return
    setJoining(true)
    setHint(null)
    try {
      const res = await tg("join_chat", { chat: v }, 120)
      if (res.ok) {
        flashHint({ ok: true, text: `已加入「${res.chat}」` })
        p.loadChats()
      } else {
        flashHint({ ok: false, text: res.error || "加入失败" })
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
        title={joining ? "加入中…" : "加入群组"}
        hint={hint ? hint.text : undefined}
        hintTone={hint ? (hint.ok ? "ok" : "error") : "info"}
        disabled={joining}
        action={async () => {
          if (joining) return
          const v = await Dialog.prompt({
            title: "加入群组",
            message: "输入邀请链接（t.me/+xxx）或公开 @用户名",
            placeholder: "@用户名 / 邀请链接",
            confirmLabel: "加入",
          })
          if (v === null || v.trim() === "") return
          await join(v.trim())
        }}
      />
    </>
  )
}

/**
 * 「显示条数」行（属于单卡的一部分，不再自带分组标题）：
 * 点行弹窗输入数字 +「写入缓存」确认才落盘（重启脚本不回默认 50）。
 * 钳制：≥1 且不超过当前会话总数（会话未加载时不设上限）。
 */
function ListLimitRow({ p }: { p: PanelCtx }) {
  const total = (p.chats || []).length
  const [hint, setHint] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  function flash(tone: "ok" | "error", msg: string) {
    setHint({ tone, text: msg })
    setTimeout(() => setHint(cur => (cur?.text === msg ? null : cur)), 5000)
  }

  return (
    <>
      <SettingsRow
        icon="list.number"
        color="#2AABEE"
        title="显示条数"
        hint={hint ? hint.text : undefined}
        hintTone={hint ? hint.tone : "info"}
        value={String(Math.max(1, p.listLimit))}
        action={async () => {
          const v = await Dialog.prompt({
            title: "显示条数",
            message:
              total > 0
                ? `首页最多显示的会话条数（1 ~ ${total}），写入缓存后重启仍生效`
                : "首页最多显示的会话条数（≥1），写入缓存后重启仍生效",
            defaultValue: String(Math.max(1, p.listLimit)),
            keyboardType: "numberPad",
            confirmLabel: "写入缓存",
          })
          if (v === null) return
          if (v.replace(/[^0-9]/g, "") === "") {
            flash("error", "请输入 ≥1 的数字")
            return
          }
          let n = Number(v)
          if (!Number.isFinite(n) || n < 1) n = 1
          const capped = total > 0 && n > total
          if (capped) n = total
          p.setListLimit(n) // 落盘（view.tsx 写入 Storage）
          flash(
            "ok",
            capped
              ? `已写入 ${fmtNum(n)} 条（按总数封顶）`
              : `已写入 ${fmtNum(n)} 条（重启仍生效）`,
          )
        }}
      />
    </>
  )
}

export function SettingsScreen({ p }: { p: PanelCtx }) {
  // API 凭证状态说明不再常驻布局：收进 api_id/api_hash 行的弹窗 message（点击才显示）
  const apiStatusMsg = p.status?.has_api
    ? "已使用自己的 API 凭证"
    : "尚未配置 API 凭证（公共凭证已移除，登录页会要求填写）"
  const saveRowTitle = p.status?.has_api ? "更新凭证" : "保存凭证"
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
          title="每会话最多条数"
          value={p.refreshLimit}
          action={async () => {
            const v = await Dialog.prompt({
              title: "每会话最多条数",
              message: "「刷新全部已同步会话」时，每个会话最多拉取的消息条数",
              defaultValue: p.refreshLimit,
              keyboardType: "numberPad",
              confirmLabel: "确定",
            })
            if (v === null) return
            const n = v.replace(/[^0-9]/g, "").slice(0, 6)
            if (n !== "") p.setRefreshLimit(n)
          }}
        />
        <SettingsRow
          icon="list.number"
          color="#5856D6"
          title="本轮会话数上限"
          value={p.refreshChatsCount}
          action={async () => {
            const v = await Dialog.prompt({
              title: "本轮会话数上限",
              message: "「刷新全部已同步会话」本轮最多遍历的会话数量",
              defaultValue: p.refreshChatsCount,
              keyboardType: "numberPad",
              confirmLabel: "确定",
            })
            if (v === null) return
            const n = v.replace(/[^0-9]/g, "").slice(0, 6)
            if (n !== "") p.setRefreshChatsCount(n)
          }}
        />
        <SettingsRow
          icon="magnifyingglass"
          color="#2AABEE"
          title="按名字同步"
          value={p.syncChat || undefined}
          action={async () => {
            if (p.busy !== null) return
            const v = await Dialog.prompt({
              title: "按名字同步",
              message: "同步单个会话的最近消息（@用户名或群名）",
              defaultValue: p.syncChat,
              placeholder: "@用户名 / 群名",
              confirmLabel: "同步",
            })
            if (v === null || v.trim() === "") return
            p.setSyncChat(v.trim())
            await p.doSyncOne(v.trim())
          }}
        />

        {/* 加入群组（邀请链接 / @用户名） */}
        <JoinChatRow p={p} />

        {/* 显示条数（写入缓存） */}
        <ListLimitRow p={p} />

        {/* API 凭证：点行弹窗填写，状态说明在弹窗里 */}
        <SettingsRow
          icon="number"
          color="#8E8E93"
          title="api_id"
          value={p.apiId || undefined}
          action={async () => {
            const v = await Dialog.prompt({
              title: "API ID",
              message: `${apiStatusMsg}；填完点下方「${saveRowTitle}」生效`,
              defaultValue: p.apiId,
              placeholder: "12345678",
              keyboardType: "numberPad",
              confirmLabel: "填写",
            })
            if (v === null) return
            p.setApiId(v.trim())
          }}
        />
        <SettingsRow
          icon="lock"
          color="#8E8E93"
          title="api_hash"
          value={p.apiHash ? "已填写" : undefined}
          action={async () => {
            const v = await Dialog.prompt({
              title: "API Hash",
              message: `${apiStatusMsg}；32 位 hash，填完点下方「${saveRowTitle}」生效`,
              defaultValue: p.apiHash,
              placeholder: "32 位 hash",
              confirmLabel: "填写",
            })
            if (v === null) return
            p.setApiHash(v.trim())
          }}
        />
        <SettingsRow
          icon="key.fill"
          color="#FF9500"
          chevron={false}
          disabled={p.busy !== null}
          title={saveRowTitle}
          action={p.saveApi}
        />
        {p.status?.has_api ? (
          <SettingsRow
            icon="xmark.bin"
            color="#FF3B30"
            danger
            disabled={p.busy !== null}
            title="清除凭证"
            action={async () => {
              if (p.busy !== null) return
              const ok = await Dialog.confirm({
                title: "清除 API 凭证",
                message: "清除后下次进入登录页要重新填写 api_id / api_hash（已有登录会话不会掉）。确定清除？",
                confirmLabel: "清除",
              })
              if (ok) await p.clearApi()
            }}
          />
        ) : null}

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
          disabled={p.busy !== null}
          title="删除本地记录"
          value={p.delChat || undefined}
          action={async () => {
            if (p.busy !== null) return
            const v = await Dialog.prompt({
              title: "删除本地记录",
              message: "输入要删除本地记录的会话名（仅本地数据库，不影响 Telegram）",
              defaultValue: p.delChat,
              placeholder: "群名",
              confirmLabel: "删除",
            })
            if (v === null || v.trim() === "") return
            p.setDelChat(v.trim())
            await p.doDeleteChat(v.trim())
          }}
        />
        <SettingsRow
          icon="power"
          color="#FF3B30"
          danger
          disabled={p.busy !== null}
          title="退出登录"
          action={async () => {
            if (p.busy !== null) return
            const ok = await Dialog.confirm({
              title: "退出登录",
              message: "仅退出本机登录（同时清除会话列表缓存），不影响手机等其他设备。重新登录属风控事件，非必要请勿反复退出。",
              confirmLabel: "退出",
            })
            if (ok) await p.doLogout()
          }}
        />
      </Section>
    </List>
  )
}
