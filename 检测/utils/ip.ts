// File: utils/ip.ts
// 获取 IP 信息并计算风险值
import { fetch, Device } from "scripting"

export const API_URL = "http://ip-api.com/json/?lang=zh-CN"
// 国内IP查询源（3322最快最稳定）
const CHINA_IP_APIS = [
  "https://ip.3322.net",           // 首选：国内服务器，纯文本
  "https://api.ipify.org?format=json",  // 备用1：全球CDN
  "https://checkip.amazonaws.com"       // 备用2：AWS
]

export interface IPInfo {
  query: string;
  country: string;
  countryCode: string;
  regionName: string;
  city: string;
  isp: string;
  org: string;
  as: string;
  status: string;
  lat: number;
  lon: number;
  asname?: string;
  proxy?: boolean;
  hosting?: boolean;
  mobile?: boolean;
  // 可选字段保持小组件和现有 IPInfo 调用方兼容。
  continent?: string;
  continentCode?: string;
  timezone?: string;
  offset?: number;
  zip?: string;
}

export const PRIVACY_MODE_KEY = "ip-detection.privacy-mode"

export function getPrivacyMode(): boolean {
  return Storage.get<boolean>(PRIVACY_MODE_KEY, { shared: true }) ?? true
}

export function setPrivacyMode(enabled: boolean): boolean {
  return Storage.set(PRIVACY_MODE_KEY, enabled, { shared: true })
}

function dottedIPv4ToGroups(value: string): string | null {
  const groups = value.split(".")
  if (groups.length !== 4 || !groups.every(group => /^\d{1,3}$/.test(group) && Number(group) <= 255)) return null
  const [a, b, c, d] = groups.map(Number)
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
}

export function expandIPv6(address: string): string[] | null {
  let source = address.split("%")[0].toLowerCase()
  // RFC 4291 允许 IPv6 尾段写成点分 IPv4（如 ::ffff:192.0.2.1）。
  if (source.includes(".")) {
    const tail = source.slice(source.lastIndexOf(":") + 1)
    const groups = dottedIPv4ToGroups(tail)
    if (!groups) return null
    source = source.slice(0, source.lastIndexOf(":") + 1) + groups
  }
  const sections = source.split("::")
  if (sections.length > 2) return null

  const left = sections[0] ? sections[0].split(":") : []
  const right = sections.length === 2 && sections[1] ? sections[1].split(":") : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (sections.length === 2 && missing === 0) || (sections.length === 1 && missing !== 0)) return null

  const groups = sections.length === 2
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.map((group) => group.padStart(4, "0"))
}

export function canonicalAddress(value: string): string | null {
  const source = value.trim().toLowerCase()
  if (!source || source.includes("%")) return null
  if (!source.includes(":")) {
    const groups = source.split(".")
    return groups.length === 4 && groups.every(group => /^\d{1,3}$/.test(group) && Number(group) <= 255)
      ? groups.map(Number).join(".") : null
  }
  const groups = expandIPv6(source)
  if (!groups) return null
  // IPv4-mapped IPv6 与对应 IPv4 视为同一地址，避免双栈出口被误判为不同。
  if (groups.slice(0, 5).every(group => group === "0000") && groups[5] === "ffff") {
    const a = parseInt(groups[6], 16), b = parseInt(groups[7], 16)
    return [a >> 8, a & 255, b >> 8, b & 255].join(".")
  }
  return groups.join(":")
}

function sameAddress(a: string, b: string): boolean {
  const key = canonicalAddress(a)
  return key !== null && key === canonicalAddress(b)
}

export function formatIPAddress(address: string | null | undefined, privacyMode = getPrivacyMode()): string {
  if (!address) return "—"
  if (!privacyMode) return address

  const canonical = canonicalAddress(address)
  if (!canonical) return "—"
  if (!canonical.includes(":")) {
    const groups = canonical.split(".")
    return `${groups[0]}.${groups[1]}.x.x`
  }
  const groups = expandIPv6(canonical)!
  return `${groups.slice(0, 4).join(":")}::/64`
}

export function formatIPLocation(
  info: Pick<IPInfo, "country" | "countryCode" | "regionName" | "city"> | null | undefined,
  fallback = "未知位置"
): string {
  if (!info) return fallback

  const code = (info.countryCode || "").toUpperCase()
  const source = `${info.country || ""} ${info.regionName || ""} ${info.city || ""}`.toLowerCase()
  const detail = [info.regionName, info.city]
    .filter((value, index, values): value is string =>
      !!value &&
      !/^(香港|香港特别行政区|澳门|澳门特别行政区|台湾|台湾省|hong kong|macao|macau|taiwan)$/i.test(value) &&
      values.indexOf(value) === index
    )

  let region: string | null = null
  if (code === "HK" || source.includes("香港") || source.includes("hong kong")) {
    region = "香港地区"
  } else if (code === "MO" || source.includes("澳门") || source.includes("macao") || source.includes("macau")) {
    region = "澳门地区"
  } else if (code === "TW" || source.includes("台湾") || source.includes("taiwan")) {
    region = "台湾省"
  }

  if (region) return ["中国", region, ...detail].join(" · ")

  return [info.country, info.regionName, info.city]
    .filter((value, index, values): value is string => !!value && values.indexOf(value) === index)
    .join(" · ") || fallback
}

const RISK_KEYWORDS = {
  dataCenter: ["数据中心", "Amazon", "Google", "Tencent", "Alibaba", "Cloudflare", "IDC", "DMIT", "Vultr", "DigitalOcean", "Linode", "OVH"],
  homeBroadband: ["电信", "移动", "联通", "宽带", "Comcast", "Verizon", "ChinaNet", "家庭", "住宅"],
  highRiskCountries: ["俄罗斯", "印度", "乌克兰"],
  vpnKeywords: ["VPN", "Proxy", "Tunnel", "虚拟", "加速器", "节点"]
};

/**
 * 获取本地活跃的网络接口信息
 */
function getLocalNetworkInfo(): { hasVPNInterface: boolean } {
  try {
    const interfaces = Device.networkInterfaces();
    const vpnInterfaceKeywords = ["utun", "ppp", "ipsec", "tun", "tap", "wireguard", "wg"];
    let hasVPNInterface = false;

    for (const [name, addresses] of Object.entries(interfaces)) {
      const lowerName = name.toLowerCase();
      // 检查是否为VPN接口
      if (vpnInterfaceKeywords.some(kw => lowerName.includes(kw))) {
        const hasExternal = addresses.some(addr => !addr.isInternal);
        if (hasExternal) {
          hasVPNInterface = true;
          break;
        }
      }
    }

    return { hasVPNInterface };
  } catch (e) {
    return { hasVPNInterface: false };
  }
}

/** 保守识别可用于出口对照的公网地址；不把本地及文档网段计为公网。 */
export function isPublicExitAddress(value: string): boolean {
  const ip = canonicalAddress(value)
  if (!ip) return false
  if (ip.includes(":")) {
    const groups = ip.split(":").map(group => parseInt(group, 16))
    // RFC 6052 的全球 NAT64 前缀不在通常的 2000::/3 内。
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0)) {
      return isPublicExitAddress([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join("."))
    }
    return (groups[0] & 0xe000) === 0x2000
      && !(groups[0] === 0x2001 && (groups[1] === 0x0db8 || groups[1] === 0x0002 && groups[2] === 0
        || (groups[1] & 0xfff0) === 0x10 || (groups[1] & 0xfff0) === 0x20))
      && !(groups[0] === 0x3fff && (groups[1] & 0xf000) === 0)
  }
  const [a, b, c, d] = ip.split(".").map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 && c === 0 && d !== 9 && d !== 10 || b === 0 && c === 2 || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113)
}

/**
 * 分析ISP类型
 */
function analyzeISP(isp: string, org: string): {
  isDataCenter: boolean;
  isHomeBroadband: boolean;
  isVPNService: boolean;
  confidence: number;
} {
  const ispLower = isp.toLowerCase();
  const orgLower = org.toLowerCase();
  const combined = `${ispLower} ${orgLower}`;

  // 检测数据中心
  const isDataCenter = RISK_KEYWORDS.dataCenter.some(kw =>
    combined.includes(kw.toLowerCase())
  );

  // 检测家宽
  const isHomeBroadband = RISK_KEYWORDS.homeBroadband.some(kw =>
    combined.includes(kw.toLowerCase())
  );

  // 检测VPN服务商
  const isVPNService = RISK_KEYWORDS.vpnKeywords.some(kw =>
    combined.includes(kw.toLowerCase())
  );

  // 计算置信度
  let confidence = 50;
  if (isDataCenter) confidence += 30;
  if (isVPNService) confidence += 20;
  if (isHomeBroadband) confidence -= 20;

  return { isDataCenter, isHomeBroadband, isVPNService, confidence: Math.max(0, Math.min(100, confidence)) };
}

/**
 * 检测IP是否为海外（与中国大陆对比）
 */
function isOverseasIP(ipInfo: IPInfo): boolean {
  // 检查国家代码
  if (ipInfo.countryCode && ipInfo.countryCode !== "CN") {
    return true;
  }
  // 检查国家名称
  if (ipInfo.country && !ipInfo.country.includes("中国")) {
    return true;
  }
  return false;
}

/**
 * 综合判断VPN/代理状态（含多源IP对比）
 */
export function detectVPNStatus(
  ipInfo: IPInfo,
  chinaIP: string | null
): {
  isVPN: boolean;
  isProxy: boolean;
  proxyType: string;
  confidence: number;
} {
  const localInfo = getLocalNetworkInfo();
  const ispAnalysis = analyzeISP(ipInfo.isp, ipInfo.org);
  const intlIP = ipInfo.query;

  let vpnScore = 0;
  let isProxy = false;
  let proxyType = "";

  // 1. 多源IP对比（核心检测）
  if (chinaIP && !sameAddress(chinaIP, intlIP)) {
    // IP不一致 = 存在分流代理/旁路由
    isProxy = true;
    proxyType = "分流代理";
    vpnScore += 50;
  }

  // 2. 地理位置异常检测（备用方案）
  // 如果查询失败，但IP显示在海外，而用户在国内，说明走了代理
  if (!chinaIP && isOverseasIP(ipInfo)) {
    // IP在海外且无法获取国内IP（说明国内直连被代理或查询失败）
    isProxy = true;
    proxyType = "代理";
    vpnScore += 45;
    console.log(`[IP检测] 检测到海外IP: ${ipInfo.country} ${intlIP}`);
  }

  // 3. VPN接口检测 (+40分)
  if (localInfo.hasVPNInterface) {
    vpnScore += 40;
  }

  // 4. ISP分析 (+30分如果是数据中心/VPN服务)
  if (ispAnalysis.isVPNService) {
    vpnScore += 35;
  } else if (ispAnalysis.isDataCenter) {
    vpnScore += 25;
  }

  // 5. 如果明确是家宽，降低VPN可能性 (-20分)
  if (ispAnalysis.isHomeBroadband && !ispAnalysis.isDataCenter) {
    vpnScore -= 20;
  }

  // 计算最终置信度
  let confidence = ispAnalysis.confidence;
  if (vpnScore > 0) {
    confidence = Math.min(95, confidence + vpnScore);
  } else {
    confidence = Math.max(5, confidence);
  }

  // 判定阈值：>= 60分认为是VPN/代理
  const isVPN = vpnScore >= 60;

  // 如果IP分流且VPN接口检测成功，认为是VPN
  if (isProxy && localInfo.hasVPNInterface) {
    return {
      isVPN: true,
      isProxy: true,
      proxyType: "VPN",
      confidence: Math.min(95, confidence)
    };
  }

  return {
    isVPN,
    isProxy,
    proxyType,
    confidence
  };
}

export function parseIPInfo(value: unknown, address?: string): IPInfo | null {
  if (!value || typeof value !== "object") return null
  const data = value as Record<string, unknown>
  const query = typeof data.query === "string" ? data.query.trim() : ""
  if (data.status !== "success" || !canonicalAddress(query) || address && !sameAddress(query, address)) return null
  const text = (key: string) => typeof data[key] === "string" ? (data[key] as string).trim() : ""
  const flag = (key: string) => typeof data[key] === "boolean" ? data[key] as boolean : undefined
  const coordinate = (key: string) => typeof data[key] === "number" && Number.isFinite(data[key]) ? data[key] as number : NaN
  return {
    query, status: "success", country: text("country"), countryCode: text("countryCode"),
    regionName: text("regionName"), city: text("city"), isp: text("isp"), org: text("org"),
    as: text("as"), lat: coordinate("lat"), lon: coordinate("lon"), asname: text("asname"),
    proxy: flag("proxy"), hosting: flag("hosting"), mobile: flag("mobile"),
    continent: text("continent"), continentCode: text("continentCode"), timezone: text("timezone"),
    offset: coordinate("offset") || (data.offset === 0 ? 0 : undefined), zip: text("zip"),
  }
}

export async function fetchIPInfo(address?: string): Promise<IPInfo | null> {
  try {
    const fields = "status,query,country,countryCode,regionName,city,lat,lon,isp,org,as,asname,mobile,proxy,hosting,continent,continentCode,timezone,offset,zip";
    const url = address
      ? `http://ip-api.com/json/${encodeURIComponent(address)}?fields=${fields}&lang=zh-CN`
      : `${API_URL}&fields=${fields}`;
    const response = await fetch(url, { timeout: 6 });
    if (!response.ok) return null;
    return parseIPInfo(await response.json(), address);
  } catch (error) {
    console.error("获取 IP 数据失败：", error);
    return null;
  }
}

/**
 * 获取国内出口IP（用于对比检测分流代理/旁路由）
 * 优先3322.net，2秒超时快速返回
 */
export async function fetchExitProbe(): Promise<{ address: string; source: string } | null> {
  for (const apiUrl of CHINA_IP_APIS) {
    try {
      const response = await fetch(apiUrl, { timeout: 2 });

      if (response.ok) {
        const text = await response.text().catch(() => "");
        // 尝试解析JSON或直接返回IP
        let ip = text.trim();
        try {
          const data = JSON.parse(text);
          ip = typeof data.ip === "string" ? data.ip : "";
        } catch { /* 纯文本接口直接返回地址 */ }
        if (isPublicExitAddress(ip)) {
          return { address: ip, source: new URL(apiUrl).hostname };
        }
      }
    } catch (error) {
      continue;
    }
  }

  console.log("[IP检测] 出口探针暂不可用");
  return null;
}

export async function fetchChinaIP(): Promise<string | null> {
  return (await fetchExitProbe())?.address ?? null;
}

export function calculateRiskValue(ipInfo: IPInfo, chinaIP: string | null = null) {
  let riskValue = 0;

  // 使用新的VPN检测方法（含IP对比）
  const vpnStatus = detectVPNStatus(ipInfo, chinaIP);

  // ISP分析
  const ispAnalysis = analyzeISP(ipInfo.isp, ipInfo.org);

  // 风险计算
  if (vpnStatus.isVPN || vpnStatus.isProxy) {
    riskValue += vpnStatus.confidence * 0.5;
  }

  if (ispAnalysis.isDataCenter) {
    riskValue += 20;
  }

  if (ispAnalysis.isHomeBroadband) {
    riskValue -= 15;
  }

  if (RISK_KEYWORDS.highRiskCountries.some(kw => ipInfo.country.includes(kw))) {
    riskValue += 25;
  }

  riskValue = Math.max(0, Math.min(100, riskValue));

  // 状态显示文本
  let vpnStatusText = "未连接";
  if (vpnStatus.isVPN) {
    vpnStatusText = "已连接";
  } else if (vpnStatus.isProxy) {
    vpnStatusText = vpnStatus.proxyType;
  }

  return {
    riskValue: Math.round(riskValue),
    isHomeBroadband: ispAnalysis.isHomeBroadband ? "家宽" : "非家宽",
    vpnStatus: vpnStatusText
  };
}
