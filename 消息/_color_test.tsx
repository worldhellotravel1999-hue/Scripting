// 临时：对照测试 DonutChart 设色方式
// ⚠️ 2026-10-06 实测：B 方案（chartForegroundStyleScale）会整个闪退 Scripting App
//    （SIGTRAP in ModifierFactory.ChartForegroundStyleScaleModifier.body，ScriptingKit 内部
//    字典查表失败后的强制断言 trap，是宿主 bug）。B 已删除，只留 A（mark.foregroundStyle）。
import { Chart, DonutChart, HStack, Text, VStack } from "scripting"

const rows = [
  { name: "A", v: 320, c: "#FF0000" },
  { name: "B", v: 180, c: "#0000FF" },
  { name: "C", v: 95, c: "#00AA00" },
  { name: "D", v: 60, c: "#FF8800" },
]

const marksA = rows.map(r => ({
  category: r.name,
  value: r.v,
  innerRadius: { type: "ratio" as const, value: 0.66 },
  angularInset: 2,
  foregroundStyle: r.c,
}))

function Legend({ colors }: { colors: string[] }) {
  return (
    <VStack alignment="leading" spacing={6}>
      {rows.map((r, i) => (
        <HStack key={r.name} spacing={6}>
          <Text font="caption2">{r.name}</Text>
          <Text font="caption2" foregroundStyle={colors[i]}>
            {colors[i]}
          </Text>
        </HStack>
      ))}
    </VStack>
  )
}

export default function ColorTest() {
  return (
    <VStack
      alignment="leading"
      spacing={12}
      padding={16}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "leading" }}
      background="#FFFFFF"
    >
      <Text font="headline">A: mark.foregroundStyle（B 方案已禁用，见文件头注释）</Text>
      <HStack spacing={12}>
        <Chart chartLegend="hidden" chartXAxis="hidden" chartYAxis="hidden" frame={{ width: 150, height: 150 }}>
          <DonutChart marks={marksA} />
        </Chart>
        <Legend colors={rows.map(r => r.c)} />
      </HStack>
    </VStack>
  )
}
