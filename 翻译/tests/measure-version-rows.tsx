// 版本弹层尺寸标定脚本：用 ImageRenderer 实测「版本行 / 加载态 / 失败态」的真实高度，
// 供 views/version-history.tsx 的 VERSION_ROW_HEIGHT / STATUS_ROW_HEIGHT 常量校核。
// 实测（iPhone 16 Pro Max / iOS 26）：版本行 44.33pt（17pt 单行 20.33 + 上下 12pt 内边距），
// 取 44.5 留亚像素余量；加载态 52.0pt、失败态 52.67pt，取 53 避免裁切。
// 运行：scripting-ts run tests/measure-version-rows.tsx
import { Button, HStack, ImageRenderer, Image, Menu, ProgressView, Script, Text, VStack } from "scripting"

async function measure(name: string, element: any, scale = 1) {
  try {
    const img = await ImageRenderer.toUIImage(element, { scale })
    console.log(`${name}@scale${scale}: width=${img.width} height=${img.height}`)
  } catch (error) {
    console.log(`${name}@scale${scale}: ERROR ${String(error)}`)
  }
}

/** 与 version-history.tsx 完全相同的版本行结构（Menu + 单行 Text，无 chevron） */
function realRow(version: string, versionId: string, current: boolean) {
  return (
    <Menu
      key={`vm-${versionId}-${version}`}
      buttonStyle="plain"
      label={
        <HStack spacing={0} padding={{ horizontal: 16, vertical: 12 }}>
          <Text
            font={17}
            fontWeight={current ? "semibold" : undefined}
            foregroundStyle="label"
            monospacedDigit
            lineLimit={1}
            minScaleFactor={0.5}
            allowsTightening
            frame={{ maxWidth: "infinity", alignment: "leading" }}
          >
            {`ID ${versionId} • V${version}`}
          </Text>
        </HStack>
      }
    >
      <Button title="复制版本号" action={() => {}} />
      <Button title="复制版本 ID" action={() => {}} />
      <Button title="复制全部（版本号 + ID）" action={() => {}} />
    </Menu>
  )
}

async function main() {
  await measure("menuRow", realRow("2.1.0", "1000001", true), 1)
  await measure("menuRow", realRow("2.1.0", "1000001", true), 3)

  const two = (
    <VStack spacing={0} alignment="leading" frame={{ maxWidth: "infinity" }}>
      {realRow("2.1.0", "1000001", true)}
      {realRow("2.0.0", "1000000", false)}
    </VStack>
  )
  await measure("menuTwoRows", two, 1)
  await measure("menuTwoRows", two, 3)

  const three = (
    <VStack spacing={0} alignment="leading" frame={{ maxWidth: "infinity" }}>
      {realRow("3.0.0", "1000002", true)}
      {realRow("2.1.0", "1000001", false)}
      {realRow("2.0.0", "1000000", false)}
    </VStack>
  )
  await measure("menuThreeRows", three, 1)

  await measure("loading", <ProgressView progressViewStyle="circular" padding={16} frame={{ maxWidth: "infinity" }} />, 1)
  await measure("loading", <ProgressView progressViewStyle="circular" padding={16} frame={{ maxWidth: "infinity" }} />, 3)
  await measure("failed", <Image systemName="arrow.clockwise" font={17} padding={16} frame={{ maxWidth: "infinity" }} />, 1)
  await measure("failed", <Image systemName="arrow.clockwise" font={17} padding={16} frame={{ maxWidth: "infinity" }} />, 3)

  Script.exit("measure done")
}

void main()
