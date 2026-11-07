export type Brand = { id: string; name: string; logo?: string }

type BrandRule = {
  brand: Brand
  modelPattern: RegExp
  providerAliases: string[]
}

const LOGO_ROOT = "assets/logos"

function makeBrand(id: string, name: string): Brand {
  return { id, name, logo: `${LOGO_ROOT}/${id}.png` }
}

const RULES: BrandRule[] = [
  {
    brand: makeBrand("openai", "OpenAI"),
    modelPattern: /^(?:gpt|chatgpt)(?=$|[-\s.]|\d)|^o[134](?=$|[-\s.])/,
    providerAliases: ["openai", "open ai"],
  },
  {
    brand: makeBrand("anthropic", "Anthropic"),
    modelPattern: /^claude(?=$|[-\s.]|\d)/,
    providerAliases: ["anthropic"],
  },
  {
    brand: makeBrand("google", "Google"),
    modelPattern: /^(?:gemini|gemma)(?=$|[-\s.]|\d)/,
    providerAliases: ["google", "gemini", "google ai", "google ai studio"],
  },
  {
    brand: makeBrand("deepseek", "DeepSeek"),
    modelPattern: /^deepseek(?=$|[-\s.]|\d)/,
    providerAliases: ["deepseek"],
  },
  {
    brand: makeBrand("alibaba", "Alibaba"),
    modelPattern: /^(?:qwen|qwq)(?=$|[-\s.]|\d)/,
    providerAliases: ["alibaba", "alibaba cloud", "aliyun", "qwen"],
  },
  {
    brand: makeBrand("xai", "xAI"),
    modelPattern: /^grok(?=$|[-\s.]|\d)/,
    providerAliases: ["xai", "x ai", "x.ai"],
  },
  {
    brand: makeBrand("moonshot", "Moonshot"),
    modelPattern: /^(?:moonshot|kimi)(?=$|[-\s.]|\d)/,
    providerAliases: ["moonshot", "moonshot ai"],
  },
  {
    brand: makeBrand("bytedance", "ByteDance"),
    modelPattern: /^(?:doubao|seed)(?=$|[-\s.]|\d)/,
    providerAliases: ["bytedance", "byte dance", "doubao"],
  },
  {
    brand: makeBrand("zhipu", "Zhipu AI"),
    modelPattern: /^(?:chatglm|glm)(?=$|[-\s.]|\d)/,
    providerAliases: ["zhipu", "zhipu ai", "zhipuai", "z.ai", "zai"],
  },
  {
    brand: makeBrand("meta", "Meta"),
    modelPattern: /^(?:meta-)?(?:llama|muse)(?=$|[-\s.]|\d)/,
    providerAliases: ["meta", "meta ai"],
  },
  {
    brand: makeBrand("mistral", "Mistral AI"),
    modelPattern: /^(?:mistral|mixtral|codestral|devstral)(?=$|[-\s.]|\d)/,
    providerAliases: ["mistral", "mistral ai"],
  },
  {
    brand: makeBrand("cohere", "Cohere"),
    modelPattern: /^command(?:$|[-\s](?:r\+?|a|light|nightly)(?=$|[-\s.]|\d))/,
    providerAliases: ["cohere"],
  },
  {
    brand: makeBrand("baidu", "Baidu"),
    modelPattern: /^ernie(?=$|[-\s.]|\d)/,
    providerAliases: ["baidu", "baidu ai", "baidu cloud"],
  },
  {
    brand: makeBrand("tencent", "Tencent"),
    modelPattern: /^(?:hy\d*|hunyuan)(?=$|[-\s.]|\d)/,
    providerAliases: ["tencent", "tencent cloud"],
  },
  {
    brand: makeBrand("minimax", "MiniMax"),
    modelPattern: /^minimax(?=$|[-\s.]|\d)/,
    providerAliases: ["minimax", "mini max"],
  },
  {
    brand: makeBrand("xiaomi", "Xiaomi"),
    modelPattern: /^mimo(?=$|[-\s.]|\d)/,
    providerAliases: ["xiaomi", "xiaomi mimo"],
  },
  {
    brand: makeBrand("perplexity", "Perplexity"),
    modelPattern: /^sonar(?=$|[-\s.]|\d)/,
    providerAliases: ["perplexity"],
  },
  {
    brand: makeBrand("nvidia", "NVIDIA"),
    modelPattern: /^(?:nvidia-)?nemotron(?=$|[-\s.]|\d)/,
    providerAliases: ["nvidia", "nvidia ai"],
  },
  {
    brand: makeBrand("microsoft", "Microsoft"),
    modelPattern: /^phi(?=$|[-\s.]|\d)/,
    providerAliases: ["microsoft", "microsoft ai"],
  },
  {
    brand: makeBrand("amazon", "Amazon"),
    modelPattern: /^nova(?:$|[-\s.](?:\d|pro|lite|micro|premier|sonic|canvas|reel)(?=$|[-\s.]|\d))/,
    providerAliases: ["amazon", "amazon bedrock", "aws", "aws bedrock"],
  },
  {
    brand: makeBrand("baai", "BAAI"),
    modelPattern: /^bge(?=$|[-\s.]|\d)/,
    providerAliases: ["baai", "baai ai"],
  },
  {
    brand: makeBrand("yi", "Yi"),
    modelPattern: /^yi(?=$|[-\s.]|\d)/,
    providerAliases: ["01-ai", "01ai", "yi", "01 ai"],
  },
  {
    brand: makeBrand("spark", "Spark"),
    modelPattern: /^spark(?:$|[-\s.]|\d|(?:desk|lite|pro|plus|max|ultra|x1)(?=$|[-\s.]|\d))/,
    providerAliases: ["spark", "iflytek", "ifly tek"],
  },
]

const UNKNOWN: Brand = { id: "unknown", name: "AI" }

// Provider names are an exact allowlist. Punctuation, URLs and channel labels
// are not stripped or searched for embedded vendor names.
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

function findProvider(value: string): BrandRule | undefined {
  const name = normalize(value)
  return RULES.find((rule) => rule.providerAliases.includes(name))
}

function modelIdentifier(value: string): string {
  const name = normalize(value)
  if (name.includes("://")) return ""

  // OpenAI fine-tuning IDs: ft:gpt-4o-2024-08-06:organization:suffix:id.
  if (name.startsWith("ft:")) return (name.split(":")[1] || "").replace(/_/g, "-")

  // Hugging Face / OpenRouter namespaces, models/gemini-..., and
  // Bedrock IDs such as us.anthropic.claude-...-v1:0.
  // 先去除 global: 等明确的路由前缀，再移除 :free / :0 等模型后缀。
  const leaf = name.split("/").pop() || ""
  return leaf
    .replace(/^(?:us|eu|apac|global)[.:]/, "")
    .replace(/^(?:openai|anthropic|google|deepseek|alibaba|qwen|xai|moonshot|bytedance|zhipu|meta|mistral|cohere|baidu|tencent|minimax|xiaomi|perplexity|nvidia|microsoft|amazon|baai|01-ai|iflytek)[.:]/, "")
    .replace(/[:@].*$/, "")
    .replace(/_/g, "-")
}

/**
 * Identify the model family first, then an exact vendor provider name.
 * Unknown/custom channel names do not imply a vendor. Returned objects are
 * independent copies; callers cannot change the mapping for subsequent calls.
 */
function resolveBrand(model: string, provider?: string): Brand {
  const value = typeof model === "string" ? model : ""
  const identifier = modelIdentifier(value)

  // These branded derivatives belong to NVIDIA / Perplexity, even though
  // their published names also mention the Llama base model.
  if (/^(?:nvidia-)?(?:llama|llama3|llama-3(?:\.\d+)?)[-\s].*\bnemotron(?=$|[-\s.]|\d)/.test(identifier)) {
    return { ...RULES.find((rule) => rule.brand.id === "nvidia")!.brand }
  }
  if (/^llama(?:-?3(?:\.\d+)?)?[-\s].*\bsonar(?=$|[-\s.]|\d)/.test(identifier)) {
    return { ...RULES.find((rule) => rule.brand.id === "perplexity")!.brand }
  }

  const modelRule = RULES.find((rule) => rule.modelPattern.test(identifier))
    || findProvider(value)
  if (modelRule) return { ...modelRule.brand }

  const providerRule = typeof provider === "string" ? findProvider(provider) : undefined
  return { ...(providerRule ? providerRule.brand : UNKNOWN) }
}

// identifyBrand 是纯函数，但列表每次渲染都会对每一行各调用一次（筛选 + 行内展示）。
// 这里做有界记忆化，避免重复跑正则；结果只依赖静态 RULES，不存在失效问题，
// 返回值仍然每次拷贝，调用方改不到缓存（保持“映射不可被污染”的原契约）。
const brandCache = new Map<string, Brand>()
const BRAND_CACHE_LIMIT = 512

export function identifyBrand(model: string, provider?: string): Brand {
  const value = typeof model === "string" ? model : ""
  const owner = typeof provider === "string" ? provider : ""
  const cacheKey = `${value}\u0000${owner}`
  const cached = brandCache.get(cacheKey)
  if (cached) return { ...cached }
  const brand = resolveBrand(value, owner)
  if (brandCache.size >= BRAND_CACHE_LIMIT) brandCache.clear()
  brandCache.set(cacheKey, { ...brand })
  return { ...brand }
}
