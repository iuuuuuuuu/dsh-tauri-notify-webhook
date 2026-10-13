[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-yes-4b6bfb)](https://github.com/iuuuuuuuu/dsh-tauri-notify-webhook)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-339933)](https://nodejs.org)

# dsh-tauri-notify-webhook

[English](./README.md) · **简体中文**

把 DSH 桌面的任务通知转发到**邮件（SMTP）**或 **pushplus**：只在任务异常停止或完成时推送，
而且只在你没盯着窗口的时候推。

## 它解决的问题

桌面端在回合结束时本来就会弹一个系统通知，而它很容易被错过，原因值得说清楚：

- 系统通知是屏幕上的东西。窗口就在你面前时，答案是你自己看着流出来的，通知纯属打扰；
  人走开了，通知在你回来之前就已经消失，屏幕上不留任何痕迹。
- 各种「结束」的价值并不一样。正常跑完的回合不需要你做什么；**报错、被中断、
  撞上长度上限、被阻塞**的回合才需要。
- 宿主每个会话只保留**最新**一条 `turn/end`，结束的会话不会留下一份可以事后翻看的队列。
  你恰好离开的那一次，信息就真的没有了。

这个插件把通知从屏幕上挪到一个会留历史的地方，并且只为你真正会处理的那两种结束触发。

## 安装

```sh
dsh plugin --profile <name> add github:iuuuuuuuu/dsh-tauri-notify-webhook
```

同一条 spec 也可以直接填进 GUI 的插件面板（**设置 → 插件 → 安装**），它接受任何 npm spec。
本地开发时改为安装目录：

```sh
dsh plugin --profile <name> add link:D:/path/to/dsh-tauri-notify-webhook
```

安装时没有构建步骤：`dist/` 已随仓库提交。这是刻意的——桌面 profile 是把插件当包安装的，
一个装完还要现场编译的包，等于要求 profile 自带那套工具链。

**装完必须重启 DSH。** 这不是可选项：宿主把已加载的插件模块留在 loader cache 里，
而 `hmr.root` 默认是 `[]`，所以新装的插件在运行中的宿主里不会生效。

## 使用

打开 **设置 → 任务推送**，选好渠道、填好对应字段，点 **发送测试**，再点 **保存**。
测试按钮只在表单与已保存内容不一致时才可点，所以一次成功的测试描述的恰好是你即将存下的那组值。

| 渠道 | 需要什么 |
| --- | --- |
| 邮件（SMTP） | SMTP 服务器、端口、加密方式、发件人、收件人；用户名与密码可留空，供允许匿名投递的中继使用 |
| pushplus | 在 [pushplus.plus](https://www.pushplus.plus) 申请的 token；推送直发官方 `/send` 接口 |
| 关闭 | 什么都不发。这是默认值 |

## 它的行为

### 两个触发时机

| 触发时机 | 何时触发 |
| --- | --- |
| 任务完成 | 回合以 `completed` 结束 |
| 任务异常停止 | 其余任何结束方式——`aborted`、`error`、`blocked`、`max-tokens`、`interrupted`、`forked` |

两项都默认开启，且可各自独立关闭。子代理会话会被跳过：它们由父会话驱动，否则一个任务会连炸出一串推送。

### 只在你离开时推送

只有 `document.visibilityState === 'hidden'` 时才推送。Tauri 外壳把 `document.hidden`
接成了真实的窗口聚焦状态，所以这里判的是「窗口不在你面前」，而不是「标签页在后台」。
你正盯着会话看的时候，插件保持安静。

### 一次推送是怎么决定的

客户端读不到回合的结束原因，所以判定要走两个来回：

1. 会话列表把某个会话从 `running: true` 翻成 `false`——只有这个边沿会被观察，
   所以插件加载前就已经结束的会话永远不会被补推一条。
2. 等 250 ms 落定（回合的 running 标记可能抖动），客户端向 `GET /turn-end?sessionId=…`
   询问宿主记下的原因。
3. 若会话仍处于停止态、且期间没有再停过一次，客户端再 `POST /delivery`。
   宿主在那一刻重新读取设置并发出去。

每一步都会重新确认插件仍然挂着，所以中途热重载不会投递出一条过期的推送。

## 凭据存在哪里

设置只存在本机，路径是 `$DSH_HOME/notify-webhook/settings`（`DSH_HOME` 默认 `~/.dsh`）。
写入走外壳的原子写助手，所以保存途中崩溃不会留下半截配置。除了你配置的那个渠道，
不会有任何东西被上传到别处。

宿主路由只接受回环地址，且每个写操作还必须同源；外部来源的网页既读不到你的设置，
也没法让插件替你发信。

## 运行要求

* DSH **桌面（Tauri）**外壳——本插件是外壳 `dsh-tauri` / `dsh-tauri-ui` 运行时插件和
  `settings.section` 槽位的客户端，因此在纯浏览器 profile 里不适用。
* Node.js ≥ 22.15.0。
* 邮件需要一台你能用它发信的 SMTP 服务器；pushplus 需要一个 token。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint .
pnpm test        # vitest run
pnpm build       # tsdown -> dist/index.js, dist/index.d.ts, dist/client.cjs
```

CI 在 Node 22 与 24 上跑同样这四道门，然后断言 `dist/` 是最新的
（`git diff --exit-code -- dist`）——改了 `src/` 就要把重新构建的 `dist/` 一起提交。

`compat/` 里是外壳在运行时注入的那两个模块（`dsh-tauri`、`dsh-tauri/client`、
`dsh-tauri-ui/client`）的本地替身。它们的存在只是为了让 `tsc` 与单元测试能在桌面应用之外跑起来；
`tsdown` 会把这些说明符标成 external，所以这份代码不会进入 `dist/`。

## 许可证

MIT

[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
