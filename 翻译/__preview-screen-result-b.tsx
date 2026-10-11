import { ImageRenderer, Text, VStack, useEffect, useState } from "scripting"
import { ScreenTranslationResult } from "./views/screen-result"

export default function Preview() {
  const [image, setImage] = useState<UIImage | null>(null)
  useEffect(() => {
    let alive = true
    ImageRenderer.toUIImage(
      <VStack spacing={10} padding={30} background="#FFFFFF">
        <Text font="largeTitle" fontWeight="bold">{"Hello Screen Overlay"}</Text>
        <Text font="title">{"Open Settings Page"}</Text>
        <Text>{"Tap the blue button to continue"}</Text>
        <Text>{"Your changes will be saved automatically"}</Text>
      </VStack>,
      { scale: 2 },
    ).then((result) => {
      if (alive) setImage(result)
    })
    return () => {
      alive = false
    }
  }, [])
  if (!image) {
    return <Text padding={20}>{"generating image..."}</Text>
  }
  return <ScreenTranslationResult image={image} />
}
