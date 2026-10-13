[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-yes-4b6bfb)](https://github.com/iuuuuuuuu/dsh-tauri-notify-webhook)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-339933)](https://nodejs.org)

# dsh-tauri-notify-webhook

**English** · [简体中文](./README.zh-CN.md)

Forward a DSH desktop task notification to **email (SMTP)** or **pushplus** — when a task
stops abnormally or completes, and only while the window is not in front of you.

## The problem this solves

The desktop shell already shows a toast when a turn ends, and it is easy to miss for a
reason worth stating precisely:

- A toast is a system notification. If the window is in front of you, you were already
  watching the answer stream in — the toast is noise. If you walked away, the toast is
  gone by the time you come back, and nothing remains on screen.
- The interesting endings are not equally interesting. A turn that ran to the end needs no
  attention. A turn that **errored, was aborted, hit the token ceiling or was blocked** does.
- The host keeps only the **latest** `turn/end` per session, so a finished session leaves no
  queue to read later. Once you were away for that moment, the information is simply gone.

This plugin moves the notification off the screen and onto a channel that keeps history,
and it fires only for the two endings you would actually act on.

## Install

```sh
dsh plugin --profile <name> add github:iuuuuuuuu/dsh-tauri-notify-webhook
```

The same spec works in the GUI plugin panel (**设置 → 插件 → 安装**), which accepts any npm
spec. For a local checkout, install the directory instead:

```sh
dsh plugin --profile <name> add link:D:/path/to/dsh-tauri-notify-webhook
```

There is no build step at install time: `dist/` is committed. This is deliberate — the
desktop profile installs plugins as packages, and a package that has to be compiled after
installation would need a toolchain the profile does not have.

**Restart DSH.** This is required, not optional: the harness keeps loaded plugin modules in
its loader cache, and `hmr.root` defaults to `[]`, so a newly installed plugin does not take
effect in a running host.

## Use

Open **设置 → 任务推送**, pick a channel, fill in its fields, press **发送测试**, then
**保存**. The test button only becomes available once the form differs from what is saved,
so a successful test always describes exactly the values you are about to store.

| Channel | What it needs |
| --- | --- |
| 邮件 (SMTP) | SMTP host, port, security, from, to; username and password are optional for relays that accept anonymous mail |
| pushplus | A token from [pushplus.plus](https://www.pushplus.plus); pushes go straight to the official `/send` endpoint |
| 关闭 | Nothing is sent. This is the default |

## What it does

### Two triggers

| Trigger | Fires when |
| --- | --- |
| 任务完成 | The turn ended with reason `completed` |
| 任务异常停止 | The turn ended any other way — `aborted`, `error`, `blocked`, `max-tokens`, `interrupted`, `forked` |

Both are on by default and are switched independently. Sub-agent sessions are skipped: they
are driven by their parent, so they would otherwise produce a burst of pushes for one task.

### Only while you are away

A push is sent only when `document.visibilityState === 'hidden'`. The Tauri shell patches
`document.hidden` to the real window focus state, so this is "the window is not in front of
you" rather than "the tab is in the background". While you are watching the session, the
plugin stays silent.

### How one push is decided

The client cannot read a turn's ending reason, so the decision takes two round trips:

1. The session list flips a session from `running: true` to `false` — that edge is the only
   thing watched, so a session that was already finished when the plugin loaded is never
   back-filled.
2. After a 250 ms settle window (a turn can flicker its running flag), the client asks
   `GET /turn-end?sessionId=…` for the reason the host recorded.
3. If the session is still stopped and has not stopped again in the meantime, the client
   posts `POST /delivery`. The host re-reads the settings at that moment and sends.

Every step re-checks that the plugin is still loaded, so a reload mid-flight cannot deliver
a stale push.

## Where your credentials live

Settings are stored on this machine only, at `$DSH_HOME/notify-webhook/settings`
(`DSH_HOME` defaults to `~/.dsh`). The file is written through the shell's atomic-write
helper, so a crash mid-save cannot leave a truncated config. Nothing is uploaded anywhere
except the channel you configure.

The host routes are loopback-only, and every mutating request must also be same-origin;
a browser page on another origin cannot read your settings or make the plugin send mail.

## Requirements

* The DSH **desktop (Tauri)** shell — this plugin is a client of the shell's `dsh-tauri`
  and `dsh-tauri-ui` runtime plugins, and of the `settings.section` slot, so it does not
  apply to a browser-only profile.
* Node.js ≥ 22.15.0.
* For email: an SMTP server you can send through. For pushplus: a token.

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint .
pnpm test        # vitest run
pnpm build       # tsdown -> dist/index.js, dist/index.d.ts, dist/client.cjs
```

CI runs the same four gates on Node 22 and 24, and then asserts that `dist/` is up to date
(`git diff --exit-code -- dist`) — if you change `src/`, commit the rebuilt `dist/` with it.

`compat/` holds local stand-ins for the two modules the shell injects at runtime
(`dsh-tauri`, `dsh-tauri/client`, `dsh-tauri-ui/client`). They exist so that `tsc` and the
unit tests can run outside the desktop app; `tsdown` marks those specifiers external, so
none of this code reaches `dist/`.

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
