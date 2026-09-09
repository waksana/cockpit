import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UploadedFile } from '@cockpit/protocol'
import { createSessionDrafts, SessionDraft, type UploadFile } from '../lib/attachmentSend'

const image: UploadedFile = {
  kind: 'image',
  name: 'preview & notes.png',
  url: '/uploads/preview.png',
  path: '/server/private/uploads/preview.png',
  size: 4,
  mime: 'image/png',
}
const document: UploadedFile = {
  kind: 'file',
  name: 'review & notes.txt',
  url: '/uploads/review.txt',
  path: '/server/private/uploads/review.txt',
  size: 4,
  mime: 'text/plain',
}
const caption = '  Caption <review> & notes\nsecond line  '
const captionMarkup = '  Caption &lt;review&gt; &amp; notes\nsecond line  '

function file(metadata: UploadedFile) {
  return new File(['data'], metadata.name, { type: metadata.mime })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function assertButton(html: string, label: string, disabled: boolean) {
  const buttons = (html.match(/<button\b[^>]*>/g) ?? [])
    .filter((button: string) => button.includes(`aria-label="${label}"`))
  assert.equal(buttons.length, 1, html)
  assert.equal(/\sdisabled(?:=|\s|>)/.test(buttons[0]), disabled, buttons[0])
}

function assertCaption(html: string, expected: string) {
  const textareas = [...html.matchAll(/(<textarea\b[^>]*>)([\s\S]*?)<\/textarea>/g)]
  assert.equal(textareas.length, 1, html)
  assert.equal(textareas[0][2], expected)
  assert.doesNotMatch(textareas[0][1], /\s(?:disabled|readonly)(?:=|\s|>)/)
}

function assertEditableAttachment(html: string) {
  assertButton(html, '移除暂存附件', false)
  assertButton(html, '添加附件', false)
  const input = html.match(/<input\b[^>]*type="file"[^>]*>/)
  assert.ok(input, html)
  assert.doesNotMatch(input[0], /\sdisabled(?:=|\s|>)/)
}

function assertReadyAttachment(html: string, metadata: UploadedFile) {
  const name = metadata.name.replaceAll('&', '&amp;')
  assert.match(html, /class="chat-staged-attachment" role="group" aria-label="暂存附件"/)
  assert.ok(html.includes(`href="${metadata.url}?download=1" download="${name}" class="chat-staged-name">${name}</a>`), html)
  assert.match(html, /class="chat-staged-status" aria-live="polite">已暂存 · 4 B · 随消息发送<\/span>/)
  assert.doesNotMatch(html, /blob:|data:image|\/server\/private/)
  if (metadata.kind === 'image') {
    assert.ok(html.includes(`<a href="${metadata.url}" target="_blank" rel="noopener noreferrer" class="chat-staged-image">`), html)
    assert.ok(html.includes(`<img src="${metadata.url}" alt="${name}"`), html)
  } else {
    assert.match(html, /class="chat-staged-icon"/)
    assert.doesNotMatch(html, /<img\b|rel="preload"/)
  }
}

test('Composer staged attachment markup', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('Composer attachment tests must not make network requests')
  })
  t.after(() => { assert.equal(fetch.mock.callCount(), 0) })

  // Import the real store without initializing its browser/network lifecycle.
  const { Composer } = await import('./Composer')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })

  function render(
    draft: SessionDraft,
    onSend: () => Promise<boolean>,
    props: { attachmentBlocked?: boolean; uploadFile?: UploadFile } = {},
  ) {
    const html = renderToStaticMarkup(createElement(Composer, { draft, onSend, ...props }))
    assert.doesNotMatch(html, /从文件库选择|href="\/files/)
    return html
  }

  for (const metadata of [image, document]) {
    await t.test(`selecting a ${metadata.kind} stages a safe card without sending or replacing the caption`, async (t) => {
      const draft = new SessionDraft(`select-${metadata.kind}`)
      draft.edit(caption)
      const onSend = t.mock.fn(async () => true)
      const selected = file(metadata)
      const uploadFile = t.mock.fn(async (value: File) => {
        assert.equal(value, selected)
        return metadata
      })
      render(draft, onSend, { uploadFile })
      assert.equal(await draft.selectAttachment(selected, uploadFile), true)

      const html = render(draft, onSend, { uploadFile })
      assertReadyAttachment(html, metadata)
      assertCaption(html, captionMarkup)
      assertEditableAttachment(html)
      assertButton(html, '发送', false)
      assert.equal(draft.getSnapshot().text, caption)
      assert.equal(uploadFile.mock.callCount(), 1)
      assert.equal(onSend.mock.callCount(), 0)
    })

    await t.test(`pending ${metadata.kind} sends leave caption, remove and replace controls enabled`, async (t) => {
      const draft = new SessionDraft(`pending-${metadata.kind}`)
      draft.edit(caption)
      assert.equal(await draft.selectAttachment(file(metadata), async () => metadata), true)
      const post = deferred<boolean>()
      const dispatch = t.mock.fn(() => post.promise)
      const onSend = t.mock.fn(() => draft.send(dispatch))
      const sending = onSend()
      try {
        assert.equal(draft.getSnapshot().pending, true)
        const html = render(draft, onSend)
        assertReadyAttachment(html, metadata)
        assertCaption(html, captionMarkup)
        assertEditableAttachment(html)
        assertButton(html, '发送', true)

        draft.edit('Caption edited while pending')
        assertCaption(render(draft, onSend), 'Caption edited while pending')
        assert.equal(await draft.send(dispatch), false)
        assert.equal(dispatch.mock.callCount(), 1)
        assert.equal(onSend.mock.callCount(), 1)
      } finally {
        post.resolve(false)
        await sending
      }
    })

    await t.test(`registry route-away/back renders the ready ${metadata.kind} from the same owner`, async (t) => {
      const values = new Map<string, string>()
      const getDraft = createSessionDrafts({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value) },
      })
      const original = getDraft('original')
      original.edit(caption)
      const onSend = t.mock.fn(async () => true)
      const upload = deferred<UploadedFile>()
      const selecting = original.selectAttachment(file(metadata), async () => upload.promise)
      assert.match(render(original, onSend), /上传中…（尚未发送）/)

      const other = getDraft('other')
      assert.notEqual(other, original)
      const otherMarkup = render(other, onSend)
      assert.doesNotMatch(otherMarkup, /class="chat-staged-attachment"/)
      assertCaption(otherMarkup, '')
      assertButton(otherMarkup, '发送', true)

      upload.resolve(metadata)
      assert.equal(await selecting, true)
      const ready = original.getSnapshot()
      const remounted = getDraft('original')
      assert.equal(remounted, original)
      const html = render(remounted, onSend)
      assertReadyAttachment(html, metadata)
      assertCaption(html, captionMarkup)
      assertButton(html, '发送', false)
      assert.equal(remounted.getSnapshot(), ready)
      assert.equal(render(other, onSend), otherMarkup)
      assert.equal(onSend.mock.callCount(), 0)
    })
  }

  for (const status of ['uploading', 'failed'] as const) {
    await t.test(`${status} attachments show status and block sends even with a caption`, async (t) => {
      const draft = new SessionDraft(status)
      draft.edit(caption)
      const onSend = t.mock.fn(async () => true)
      const upload = deferred<UploadedFile>()
      const selecting = draft.selectAttachment(file(image), async () => upload.promise)
      try {
        if (status === 'failed') {
          upload.reject(new Error('Upload failed; please retry'))
          assert.equal(await selecting, false)
        }
        assert.equal(draft.getSnapshot().staged?.status, status)
        const html = render(draft, onSend)
        assert.match(html, /class="chat-staged-attachment"/)
        assert.match(html, /class="chat-staged-name">preview &amp; notes.png<\/span>/)
        assert.match(html, status === 'uploading'
          ? /aria-live="polite">上传中…（尚未发送）<\/span>/
          : /aria-live="polite">Upload failed; please retry<\/span>/)
        assert.doesNotMatch(html, /<img\b|rel="preload"|download=/)
        assertCaption(html, captionMarkup)
        assertEditableAttachment(html)
        assertButton(html, '发送', true)
        assert.equal(await draft.send(onSend), false)
        assert.equal(onSend.mock.callCount(), 0)
      } finally {
        if (status === 'uploading') upload.resolve(image)
        await selecting
      }
    })
  }

  await t.test('a ready attachment enables send with an empty caption', async (t) => {
    for (const metadata of [image, document]) {
      const draft = new SessionDraft(`empty-${metadata.kind}`)
      const onSend = t.mock.fn(async () => true)
      assertButton(render(draft, onSend), '发送', true)
      assert.equal(await draft.selectAttachment(file(metadata), async () => metadata), true)
      const html = render(draft, onSend)
      assertReadyAttachment(html, metadata)
      assertCaption(html, '')
      assertButton(html, '发送', false)
      assert.equal(onSend.mock.callCount(), 0)
    }
  })

  await t.test('ask/plan attachmentBlocked retains the ready attachment and disables sending', async (t) => {
    for (const text of ['', caption]) {
      const draft = new SessionDraft('blocked')
      draft.edit(text)
      assert.equal(await draft.selectAttachment(file(image), async () => image), true)
      const before = draft.getSnapshot()
      const onSend = t.mock.fn(async () => true)
      const html = render(draft, onSend, { attachmentBlocked: true })
      assertReadyAttachment(html, image)
      assertCaption(html, text ? captionMarkup : '')
      assertEditableAttachment(html)
      assertButton(html, '发送', true)
      assert.match(html, /请先处理上方提问或计划，或移除附件后发送文字。/)
      assert.equal(draft.getSnapshot(), before)
      assertButton(render(draft, onSend, { attachmentBlocked: false }), '发送', false)
      assert.equal(onSend.mock.callCount(), 0)
    }
  })

  await t.test('an unsafe uploaded image URL produces a failed stage, never a preview', async (t) => {
    for (const url of ['https://external.example/photo.png', '//external.example/photo.png', 'javascript:alert(1)']) {
      const draft = new SessionDraft('unsafe')
      draft.edit(caption)
      const onSend = t.mock.fn(async () => true)
      assert.equal(await draft.selectAttachment(file(image), async () => ({ ...image, url })), false)
      const html = render(draft, onSend)
      assert.equal(draft.getSnapshot().staged?.status, 'failed')
      assert.match(html, /aria-live="polite">附件信息无效<\/span>/)
      assert.doesNotMatch(html, /<img\b|rel="preload"|download=/)
      assert.ok(!html.includes(url), html)
      assertCaption(html, captionMarkup)
      assertButton(html, '发送', true)
      assert.equal(onSend.mock.callCount(), 0)
    }
  })
})
