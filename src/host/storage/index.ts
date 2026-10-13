import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DSH_HOME, writeAtomic } from 'dsh-tauri'

/**
 * host/storage —— 插件自己的落盘格。
 *
 * 只存一份设置文档，所以不引入存储抽象层：路径固定在
 * `$DSH_HOME/notify-webhook/settings`，写入走 `dsh-tauri` 的 `writeAtomic`
 * （临时文件 + 改名，避免半个文件被读到）。
 */

const BASE = 'notify-webhook'

/** 设置文档的绝对路径。 */
function pathOf(key: string): string {
  return join(DSH_HOME, BASE, key.replace(/:/g, '/'))
}

/**
 * 读取文档。
 *
 * 文件不存在回 `null`（首次安装的正常路径），其它 IO 错误原样抛出：
 * 权限、磁盘故障这类问题必须以错误码回给设置面板，不能伪装成「还没配置过」。
 */
async function getItem(key: string): Promise<unknown> {
  try {
    const text = await readFile(pathOf(key), 'utf8')
    return parseDocument(text)
  }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT')
      return null
    throw error
  }
}

/** 写入文档：目录先补齐，内容按 JSON 序列化后原子落盘。 */
async function setItem(key: string, value: unknown): Promise<void> {
  const target = pathOf(key)
  await mkdir(dirname(target), { recursive: true })
  await writeAtomic(target, stringifyDocument(value))
}

/** 空文件按「没有内容」处理；坏 JSON 原样交回，由归一化兜住非法值。 */
function parseDocument(text: string): unknown {
  if (text.trim().length === 0)
    return null
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

/** 与旧实现同口径：字符串原样写，其余对象走 JSON。 */
function stringifyDocument(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** 设置服务消费的存储面（只保留读写两个动作）。 */
export const storage = { getItem, setItem }
