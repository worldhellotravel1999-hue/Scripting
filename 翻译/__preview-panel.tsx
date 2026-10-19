import { TranslationPanel } from "./views/translation-panel"

export default function Preview() {
  return (
    <TranslationPanel
      inputText={"Apple 今日发布了新的 iPad Pro。新款设备采用 M5 芯片，机身更薄，续航更长。\n\n此外，系统还带来了多项翻译与显示方面的改进。"}
      allowsReplacement={true}
    />
  )
}
