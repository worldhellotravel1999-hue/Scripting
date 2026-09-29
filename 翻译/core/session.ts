declare const TranslationUIProvider: {
  readonly inputText: string | null
  readonly allowsReplacement: boolean
  present(node: any): void
  expandSheet?(): void
  finish(translation?: string | null): void
}

export function getTranslationSession() {
  return {
    inputText: TranslationUIProvider.inputText,
    allowsReplacement: TranslationUIProvider.allowsReplacement,
  }
}

export function presentTranslationUI(node: any) {
  TranslationUIProvider.present(node)
}

export function expandTranslationSheet() {
  try { TranslationUIProvider.expandSheet?.() } catch {}
}

export function finishTranslation(value?: string | null) {
  TranslationUIProvider.finish(value)
}
