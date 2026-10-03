import { useEffect, useRef, useState } from "scripting"
import { RunToken, pingModel } from "./probe"
import { configuredTargets, flattenModels, loadProviders, probeBuiltinFlags } from "./providers"
import { addSample, rewardTopThree } from "./scoring"
import { readHistory, readResults, saveRecords } from "./storage"
import { delay } from "./types"
import type { History, Model, Phase, Results } from "./types"

export type InitialRecords = { history: History; results: Results }

export function useDetection(models: Model[], preview?: InitialRecords) {
  const [history, setHistory] = useState<History>(() => preview?.history ?? readHistory())
  const [results, setResults] = useState<Results>(() => preview?.results ?? readResults())
  const [phases, setPhases] = useState<Record<string, Phase>>({})
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const historyRef = useRef(history)
  const resultsRef = useRef(results)
  const active = useRef<RunToken | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current?.cancel() }
  }, [])

  function stop() {
    active.current?.cancel()
    active.current = null
    setPhases({})
    setRunning(false)
  }

  async function start(targets: Model[]) {
    if (active.current || !targets.length || preview) return
    // 内置渠道“是否已添加”靠一次本地探测判定，先等它出结果，
    // 否则刚打开页面就点检测会把内置模型全部过滤掉。
    await probeBuiltinFlags()
    if (active.current || !targets.length || preview) return
    targets = configuredTargets(targets, flattenModels(loadProviders()))
    if (!targets.length) { setError("这些模型已不在 Scripting 的已添加列表中"); return }
    setError("")
    setErrors({})
    const run = new RunToken()
    active.current = run
    setRunning(true)
    setProgress({ done: 0, total: targets.length })
    setPhases(Object.fromEntries(targets.map(m => [m.key, "queued" as Phase])))
    const alive = () => mounted.current && active.current === run && !run.cancelled
    let completed = 0
    let lastReveal = Date.now()
    let revealQueue = Promise.resolve()
    const successful: Array<{ key: string; ms: number; at: number }> = []

    // 同渠道串行，全部渠道并行（最多八个 worker）；快响应按 150ms 间隔逐条揭晓，
    // 每行至少展示 0.4 秒检测状态。延迟仅控制显示，不会增加请求耗时或改变分数。
    const channelMap = new Map<string, Model[]>()
    for (const model of targets) {
      const key = `${model.builtin ? "b" : "c"}/${model.group}`
      channelMap.set(key, [...(channelMap.get(key) ?? []), model])
    }
    const channels = [...channelMap.values()]
    let cursor = 0

    async function check(model: Model) {
      if (!alive()) return
      if (!configuredTargets([model], flattenModels(loadProviders())).length) {
        setPhases(prev => ({ ...prev, [model.key]: "idle" }))
        setProgress({ done: ++completed, total: targets.length })
        return
      }
      const began = Date.now()
      setPhases(prev => ({ ...prev, [model.key]: "checking" }))
      let result
      try {
        result = await pingModel(model.provider, model.id, run)
      } catch (error) {
        result = { ok: false, ms: Math.max(1, Date.now() - began), at: Date.now(), error: String((error as Error)?.message ?? error ?? "") }
      }
      if (!result || !alive()) return
      // 记下失败原因，配置类问题（未选模型、缺 API key）要能在页面上看到，
      // 否则只显示一个 0 分无从判断是渠道挂了还是配置没做完。
      const message = result.error
      setErrors(prev => {
        if (!message) {
          if (!(model.key in prev)) return prev
          const next = { ...prev }
          delete next[model.key]
          return next
        }
        return prev[model.key] === message ? prev : { ...prev, [model.key]: message }
      })
      // 完成即保存。揭晓等待只控制视觉，停止/退出不再丢失已完成请求。
      historyRef.current = addSample(historyRef.current, model.key, result)
      resultsRef.current = { ...resultsRef.current, [model.key]: result }
      if (result.ok) successful.push({ key: model.key, ms: result.ms, at: result.at })
      setHistory(historyRef.current)
      setResults(resultsRef.current)
      saveRecords(models, historyRef.current, resultsRef.current)
      setProgress({ done: ++completed, total: targets.length })
      const ok = result.ok
      const reveal = async () => {
        await delay(Math.max(0, began + 400 - Date.now(), lastReveal + 150 - Date.now()))
        if (!alive()) return
        lastReveal = Date.now()
        setPhases(prev => ({ ...prev, [model.key]: ok ? "ok" : "fail" }))
      }
      revealQueue = revealQueue.then(reveal)
    }

    async function worker() {
      while (alive()) {
        const list = channels[cursor++]
        if (!list) break
        for (const model of list) {
          if (!alive()) break
          await check(model)
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(8, channels.length) }, () => worker()))
      await revealQueue
      if (alive()) {
        if (targets.length > 1) {
          historyRef.current = rewardTopThree(historyRef.current, successful)
          setHistory(historyRef.current)
          saveRecords(models, historyRef.current, resultsRef.current)
        }
      }
    } catch (_) {
      if (alive()) setError("检测中断，已完成的结果已保留，请重试")
    } finally {
      if (active.current === run) {
        active.current = null
        run.cancel()
        if (mounted.current) { setRunning(false); setPhases({}) }
      }
    }
  }

  return { history, results, phases, running, progress, error, errors, start, stop }
}
