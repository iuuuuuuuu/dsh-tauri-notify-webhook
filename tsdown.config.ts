import type { UserConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'tsdown'

/** 是否处于 watch/dev 模式：跳过 minify 加速热重建。 */
const isWatchMode = process.argv.includes('--watch') || process.argv.includes('-w')

/**
 * client bundle 是 dsh-client-modules 模块表里的 classic script：
 * 以 ModuleLoader factory 包装（{ js } addon 只作用于 JS 输出，d.ts 必须保持真 ES module）。
 *
 * require 包一层 resolve：模块表里的链接模块名带 /client 后缀（dsh-tauri/client），
 * 而它注册的模块 id 只有 dsh-tauri，剥掉后缀才查得到。
 */
function clientBundleRegistration() {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  const id = JSON.stringify(pkg.name)
  return {
    banner: {
      js: `window.__ModuleLoader__.load({id:${id},factory:(require)=>{const loaderRequire=require;const resolve=(specifier)=>specifier.endsWith('/client')?specifier.slice(0,-7):specifier;require=(specifier)=>loaderRequire(resolve(specifier));var module={exports:{}};var exports=module.exports;`,
    },
    footer: {
      js: 'return module.exports;}});',
    },
  }
}

const dshExternal = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'dsh-tauri/client',
  'dsh-tauri-ui/client',
  /^@deepseek-ai\//,
]

// 模块表只认识平台种子词与已加载链接模块：client 直接 import 的工具库必须内联，
// 否则产物发出 loader 查不到的 require（"missed the module table"）。
const dshClientInline = [/^(valtio-define|lodash-es|date-fns|tailwind-variants)([/-].*)?$/]

const common: UserConfig = {
  outDir: 'dist',
  format: 'esm',
  // 显式 target：tsdown 对「CJS + target >= 22.12」（engines 推断出 node22.15）
  // 按 ERROR 处理并退出 1；client.cjs 必须是 CJS（ModuleLoader 包装）。
  target: 'node22',
  outExtensions: () => ({ js: '.js' }),
  external: dshExternal,
}

export default defineConfig([
  {
    ...common,
    entry: { index: 'src/index.ts' },
    dts: true,
    sourcemap: false,
    clean: true,
  },
  {
    ...common,
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    noExternal: dshClientInline,
    outExtensions: () => ({ js: '.cjs' }),
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    ...clientBundleRegistration(),
    publint: false,
    dts: false,
    sourcemap: true,
    minify: !isWatchMode,
    clean: false,
  },
] as UserConfig[])
