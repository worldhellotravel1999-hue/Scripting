// 合集页行头方框尺寸标定：复刻 appraven-collections.tsx 行头 4 种方框结构，
// 用 ImageRenderer 实测外框尺寸，找出不一致者。
// 运行：scripting-ts run tests/probe-collection-boxes.tsx
import { AppStoreIcon } from "../views/app-store"
import {
  Button,
  Circle,
  HStack,
  Image,
  ImageRenderer,
  RoundedRectangle,
  Script,
  VStack,
  ZStack,
} from "scripting"

const TOP_BOX_FILL = { light: "rgba(120,120,128,0.18)", dark: "rgba(120,120,128,0.24)" } as const
const BUTTON_BOX_FILL = { light: "rgba(248,248,251,0.75)", dark: "rgba(240,240,245,0.70)" } as const

async function measure(name: string, element: any, scale = 1) {
  try {
    const img = await ImageRenderer.toUIImage(element, { scale })
    console.log(`${name}@${scale}: width=${img.width} height=${img.height}`)
  } catch (error) {
    console.log(`${name}@${scale}: ERROR ${String(error)}`)
  }
}

/** 1. artwork 方框（合集行头 App 图标盒） */
function artworkBox() {
  return (
    <HStack
      padding={{ horizontal: 4, vertical: 4 }}
      background={<RoundedRectangle fill={TOP_BOX_FILL} cornerRadius={10} />}
      clipShape={{ type: "rect", cornerRadius: 10, style: "continuous" }}
    >
      <AppStoreIcon imageUrl={undefined} size={32} />
    </HStack>
  )
}

/** 2. RoundIconButton（刷新/退出/全屏）：Button > 盒 */
function roundIconButtonBox() {
  return (
    <Button buttonStyle="plain" action={() => {}}>
      <HStack
        padding={{ horizontal: 4, vertical: 4 }}
        background={<RoundedRectangle fill={TOP_BOX_FILL} cornerRadius={10} />}
        clipShape={{ type: "rect", cornerRadius: 10, style: "continuous" }}
      >
        <Image
          systemName="arrow.clockwise"
          font={16}
          foregroundStyle={{ light: "#000000", dark: "#FFFFFF" }}
          frame={{ width: 32, height: 32 }}
          background={{ style: BUTTON_BOX_FILL, shape: "circle" }}
        />
      </HStack>
    </Button>
  )
}

/** 3. LayoutToggle 方框：盒 > Button > ZStack32 */
function layoutBox() {
  return (
    <HStack
      padding={{ horizontal: 4, vertical: 4 }}
      background={<RoundedRectangle fill={TOP_BOX_FILL} cornerRadius={10} />}
      clipShape={{ type: "rect", cornerRadius: 10, style: "continuous" }}
    >
      <Button buttonStyle="plain" action={() => {}}>
        <ZStack
          frame={{ width: 32, height: 32 }}
          background={{ style: BUTTON_BOX_FILL, shape: "circle" }}
        >
          <Image systemName="square.grid.2x2" font={15} />
        </ZStack>
      </Button>
    </HStack>
  )
}

/** 4. 加减（Join）方框：盒 > HStack > Button > ZStack32 */
function joinBox() {
  return (
    <HStack
      padding={{ horizontal: 4, vertical: 4 }}
      background={<RoundedRectangle fill={TOP_BOX_FILL} cornerRadius={10} />}
      clipShape={{ type: "rect", cornerRadius: 10, style: "continuous" }}
    >
      <HStack>
        <Button buttonStyle="plain" action={() => {}}>
          <ZStack frame={{ width: 32, height: 32 }}>
            <Circle fill={BUTTON_BOX_FILL} />
            <ZStack frame={{ width: 32, height: 32 }}>
              <Image systemName="plus.circle.fill" font={22} />
            </ZStack>
          </ZStack>
        </Button>
      </HStack>
    </HStack>
  )
}

/** 5. 排序态加减方框（盒 > VStack 双 chevron） */
function joinSortBox() {
  return (
    <HStack
      padding={{ horizontal: 4, vertical: 4 }}
      background={<RoundedRectangle fill={TOP_BOX_FILL} cornerRadius={10} />}
      clipShape={{ type: "rect", cornerRadius: 10, style: "continuous" }}
    >
      <VStack spacing={4}>
        <Button buttonStyle="plain" action={() => {}}>
          <Image systemName="chevron.up" font="body" />
        </Button>
        <Button buttonStyle="plain" action={() => {}}>
          <Image systemName="chevron.down" font="body" />
        </Button>
      </VStack>
    </HStack>
  )
}

/** 6. 内层内容对照：直接量 32 内容是否被 Button 撑大 */
function bareButtonZStack() {
  return (
    <Button buttonStyle="plain" action={() => {}}>
      <ZStack frame={{ width: 32, height: 32 }} background={{ style: BUTTON_BOX_FILL, shape: "circle" }}>
        <Image systemName="square.grid.2x2" font={15} />
      </ZStack>
    </Button>
  )
}

async function main() {
  await measure("artworkBox", artworkBox(), 3)
  await measure("roundIconButtonBox", roundIconButtonBox(), 3)
  await measure("layoutBox", layoutBox(), 3)
  await measure("joinBox", joinBox(), 3)
  await measure("joinSortBox", joinSortBox(), 3)
  await measure("bareButtonZStack", bareButtonZStack(), 3)
  Script.exit("measure done")
}

void main()
