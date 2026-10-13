import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// dsh-tauri / dsh-tauri-ui 是桌面运行时注入的模块，npm 上没有可 import 的 Node
// 入口（dsh-tauri 的 types 字段指向不存在的 dist/index.d.ts，dsh-tauri/client
// 是 ModuleLoader 浏览器脚本）。独立仓库用本地垫片提供类型与单测实现；构建产物
// 仍把这两个标识符保持为 external。
const shim = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'dsh-tauri/client': shim('./compat/dsh-tauri-client.ts'),
      'dsh-tauri-ui/client': shim('./compat/dsh-tauri-ui-client.ts'),
      'dsh-tauri': shim('./compat/dsh-tauri.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    testTimeout: 30000,
  },
})
