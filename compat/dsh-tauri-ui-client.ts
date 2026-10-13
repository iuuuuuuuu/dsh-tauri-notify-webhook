import type { ComponentType, ReactNode } from 'react'

/**
 * compat/dsh-tauri-ui-client —— `dsh-tauri-ui/client` 的本地声明垫片。
 *
 * 该模块由桌面壳在客户端运行时注入（列在 `package.json` 的
 * `dsh.client.external` 里），独立仓库只能声明形状，不能实现。
 * 组件在单元测试里由 `src/client/test-utils/ui-mock.ts` 顶替。
 */

export interface ButtonProps {
  variant?: string | undefined
  size?: string | undefined
  onPress?: (() => void) | undefined
  onClick?: (() => void) | undefined
  disabled?: boolean | undefined
  className?: string | undefined
  title?: string | undefined
  children?: ReactNode
}

export interface InputProps {
  className?: string | undefined
  value?: string | undefined
  type?: string | undefined
  disabled?: boolean | undefined
  onChange?: ((event: { target: { value: string } }) => void) | undefined
}

export interface SelectProps {
  options: ReadonlyArray<{ value: string, label: string }>
  value: string
  onChange: (next: string) => void
  label?: string | undefined
  disabled?: boolean | undefined
  className?: string | undefined
}

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean | undefined
  title?: string | undefined
  className?: string | undefined
}

export declare const Button: ComponentType<ButtonProps>
export declare const Input: ComponentType<InputProps>
export declare const Select: ComponentType<SelectProps>
export declare const Switch: ComponentType<SwitchProps>
