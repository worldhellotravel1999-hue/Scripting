import { Button, Circle, Ellipse, HStack, Image, Rectangle, RoundedRectangle, Text, VStack, ZStack, useState } from "scripting"

const SIZE = 42
const FILL: any = { light: "rgba(30,30,32,0.55)", dark: "rgba(30,30,32,0.55)" }
const STROKE: any = { light: "rgba(255,255,255,0.22)", dark: "rgba(255,255,255,0.16)" }

function shell(icon: any, label: string) {
  return (
    <ZStack frame={{ width: SIZE, height: SIZE }} contentShape="circle" accessibilityLabel={label}>
      <Circle fill={FILL} frame={{ width: SIZE, height: SIZE }} />
      <Circle stroke={{ shapeStyle: STROKE, strokeStyle: { lineWidth: 0.5 } }} frame={{ width: SIZE, height: SIZE }} />
      {icon}
    </ZStack>
  )
}

function circle(systemName: string, label: string) {
  return shell(<Image systemName={systemName} font={24} foregroundStyle="white" />, label)
}

function moreGlyph() {
  const box = 24
  const dot = box * 0.26
  const gap = box * 0.1
  return shell(
    <ZStack frame={{ width: box, height: box }}>
      <RoundedRectangle stroke={{ shapeStyle: "white", strokeStyle: { lineWidth: box * 0.07 } }} cornerRadius={box * 0.24} frame={{ width: box, height: box }} />
      <VStack spacing={gap}>
        <HStack spacing={gap}>
          <Circle fill="white" frame={{ width: dot, height: dot }} />
          <Circle fill="white" frame={{ width: dot, height: dot }} />
        </HStack>
        <HStack spacing={gap}>
          <Circle fill="white" frame={{ width: dot, height: dot }} />
          <Circle fill="white" frame={{ width: dot, height: dot }} />
        </HStack>
      </VStack>
    </ZStack>,
    "more",
  )
}

function translationGlobe(char: string) {
  const box = 24
  const globe = box * 5 / 6
  const badge = box / 2
  return shell(
    <ZStack frame={{ width: box, height: box }}>
      <ZStack frame={{ width: globe, height: globe }}>
        <Circle stroke={{ shapeStyle: "white", strokeStyle: { lineWidth: 1.3 } }} frame={{ width: globe, height: globe }} />
        <Ellipse stroke={{ shapeStyle: "white", strokeStyle: { lineWidth: 0.9 } }} frame={{ width: globe * 0.44, height: globe }} />
        <Rectangle fill="white" frame={{ width: globe * 0.88, height: 1 }} />
      </ZStack>
      <ZStack frame={{ width: badge, height: badge }} offset={{ x: box / 4, y: box / 4 }}>
        <Circle fill="rgba(30,30,32,0.96)" frame={{ width: badge, height: badge }} />
        <Circle fill="white" frame={{ width: badge * 5 / 6, height: badge * 5 / 6 }} />
        <Text font={7.5} fontWeight="bold" foregroundStyle="#1E1E20">{char}</Text>
      </ZStack>
    </ZStack>,
    "mode",
  )
}

export default function Preview() {
  const [open, setOpen] = useState(true)
  const entries = [
    { key: "share", node: circle("square.and.arrow.up", "share") },
    { key: "retry", node: circle("arrow.clockwise", "retry") },
    { key: "mode", node: translationGlobe("A") },
  ]
  return (
    <ZStack background={{ light: "#FFFFFF", dark: "#0D1117" }} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <Text font="title" fontWeight="bold" foregroundStyle="secondaryLabel" padding={{ top: 60 }}>GitHub Release</Text>
      <VStack
        alignment="trailing"
        spacing={10}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomTrailing" as any }}
        padding={{ trailing: 14, bottom: 14 }}
      >
        <HStack spacing={8} padding={{ horizontal: 14, vertical: 8 }} background={{ style: { light: "rgba(255,255,255,0.94)", dark: "rgba(28,28,30,0.94)" }, shape: "capsule" }} clipShape="capsule" shadow={{ color: "rgba(0,0,0,0.14)", radius: 10, y: 3 }}>
          <Text font="caption" foregroundStyle="secondaryLabel">Translating release notes…</Text>
        </HStack>
        <VStack spacing={8} alignment="center">
          {open ? entries.map((entry, index) => (
            <Button key={entry.key} buttonStyle="plain" action={() => {}} transition={Transition.asymmetric(
              Transition.scale(0.1, "bottom").combined(Transition.opacity()).animation(Animation.bouncy({ duration: 0.42, extraBounce: 0.32 }).delay(index * 0.055)),
              Transition.scale(0.1, "bottom").combined(Transition.opacity()).animation(Animation.easeIn(0.16)),
            )}>{entry.node}</Button>
          )) : null}
          <Button buttonStyle="plain" action={() => setOpen(v => !v)}>
            {open ? circle("xmark", "more") : moreGlyph()}
          </Button>
        </VStack>
      </VStack>
    </ZStack>
  )
}
