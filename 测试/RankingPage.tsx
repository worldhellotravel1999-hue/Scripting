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

type Sort = "scoreDown" | "scoreUp" | "nameUp" | "nameDown"
export type PageProps = {
  models?: Model[]
  records?: InitialRecords
  logoDirectory?: string
  initialGroup?: string
  initialQuery?: string
  initialSelected?: string[]
  initialSort?: Sort
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
      timer = setTimeout(tick, 650)
    }
    timer = setTimeout(tick, 30)
    return () => { alive = false; clearTimeout(timer) }
  }, [phase])
  const color = phase === "ok" || phase === "checking" ? GREEN : phase === "fail" ? RED : MUTED
  return <ZStack alignment="leading" frame={{ width: 46, height: 6 }} clipShape={{ type: "rect", cornerRadius: 3 }} accessibilityHidden>
    <Rectangle fill={color} opacity={0.16} />
    <Rectangle
      fill={color}
      frame={{ width: phase === "checking" ? 16 : phase === "queued" ? 10 : 46, height: 6 }}
      clipShape={{ type: "rect", cornerRadius: 3 }}
      offset={{ x: phase === "checking" && pulse ? 30 : 0, y: 0 }}
      opacity={phase === "queued" ? 0.45 : 1}
      animation={{ animation: Animation.easeIn(0.6), value: `${phase}/${pulse}` }}
    />
  </ZStack>
}

function ModelRow({ model, value, phase, failure, logoDirectory, action }: {
  model: Model; value: number | null; phase: Phase; failure?: string; logoDirectory: string; action: () => void
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
    const timer = setTimeout(() => setFlash(false), 750)
    return () => clearTimeout(timer)
  }, [phase])
  const checking = phase === "checking"
  const failed = phase === "fail"
  const scoreColor = phase === "ok" ? GREEN : phase === "fail" ? RED : INK
  const tint = checking ? "#F0FAF5" : flash ? (phase === "fail" ? "#FDE8EA" : "#DCF5E7") : PAPER
  const status = checking ? "检测中" : phase === "queued" ? "等待中" : phase === "ok" ? "成功" : phase === "fail" ? "失败" : "未检测"
  const label = `${model.id}，${brand.name}，${model.group}，${status}，${value === null ? "暂无分数" : `${value}分`}`
  // 失败时把应用返回的真实原因显示出来，配置类问题（未选模型、缺 key）一眼可见。
  const detail = checking ? " · 检测中" : phase === "queued" ? " · 等待中" : failed ? ` · ${failure ?? "失败"}` : ""
  const subtitle = `${brand.name} · ${model.group}${detail}`
  // 图标与行内其余部分是两个并列的透明按钮，外观与原版完全一致：
  // 轻点图标即可只测这一个模型，点行内其它位置同样重测。
  return <HStack spacing={11} padding={{ horizontal: 17 }} frame={{ height: 84, maxWidth: "infinity" }} background={tint} animation={{ animation: Animation.easeOut(0.45), value: tint }}>
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
            <Text font={{ name: "Menlo-Regular", size: 21 }} fontWeight="semibold" foregroundStyle={scoreColor} lineLimit={1} frame={{ maxWidth: "infinity", alignment: "trailing" }} contentTransition="numericText" opacity={checking ? 0 : 1} scaleEffect={flash ? 1.16 : 1} animation={{ animation: Animation.spring({ duration: 0.55, bounce: 0.25 }), value: `${value}/${phase}/${flash}` }}>{value === null ? "—" : String(value)}</Text>
            {checking ? <ProgressView progressViewStyle="circular" tint={GREEN} frame={{ width: 26, height: 24 }} /> : null}
          </ZStack>
          <StatusBar phase={phase} />
        </VStack>
      </HStack>
    </Button>
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

  // 单击：切到单一分组（并退出多选）。长按：把该分组加入/移出多选。
  // 长按“All On”直接清空多选。包括内置分组在内，每个标签都支持长按。
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
                accessibilityLabel={`分组 ${item || "All On"}${chosen ? "，已选中" : ""}，轻点单选，长按多选`}
                onTapGesture={() => pick(item)}
                onLongPressGesture={{ minDuration: 400, perform: () => toggle(item) }}
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
          <Text font={12} fontDesign="monospaced" foregroundStyle={INK} contentTransition="numericText" animation={{ animation: Animation.easeOut(0.3), value: detection.progress.done }}>{detection.progress.done} / {detection.progress.total}</Text>
        </HStack>
        <ProgressView value={detection.progress.done} total={detection.progress.total} progressViewStyle="linear" tint={GREEN} animation={{ animation: Animation.easeOut(0.4), value: detection.progress.done }} />
      </VStack> : null}
      {detection.error ? <Text font={12} foregroundStyle={RED} padding={{ horizontal: 18, vertical: 8 }}>{detection.error}</Text> : null}
      <List listStyle="plain" scrollContentBackground="hidden" background={PAPER} animation={{ animation: Animation.spring({ duration: 0.6, bounce: 0.35 }), value: displayed.map(m => m.key).join("|") }}>
        {displayed.map(model => {
          const score = scores[model.key]
          const phase = props.previewPhases?.[model.key] ?? detection.phases[model.key] ?? (score?.stale ? "idle" : score ? (score.ok ? "ok" : "fail") : "idle")
          return <VStack key={model.key} spacing={0} listRowInsets={{ top: 0, leading: 0, bottom: 0, trailing: 0 }} listRowSeparator="hidden" listRowBackground={<Rectangle fill={PAPER} />}>
            <ModelRow key={model.key} model={model} value={score?.value ?? null} phase={phase} failure={detection.errors[model.key]} logoDirectory={logoDirectory} action={() => { if (!detection.running) run([model]) }} />
            <Rectangle fill={RULE} frame={{ height: 1 }} />
          </VStack>
        })}
        {!displayed.length ? <Text font={15} foregroundStyle="#999999" padding={{ vertical: 28 }} frame={{ maxWidth: "infinity" }} listRowSeparator="hidden">{models.length ? "没有匹配的模型" : "暂无已添加的模型，请先在 Scripting 中添加"}</Text> : null}
      </List>
    </VStack>
  </NavigationStack>
}
