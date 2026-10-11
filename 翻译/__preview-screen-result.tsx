import { ScreenTranslationResult } from "./views/screen-result"

const image = UIImage.fromFile(
  "/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/翻译/__preview-blank.png",
)

export default function Preview() {
  return <ScreenTranslationResult image={image!} />
}
