# 翻译 脚本工作区记忆

## 项目结构
- Scripting App 项目：`script.json` + `index.tsx`（主入口）+ `intent.tsx`（快捷指令）+ `translation_ui_provider.tsx`（翻译界面）
- 业务逻辑在 `core/`（pricing.ts 价格、appstore.ts、translate.ts 等），UI 在 `views/`
- `core/linkedom.js`：自制 ESM 版 linkedom（HTML 解析），供 pricing.ts 等 5 个 core 模块做 HTML 解析；调试用的 CommonJS 版 linkedom.cjs 已于 2026-10-31 维护性清理中删除

## App Store 价格模块（core/pricing.ts）
- 本体价：iTunes Lookup API（`itunes.apple.com/{cc}/lookup?id=...`），返回 `trackViewUrl`（官方地区链接）+ 价格
- Premium 内购价：抓 `apps.apple.com` 网页解析。**关键坑**：Apple 按 IP 地理重定向，缺少 `X-Apple-Store-Front` 头时任何 `apps.apple.com/{cc}/...` URL（含完整 slug、lookup trackViewUrl、带 l=/ign-mpt= 参数、Cookie geo=US）都会被 302 到用户所在区的 `/cn/iphone/today` 页（无内购数据）；仅桌面 UA（Windows Chrome）+ `X-Apple-Store-Front: {id},12` 头返回 200 正确页
- iOS/iPhone UA 即使带头也会被 301 到 `itms-appss://`（App Store 协议），fetch 无法跟随
- 修复（2025-06）：① 优先用 lookup 的 `trackViewUrl` 作为抓取链接；② `handleRedirect` 拦截跨地区重定向；③ `RegionPrice.inAppError` 字段 + UI 展示失败原因（不再静默空白）；④ 解析加正则回退（`parseInAppPurchasesWithRegex`，匹配 legacy `in-app-title`/`in-app-price` 标记）防 linkedom 加载失败；⑤ 汇率源三级回退（open.er-api.com → api.exchangerate-api.com → api.frankfurter.app）
- 解析选择器三分支：`.text-pair.svelte-1gyt6l2` → `li.shelf-grid__list-item` → `.extra-list.in-app-purchases li`（legacy，已用 Minecraft 美区页 12 条内购验证）
- 价格面板排版（2.4.24 起）：`views/price-history.tsx` 导出 `PRICE_COLUMN_TITLE_FONT`(13.8) / `PRICE_ROW_FONT`(15.3 = 应用介绍正文 17pt 的 90%) / `PRICE_ROW_META_FONT`(13)；`region-prices.tsx` 的价格行改为「地区名 + 当前价」通栏标题（与正文同字号半粗），下方「价格历史」与「App 内购买」两列各占半宽、字号行距一一对应（不再用 DisclosureGroup，改为整行点按折叠）。改两列排版或字号时左右必须同改，回归脚本：`workspace/translate-work/validation/price-layout.test.tsx`（含字号=17pt×0.9 断言）
- 价格历史防折行（2.4.27 起）：价格链/ID行加 `lineLimit={1} + minScaleFactor={0.5} + allowsTightening` 强制单行，字多时紧缩缩小不折行；列宽/字号/数据源不动
- 版本列表（2.4.27 起）：版本行去掉右侧 chevron（`Image` 未再使用时注意 import），整行点按仍弹复制菜单（版本号/版本 ID/全部）；行 `HStack spacing` 8→0，去多余空白；数据/复制/面板尺寸不动
- 版本弹层高度自适应（2026-09-24 起）：版本列表现为自绘 popover（非原生 Menu 子菜单）；面板高度随条目数收缩（行高实测 44.33pt→取 44.5；加载/失败态取 53），上限 `min(500, 屏高×60%)`，超出才内部滚动；修复「只有两个版本也显示固定全高面板」。标定脚本 `tests/measure-version-rows.tsx`
- 翻译等待提示（2.4.28 起）：搜索/分享页更新·说明是 readOnly 卡，行内等待位只占位不重复显示，底部全局 `LoadingCaption` 保留一行「正在连接翻译引擎…」；`LoadingCaption` 轮播短语/间隔/翻译链路不动，可编辑卡（主翻译页）行内提示保留
- 内购默认展开（2.4.29 起）：`MultiRegionCompactList` 初始 `expandedRows` false→true（兜底 `?? false`→`?? true`），有内购直接展示明细，可点标题收起；分享页 `RegionPriceList` 本来就是默认展开，不动
- 价格历史提速（2.4.29 起）：`fetchPriceHistoryFast` 两段式——增强接口（版本 ID/汇率）与 AppRaven 主请求并行启动，主响应一到先出首屏价格链，后台补齐再替换；`prewarmPriceHistory` 在 `PriceRow` 本体价到达时分发启动，历史列挂载复用 pending/缓存；主请求超时 20→12；旧 `fetchPriceHistory` 改为走 fast 的 completed，解析/缓存语义不变

## 翻译引擎回退（2.4.26 起）
- 链路：谷歌免费网页优先（并发快路径），失败回退系统原生；冷却期内直接走系统（`core/google_engine.ts`）
- 弱网慢的原因是“谷歌连不上时白等”：旧逻辑每段串行试 2 个端点（3s+3s），长文本多分片再叠加
- 2.4.26：单请求 3s→2s；词典端点超时/断连直接失败（只有 HTTP 非 ok/空译文这种“网络通但被限”才试 gtx）；整个谷歌快路径 5s 整体限时，超时直接回退系统。UI/缓存/重试逻辑未动
- 2026-10-18：长文本整体上限保持 5s。实测 5948 字符健康网络 1.7–3.1s 返回（首进度 0.9–1.3s），曾试 2.8s 会误杀正常翻译并退回串行原生。整体超时或单分片失败时，只要已有分片成功就不再标记 2 分钟冷却（避免一次慢分片让后续长文全走慢速原生）
- App Store 长文本上限（2026-10-18）：`appStoreTextSlots` 把发布说明与应用说明统一限制在 8000 字符（超出追加截断提示）。发布说明此前无上限，分享扩展里会拆出几十个原生分片并渲染超长文本。回归：`tests/selected-version-notes.ts`、`tests/appstore-long-race.ts`
- 跨进程缓存（2.4.62 起）：分享扩展每次分享都是新进程，内存缓存全丢，导致「点版本号 / 查看新说明」每次都重新请求+重译。现版本号与历史说明写共享 Storage（`lingo_app_version_cache_v1`，10 分钟新鲜期/7 天过期/单条 64KB/总 384KB，`peekCached*` 首帧读），译文快照写 `lingo_translation_snapshots_v1`（完整成功才写、7 天过期、命中且 token 未变则不翻译）。`TranslatedBlock` 用不含 `selectionId` 的 `snapshotScope` 作键。回归：`tests/version-cache.ts`、`tests/translation-snapshot.ts`、`tmp/version-cache-hook-check.cjs`、`tmp/translation-snapshot-skip.cjs`

## 系统翻译界面（Translation UI，2.4.30 起）
- 系统面板 UI（2.4.38 起）：与主 Translate 卡片列表完全同一套容器渲染——`List listStyle="plain" scrollContentBackground="hidden" background=#F2F2F7/#000 + Section`（语言栏一个 Section、卡片一个 Section），视觉上是连续整体、没有散块分割感；translationHost 挂在 List 上。（2.4.34~2.4.37 曾临时用 ScrollView+spacing 18，因「分割不是一个整体」已回退。）
- 长按菜单（2.4.31 起为面板自绘；2.4.34 覆盖层方案；2.4.35 文案改「原文/译文」；2.4.36 行尺寸恢复原样；2.4.37 行加隐形命中层=判定扩大但外观不变）：面板给 readOnly 卡传入 `onMenuRequest` 后，原文/译文长按弹自绘小菜单。**2.4.34 关键改法**：文本本身（WebView 自定义字体 / AnimText / 普通 Text）一律不再挂手势，改在文本正上方盖一层 `Rectangle fill="rgba(0,0,0,0.003)"` 透明覆盖层（ZStack 叠放、contentShape=rect、撑满）接管 onLongPressGesture——WebView 会吞触摸，手势必须放在 WebView 之上；每处覆盖层必须独立元素实例（`menuOverlay(fire)` 工厂）。菜单文案：原文=「原文」+重试，译文=「译文」+重试+(允许时)替换。行视觉尺寸保持原样（padding 18×10 / minWidth 96）；**2.4.37**：每行 Button 用 overlay 叠一块 116×56 的透明命中层（onTapGesture+onLongPressGesture=先关再执行；保持有界以免吞掉遮罩的点空白关闭）——点判定四周各扩约 8–10pt，外观零变化。遮罩全屏（覆盖整个系统 Translation UI）。非面板 readOnly 卡（搜索/分享页）仍系统 contextMenu 且文本保持可选；面板容器为 ScrollView（对齐 fanyi 结构）。

## 自定义字体与 App Store 宿主（2.4.67）
- 字体选择保持旧共享键 `lingo_translation_font_settings_v1`，新增 App Group `Documents/lingo_translation_font_settings_v1.json` 快照：文件优先读取以保证主脚本/分享意图/App Store 宿主读到同一份原文/译文绑定；原 Storage 继续镜像兼容。
- 可见字体组件订阅设置指纹，前后台独立进程间每 1.2 秒刷新一次，有活动订阅时才轮询，最后一个组件卸载时停止。FontText 原生 key 加 `role`，避免 source/target 复用同一个 WebView 实例。
- 此版需设备实测 App Group 文件是否跨 Scripting 执行宿主共享，并实测实际 TTF 在 App Store 分享意图 WebView 能否加载；本地静态检查不能替代宿主验证。

## 环境限制（重要）
- 设备上 `node` 是 Scripting shim：`scripting-ts eval` 无 fs 读写权限、stdin 不可用（readFileSync(0) ENOENT）；`require()` 只加载 CJS
- 测 HTML 解析的可行方案：awk 把 HTML 转成内联转义字符串数组生成 .cjs 测试脚本再 `node` 运行
- `scripting-ts run <file> --timeout N` 在本环境实测可用（2026-10-18 跑通翻译回归）；不带超时仍可能挂起。`scripting-ts eval` 无 fs 读写权限、stdin 不可用（readFileSync(0) ENOENT）；`require()` 只加载 CJS
- shell 无 `printf`；复杂引号命令会损坏 → awk 脚本一律写文件用 `-f`；stdout 常为空 → 重定向到文件再读
- TypeScript 诊断现有 5 个历史遗留错误（`Dialog` 不存在于 scripting 模块 ×3、intent.tsx 比较类型、translation-card.tsx ShapeStyle），与 pricing/region-prices 无关

## 维护性审查（2026-10-31）
- 已删死代码：`core/screen-job.ts` activeScreenTranslation、`core/translation-snapshot.ts` snapshotCoversTargets、`core/github.ts` 对 parseGitHubReleaseURLFromValue 的无效转发、LinkBadgeButton 无效 grayBackground prop（含 app-store 调用点）、screen-result 未用 RoundedRectangle 导入、font-menu 多余 export、根目录全部 `__*` 临时扫描/预览文件与 core/linkedom.cjs
- 已修 bug：github-page.ts 图片 alt 正则 `\\\\s`→`\\s`（空白归一与超长过滤此前完全失效）；screen-ocr.ts 单切片 Vision 原生错误此前被静默吞掉（去掉 `slices.length > 1` 门槛）；translate.ts 超长行缓存引擎标签硬编码 google（现透传 onEngineResolved 真实引擎）；translation-card.tsx 紧凑卡 TTS key 全局撞车（加 props.id）；anim-text.tsx useMemo 依赖漏 font 等样式 prop（改为不用 memo）
- 未动（有意保留）：truncated 残留字段（牵连 tests 断言）、仅 tests 引用的 fetchPriceHistory/parseAppRavenCookieHeader、GlassBadge 未消费的 background/hideBorder 与 success/rose/purple token、fnv1a 两份重复与头像提取两份实现（合并收益低）
