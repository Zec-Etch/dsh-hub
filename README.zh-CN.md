# DSH Hub

[English](README.md)

一个常驻服务器的轻量 Web 服务，加一个 DeepSeek Harness（DSH）插件。各台 DSH 主动连上 hub，浏览器登录后选择一台后端，直接使用它**完整的原版 Web 界面**：所有页面、设置、终端、文件、插件 UI 都来自后端自己，hub 只负责转发，并在外层补上 PWA 和手机适配，不修改 DSH。

```
浏览器 ──HTTPS/WSS──▶ dsh-hub（服务器）◀──WSS 出站长连接── dsh-hub-agent 插件（各台 DSH）
       /h/<id>/*                字节隧道             └▶ 本机 DSH Web 服务
```

- [`hub/`](hub/)：服务端、登录和后端选择页、[移动端外壳](hub/public/shell/)。唯一的运行时依赖是 `ws`，前端不用构建。
- [`plugin/`](https://github.com/Zec-Etch/dsh-hub/tree/v0.2.1/plugin)：DSH 插件，零依赖。用这台 DSH 自己的浏览器会话重放请求，所以 DSH 版本升级、新增插件都不需要改 hub。

[agent mux](https://github.com/Zec-Etch/dsh-hub/blob/v0.2.1/plugin/mux.js) 和 [server mux](hub/mux.mjs) 必须完全一致，测试会检查。

> 这是独立的非官方项目，不包含 DeepSeek Harness 的任何代码，与其作者无关联。

## v0.2.1：先选对发布包

| 组件 | 兼容要求 | 安装/下载 |
| --- | --- | --- |
| DSH 客户端 bundle **`dsh-hub-agent`**（仓库根包） | DSH **`>=0.2.2-rc.1 <0.3.0`**；agent 运行时 **Node.js >=22** | DSH 安装源 `github:Zec-Etch/dsh-hub#v0.2.1`，或 [dsh-hub-agent-0.2.1.tgz](https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz) |
| 独立 hub 服务端 | **Node.js >=20**，**推荐 22**；Docker 镜像使用 22 | [dsh-hub-server-0.2.1.tar.gz](https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-server-0.2.1.tar.gz)，或源码 tag `v0.2.1` |

客户端 tgz **不是服务端**。服务端归档解压后顶层是 `dsh-hub-server-0.2.1/`，包含 [`hub/`](hub/)、[`docs/`](docs/)、双语 README、[LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [SECURITY.md](SECURITY.md)。服务端唯一运行时依赖是 `ws`；前端免构建，不打包 DSH 私有代码。

## 部署 hub

首次生产部署请按[中文部署指南](docs/deployment.zh-CN.md)（[English](docs/deployment.md)）操作：含下载/checkout tag、Docker/Compose 初始化、DNS、Caddy HTTPS/WebSocket、权限、systemd/MCSManager、备份升级和故障恢复的完整命令。

以下仅用于本机 Node.js 快速验证；从解压目录或源码根目录开始：

```sh
cd hub
npm ci --omit=dev
export DSH_HUB_DATA="$PWD/data"
node server.mjs set-password   # 输出新生成的随机密码，请私下保存
node server.mjs serve          # 默认 127.0.0.1:8790；前台运行
```

不要向公网开放这个 HTTP 端口。生产环境应使用可信的 TLS 反向代理，设置 `DSH_HUB_PUBLIC_ORIGIN=https://hub.example.com` 和 `DSH_HUB_TRUST_PROXY=1`，数据目录放在发布目录之外并持久化。远程 agent、PWA 和 Service Worker 要求 HTTPS。提供的 [Compose 配置](hub/deploy/compose.yaml) **只发布 `127.0.0.1:8790`**，以非 root 运行，用命名卷持久化 `/data`。

**推荐的保守密码轮换流程：先停止 hub，再以同一服务用户、同一数据目录/卷运行 `set-password`，最后启动 hub。** 完成该流程后，旧密码和所有旧浏览器会话失效。这是运维建议，不表示密码变更在功能上必须重启才能生效。不要让两个提供服务的 hub 实例共用数据目录。详见[运维操作](docs/deployment.zh-CN.md#运维操作)。

## 安装并接入一台 DSH

1. 在**每台 DSH 的插件/bundle 安装器**中安装 **`github:Zec-Etch/dsh-hub#v0.2.1`**。也可在安装器中粘贴 [Release tgz URL](https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz)，或下载后安装其本地绝对路径。安装后的 bundle 名为 `dsh-hub-agent`；对服务端运行 npm 安装并不会启用 DSH 插件。

   ```text
   https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz
   ```
2. 登录 HTTPS hub，在选择页点「接入新后端」，输入名称，复制**只显示一次**的 JSON。
3. 将 JSON 私下保存到**运行 DSH 的后端机器**的 `$DSH_HOME/dsh-hub-agent.json`。未设置 `DSH_HOME` 时，是 DSH 进程用户的 `~/.dsh/dsh-hub-agent.json`，不是浏览器所在电脑的家目录。POSIX 目录权限 `0700`、文件 `0600`；Windows 用 ACL 限制为该账号。详见[凭据配置](docs/deployment.zh-CN.md#接入-agent)。
4. bundle 加载后，配置变化约 5 秒内自动生效，无需为修改凭据重启 DSH。等待后端显示在线，再打开检查 GUI 和终端。

URL/token 缺失或无效时 agent 保持空闲。远程连接必须用 `https`/`wss`，生产环境不要开启不安全覆盖选项。连接由后端**主动出站**发起，不需要给 DSH 开放入站转发端口。把 JSON 当作密码保管：不要将真实内容放进日志、截图、Issue 或仓库。

该 bundle 会把这台 DSH 的文件夹选择器固定为应用内版本（`directory-picker-browse`），电脑上的 DSH 也一样。原生对话框只会弹在后端屏幕上，远程打开时等于卡死。

## 安全模型

**hub 登录等同于这台电脑的完整控制权。** 通过 hub 能用终端、读写文件、改设置、管理插件和凭据，没有接口白名单。详见 [SECURITY.md](SECURITY.md)。

- **密码是唯一的门。** 使用足够长的随机密码；一旦泄露，建议按上述保守流程停止 hub，用同一持久化数据运行 `set-password`，再启动 hub。完成该流程后，旧密码和所有旧浏览器会话失效。
- **hub 和 TLS 反代都在信任边界内。** HTTPS/WSS 在反代终结，再转发给 hub，两者都能看到流量；控制它们的人可以操作所有已连接的 DSH。使用可信机器，并保护反代到 hub 的链路。
- 浏览器：scrypt 密码、HttpOnly + SameSite=Strict Cookie、登录限速、WebSocket 和写请求的 Origin 校验。hub 的 Cookie 不会穿过隧道，DSH 的 Cookie 也不会到浏览器。
- 后端：每台独立的 256 位令牌，hub 只存哈希；令牌走首帧，不进 URL 和访问日志；可随时吊销。
- 所有后端共用一个来源。本地存储按后端加前缀是使用便利措施，不是互不可信后端之间的安全隔离；只接入你信任的机器。

## 移动端和 PWA

原版界面没有手机布局，[移动端外壳](hub/public/shell/)在不改 DSH 的前提下补上这一层。选择器只用 CSS Module 名称里的语义部分（如 `_sidebarCol`）和 DSH 的 `data-*` 状态属性，DSH 重新构建后哈希变化也不受影响。设计说明和 iOS 上的发现见 [docs/mobile-shell.md](docs/mobile-shell.md)。

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

浏览器回归不属于 `npm test`。[触屏样式回归](hub/test-browser/touch-styles.mjs) 只需已有的 `ws` 依赖，以及仅在回环地址开放远程调试的独立 Chromium 测试浏览器：

```sh
# 从 hub/ 执行；独立测试浏览器已在回环端口 9333 监听：
CDP_URL=http://127.0.0.1:9333 node test-browser/touch-styles.mjs public/shell/boot.js
```

原有的[手机输入回归](hub/test-browser/shell-input.mjs) 额外需要可选开发工具 `playwright-core`，它不是服务端运行时依赖。不要公开暴露浏览器调试端口，也不要用保存真实凭据的浏览器运行这些测试。

## 许可证

[Apache License 2.0](LICENSE)
