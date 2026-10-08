import {
  Button,
  Divider,
  HStack,
  Image,
  List,
  Menu,
  ProgressView,
  RoundedRectangle,
  Section,
  Text,
} from "scripting"
import { Banners, SettingsRow } from "./components"
import { PAGE_ACCOUNT, type PanelCtx } from "./ctx"
import { promptInput } from "./prompt"

/**
 * 账号页（底部第 4 个页签，2026-10-07 学 IPA-Tool 账号切换，风格保持 Telegram-iOS 自家样式）：
 *  - 顶部：当前账号行（与下方各行同款 SettingsRow：48×48 渐变图标块 + 名字 +
 *    行内副信息 + 右侧「当前」小字，不再用圆形头像卡）
 *  - 账号列表：点行切换（Dialog 确认），长按移除（仅删本机会话，不碰 Telegram 服务器）
 *  - 添加账号：后端开新 session slot → 全屏登录页，成功后随时可切回；中途可取消回滚
 *  - 退出当前账号：若还有其他账号，后端自动切到下一个（不把人踢回登录页）
 *
 * 后端：tg_api 的 account_switch / account_add_begin / account_add_cancel /
 * account_remove + 注册表 accounts.json（每账号独立 session/state/messages 库）。
 */

/** 账号展示名：name → @username → phone → sid */
function acctName(a: { name?: string; username?: string; phone?: string; sid?: string }): string {
  return a.name || (a.username ? `@${a.username}` : "") || a.phone || a.sid || "未知账号"
}

/** 账号次要信息（行 value / 菜单用）：手机号优先，避免拼接过长换行 */
function acctSub(a: { phone?: string; username?: string }): string {
  return a.phone || (a.username ? `@${a.username}` : "")
}

/**
 * 顶栏快速切换菜单（学 IPA-Tool 的 QuickSwitchAccountMenu：
 * 胶囊 label 显示当前账号，展开列出全部账号 + 勾选 + 分隔 + 添加/管理）。
 * 放在会话页 toolbar topBarTrailing（与忙碌转圈并排）。
 */
export function AccountMenu({ p }: { p: PanelCtx }) {
  const accounts = p.accounts
  const current = accounts.find(a => a.sid === p.accountSid)
  const label = current ? acctName(current) : p.status?.me?.name || "账号"

  return (
    <Menu
      disabled={p.busy !== null}
      label={
        <HStack
          spacing={5}
          padding={{ horizontal: 11, vertical: 7 }}
          glassEffect="capsule"
          contentShape="capsule"
          background={<RoundedRectangle fill="rgba(255,255,255,0.78)" cornerRadius={17} />}
          shadow={{ color: "rgba(0,0,0,0.12)", radius: 12, y: 4 }}
        >
          <Image
            systemName="person.crop.circle"
            foregroundStyle="#2AABEE"
            frame={{ width: 15, height: 15 }}
          />
          <Text font="caption" fontWeight="semibold" lineLimit={1}>
            {label}
          </Text>
          <Image
            systemName="chevron.down"
            foregroundStyle="#8E8E93"
            frame={{ width: 10, height: 10 }}
          />
        </HStack>
      }
    >
      {accounts.length === 0 ? (
        // 空态只留一个入口：以前还会跟一个「添加账号」（同一回调）和「管理账号」
        // （点进去是空页），两个语义重复的项并列容易误点。
        <Button title="登录账号" systemImage="person.badge.plus" action={p.beginAddAccount} />
      ) : (
        <>
          {accounts.map(a => (
            <Button
              key={a.sid}
              title={acctName(a)}
              systemImage={a.sid === p.accountSid ? "checkmark" : "person"}
              action={() => {
                if (a.sid !== p.accountSid) p.switchAccount(a.sid)
              }}
            />
          ))}
          <Divider />
          <Button title="添加账号" systemImage="person.badge.plus" action={p.beginAddAccount} />
          <Button title="管理账号" systemImage="gearshape" action={() => p.push(PAGE_ACCOUNT)} />
        </>
      )}
    </Menu>
  )
}

/** 当前账号行：与下方账号行同一套 SettingsRow UI（渐变图标块 + 标题 + 右侧「当前」） */
function CurrentAccountCard({ p }: { p: PanelCtx }) {
  const me = p.status?.me
  const current = p.accounts.find(a => a.sid === p.accountSid)
  const name = me?.name || (current ? acctName(current) : "未登录")
  const sub =
    (me?.username ? `@${me.username}` : "") ||
    (me?.phone ? me.phone : "") ||
    (current ? acctSub(current) : "")
  return (
    <SettingsRow
      icon="person.crop.circle"
      // 真实 Telegram 头像（status.me.avatar = ~/.tg-hub/avatars/<photo_id>.jpg）
      iconSrc={me?.avatar || undefined}
      color="#2AABEE"
      chevron={false}
      title={name}
      hint={sub || undefined}
      hintTone="muted"
      hintMax={90}
      value="当前"
    />
  )
}

export function AccountScreen({ p }: { p: PanelCtx }) {
  const others = p.accounts.filter(a => a.sid !== p.accountSid)
  // API 凭证说明收进弹窗 message（从设置页迁来，点击才显示）
  const apiStatusMsg = p.status?.has_api
    ? "已使用自己的 API 凭证"
    : "尚未配置 API 凭证（公共凭证已移除，登录页会要求填写）"
  const saveRowTitle = p.status?.has_api ? "更新凭证" : "保存凭证"

  return (
    <List
      listStyle="plain"
      listRowSpacing={10}
      listRowInsets={{ top: 0, bottom: 0, leading: 16, trailing: 16 }}
      navigationTitle="账号"
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        // 顶栏右侧的刷新按钮已删（2026-10-07）：忙碌时仅保留转圈
        topBarTrailing: p.busy ? <ProgressView /> : undefined,
      }}
    >
      <Banners p={p} />

      {/* 整页一张无题单卡（与设置页同风格：无分组标题、无说明提示） */}
      <Section>
        <CurrentAccountCard p={p} />
        <SettingsRow
          icon="person.crop.circle"
          color="#34C759"
          chevron={false}
          title="登录状态"
          value={p.authorized ? p.status?.me?.name || "已登录" : "未登录"}
        />

        {/* 其他账号：点行切换（确认），长按移除 */}
        {others.map(a => (
          <SettingsRow
              key={a.sid}
              icon="person"
              color="#5856D6"
              title={acctName(a)}
              value={a.has_session === false ? "需重新登录" : acctSub(a) || undefined}
              disabled={p.busy !== null}
              action={async () => {
                if (p.busy !== null) return
                if (a.has_session === false) {
                  const ok = await Dialog.confirm({
                    title: "该账号登录已失效",
                    message: `「${acctName(a)}」的本机会话已不在，切换后需要重新登录。`,
                    confirmLabel: "去登录",
                  })
                  if (ok) await p.switchAccount(a.sid)
                  return
                }
                const ok = await Dialog.confirm({
                  title: "切换账号",
                  message: `切换到「${acctName(a)}」？会话列表、统计与消息查询都会换成该账号的数据。`,
                  confirmLabel: "切换",
                })
                if (ok) await p.switchAccount(a.sid)
              }}
              onLongPress={async () => {
                if (p.busy !== null) return
                const ok = await Dialog.confirm({
                  title: "移除账号",
                  message: `移除「${acctName(a)}」？仅删除本机的登录会话与登录缓存，不影响 Telegram 服务器上的登录；已同步到本地的消息库保留。`,
                  confirmLabel: "移除",
                })
                if (ok) await p.removeAccount(a.sid)
              }}
            />
          ))}

        {/* 账号操作 */}
        <SettingsRow
          icon="person.badge.plus"
          color="#34C759"
          title={p.addingAccount ? "正在添加账号…" : "添加账号"}
          chevron={!p.addingAccount}
          disabled={p.busy !== null || p.addingAccount}
          action={p.beginAddAccount}
        />
        <SettingsRow
          icon="power"
          color="#FF3B30"
          danger
          chevron={false}
          disabled={p.busy !== null}
          title="退出当前账号"
          value={p.status?.me?.name || undefined}
          action={async () => {
            if (p.busy !== null) return
            const othersN = p.accounts.length - 1
            const ok = await Dialog.confirm({
              title: "退出当前账号",
              message:
                othersN > 0
                  ? "仅退出本机登录（不影响手机等其他设备），并自动切换到另一个已登录账号。本地会话列表缓存会被清除。"
                  : "仅退出本机登录（同时清除会话列表缓存），不影响手机等其他设备。重新登录属风控事件，非必要请勿反复退出。",
              confirmLabel: "退出",
            })
            if (ok) await p.doLogout()
          }}
        />

        {/* API 凭证（从设置页迁来：点行弹窗填写，状态说明在弹窗里） */}
        <SettingsRow
          icon="number"
          color="#8E8E93"
          title="api_id"
          value={p.apiId || undefined}
          action={async () => {
            const v = await promptInput("apiId", {
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
            const v = await promptInput("apiHash", {
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
      </Section>
    </List>
  )
}
