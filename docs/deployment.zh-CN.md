# 部署 DSH Hub v0.2.1

[English](deployment.md) · [项目 README](../README.zh-CN.md)

## 范围与前提

登录 hub 就拥有**所有已连接 DSH 后端的完整控制权**，包括终端、文件、设置、插件和凭据。请像保护 SSH 控制面一样保护 hub、TLS 反代、数据备份和 agent JSON 凭据。参见 [SECURITY.md](../SECURITY.md)。本项目独立、非官方，不包含 DSH 私有代码。

以下命令适用于 **Linux/POSIX shell**，示例域名统一为占位符 `hub.example.com`，请替换为你控制的域名。每个数据目录只能有**一个 hub 写入进程**；Compose、普通 Docker、原生/systemd 三种模式**任选一种**，不要同时启动。

- 服务端：**Node.js >=20**，**推荐 22**；唯一运行时依赖是 `ws`，静态前端**无需构建**。
- agent：DSH **`>=0.2.2-rc.1 <0.3.0`**；运行 agent 的环境需 **Node.js >=22**（全局 WebSocket）。这比服务端要求更高。
- 容器模式：Docker Engine、Compose v2。无需预先发布的镜像，直接用发布文件本地构建。
- 原生/systemd：Node.js/npm、独立非 root 服务账号，以及安装服务所需的管理员权限。
- 可信 TLS 反代（下文示例为 Caddy）、DNS，以及签发证书通常需要的入站 TCP 80/443。agent 只需出站 HTTPS/WSS 到 hub；**不要**暴露 DSH 后端端口。

## 1. 获取服务端

以下两种方式**任选一种**；后续命令从得到的顶层目录执行。客户端包 `dsh-hub-agent-0.2.1.tgz` 不是独立服务端。

### Release 归档

```sh
curl --fail --location --remote-name \
  https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-server-0.2.1.tar.gz
tar -tzf dsh-hub-server-0.2.1.tar.gz   # 解压前检查目录结构
tar -xzf dsh-hub-server-0.2.1.tar.gz
cd dsh-hub-server-0.2.1
```

只从可信的 [v0.2.1 Release](https://github.com/Zec-Etch/dsh-hub/releases/tag/v0.2.1) 下载；若提供校验和，解压前先验证。归档顶层为 `dsh-hub-server-0.2.1/`，包含 [`hub/`](../hub/)、[`docs/`](./)、双语 README、[LICENSE](../LICENSE)、[NOTICE](../NOTICE) 和 [SECURITY.md](../SECURITY.md)，不含 DSH 应用，也不需要其源码。

### 源码 tag

```sh
git clone --branch v0.2.1 --depth 1 \
  https://github.com/Zec-Etch/dsh-hub.git dsh-hub-server-0.2.1
cd dsh-hub-server-0.2.1
git describe --tags --exact-match   # v0.2.1
```

不要部署会变化的默认分支。服务端依赖安装应在 `hub` 目录进行，不是在仓库根部的客户端包中。

## 2. 选择一种服务端运行方式

### 方案 A：Docker Compose（推荐）

[Dockerfile](../hub/Dockerfile) 使用 Node 22 Alpine，以 `npm ci --omit=dev --ignore-scripts` 安装锁定的生产依赖，只复制服务端运行/静态文件，以 `node` 用户（UID/GID 1000）运行。entrypoint 是 `node server.mjs`，默认参数是 `serve`；下面的 **`set-password` 用来替换默认参数**，不要再加一遍 `node server.mjs`。

[Compose 配置](../hub/deploy/compose.yaml) 用独立命名卷 **`dsh-hub-data`** 持久化 `/data`，容器根文件系统只读、丢弃 capabilities，并继承镜像的 `/healthz` 健康检查。宿主机端口**只绑定 `127.0.0.1:8790`**。容器内部 `HOST=0.0.0.0` 是接收映射流量所需，不会改变宿主机的回环绑定。这里假设 Caddy 在同一宿主机运行。

从发布根目录执行：

```sh
export DSH_HUB_PUBLIC_ORIGIN=https://hub.example.com
docker compose -f hub/deploy/compose.yaml config --quiet
docker compose -f hub/deploy/compose.yaml build
# 仅首次初始化；此时不应有 hub 服务在运行。
docker compose -f hub/deploy/compose.yaml run --rm --no-deps hub set-password
# 将随机密码私下保存后再继续。
docker compose -f hub/deploy/compose.yaml up -d hub
docker compose -f hub/deploy/compose.yaml ps
curl --fail http://127.0.0.1:8790/healthz   # ok
```

初始化会在终端输出一次新生成的随机密码。请在本机私密终端操作，不要在 CI、共享日志或录屏会话中执行，并存入密码管理器；不要把密码提交到配置。换 shell 后运行任何 Compose 命令前，需重新 export 同一个 `DSH_HUB_PUBLIC_ORIGIN`；配置会在缺失时主动报错。如使用本地环境文件，请限制其权限并排除版本控制。

新命名卷会继承镜像中 `/data` 的属主；已存在或恢复后权限错误的卷，见[数据与权限](#数据与权限)。不同 hub 安装必须使用不同卷名；仅改变 Compose 项目名或发布目录**不会**隔离这个显式命名卷。

### 方案 B：普通 Docker

与 Compose **二选一**。从发布根目录执行：

```sh
export DSH_HUB_PUBLIC_ORIGIN=https://hub.example.com
docker build --tag dsh-hub-server:0.2.1 --file hub/Dockerfile hub
docker volume create dsh-hub-data
docker run --rm \
  --mount type=volume,source=dsh-hub-data,target=/data \
  dsh-hub-server:0.2.1 set-password
# 私下保存随机密码，然后启动服务。
docker run --detach --name dsh-hub --init --restart unless-stopped \
  --publish 127.0.0.1:8790:8790 \
  --mount type=volume,source=dsh-hub-data,target=/data \
  --env DSH_HUB_PUBLIC_ORIGIN --env DSH_HUB_TRUST_PROXY=1 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  dsh-hub-server:0.2.1
curl --fail http://127.0.0.1:8790/healthz
```

镜像自带健康检查，可用 `docker inspect --format '{{.State.Health.Status}}' dsh-hub` 查看。容器和镜像可替换，命名卷不可当作临时数据删除；升级或清理时不要删除数据卷。

### 方案 C：原生 Node.js + systemd

以下假设 Linux 首次安装、当前目录为发布根目录，且 Node 路径为 `/usr/bin/node`。若实际不同，需同时修改下列命令和 unit 中的 `ExecStart`。代码与可写状态分离：

```sh
sudo useradd --system --user-group --home-dir /var/lib/dsh-hub \
  --shell /usr/sbin/nologin dsh-hub
sudo install -d -m 755 /opt/dsh-hub
sudo cp -a . /opt/dsh-hub/
sudo install -d -o dsh-hub -g dsh-hub -m 700 /var/lib/dsh-hub
cd /opt/dsh-hub/hub
sudo npm ci --omit=dev --ignore-scripts
# 按本指南的保守流程，初始化/轮换时保持服务停止。
sudo -u dsh-hub env DSH_HUB_DATA=/var/lib/dsh-hub \
  /usr/bin/node /opt/dsh-hub/hub/server.mjs set-password
```

私下保存随机密码。安装并编辑已有的 [systemd unit](../hub/deploy/dsh-hub.service)：

```sh
sudo cp deploy/dsh-hub.service /etc/systemd/system/dsh-hub.service
sudoedit /etc/systemd/system/dsh-hub.service
```

**启动前显式设置/核对安装后的 unit 中以下指令**，替换原值，不要再追加第二条 `ExecStart`。归档内包含 `hub` 子目录，不要把入口误设为 `/opt/dsh-hub/server.mjs`；将占位域名改为实际 HTTPS origin：

```ini
[Service]
User=dsh-hub
WorkingDirectory=/opt/dsh-hub/hub
ExecStart=/usr/bin/node /opt/dsh-hub/hub/server.mjs serve
Environment=DSH_HUB_DATA=/var/lib/dsh-hub
Environment=DSH_HUB_PUBLIC_ORIGIN=https://hub.example.com
ReadWritePaths=/var/lib/dsh-hub
```

然后启动安装后的服务：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-hub
sudo systemctl status dsh-hub --no-pager
curl --fail http://127.0.0.1:8790/healthz
```

示例 unit 已设 `HOST=127.0.0.1`、`PORT=8790`、`DSH_HUB_TRUST_PROXY=1`，仅允许写 `/var/lib/dsh-hub`。代码与依赖必须对服务用户可读，不要安装在其他用户的私有家目录。以后在维护窗口将依赖安装到新发布目录，不要对正在运行的安装执行 `npm ci`。

### MCSManager 参考

保留的 [MCSManager 示例](../hub/deploy/mcsm-instance.example.json) 是起点，不是可直接套用的宿主机配置。已受管实例应通过 MCSManager 启停/重启，不要再用 `docker stop/restart` 争抢生命周期。

- 示例使用 Node 22、`runAs=1000:1000`、宿主机回环端口绑定，`/app` 挂载代码、`/data` 挂载状态。启动前用兼容运行时在代码目录执行 `npm ci --omit=dev --ignore-scripts`。
- 示例 `/opt/dsh-hub|/app` 假设宿主机此目录直接包含服务端入口文件。若采用上面的原生目录布局，应改成 `/opt/dsh-hub/hub|/app`。数据 bind mount 的属主应为 UID/GID 1000，目录权限 `0700`。
- `workingDir` 保持 `/workspace`：MCSManager 会把实例目录自动挂到该工作目录；再将隐式工作目录设为 `/app`，可能出现 `Duplicate mount point`。
- 在受管实例**已停止**时，以相同代码、运行时、用户和数据挂载初始化密码。采用上述原生目录布局时，管理员可运行下面的一次性命令（不是启动受管服务）：

```sh
docker run --rm --user 1000:1000 \
  --mount type=bind,source=/opt/dsh-hub/hub,target=/app,readonly \
  --mount type=bind,source=/var/lib/dsh-hub,target=/data \
  --workdir /app --env DSH_HUB_DATA=/data \
  node:22-alpine node server.mjs set-password
```

在实例环境中设置实际 public origin，再从 MCSManager 启动并检查健康。示例路径都应按自己的宿主机调整，不要复制他人的集群地址或凭据。

## 3. DNS 与 HTTPS 反向代理

1. 为域名设置指向自己服务器公网地址的 DNS A 记录；只有 IPv6 路由和防火墙确实可用时才发布 AAAA。
2. 允许入站 80/443 到 Caddy，以便签发证书和提供 HTTPS。**不要**向公网放行 8790，检查是否误发布成 `0.0.0.0:8790` 或 `[::]:8790`。
3. Caddy 与 hub 同宿主机时，参考 [Caddy 示例](../hub/deploy/Caddyfile.example)，替换域名：

```caddyfile
hub.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

Caddy 会自动申请 TLS 证书、将 HTTP 重定向至 HTTPS，并支持 WebSocket upgrade，无需额外 upgrade 指令。不要删除 `Origin`、禁用升级、缓存已认证/隧道内容，也不要额外添加路径前缀：hub 应部署在 origin 根路径。反代必须根据直接客户端覆盖转发头；如前面还有代理，显式配置其可信范围。

修改既有反代配置前先备份；使用 `caddy validate --config /etc/caddy/Caddyfile` 验证后，通过原有服务管理器 reload。如果 Caddy 在另一个容器中，其 `127.0.0.1` **不是**宿主机，应使用私有共享容器网络和对应 upstream，不要为图方便新增公网 HTTP 绑定。跨宿主机反代应使用受防火墙限制的私有链路；不可信链路还需 TLS。提供的回环示例刻意限定为同宿主机。

从另一台机器验证，正常校验证书：

```sh
curl --fail https://hub.example.com/healthz   # ok
```

再打开 `https://hub.example.com` 登录、接入 agent。不要用 `curl -k` 掩盖证书问题。`/healthz` 无需登录，只证明进程存活，**不能**证明 TLS、登录或 DSH 隧道正常。

## 环境变量

这些变量必须设置到 **hub 进程/容器**；systemd/MCSManager 不会自动继承你交互 shell 里的 export。

| 变量 | 默认值/作用 |
| --- | --- |
| `DSH_HUB_DATA` | 默认 `./data`，相对进程工作目录。生产使用绝对持久化路径；镜像为 `/data`。其中保存敏感状态文档。 |
| `HOST` | 原生默认 `127.0.0.1`；镜像使用 `0.0.0.0` 接收容器映射流量。宿主机发布仍应只绑定回环。 |
| `PORT` | 默认 `8790`。若修改，应同时调整映射、反代 upstream 和探针。 |
| `DSH_HUB_PUBLIC_ORIGIN` | 浏览器实际 origin，如 `https://hub.example.com`，不含路径/query。用于 Origin 校验和 Secure Cookie；生产显式设置。 |
| `DSH_HUB_TRUST_PROXY` | 仅字面值 `1` 开启信任 `X-Forwarded-For`。可信反代后启用，避免所有客户端共享一个限速桶。应用不按代理 IP 做白名单校验，因此必须阻止直连并由反代清理该头。 |
| `DSH_HUB_PASSWORD` | **仅 `set-password` 使用**，不是 `serve` 的登录配置。未设置时生成随机密码并输出；指定时至少 10 字符，应使用更长的随机值。不要把明文写入 shell 历史、Compose 或仓库。 |

给 `serve` 换一个密码变量、或仅改环境文件，不会轮换持久化密码。请按下文停服轮换步骤操作。

## 数据与权限

状态文档包含密码/令牌哈希、后端注册和会话签名密钥。即使不存 agent 明文令牌，备份仍是敏感数据。备份整个目录，不要只挑字段；排障时不要打印其内容，也不要将数据目录放到公开静态目录内。

- 服务端新建目录权限 `0700`、状态文件 `0600`；已有目录的属主/权限仍需自己核对。
- 原生：属主应是服务账号。上例停服后可用 `sudo chown -R dsh-hub:dsh-hub /var/lib/dsh-hub` 和 `sudo chmod 700 /var/lib/dsh-hub` 修正，并确认状态文件为 `0600`。
- 容器 bind mount：首次使用前执行 `sudo install -d -o 1000 -g 1000 -m 700 /var/lib/dsh-hub`，再挂载到 `/data`。bind mount 不会继承镜像目录的属主。
- 已有命名卷可在 **hub 停止后**，用一次性维护容器修复：

```sh
docker run --rm --user 0:0 --entrypoint sh \
  --mount type=volume,source=dsh-hub-data,target=/data \
  dsh-hub-server:0.2.1 \
  -c 'chown -R node:node /data && chmod 700 /data && if [ -f /data/hub.json ]; then chmod 600 /data/hub.json; fi'
```

只有这个临时权限修复命令使用 root，常驻服务仍为非 root。不要用 `chmod 777`、privileged 或以 root 跑服务来掩盖权限问题。

## 接入 agent

1. 在**每台 DSH 后端**的插件/bundle 安装器中粘贴 **`github:Zec-Etch/dsh-hub#v0.2.1`**。也可粘贴下面的 Release tgz URL，或下载 [dsh-hub-agent-0.2.1.tgz](https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz) 后安装本地 tgz 的绝对路径。包名为 `dsh-hub-agent`，根 bundle 会应用 [cordis patch](https://github.com/Zec-Etch/dsh-hub/blob/v0.2.1/plugin/cordis.patch.yml)。不必在每个后端安装 hub 服务端。

```text
https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz
```

2. 登录 HTTPS hub，点「接入新后端」，起名并复制**只显示一次**的 JSON。令牌无法事后取回；丢失后应移除该后端并重新接入。
3. 在**运行 DSH 的机器上、以 DSH 的同一系统账号**，私下保存为 `$DSH_HOME/dsh-hub-agent.json`。未设置 `DSH_HOME` 时默认该进程用户的 `~/.dsh/dsh-hub-agent.json`。如果 DSH 自己运行在容器里，是其容器/挂载中的持久化 DSH home，不是宿主机上不相关的家目录。

格式示例，**不是可用凭据**：

```json
{
  "hubUrl": "https://hub.example.com",
  "token": "<paste-the-once-shown-token-privately>",
  "harnessName": "Example backend"
}
```

POSIX 后端可这样私下编辑，避免将令牌放入命令历史或打印：

```sh
umask 077
agent_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$agent_home"
chmod 700 "$agent_home"
"${EDITOR:-vi}" "$agent_home/dsh-hub-agent.json"   # 私下粘贴，保存合法 JSON
chmod 600 "$agent_home/dsh-hub-agent.json"
```

Windows 使用 DSH 进程的 `DSH_HOME`，未设置时用该用户 profile 中的 `.dsh`；通过 ACL 限制为该账号及可信系统管理员，不要假设 `chmod` 就能保护。不要在报告、命令输出或截图中包含真实凭据。

bundle 加载后约每 5 秒检查一次配置；无可用 URL/token 时保持空闲。远程 URL 必须用 `https`/`wss`，生产不要设置 `allowInsecure`。若也在插件配置中写了同名配置，它会覆盖 JSON，应清理旧覆盖值。令牌未知/已吊销（4401/4403）时停止重试，修改配置后才会重新连接；普通网络失败会退避重试，最长约一分钟。

确认后端显示在线，打开其原版 DSH GUI，进行无害操作并检查终端连接；这同时验证 WebSocket 隧道。无需为 DSH 做入站端口转发。

## 运维操作

以下示例假定沿用初始命名卷，shell 中仍 export 同一 `DSH_HUB_PUBLIC_ORIGIN`。请安排维护窗口：停止 hub 会中断浏览器隧道、终端和 agent 连接。后端任务可能独立继续，但客户端必须重连，不应承诺会话无感。

### 轮换登录密码

对于 **v0.2.1**，本指南推荐**保守的维护流程**：停止 hub，以同一服务身份和同一数据目录/卷运行 `set-password`，再启动 hub。这是运维建议，不表示密码变更在功能上必须重启才能生效。以下步骤统一采用此停服轮换流程。

```sh
# 从发布根目录执行：
docker compose -f hub/deploy/compose.yaml stop hub
docker compose -f hub/deploy/compose.yaml run --rm --no-deps hub set-password
docker compose -f hub/deploy/compose.yaml start hub
```

普通 Docker：`docker stop dsh-hub`，对同一个 `dsh-hub-data` 卷运行首次初始化时的 `docker run --rm --mount ... IMAGE set-password`，再 `docker start dsh-hub`。systemd：`sudo systemctl stop dsh-hub`，在已安装的服务端目录执行相同的 `sudo -u dsh-hub env DSH_HUB_DATA=... /usr/bin/node server.mjs set-password`，再 `sudo systemctl start dsh-hub`。MCSManager 通过面板停启，中间用匹配的一次性初始化命令改密码。

私下保存新密码；重启后旧密码和所有旧浏览器会话失效。agent 令牌仍有效；如 agent 令牌泄露，应在选择页移除该后端、重新接入并更新其私有 JSON。hub 主机若已被入侵，应在可信主机恢复并替换凭据，单纯改密码不构成修复。

### 备份

停掉唯一写入进程后再做一致性备份。记录代码版本、非秘密部署配置和 origin，安全保存整个数据目录的**加密/私有**副本。不要提交状态或备份到仓库。

Compose 示例，使用 POSIX shell 直接重定向二进制 tar 输出：

```sh
umask 077
mkdir -p backups
backup="backups/dsh-hub-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose -f hub/deploy/compose.yaml stop hub
docker run --rm --entrypoint tar \
  --mount type=volume,source=dsh-hub-data,target=/data,readonly \
  dsh-hub-server:0.2.1 -czf - -C /data . > "$backup"
tar -tzf "$backup" >/dev/null   # 成功验证后再继续
docker compose -f hub/deploy/compose.yaml start hub
```

任一归档命令失败都要先排查，不能将备份标为成功。原生等价流程：停止服务，执行 `umask 077; sudo tar -czf - -C /var/lib/dsh-hub . > "$backup"`，验证后启动。普通 Docker/MCSManager 同样按各自管理器执行“停止→归档→启动”。安全复制到异机并定期演练恢复，不要打印备份内容。

### 升级与回滚

1. 记录当前版本、环境、挂载和 origin，停服备份并验证。
2. 保留旧发布目录/镜像和备份，将**新 tag 发布解压到新目录**，不要覆盖运行时代码或删除卷。阅读迁移/兼容说明，必要时同步升级 agent。
3. Compose：旧服务停止后，在旧目录执行 `docker compose -f hub/deploy/compose.yaml down`，**不得加 `--volumes`/`-v`**。到新发布根目录构建新镜像、重新 export origin，复用同一命名卷，然后 `up -d hub`。常规升级**不要重新 `set-password`**。显式卷名不随项目目录变化；不要让旧服务仍能自动启动成第二个写入者。
4. 原生/systemd 或 MCSManager：通过管理器停服，在新服务端目录执行 `npm ci --omit=dev --ignore-scripts`，将管理器指向新代码及原有数据，再启动；保留属主和加固设置。
5. 验证本机/公网 `/healthz`、证书、登录、后端列表、GUI 和终端。仅探针绿色不代表端到端通过。
6. 新版验证失败时先停新版。只有数据向后兼容才可让保留的旧版直接读原数据；否则先将匹配的升级前备份恢复到空的新卷/目录。新旧版本不能同时写同一份状态。

### 恢复

先停服务，保留当前数据用于调查。恢复到**新建空卷**，不要直接覆盖/合并正在使用的状态：

```sh
# backup 设为此前已验证且私密保存的备份归档路径。
docker compose -f hub/deploy/compose.yaml stop hub
docker volume create dsh-hub-data-restored
docker run --rm --interactive --user 0:0 --entrypoint sh \
  --mount type=volume,source=dsh-hub-data-restored,target=/data \
  dsh-hub-server:0.2.1 \
  -c 'tar -xzf - -C /data && chown -R node:node /data && chmod 700 /data && chmod 600 /data/hub.json' \
  < "$backup"
```

每次恢复尝试使用不同的新卷名；只有解压成功才继续。将本地 [Compose 配置](../hub/deploy/compose.yaml) 中卷的 `name` 改成 `dsh-hub-data-restored`，使用与备份匹配的版本运行 `docker compose -f hub/deploy/compose.yaml up -d --force-recreate hub`。验证恢复前保留旧卷。普通 Docker 用新卷和原有设置重建已停止的容器。

原生/systemd：解压到空的替代目录，属主恢复为 `dsh-hub`，目录 `0700`、状态文件 `0600`；同时修改 unit 中的 **`DSH_HUB_DATA` 和 `ReadWritePaths`**，daemon-reload 后启动。MCSManager 停止时修改数据挂载，再通过面板启动。

恢复旧状态也会恢复旧密码、会话和令牌注册。按需在恢复后停服轮换密码；重新检查已吊销令牌，因为吊销前的备份可能让旧令牌复活。若整个数据目录丢失，不能恢复原令牌：需要初始化新 hub，并重新接入每台后端。

## 失败诊断

在本机用 `docker compose -f hub/deploy/compose.yaml logs --tail=100 hub`、`docker logs --tail=100 dsh-hub`、`journalctl -u dsh-hub -n 100 --no-pager` 或 MCSManager 控制台检查日志。对外分享前脱敏主机名、路径等元数据；不要 dump 环境文件、状态文档、Cookie 或 agent JSON。

| 症状 | 检查/处理 |
| --- | --- |
| `no password set` / 不断重启 | 停服后 `set-password`；确认初始化与服务使用完全相同的数据卷/目录，不要对空目录反复启动。 |
| `EACCES`、只读错误或重建后后端丢失 | 检查容器 UID/GID 1000 或原生服务用户、目录 `0700`、持久化 `/data` 挂载和剩余空间。代码可只读，数据不可只读；不要用 `chmod 777`。 |
| 本机 `/healthz` 不通 | 看进程/容器日志、端口冲突、`HOST`、`PORT` 和映射。Docker 内绑定 `127.0.0.1` 而非 `0.0.0.0` 会导致宿主机映射访问失败。 |
| 本机健康但 HTTPS 不通/反代 502 | 检查 DNS A/AAAA、防火墙 80/443、证书、Caddy upstream 和代理位置。容器回环不是宿主机回环；不要用公网暴露 8790 规避。 |
| 登录/写请求/列表 403 `origin` | 浏览器 scheme/host/port 必须与 `DSH_HUB_PUBLIC_ORIGIN` 一致；部署根路径、保留 `Origin`，环境改变后重启。 |
| 改环境变量后仍登录 401 | `serve` 不把 `DSH_HUB_PASSWORD` 当成改密码；对实际数据路径执行停服 `set-password` 流程。 |
| 登录 429 / 不同用户一起被限速 | 登录失败按客户端地址限制约 10 分钟。等待并检查密码、可信转发头；不要绕过 TLS 或限速。 |
| agent 一直 idle/offline | 检查 bundle 是否启用、Node >=22、DSH 用户的正确 `DSH_HOME`、合法私有 JSON、URL/token 和旧插件覆盖配置。检查出站 DNS/TLS/WSS 及 agent 日志，不打印凭据。 |
| agent 被拒 4401/4403 | 令牌未知/已吊销；按需重新接入并修改配置文件，仅等待或重启 hub 不会让令牌恢复。 |
| agent 4426 / 重复断线 | 将 agent/server 升级为兼容协议组合；4409 可能是两个 agent 共用令牌，每台后端应独立签发。 |
| 列表正常但终端/GUI 失败 | 反代需支持 `/ws/*` 和 `/h/*` 长连接 upgrade，不缓存、不删头、不设过短 idle timeout；再检查后端 DSH Web 服务和 agent 日志。 |
| 升级后手机/PWA 仍旧资源 | 确认服务端版本后重新加载/打开 PWA；反代不应缓存后端内容/API。见[移动端说明](mobile-shell.md)。 |

公开 Issue 不应包含真实凭据或私有集群细节；请提供版本、部署模式、脱敏配置、通过的健康检查以及失败步骤。
