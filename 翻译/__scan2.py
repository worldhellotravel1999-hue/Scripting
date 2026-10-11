import re

cands = [
    ("core/appraven.ts", "APPRAVEN_IMAGES_URL"),
    ("core/appraven.ts", "APPRAVEN_USER_ICON_PATH"),
    ("core/appraven.ts", "APPRAVEN_DEFAULT_USER_ICON_URL"),
    ("core/appraven.ts", "AppRavenPage"),
    ("core/appraven.ts", "AppRavenCookie"),
    ("core/appraven.ts", "AppRavenUser"),
    ("core/appraven.ts", "parseAppRavenMutationResult"),
    ("core/appraven.ts", "parseAppRavenCookieHeader"),
    ("core/appraven.ts", "parseAppRavenSetCookieHeaders"),
    ("core/appraven.ts", "parseAppRavenGraphQLData"),
    ("core/appraven.ts", "parseAppRavenUser"),
    ("core/appraven.ts", "parseAppRavenPage"),
    ("core/appraven.ts", "parseAppRavenCollectionPage"),
    ("core/appraven.ts", "parseAppRavenCollectionItemPage"),
    ("core/appraven.ts", "parseAppRavenITunesId"),
    ("core/preferences.ts", "normalizePreferences"),
    ("core/price-history.ts", "PriceHistoryOptions"),
    ("core/price-history.ts", "PriceHistoryFastHandle"),
    ("core/price-history.ts", "parsePriceHistory"),
    ("core/price-history.ts", "matchVersionIds"),
    ("core/price-history.ts", "fetchPriceHistory"),
    ("core/pricing.ts", "RegionDefinition"),
    ("core/screen-ocr.ts", "OCRBox"),
    ("core/screen-ocr.ts", "OCRCandidate"),
    ("core/screen-ocr.ts", "buildOCRBlocks"),
    ("core/screen-ocr.ts", "buildSourceText"),
    ("core/screen-overlay.tsx", "ScreenOverlayLine"),
    ("core/screen-overlay.tsx", "renderCoverImage"),
    ("core/screen-translation.ts", "translateScreenImages"),
    ("core/translate.ts", "splitTranslationText"),
    ("core/fonts.ts", "FontSettings"),
    ("core/versions.ts", "parseVersionHistoryNotes"),
]

for f, name in cands:
    with open(f, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    pat = re.compile(r"\b" + re.escape(name) + r"\b")
    hits = [(i+1, l.strip()[:100]) for i, l in enumerate(lines) if pat.search(l)]
    print(f"== {f} :: {name} — {len(hits)} hits")
    for ln, txt in hits:
        print(f"   {ln}: {txt}")
