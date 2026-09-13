# 项目外源码归档

本文记录源码搬迁，不是模块安装、生产迁移或新的运行状态。
本次来源固定为 `waksana/cockpit` 提交
`3548240b9283bc5ea022ccd55633ac0a8801eea3`。

## 本机保存位置

```text
/home/honglai/cockpit-extracted/2026-09-13-3548240b/
```

它位于 Cockpit 仓库和工作树之外，不参与 workspace、构建、测试发现或运行包。
这是执行本次搬迁的机器上的实际位置，不是其他使用者可访问的下载 URL。

| 目录 | 保存内容 |
| --- | --- |
| `modules/` | 原 `module-staging/` 全部内容，保持文件、通知、语音、会话整理、系统状态、重启便利、reset、Assistant、Task、微信等原分组。 |
| `main-updater/` | consumer 安装/更新/运行器、core 中的发行传输、consumer 协议和对应用例。 |
| `private-delivery/` | `.delivery` 工具集、私有 CI/CD 工作流、产包/接收/控制配置和原使用文档。 |
| `source-supervisor/` | 循环启动 wrapper 和配套参数工具。 |
| `host-configuration/` | 原 systemd/Nginx 示例，不是线上配置的拷贝。 |
| `mixed-originals/` | 原生功能和迁出接线混在一起的完整原文件；不表示整份都属于模块。 |
| `licensing/` | 原仓库 LICENSE 和 NOTICE。 |

根 `source-inventory.json` 记录原路径、新路径、源 SHA、文件摘要、字节数和 Git mode。
本次清单保存 **421 份原件**（含 315 个原 `module-staging` 文件及其来源资料）。
清单文件 SHA-256：

```text
85909852fe2f60dd93866bd6049a069cbb7cc00e803de824d2f780d3d431f80e
```

原件不改 imports，不在新位置直接运行脚本，也不因转存就声称模块已适配。
`modules/` 内旧 inventory 保持原样，它的 `module-staging/` 路径是历史来源；
当前位置以顶层 inventory 为准。

## 公开追溯

即使不在这台机器上，也可按固定提交与原路径读取源文件，例如：

```sh
git show 3548240b9283bc5ea022ccd55633ac0a8801eea3:scripts/start.mjs
```

旧模块原件此前来自另外两个固定提交，其来源关系保存在转存的原 inventory 中。
Git 历史和项目外原件是恢复代码的依据，不恢复旧运行器或业务状态。
后续适配应从对应分类取得代码，另行定义模块接口，不把归档目录接回本体。

没有从生产读取/复制 credentials、native home、用户聊天、模块业务数据、
控制器数据库或已安装身份。正在运行的旧包和外部服务没有被这次源码搬迁停止。
最后一次已确认生产部署仍见[部署记录](deployments.md)。
