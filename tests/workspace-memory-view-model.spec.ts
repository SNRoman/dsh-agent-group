import { describe, expect, it } from 'vitest'
import { memoryExcerpt } from '../packages/web/src/client/memory-view-model.ts'

describe('personal memory excerpts', () => {
  it.each([
    ['plain text', '  普通消息\nnext\tline  ', '普通消息 next line'],
    ['link labels', '**称呼**：[研发**群**](https://example.invalid/room "Room title") 与 [同事][person]。\n\n[person]: https://example.invalid/person "Person title"', '称呼：研发群 与 同事。'],
    ['entities', '&lt;node&gt; &amp; &#x4E2D;&#25991; &quot;OK&quot;', '<node> & 中文 "OK"'],
    ['blocks and lists', '## 标题\n\n第一行  \n第二行\n\n- 第一项\n- **第二项**\n  - 子项\n\n> 引文', '标题 第一行 第二行 第一项 第二项 子项 引文'],
    ['code', '用 `foo < bar &amp;` 检查\n\n```ts\nconst value = 1;\nnext();\n```', '用 foo < bar &amp; 检查 const value = 1; next();'],
    ['image alternatives', '![接口图 &amp; 注释](https://example.invalid/image.png "Image title") 与 ![图二][image]\n\n[image]: https://example.invalid/second.png', '接口图 & 注释 与 图二'],
    ['visible URLs', 'https://example.invalid/plain 和 <https://example.invalid/auto>', 'https://example.invalid/plain 和 https://example.invalid/auto'],
  ])('keeps visible %s without Markdown presentation syntax', (_name, text, expected) => {
    expect(memoryExcerpt(text)).toBe(expected)
  })

  it('applies the length limit after extracting visible text', () => {
    expect(memoryExcerpt(`**${'记'.repeat(180)}**`)).toBe('记'.repeat(180))
    expect(memoryExcerpt(`[${'记'.repeat(181)}](https://example.invalid/room)`)).toBe(`${'记'.repeat(180)}…`)
  })
})
