import { identifyBrand } from "../../brands"

/** Pure regression checks; no network, file access or application configuration. */
export function checkBrands(): { passed: number; brands: number } {
  let passed = 0
  const seen = new Set<string>()
  function expect(model: string, provider: string | undefined, id: string) {
    const actual = identifyBrand(model, provider)
    if (actual.id !== id) {
      throw new Error(`${JSON.stringify([model, provider])}: expected ${id}, got ${actual.id}`)
    }
    if (id === "unknown") {
      if (actual.name !== "AI" || "logo" in actual) throw new Error("Unknown must be AI without logo")
    } else {
      if (!actual.name || actual.logo !== `assets/logos/${id}.png`) throw new Error(`Invalid brand: ${id}`)
      seen.add(id)
    }
    passed++
  }

  const families: Array<[string, string[]]> = [
    ["openai", ["OpenAI", "gpt", "gpt-4o", "GPT-4.1-mini", "gpt-5", "o1", "o1-preview", "o3", "o3-mini", "o4", "o4-mini", "chatgpt", "chatgpt-4o-latest"]],
    ["anthropic", ["Anthropic", "claude", "claude-3-7-sonnet-20250219", "claude-sonnet-4-5"]],
    ["google", ["Google", "gemini", "gemini-2.5-pro", "gemma", "gemma-3-27b-it"]],
    ["deepseek", ["DeepSeek", "deepseek-chat", "deepseek-reasoner", "DeepSeek-R1-Distill-Qwen-32B", "DeepSeek-R1-Distill-Llama-70B"]],
    ["alibaba", ["Alibaba", "qwen", "qwen3-235b-a22b", "Qwen2.5-Coder-32B-Instruct", "qwq", "qwq-32b"]],
    ["xai", ["xAI", "grok", "grok-4", "grok-3-mini"]],
    ["moonshot", ["Moonshot", "moonshot-v1-8k", "kimi", "kimi-k2-instruct"]],
    ["bytedance", ["ByteDance", "doubao", "doubao-seed-1-6-250615", "seed", "Seed-OSS-36B-Instruct"]],
    ["zhipu", ["Zhipu", "glm", "glm-4.5", "chatglm3-6b"]],
    ["meta", ["Meta", "llama", "Llama-3.3-70B-Instruct", "Meta-Llama-3-8B-Instruct", "muse-spark-1.3-contributor"]],
    ["mistral", ["Mistral", "mistral-large-latest", "mixtral", "mixtral-8x7b-instruct", "codestral", "codestral-latest", "devstral", "devstral-small-2505"]],
    ["cohere", ["Cohere", "command", "command-r", "command-r-plus", "command-a-03-2025", "command-light"]],
    ["baidu", ["Baidu", "ernie", "ERNIE-4.5-300B-A47B"]],
    ["tencent", ["Tencent", "hunyuan", "hunyuan-turbo", "Hunyuan-A13B-Instruct", "hy4-preview"]],
    ["minimax", ["MiniMax", "MiniMax-M1", "MiniMax-M2"]],
    ["xiaomi", ["Xiaomi", "mimo", "MiMo-7B-RL", "mimo-v2-flash"]],
    ["perplexity", ["Perplexity", "sonar", "sonar-pro", "sonar-reasoning-pro"]],
    ["nvidia", ["NVIDIA", "nemotron", "Nemotron-4-340B-Instruct"]],
    ["microsoft", ["Microsoft", "phi", "Phi-4", "phi-3.5-mini-instruct"]],
    ["amazon", ["Amazon", "nova", "nova-pro-v1", "nova-lite-v1", "nova-2-lite-v1"]],
    ["baai", ["BAAI", "bge", "bge-m3", "bge-reranker-v2-m3"]],
    ["yi", ["Yi", "Yi-1.5-34B-Chat", "yi-lightning", "01-ai"]],
    ["spark", ["Spark", "spark-4.0-ultra", "SparkDesk", "SparkMax", "SparkLite", "Spark-X1"]],
  ]
  for (const [id, models] of families) {
    for (const model of models) {
      expect(model, undefined, id)
      expect(model, id === "openai" ? "Anthropic" : "OpenAI", id)
    }
  }

  const qualified: Array<[string, string]> = [
    ["openai/gpt-4o", "openai"], ["openai/claude-sonnet-4", "anthropic"],
    ["google/gemma-3-27b-it", "google"], ["models/gemini-2.5-flash", "google"],
    ["google/unknown-model", "unknown"], ["Qwen/Qwen3-32B", "alibaba"],
    ["deepseek-ai/DeepSeek-R1-Distill-Llama-70B", "deepseek"],
    ["meta-llama/Llama-3.1-8B-Instruct", "meta"], ["mistralai/Mixtral-8x7B-Instruct-v0.1", "mistral"],
    ["moonshotai/Kimi-K2-Instruct", "moonshot"], ["ByteDance-Seed/Seed-OSS-36B", "bytedance"],
    ["z-ai/glm-4.5", "zhipu"], ["XiaomiMiMo/MiMo-7B-RL", "xiaomi"],
    ["nvidia/Llama-3.1-Nemotron-70B-Instruct", "nvidia"],
    ["nvidia/Llama-3.3-Nemotron-Super-49B-v1", "nvidia"],
    ["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "nvidia"],
    ["perplexity/llama-3.1-sonar-large-128k-online", "perplexity"],
    ["microsoft/Phi-4", "microsoft"], ["BAAI/bge-m3", "baai"], ["01-ai/Yi-34B-Chat", "yi"],
    ["us.anthropic.claude-3-7-sonnet-20250219-v1:0", "anthropic"],
    ["eu.amazon.nova-pro-v1:0", "amazon"], ["cohere.command-r-plus-v1:0", "cohere"],
    ["ft:gpt-4o-2024-08-06:company:experiment:id", "openai"],
    ["gemini-2.5-pro@20250617", "google"], ["  GPT_4o  ", "openai"],
  ]
  for (const [model, id] of qualified) expect(model, undefined, id)

  const providers: Array<[string, string]> = [
    ["OpenAI", "openai"], [" Anthropic ", "anthropic"], ["Google", "google"],
    ["DeepSeek", "deepseek"], ["Alibaba", "alibaba"], ["xAI", "xai"], ["x.ai", "xai"],
    ["Moonshot", "moonshot"], ["ByteDance", "bytedance"], ["Zhipu", "zhipu"], ["z.ai", "zhipu"],
    ["Meta", "meta"], ["Mistral AI", "mistral"], ["Cohere", "cohere"], ["Baidu", "baidu"],
    ["Tencent", "tencent"], ["MiniMax", "minimax"], ["Xiaomi", "xiaomi"],
    ["Perplexity", "perplexity"], ["NVIDIA", "nvidia"], ["Microsoft", "microsoft"],
    ["Amazon", "amazon"], ["BAAI", "baai"], ["Yi", "yi"], ["iFlytek", "spark"],
  ]
  for (const [provider, id] of providers) expect("unlisted-model", provider, id)

  for (const provider of ["", "OpenRouter", "custom", "local", "SiliconFlow", "Together", "Groq", "relay-openai", "OpenAI-compatible", "my-google-channel", "https://api.openai.com", "google.ai", "open/ai", "open_ai", "azure-openai"]) {
    expect("unlisted-model", provider, "unknown")
    expect("claude-sonnet-4", provider, "anthropic")
  }
  for (const model of ["", "   ", "unknown", "auto", "default", "router", "local-model", "mygpt", "gptish", "o10", "o30", "o40", "foo-o1", "my-gpt-wrapper", "seedling", "phixture", "llamaindex", "yikes", "sparkles", "commandcode", "command-line", "nova-search", "google-unknown", "openai-compatible", "https://example.com/gpt-4o"]) {
    expect(model, undefined, "unknown")
  }

  const first = identifyBrand("gpt-4o")
  first.id = "changed"
  delete first.logo
  expect("gpt-4o", undefined, "openai")
  const unknown = identifyBrand("")
  unknown.logo = "invalid.png"
  expect("", undefined, "unknown")
  if (seen.size !== 23) throw new Error(`Expected 23 brands, checked ${seen.size}`)
  return { passed, brands: seen.size }
}
