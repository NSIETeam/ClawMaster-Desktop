// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en, zh } from '../src/client/locale.ts'
import { ReasoningRow } from '../src/client/chat/ReasoningRow.tsx'
import { ContextInjectionRow } from '../src/client/chat/ContextInjectionRow.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe.each([
  ['en', makeTranslate(en, commonEn)],
  ['zh', makeTranslate(zh, commonZh)],
] as const)('ClawMaster process disclosures (%s)', (_locale, t) => {
  it.each([
    ['@deepseek-ai/dsh-system-prompt', 'message.producer.clawmasterInstructions'],
    ['clawmaster-sys-prompt', 'message.producer.clawmasterInstructions'],
    ['@deepseek-ai/dsh-time-context', 'message.producer.currentTime'],
    ['time-context', 'message.producer.currentTime'],
  ] as const)('presents %s with a product label while retaining its recorded source', (plugin, key) => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'clawmaster')
    const source = Object.freeze({ kind: 'plugin', plugin })
    const content = Object.freeze([{ type: 'text' as const, text: 'unchanged recorded instructions' }])
    const view = render(<ContextInjectionRow content={content} source={source}
      provenance={{ role: 'inject', label: plugin }} form={null} t={t} />)
    expect(view.container.textContent).toContain(t(key))
    expect(view.container.textContent).not.toContain(plugin)
    expect(view.container.textContent).toMatchSnapshot()
    fireEvent.click(view.getByRole('button'))
    expect(view.container.querySelector('[data-context-fields]')?.textContent).toContain(plugin)
    expect(view.container.textContent).toContain('unchanged recorded instructions')
    expect(source.plugin).toBe(plugin)
    expect(content[0]?.text).toBe('unchanged recorded instructions')
  })

  it('does not relabel another producer, a user-controlled path, or the upstream build', () => {
    const renderSource = (source: unknown, label: string) => <ContextInjectionRow
      content={[]} source={source} provenance={{ role: 'inject', label }} form={null} t={t} />
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'clawmaster')
    const label = '@deepseek-ai/dsh-system-prompt'
    const view = render(renderSource({ kind: 'agent-instructions' }, label))
    expect(view.container.textContent).toContain(label)
    view.rerender(renderSource({ kind: 'plugin', plugin: 'external-plugin' }, 'external-plugin'))
    expect(view.container.textContent).toContain('external-plugin')
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', '')
    view.rerender(renderSource({ kind: 'plugin', plugin: label }, label))
    expect(view.container.textContent).toContain(label)
  })

  it('keeps reasoning out of the collapsed DOM through streaming and completion', () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'clawmaster')
    const view = render(<ReasoningRow text="private reasoning" running t={t} />)
    expect(view.container.textContent).not.toContain('private reasoning')
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    view.rerender(<ReasoningRow text="private reasoning\ncompleted reasoning" running={false} t={t} />)
    expect(view.container.textContent).not.toContain('completed reasoning')
    expect(view.container.textContent).toMatchSnapshot()
    fireEvent.click(view.getByRole('button'))
    expect(view.container.textContent).toContain('completed reasoning')
    view.rerender(<ReasoningRow text="private reasoning\nupdated reasoning" running t={t} />)
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(view.container.textContent).toContain('updated reasoning')
    fireEvent.click(view.getByRole('button'))
    view.rerender(<ReasoningRow text="private reasoning\nfinal reasoning" running={false} t={t} />)
    expect(view.container.textContent).not.toContain('final reasoning')
  })

  it('keeps memory source visible and reveals its recorded body only on demand', () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'clawmaster')
    const props = {
      t, source: { kind: 'memory', form: 'notice', summary: 'private memory summary' },
      provenance: { role: 'inject' as const, label: 'OpenViking Memory' },
      form: 'notice' as const,
      content: [{ type: 'text' as const, text: 'private memory body' }],
    }
    const view = render(<ContextInjectionRow {...props} />)
    expect(view.container.textContent).toContain('OpenViking Memory')
    expect(view.container.textContent).not.toContain('private memory')
    expect(view.container.querySelector('[data-context-injection-body]')).toBeNull()
    expect(view.container.textContent).toMatchSnapshot()
    fireEvent.click(view.getByRole('button'))
    expect(view.container.textContent).toContain('private memory body')
    view.rerender(<ContextInjectionRow {...props} content={[{ type: 'text', text: 'updated memory body' }]} />)
    expect(view.container.textContent).toContain('updated memory body')
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })
})
