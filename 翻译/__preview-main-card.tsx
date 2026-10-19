import { ScrollView, VStack } from "scripting"
import { TranslationCard } from "./views/translation-card"

const SOURCE = "Apple 今日发布了新的 iPad Pro。新款设备采用 M5 芯片，机身更薄，续航更长。此外，系统还带来了多项翻译与显示方面的改进。"
const TARGET = "Apple today announced the new iPad Pro. The new device features the M5 chip with a thinner body and longer battery life. In addition, the system brings several improvements to translation and display."

export default function Preview() {
  return (
    <ScrollView>
      <VStack spacing={16} padding={16}>
        {/* 主界面活动卡（可编辑） */}
        <TranslationCard
          id="main-active"
          sourceLanguage="zh-Hans"
          targetLanguages={["en"]}
          initialText={SOURCE}
          initialResults={[{ languageCode: "en", text: TARGET, error: "", loading: false }]}
          autoTranslate={false}
        />
        {/* 主界面完成卡（compact） */}
        <TranslationCard
          id="main-compact"
          sourceLanguage="zh-Hans"
          targetLanguages={["en"]}
          initialText={SOURCE}
          initialResults={[{ languageCode: "en", text: TARGET, error: "", loading: false }]}
          compact
        />
      </VStack>
    </ScrollView>
  )
}
