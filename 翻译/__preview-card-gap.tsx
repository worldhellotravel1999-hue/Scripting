import { ScrollView, VStack } from "scripting"
import { TranslationCard } from "./views/translation-card"

const SOURCE = "The quick brown fox jumps over the lazy dog. This sentence is used to demonstrate the spacing between the language title and the text inside the system translation card."
const TARGET = "敏捷的棕色狐狸跃过懒狗。这句话用来展示系统翻译卡片中语言标题与正文之间的间距。"

export default function Preview() {
  return (
    <ScrollView>
      <VStack spacing={16} padding={16}>
        <TranslationCard
          id="gap-first"
          initialText={SOURCE}
          sourceLanguage="en"
          targetLanguages={["zh-Hans"]}
          initialResults={[{ languageCode: "zh-Hans", text: TARGET, error: "", loading: false }]}
          readOnly
          autoTranslate={false}
          translationFirst
        />
        <TranslationCard
          id="gap-normal"
          initialText={SOURCE}
          sourceLanguage="en"
          targetLanguages={["zh-Hans"]}
          initialResults={[{ languageCode: "zh-Hans", text: TARGET, error: "", loading: false }]}
          readOnly
          autoTranslate={false}
        />
      </VStack>
    </ScrollView>
  )
}
