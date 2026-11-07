import { Script } from "scripting"

/**
 * 行图标（彩色）——SettingsRow 左上角 48×48 色块里的图标，以及底部标签栏图标。
 *
 * 2026-10-12 改版：原来是白色 SF Symbol（单色、细线），现改为**彩色图片图标**
 * （Apple 风格 emoji 素材，与 Telegram iOS 里表情观感一致），尺寸/文字不变：
 *   · 色块仍是 48×48 圆角渐变块、行高与内边距不动；
 *   · 只把中间的白色 symbol 换成 27×27 的彩色 PNG（素材自带留白，视觉约 24pt）；
 *   · 映射表里没有的 symbol 继续渲染原白色 symbol（不会出现空白块）。
 *
 * 2026-10-12 二次修订：按用户反馈修正错配/重复的图标——
 *   · api_id 由「数字」改为 🆔（ID 卡按钮）；api_hash 由「锁」改为 🔐（带钥匙的锁）；
 *   · 「本轮会话数上限」改用 🧮（算盘 = 计数上限），与「显示条数」的 🔢 区分；
 *   · 「同步消息」由 🔄 改为 📥（把消息拉到本地），与设置页「刷新全部已同步会话」的 🔄 区分。
 *
 * 素材随脚本打包：assets/rowicons/<key>.png（128×128，透明底）。
 * 换风格只需替换这批 PNG（或改本表的 key），无需动页面代码。
 * 行级覆盖：SettingsRow 传 iconAsset="xxx" 可只用某一行，不影响其它行。
 */

const dir = Script.directory.endsWith("/") ? Script.directory.slice(0, -1) : Script.directory

/** 彩色图标素材目录（随包发布） */
export const ROW_ICON_DIR = `${dir}/assets/rowicons`

/** SF Symbol → 素材 key（同名 symbol 出现在多行时共用一张图） */
const SYMBOL_ASSET: Record<string, string> = {
  // 设置页
  "arrow.clockwise": "sync", // 刷新全部已同步会话
  gauge: "chart", // 每会话最多条数
  "list.number": "numbers", // 显示条数（本轮会话数上限走 iconAsset="abacus"）
  number: "id", // api_id（账号页）
  magnifyingglass: "search", // 按名字同步
  "plus.circle": "add", // 加入群组 / 添加分析动作
  "person.badge.plus": "add", // 添加账号
  "checkmark.circle": "check", // 全选本页（机器人签到走 iconAsset="robot"）
  wifi: "wifi", // 网络
  trash: "trash", // 删除类行
  "xmark.bin": "trash", // 清除凭证
  xmark: "xmark", // 取消
  // 群详情页 · 同步与消息
  "arrow.triangle.2.circlepath": "inbox", // 同步消息（拉取到本地）
  "bubble.left.fill": "chat", // 输入消息对话
  "arrow.uturn.left": "undo", // 撤回我发出的（退出类行走 iconAsset="door"）
  "text.alignleft": "text", // 查看最近消息
  // 群详情页 · 群组频道管理 / 分组
  "person.3.fill": "people", // 群组频道管理 / 群组
  "antenna.radiowaves.left.and.right": "megaphone", // 频道
  "line.3.horizontal": "list", // 全部
  "chevron.left": "back", // 返回
  folder: "folder", // 从「已同步」分组移出
  "folder.badge.minus": "folder",
  "arrow.counterclockwise": "recycle", // 恢复到「已同步」分组
  // 账号页
  person: "person",
  "person.crop.circle": "person", // 登录状态
  power: "plug", // 退出当前账号
  lock: "locked_key", // api_hash（带钥匙的锁 = 密钥串）
  "key.fill": "key", // 保存/更新 API 凭证
  // AI 面板
  clock: "clock", // 时间范围
  sparkles: "sparkles", // 分析动作
  "questionmark.circle": "question", // 自由提问 / 发送指令
  // 其它（备用）
  link: "link",
  calendar: "calendar",
}

/** 某个 symbol（或行级覆盖 key）对应的素材文件路径；无映射返回 null */
export function rowIconAssetPath(symbol: string, override?: string): string | null {
  const key = override !== undefined && override !== "" ? override : SYMBOL_ASSET[symbol]
  return key ? `${ROW_ICON_DIR}/${key}.png` : null
}

/**
 * 标签栏图标：把彩色素材做成 26pt 的 UIImage（保持原图不透明度，不被系统着色）。
 *
 * 用途：`<Tab image={...}>` —— 系统标签栏正常只接受 SF Symbol，这里给「宿主支持
 * 自定义图片」的版本留一个口子：
 *   · 支持 → 标签栏显示彩色图标（仍保持系统标签栏的样式/尺寸/动效）；
 *   · 不支持 → 该参数被忽略，继续用 systemImage 的系统符号（外观与原来完全一致）。
 * 全程 try/catch + 能力探测，任何一步不可用都返回 null，绝不影响页面渲染。
 */
export function tabIconImage(asset: string): any {
  try {
    const path = rowIconAssetPath("", asset)
    if (path === null) return null
    const U: any = (globalThis as any).UIImage
    if (!U || typeof U.fromFile !== "function") return null
    const img = U.fromFile(path)
    if (!img) return null
    // 缩到标签栏图标的常规尺寸（26pt），避免大图被系统按原始点数渲染
    let out = img
    if (typeof img.preparingThumbnail === "function") {
      out = img.preparingThumbnail({ width: 26, height: 26 }) ?? img
    }
    // 保持原色（不加这一步，图标会被标签栏的 tint 染成单色）
    if (typeof out.withRenderingMode === "function") {
      out = out.withRenderingMode("alwaysOriginal") ?? out
    }
    return out
  } catch {
    return null
  }
}
