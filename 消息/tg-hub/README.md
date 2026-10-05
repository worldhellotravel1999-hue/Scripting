# tg-hub（Scripting / iOS 版）

基于 [jackwener/tg-cli](https://github.com/jackwener/tg-cli) 的 Telegram 本地优先数据技能，
适配 Scripting 应用的 iOS 环境：**不依赖 uv / 子进程**，通过脚本内的 `Python.run` 进程内调用。

> 本目录已内置于 `TG Hub` 脚本包中，随 `.scripting` 一起分发。

## 目录

```
tg-hub/
├── scripts/            # 原 tg-hub 包（config / db / client / exceptions）
├── vendor/             # telethon 1.42 + pyaes + rsa + pyasn1（纯 Python，iOS 可直接用）
├── vendor_bootstrap.py # 把 vendor 与包根目录加入 sys.path
├── tg_net.py           # 常驻单连接管理（登录不掉线的关键，见下文）
├── tg_api.py           # JSON 命令行 API（面板与脚本的唯一入口）
├── __test_fix.py       # 登录检测 / 单连接的回归验证脚本
├── probe_connect.py    # Telegram 连通性探针
└── README.md
```

数据默认落在 App Group：`~/.tg-hub/messages.db`（SQLite）、`~/.tg-hub/tg_hub.session`。

## 调用方式

```python
import sys
sys.path.insert(0, "<本目录>")
import tg_api
tg_api.dispatch("<命令>", "<JSON 参数>")   # 打印单行 @@TG@@{...}
```

命令：

| 类型 | 命令 |
|------|------|
| 状态 / 登录 | `status`、`send_code`、`sign_in`、`password`、`logout` |
| 在线 | `list_chats`、`sync`、`refresh` |
| 离线（本地 SQLite） | `stats`、`local_chats`、`search`、`filter`、`today`、`recent`、`top_senders`、`timeline`、`delete_chat`、`set_api`、`shutdown` |

示例：

```bash
python3 tg_api.py status '{}'
python3 tg_api.py search '{"keyword":"招聘","hours":24}'
```

## 与原版的差异

1. **依赖**：去掉 uv / venv，三方库放在 `vendor/`，由 `vendor_bootstrap` 注入 `sys.path`。
2. **`_connect(interactive=False)`（默认）**：不再触发 stdin 交互式登录，未授权抛
   `NotAuthenticatedError`（友好中文提示）；只有 `login()` 走终端交互登录。
3. **登录流程改为非交互**：`send_code` → `sign_in`（可选 `password`），
   `phone_code_hash` 暂存在 `~/.tg-hub/login_state.json`，供面板分步登录使用。
4. **JSON 输出**：`dispatch()` 捕获所有异常并以 `@@TG@@{...}` 单行返回。
5. **常驻单连接（`tg_net.py`）**：所有联网命令复用同一条 Telegram 主连接。
   Telegram 规定同一登录会话只允许一条主连接，一旦出现并行/残留的第二条连接
   （旧实现“每条命令 connect→disconnect”，以及超时后后台仍在连的客户端），
   服务端会返回 `AUTH_KEY_DUPLICATED` 并**直接吊销该会话**——即“刚登录就被登出”。
6. **登录检测三态**（`status`）：
   - 本地无登录密钥 → **不联网**直接判定未登录（启动秒出）；
   - 本地有密钥 → 联网确认：服务端明确吊销才清本地回登录页；
   - **网络不可用 → 信任本地会话保持已登录**（不因网络抖动误踢回登录页，
     避免诱使用户反复登录——反复登录正是被服务端批量登出的诱因）。
7. **`logout` 只动本机**：删本地 session 文件，**不调用 `auth.logOut`**，
   从机制上保证不会波及手机等其他已登录设备。

## 面板

配套界面即上层脚本 `TG Hub/`（概览 / 会话 / 消息 / 排行 / 同步 / 设置 六个标签），
它通过 `api.ts` 把 `TG_ROOT` 指向 `<脚本目录>/tg-hub`。

> ⚠️ iOS 的 Python 解释器是**常驻**的（`sys.modules` 跨命令保持），
> 修改本目录代码后面板会自动 `importlib.reload` 我们自己的模块（telethon 不重载），
> 若你在终端里直接 `import`，也请记得 `importlib.reload`。

## 风控建议

- 尽量在 my.telegram.org 自备 api_id / api_hash：可在面板「设置 → API 凭证」保存到
  `~/.tg-hub/api.json`（0600），或用环境变量 `TG_API_ID` / `TG_API_HASH`（须成对；当前默认公共凭证 api_id=2040）。
- **不要在已有登录会话的情况下更换 api_id/api_hash**：换凭证会重建连接并可能迫使重新登录，
  而每一次手机号登录都是风控事件。
- 面板每次调用带 `__timeout`，`dispatch` 用守护线程 join 兜底（Python.run 不支持超时），超时返回 `etype=Timeout`。
- 日常用 `refresh`（每会话 ≤500 条、间隔 1 秒），首次全量用 `sync` 并控制 limit。
- 读操作（搜索 / 统计 / 排行）完全离线，风险最低。
