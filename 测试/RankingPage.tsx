import {
  Button, HStack, Image, List, NavigationStack, ProgressView, Rectangle,
  Script, ScrollView, Spacer, Text, TextField, VStack, ZStack, useEffect, useMemo, useRef, useState,
} from "scripting"
import { identifyBrand } from "./brands"
import { flattenModels, loadProviders, onBuiltinFlags, probeBuiltinFlags } from "./providers"
import { scoreOf } from "./scoring"
import { useDetection } from "./useDetection"
import type { InitialRecords } from "./useDetection"
import type { Model, Phase } from "./types"

const INK = "#282828"
const GREEN = "#24A66A"
const RED = "#DB5359"
const MUTED = "#BDBDBD"
const PAPER = "#FFFFFF"
const RULE = "#ECECEB"

// 检测中的卡片按“右→下→左→上”极小幅缓慢循环摆动（幅度约 1pt），奇偶行方向相反，揭晓后归位。
const SWAY_STEPS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }]
const SWAY_INTERVAL = 520
// 打分（检测中）时行背景在淡红 / 淡绿之间交替，出结果定格为对应淡色。
const BLINK_INTERVAL = 650
// 整段红绿交替效果的总时长（毫秒）：只在检测开始后的这段时间内交替，之后归于白底静默等结果，
// 不是整轮检测期间一直红绿来回（每次换色的间隔保持不变，不加快来回闪动）。
const BLINK_TOTAL = 2000
// 出结果定格闪光的时长：合格的绿色拉长为“弹窗”般的一下（分数同步放大停住，再缩放回去），失败红保持较短。
const FLASH_HOLD_OK = 1200
const FLASH_HOLD_FAIL = 450
// 打分时右侧分数位的滚动间隔（单位毫秒），放慢后更柔和。
const ROLL_INTERVAL = 280

type Sort = "scoreDown" | "scoreUp" | "nameUp" | "nameDown"
export type PageProps = {
  models?: Model[]
  records?: InitialRecords
  logoDirectory?: string
  initialGroup?: string
  initialQuery?: string
  initialSelected?: string[]
  initialSort?: Sort
  // 预览/外部调用用：进入页面时就处于两列并排状态。
  initialSideBySide?: boolean
  previewPhases?: Record<string, Phase>
}

function StatusBar({ phase }: { phase: Phase }) {
  const [pulse, setPulse] = useState(false)
  useEffect(() => {
    if (phase !== "checking") { setPulse(false); return }
    let timer: ReturnType<typeof setTimeout>
    let alive = true
    const tick = () => {
      if (!alive) return
      setPulse(v => !v)
      timer = setTimeout(tick, 700)
    }
    timer = setTimeout(tick, 100)
    return () => { alive = false; clearTimeout(timer) }
  }, [phase])
  const color = phase === "ok" || phase === "checking" ? GREEN : phase === "fail" ? RED : MUTED
  return <ZStack alignment="leading" frame={{ width: 46, height: 6 }} clipShape={{ type: "rect", cornerRadius: 3 }} accessibilityHidden>
    <Rectangle fill={color} opacity={0.14} />
    <Rectangle
      fill={color}
      frame={{ width: phase === "checking" ? 16 : phase === "queued" ? 10 : 46, height: 6 }}
      clipShape={{ type: "rect", cornerRadius: 3 }}
      offset={{ x: phase === "checking" && pulse ? 22 : 0, y: 0 }}
      opacity={phase === "queued" ? 0.4 : 0.7}
      animation={{ animation: Animation.smooth({ duration: 0.65 }), value: `${phase}/${pulse}` }}
    />
  </ZStack>
}

function ModelRow({ model, value, phase, failure, logoDirectory, action, flip }: {
  model: Model; value: number | null; phase: Phase; failure?: string; logoDirectory: string; action: () => void; flip?: boolean
}) {
  const brand = identifyBrand(model.id, model.builtin && typeof model.provider === "string" ? model.provider : undefined)
  const logo = useMemo(() => brand.logo ? UIImage.fromFile(`${logoDirectory}/${brand.logo.split("/").pop()}`) : null, [brand.logo, logoDirectory])
  const [flash, setFlash] = useState(false)
  const previous = useRef(phase)
  useEffect(() => {
    const finished = previous.current === "checking" && (phase === "ok" || phase === "fail")
    previous.current = phase
    if (!finished) { setFlash(false); return }
    setFlash(true)
    const timer = setTimeout(() => setFlash(false), phase === "ok" ? FLASH_HOLD_OK : FLASH_HOLD_FAIL)
    return () => clearTimeout(timer)
  }, [phase])
  // 检测中/等待中的卡片快速循环摆动（约 0.16 秒一步，反复循环），结果揭晓立刻归位。
  const [swayIndex, setSwayIndex] = useState(-1)
  useEffect(() => {
    const active = phase === "checking" || phase === "queued"
    if (!active) { setSwayIndex(-1); return }
    let alive = true
    let index = -1
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      if (!alive) return
      index = (index + 1) % SWAY_STEPS.length
      setSwayIndex(index)
      timer = setTimeout(tick, SWAY_INTERVAL)
    }
    timer = setTimeout(tick, 40)
    return () => { alive = false; clearTimeout(timer); setSwayIndex(-1) }
  }, [phase])
  const base = swayIndex < 0 ? { x: 0, y: 0 } : SWAY_STEPS[swayIndex]
  // 奇偶行方向相反：偶数行右→下→左→上，奇数行左→上→右→下，像心跳一样一收一放。
  const sway = flip ? { x: -base.x, y: -base.y } : base
  // 打分时红绿交替（0.65 秒一换），但整段交替效果只持续 BLINK_TOTAL（约 2 秒），到点即停、归于白底；
  // 出结果那一刻定格：成功绿拉长闪光、失败红较短。
  // 脚本环境不支持 8 位带透明度色值，闪底用白底调出的淡红 #FDF5F5 / 淡绿 #F2FAF6（约 6% 淡度，柔和仍可辨），
  // 揭晓定格用更深的 #FDE8EA / #DCF5E7，让结果色一眼可辨。
  const [blink, setBlink] = useState(false)
  useEffect(() => {
    if (phase !== "checking") { setBlink(false); return }
    let alive = true
    let elapsed = 0
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      if (!alive) return
      elapsed += BLINK_INTERVAL
      if (elapsed > BLINK_TOTAL) { setBlink(false); return }
      setBlink(value => !value)
      timer = setTimeout(tick, BLINK_INTERVAL)
    }
    timer = setTimeout(tick, 60)
    return () => { alive = false; clearTimeout(timer); setBlink(false) }
  }, [phase])
  // 打分时分数位滚动 1—100 的随机数字（0.09 秒一跳），替代圆形加载指示，
  // 让“测速中”在分数位也有动态；出结果后由下面的 count-up 接手。
  const [roll, setRoll] = useState(() => 1 + Math.floor(Math.random() * 100))
  useEffect(() => {
    if (phase !== "checking") return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      if (!alive) return
      setRoll(1 + Math.floor(Math.random() * 100))
      timer = setTimeout(tick, ROLL_INTERVAL)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [phase])
  // 揭晓时从低约 30 分用 0.4 秒快速数到真实分数，避免结果“砰”地一下直接蹦出来。
  const [settle, setSettle] = useState<number | null>(null)
  useEffect(() => {
    if (phase !== "ok" && phase !== "fail") { setSettle(null); return }
    if (value === null || value <= 30) { setSettle(null); return }
    const target = value
    const step = Math.max(1, Math.ceil(30 / 12))
    let alive = true
    let current = Math.max(1, target - 30)
    let timer: ReturnType<typeof setTimeout>
    setSettle(current)
    const tick = () => {
      if (!alive) return
      current = Math.min(target, current + step)
      setSettle(current)
      if (current < target) timer = setTimeout(tick, 26)
      else timer = setTimeout(() => { if (alive) setSettle(null) }, 80)
    }
    timer = setTimeout(tick, 60)
    return () => { alive = false; clearTimeout(timer); setSettle(null) }
  }, [phase, value])
  const checking = phase === "checking"
  const failed = phase === "fail"
  const scoreColor = phase === "ok" ? GREEN : phase === "fail" ? RED : INK
  const tint = checking ? (blink ? "#FDF5F5" : "#F2FAF6") : flash ? (phase === "fail" ? "#FDE8EA" : "#DCF5E7") : PAPER
  const status = checking ? "检测中" : phase === "queued" ? "等待中" : phase === "ok" ? "成功" : phase === "fail" ? "失败" : "未检测"
  const label = `${model.id}，${brand.name}，${model.group}，${status}，${value === null ? "暂无分数" : `${value}分`}`
  // 失败时把应用返回的真实原因显示出来，配置类问题（未选模型、缺 key）一眼可见。
  const detail = checking ? " · 检测中" : phase === "queued" ? " · 等待中" : failed ? ` · ${failure ?? "失败"}` : ""
  const subtitle = `${brand.name} · ${model.group}${detail}`
  // 图标与行内其余部分是两个并列的透明按钮，外观与原版完全一致：
  // 轻点图标即可只测这一个模型，点行内其它位置同样重测。
  // 检测完成那一刻整张卡片（含底色）变大弹出，与定格闪光一起停住，闪光结束再弹簧缩回去；
  // 缩放放在外层容器，底色/摆动仍在内层，两种动画互不干扰。
  return <HStack spacing={0} frame={{ height: 84, maxWidth: "infinity" }}
    scaleEffect={flash ? 1.06 : 1}
    animation={{ animation: Animation.spring({ duration: 0.35, bounce: 0.3 }), value: String(flash) }}>
    <HStack spacing={11} padding={{ horizontal: 17 }} frame={{ height: 84, maxWidth: "infinity" }} background={tint}
      offset={{ x: sway.x, y: sway.y }}
      animation={{ animation: Animation.smooth({ duration: 0.1 }), value: `${tint}/${sway.x}/${sway.y}` }}>
      <Button action={action} buttonStyle="plain" accessibilityLabel={`${label}，轻点图标单独检测`}>
        {logo
          ? <Image image={logo} resizable scaleToFit frame={{ width: 24, height: 25 }} />
          : <Image systemName="sparkles" foregroundStyle="#080808" font={22} frame={{ width: 24, height: 25 }} />}
      </Button>
      <Button action={action} buttonStyle="plain" accessibilityLabel={`${label}，轻点重新检测`} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={11} frame={{ maxWidth: "infinity" }}>
          <VStack alignment="leading" spacing={5} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={{ name: "Menlo-Regular", size: 17 }} fontWeight="regular" foregroundStyle={INK} lineLimit={1} minScaleFactor={0.76} truncationMode="middle" frame={{ maxWidth: "infinity", alignment: "leading" }}>{model.id}</Text>
            <Text font={14} foregroundStyle={failed ? "#B23A2E" : "#555555"} lineLimit={1} truncationMode="tail" frame={{ maxWidth: "infinity", alignment: "leading" }}>{subtitle}</Text>
          </VStack>
          <VStack alignment="trailing" spacing={9} frame={{ width: 52, alignment: "trailing" }}>
            <ZStack alignment="trailing" frame={{ width: 52, height: 25 }}>
              <Text font={{ name: "Menlo-Regular", size: 21 }} fontWeight="semibold" foregroundStyle={checking ? "#888888" : scoreColor} lineLimit={1} frame={{ maxWidth: "infinity", alignment: "trailing" }} contentTransition="numericText" scaleEffect={flash ? 1.16 : 1} animation={{ animation: Animation.spring({ duration: 0.3, bounce: 0.25 }), value: `${value}/${phase}/${flash}` }}>{checking ? String(roll) : (settle !== null ? String(settle) : (value === null ? "—" : String(value)))}</Text>
            </ZStack>
            <StatusBar phase={phase} />
          </VStack>
        </HStack>
      </Button>
    </HStack>
  </HStack>
}

function IconButton({ name, label, action, disabled = false }: { name: string; label: string; action: () => void; disabled?: boolean }) {
  return <Button action={action} buttonStyle="plain" disabled={disabled} accessibilityLabel={label}>
    <Image systemName={name} font={19} foregroundStyle={disabled ? MUTED : INK} contentTransition="symbolEffectReplace" animation={{ animation: Animation.easeOut(0.25), value: name }} frame={{ width: 34, height: 40 }} />
  </Button>
}

export default function RankingPage(props: PageProps = {}) {
  const [models, setModels] = useState(() => props.models ?? flattenModels(loadProviders()))
  const detection = useDetection(models, props.records)
  const [group, setGroup] = useState(props.initialGroup ?? "")
  const [query, setQuery] = useState(props.initialQuery ?? "")
  const [search, setSearch] = useState(Boolean(props.initialQuery))
  const [sort, setSort] = useState<Sort>(props.initialSort ?? "scoreDown")
  const [now, setNow] = useState(Date.now())
  // 长按分组标签多选：选中的分组同时出现在列表中，便于横向比对、一次性一起测。
 const [selected, setSelected] = useState<string[]>(props.initialSelected ?? [])
  const selecting = selected.length > 0
  // 长按“All On”切换下面的模型是否并排（两列）：卡片样式完全不变，只缩窄尺寸。
  const [sideBySide, setSideBySide] = useState(props.initialSideBySide ?? false)
  // 长按和点按的手势识别存在竞争：长按刚触发后紧跟的一次 tap 直接忽略，
  // 否则“长按选中”会被随后的 tap 清掉，表现为长按无效。
  const lastToggle = useRef(0)
  const groups = [...new Set(models.map(m => m.group))]
  const logoDirectory = props.logoDirectory ?? Script.directory + "/assets/logos"

  function refresh() {
    if (props.models) return
    const next = flattenModels(loadProviders())
    setModels(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
    setGroup(prev => next.some(m => m.group === prev) ? prev : "")
    setSelected(prev => prev.filter(name => next.some(m => m.group === name)))
  }

  // 单击：切到单一分组（并退出多选；轻点“All On”本身就清空多选）。长按：把该分组加入/移出多选。
  // 长按“All On”不进多选，改为让下面的模型卡片并排（两列）/恢复单列，顶部不新增按钮。
  function pick(item: string) {
    if (Date.now() - lastToggle.current < 700) return
    setSelected([])
    setGroup(item)
  }

  function toggle(item: string) {
    lastToggle.current = Date.now()
    setSelected(prev => {
      if (!item) return []
      const next = prev.includes(item) ? prev.filter(name => name !== item) : [...prev, item]
      if (next.length) setGroup("")
      return next
    })
  }

  // 长按“All On”：卡片本身不改样式，只是把它们缩窄、左右并排；再长按恢复单列。
  // 与多选长按一样，用 lastToggle 屏蔽长按后紧跟的那次 tap，否则刚切完就被点回去。
  function toggleSideBySide() {
    lastToggle.current = Date.now()
    setSideBySide(prev => !prev)
  }

  // 内置渠道是否已添加要在首屏之后才探明；探明后立刻补上分组与模型。
  useEffect(() => {
    const off = onBuiltinFlags(() => refresh())
    void probeBuiltinFlags().then(refresh)
    return off
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      setNow(Date.now())
      refresh()
      timer = setTimeout(tick, 5000)
    }
    timer = setTimeout(tick, 5000)
    return () => clearTimeout(timer)
  }, [])

  const matching = models.filter(m => {
    if (selecting ? !selected.includes(m.group) : group && m.group !== group) return false
    const brand = identifyBrand(m.id, m.builtin && typeof m.provider === "string" ? m.provider : undefined)
    const text = `${m.id} ${m.group} ${brand.name}`.toLowerCase()
    return !query.trim() || text.includes(query.trim().toLowerCase())
  })
  const scores = Object.fromEntries(models.map(m => [m.key, scoreOf(m.key, detection.history, now, detection.results[m.key])]))
  // 分组顺序与顶部标签一致（Workbuddy、lfree、kcne…），Model 排序按“先分组、组内再按名称”，
  // 这样点一下 Model 就能恢复“每个分组的模型挨在一起”的视图，而不是把各组模型按名称打散。
  const groupIndex = Object.fromEntries(groups.map((name, index) => [name, index]))
  const sorted = [...matching].sort((a, b) => {
    if (sort === "nameUp" || sort === "nameDown") {
      const dir = sort === "nameUp" ? 1 : -1
      const delta = (groupIndex[a.group] ?? 99) - (groupIndex[b.group] ?? 99)
      return dir * (delta || a.id.localeCompare(b.id))
    }
    const av = scores[a.key]?.value
    const bv = scores[b.key]?.value
    if (av == null && bv != null) return 1
    if (bv == null && av != null) return -1
    const delta = (av ?? 0) - (bv ?? 0)
    if (delta) return (sort === "scoreDown" ? -1 : 1) * delta
    return (detection.results[a.key]?.ms ?? Infinity) - (detection.results[b.key]?.ms ?? Infinity) || a.id.localeCompare(b.id) || a.group.localeCompare(b.group)
  })

  // 每个结果落地就立刻按最新分数重排：行随分数上下移动，像行情列表一样跳动。
  const displayed = sorted

  function run(targets: Model[]) {
    void detection.start(targets)
  }

  // 一张模型卡片：并排与单列共用同一段，卡片样式（图标、字体、分数列、状态条）不因布局改变。
  // flip 按全局序号奇偶取反，让相邻行摆动方向相反，像心跳一样一收一放。
  function card(model: Model, index: number) {
    const score = scores[model.key]
    const phase = props.previewPhases?.[model.key] ?? detection.phases[model.key] ?? (score?.stale ? "idle" : score ? (score.ok ? "ok" : "fail") : "idle")
    return <ModelRow key={model.key} model={model} value={score?.value ?? null} phase={phase} failure={detection.errors[model.key]} logoDirectory={logoDirectory} flip={index % 2 === 1} action={() => { if (!detection.running) run([model]) }} />
  }

  // 并排模式把模型两个一组放进同一行（各占一半宽），单列模式仍是一行一个。
  const rows: Model[][] = []
  if (sideBySide) {
    for (let i = 0; i < displayed.length; i += 2) rows.push(displayed.slice(i, i + 2))
  } else {
    displayed.forEach(model => rows.push([model]))
  }

  return <NavigationStack>
    <VStack spacing={0} navigationBarVisibility="hidden" background={PAPER} preferredColorScheme="light">
      <HStack spacing={4} padding={{ leading: 12, trailing: 10, vertical: 5 }} background="#FAF9F7">
        <ScrollView axes="horizontal" scrollIndicator="hidden">
          <HStack spacing={4}>
            {["", ...groups].map(item => {
              const chosen = selecting ? selected.includes(item) : group === item
              // 多选：浅粉底 + 加粗，不加 ✓，不改字色（脚本环境不支持 8 位带透明度的色值，
              // 所以用接近“透明红粉”的浅粉实色）；单选：沿用原来的米色底。
              return <Text
                key={item || "all"}
                font={15}
                fontWeight={chosen ? "semibold" : "regular"}
                foregroundStyle={INK}
                lineLimit={1}
                padding={{ horizontal: 13, vertical: 9 }}
                background={chosen ? (selecting ? "#F9D8DC" : "#EFEBE5") : "clear"}
                clipShape={{ type: "rect", cornerRadius: 9 }}
                accessibilityLabel={item ? `分组 ${item}${chosen ? "，已选中" : ""}，轻点单选，长按多选` : `All On${chosen ? "，已选中" : ""}，轻点单选，长按${sideBySide ? "恢复单列" : "并排显示"}`}
                onTapGesture={() => pick(item)}
                onLongPressGesture={{ minDuration: 400, perform: () => item ? toggle(item) : toggleSideBySide() }}
              >{item || "All On"}</Text>
            })}
          </HStack>
        </ScrollView>
        <Rectangle fill="#D9D8D5" frame={{ width: 1, height: 22 }} />
        <IconButton name={search ? "xmark" : "magnifyingglass"} label="搜索模型或分组" action={() => { setSearch(!search); if (search) setQuery("") }} />
        <IconButton name={detection.running ? "stop.fill" : "play.fill"} label={detection.running ? "停止检测" : "检测当前列表"} disabled={!detection.running && !matching.length} action={() => detection.running ? detection.stop() : run(sorted)} />
      </HStack>
      {search ? <HStack padding={{ horizontal: 18, vertical: 9 }}>
        <TextField title="" value={query} onChanged={setQuery} prompt="Model / Group" autocorrectionDisabled textInputAutocapitalization="never" font={15} />
      </HStack> : null}
      <Rectangle fill={RULE} frame={{ height: 1 }} />
      <HStack spacing={5} padding={{ leading: 52, trailing: 17 }} frame={{ height: 48 }}>
        <Button action={() => setSort(sort === "nameDown" ? "scoreDown" : sort === "nameUp" ? "nameDown" : "nameUp")} buttonStyle="plain">
          <HStack spacing={7}>
            <Text font={15} fontWeight="semibold" foregroundStyle={INK}>Model</Text>
            <Image systemName={sort === "nameUp" ? "arrow.up" : sort === "nameDown" ? "arrow.down" : "chevron.up.chevron.down"} font={11} foregroundStyle="#888888" />
          </HStack>
        </Button>
        <Spacer />
        <Button action={() => setSort(sort === "scoreDown" ? "scoreUp" : "scoreDown")} buttonStyle="plain">
          <HStack spacing={6}>
            <Text font={15} fontWeight="semibold" foregroundStyle={INK}>Score</Text>
            <Image systemName={sort === "scoreUp" ? "arrow.up" : "arrow.down"} font={16} foregroundStyle={INK} />
          </HStack>
        </Button>
      </HStack>
      <Rectangle fill={RULE} frame={{ height: 1 }} />
      {detection.progress.total > 0 ? <VStack spacing={7} padding={{ horizontal: 18, vertical: 10 }} background="#FAFCFA">
        <HStack>
          <Text font={12} foregroundStyle={detection.running ? GREEN : "#777777"}>{detection.running ? "正在检测" : detection.progress.done === detection.progress.total ? "检测完成" : "已停止"}</Text>
          <Spacer />
          <Text font={12} fontDesign="monospaced" foregroundStyle={INK} contentTransition="numericText" animation={{ animation: Animation.easeOut(0.2), value: detection.progress.done }}>{detection.progress.done} / {detection.progress.total}</Text>
        </HStack>
        <ProgressView value={detection.progress.done} total={detection.progress.total} progressViewStyle="linear" tint={GREEN} animation={{ animation: Animation.easeOut(0.25), value: detection.progress.done }} />
      </VStack> : null}
      {detection.error ? <Text font={12} foregroundStyle={RED} padding={{ horizontal: 18, vertical: 8 }}>{detection.error}</Text> : null}
      <List listStyle="plain" scrollContentBackground="hidden" background={PAPER} animation={{ animation: Animation.spring({ duration: 0.3, bounce: 0.35 }), value: displayed.map(m => m.key).join("|") }}>
        {rows.map((row, rowIndex) => {
          // 并排时一行两张卡，中间一条细分隔线；只剩一张时右侧留白，保持两列宽度一致。
          const base = sideBySide ? rowIndex * 2 : rowIndex
          return <VStack key={row.map(model => model.key).join("+")} spacing={0} listRowInsets={{ top: 0, leading: 0, bottom: 0, trailing: 0 }} listRowSeparator="hidden" listRowBackground={<Rectangle fill={PAPER} />}>
            <HStack spacing={0}>
              {card(row[0], base)}
              {row[1] ? <Rectangle fill={RULE} frame={{ width: 1, height: 84 }} /> : null}
              {row[1] ? card(row[1], base + 1) : sideBySide ? <Rectangle fill={PAPER} frame={{ height: 84, maxWidth: "infinity" }} /> : null}
            </HStack>
            <Rectangle fill={RULE} frame={{ height: 1 }} />
          </VStack>
        })}
        {!displayed.length ? <Text font={15} foregroundStyle="#999999" padding={{ vertical: 28 }} frame={{ maxWidth: "infinity" }} listRowSeparator="hidden">{models.length ? "没有匹配的模型" : "暂无已添加的模型，请先在 Scripting 中添加"}</Text> : null}
      </List>
    </VStack>
  </NavigationStack>
}
