import { AppIntentManager, AppIntentProtocol, Script } from "scripting";

export const RefreshIPIntent = AppIntentManager.register({
    name: "RefreshIPIntent",
    protocol: AppIntentProtocol.AppIntent,
    perform: async () => {
        // 打开页面执行一整轮检测，再统一更新 IP / 地图 / 风险 / 服务状态。
        // 单纯重载 widget 只会重画旧快照，无法完成重新检测。
        const opened = await Safari.openURL(Script.createRunURLScheme(Script.name));
        if (!opened) console.log("[IP检测] 请打开脚本重新检测");
    }
});
