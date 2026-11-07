# DSH Hub

[English](README.md)

一个常驻服务器的轻量 Web 服务，加一个 DeepSeek Harness（DSH）插件。各台 DSH 主动连上 hub，浏览器登录后选择一台后端，直接使用它**完整的原版 Web 界面**：所有页面、设置、终端、文件、插件 UI 都来自后端自己，hub 只负责转发，并在外层补上 PWA 和手机适配，不修改 DSH。

```
浏览器 ──HTTPS/WSS──▶ dsh-hub（服务器）◀──WSS 出站长连接── dsh-hub-agent 插件（各台 DSH）
       /h/<id>/*                字节隧道             └▶ 本机 DSH Web 服务
```

- `hub/`：服务端、登录和后端选择页、移动端外壳（`public/shell/`）。唯一的运行时依赖是 `ws`，前端不用构建。
- `plugin/`：DSH 插件，零依赖。用这台 DSH 自己的浏览器会话重放请求，所以 DSH 版本升级、新增插件都不需要改 hub。

`plugin/mux.js` 和 `hub/mux.mjs` 必须完全一致，测试会检查。

> 这是独立的非官方项目，不包含 DeepSeek Harness 的任何代码，与其作者无关联。

## 部署 hub

需要 Node.js 20 或更高版本。

```sh
cd hub && npm ci --omit=dev
DSH_HUB_DATA=/var/lib/dsh-hub node server.mjs set-password   # 生成并打印一次访问密码
DSH_HUB_DATA=/var/lib/dsh-hub node server.mjs serve          # 默认只监听 127.0.0.1:8790
```

生产环境放在 TLS 反向代理后面，可参考 [dsh-hub.service](hub/deploy/dsh-hub.service) 和 [Caddyfile.example](hub/deploy/Caddyfile.example)。PWA 和 Service Worker 要求 HTTPS。

用 MCSManager 托管时，参考 [mcsm-instance.example.json](hub/deploy/mcsm-instance.example.json)：docker 实例，代码挂到 `/app`，数据目录挂到 `/data`。daemon 会把实例目录自动挂到工作目录，所以 `workingDir` 保持 `/workspace`，不要把 `/app` 当工作目录，否则会报 `Duplicate mount point`。

| 环境变量 | 作用 |
| --- | --- |
| `DSH_HUB_DATA` | 数据目录，默认 `./data` |
| `HOST` / `PORT` | 监听地址，默认 `127.0.0.1:8790` |
| `DSH_HUB_PUBLIC_ORIGIN` | 对外地址，例如 `https://hub.example.com`；用于 Origin 校验和 Secure Cookie |
| `DSH_HUB_TRUST_PROXY` | 设为 `1` 时信任反代的 `X-Forwarded-For`。在反代后面必须开启，否则所有人共用一个登录限速桶 |
| `DSH_HUB_PASSWORD` | 配合 `set-password` 指定密码，至少 10 个字符 |

改密码会让所有已登录的浏览器失效。`hub/public/` 下的静态文件每次请求都从磁盘读取，改前端不需要重启；改 `server.mjs` 需要。

## 接入一台 DSH

1. 在 DSH 上安装 `plugin/` 这个 bundle。
2. 在选择页点「接入新后端」，得到一段只显示一次的 JSON。
3. 把它存成该 DSH 的 `$DSH_HOME/dsh-hub-agent.json`，几秒内自动连上，不需要重启。

没有这个文件时插件保持空闲。非回环地址必须用 `https`/`wss`，否则插件拒绝连接。

该 bundle 会把这台 DSH 的文件夹选择器固定为应用内版本（`directory-picker-browse`），电脑上的 DSH 也一样。原生对话框只会弹在后端屏幕上，远程打开时等于卡死。

## 安全模型

**hub 登录等同于这台电脑的完整控制权。** 通过 hub 能用终端、读写文件、改设置、管理插件和凭据，没有接口白名单。详见 [SECURITY.md](SECURITY.md)。

- **密码是唯一的门。** 用足够长的随机密码；一旦泄露，立刻运行 `set-password`，旧密码和所有登录随即失效。
- **hub 在信任边界内。** TLS 在 hub 终结，hub 能看到全部内容，拿下 hub 的人可以操作所有已连接的 DSH。部署到你信任的机器上。
- 浏览器：scrypt 密码、HttpOnly + SameSite=Strict Cookie、登录限速、WebSocket 和写请求的 Origin 校验。hub 的 Cookie 不会穿过隧道，DSH 的 Cookie 也不会到浏览器。
- 后端：每台独立的 256 位令牌，hub 只存哈希；令牌走首帧，不进 URL 和访问日志；可随时吊销。
- 所有后端共用一个来源，所以 DSH 的本地存储按后端加了前缀，会话状态不会串台。

## 移动端和 PWA

原版界面没有手机布局，`hub/public/shell/` 在不改 DSH 的前提下补上这一层。选择器只用 CSS Module 名称里的语义部分（如 `_sidebarCol`）和 DSH 的 `data-*` 状态属性，DSH 重新构建后哈希变化也不受影响。设计说明和 iOS 上的发现见 [docs/mobile-shell.md](docs/mobile-shell.md)。

| 屏幕 | 布局 |
| --- | --- |
| 宽 < 768，或触屏且设备高度 ≤ 500 | 单栏；侧栏变抽屉，支持边缘滑动；设置页变单栏全屏 |
| 平板、桌面 | DSH 原版多栏 |

- 软键盘：用 `visualViewport` 让页面跟随可见区域，输入框不会被遮挡，也不会触发 iOS 缩放。
- 触屏：悬停才出现的操作保持可见，这条规则在运行时扫描样式表，第三方插件也生效；触控目标加大；隐藏键盘快捷键提示；输入框上的工具栏按钮不再唤起键盘。
- 终端：有焦点时在键盘上方显示 Esc、Tab、方向键、Ctrl+C/D/L。
- 刘海和手势条安全区、横屏、深浅色、减少动效。
- PWA：可安装、离线时能打开选择页、重新打开时回到上次的后端。Service Worker 不缓存后端内容和 API，避免把过期会话显示成在线状态。
- 诊断：长按菜单按钮会弹出面板，显示视口、安全区和输入框事件读数，方便反馈设备相关的布局问题。

## 已知限制

- 「在应用中打开」「显示文件位置」「打开配置文件」在**后端电脑**上执行，这是这些功能的定义。
- 右侧边栏的浏览器在**手机**上加载网址，`localhost` 指手机自己，不是后端。
- 语音输入需要 HTTPS 下的麦克风权限；hub 不限制，由浏览器决定。
- iOS 主屏幕应用的窗口可能比屏幕矮一截，那一条用不了（见移动端说明）。

## 测试

```sh
cd hub && npm test
```

Windows 的受限环境里无法创建子进程时，改用 `node --test --test-isolation=none test/hub.test.mjs`。

手机外壳的浏览器回归检查在 [`hub/test-browser/`](hub/test-browser/shell-input.mjs)，需要带远程调试的 Chromium 和 `playwright-core`，不属于 `npm test`。

## 许可证

[Apache License 2.0](LICENSE)
