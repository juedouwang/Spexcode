import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFrontmatter } from '@spexcode/spec-core'

// [[source-of-truth]] — frontmatter is YAML to every other tool that opens a spec.md, and agents quote a scalar
// whenever it carries ": " (a desc usually does). The quotes delimit the value; they are never part of it.
test('parseFrontmatter reads YAML-quoted scalars and list items without their quotes', () => {
  const { fm } = parseFrontmatter([
    '---',
    'title: "Request pipeline"',
    `desc: "One request's life: build, retry, read."`,
    "status: 'active'",
    'hue: 30',
    'code:',
    '  - "source/core/Ky.ts"',
    "  - 'source/core/Ky.ts#Ky.fetch'",
    'related:',
    '  - source/errors/KyError.ts',
    '---',
    'body',
  ].join('\n'))
  assert.equal(fm.title, 'Request pipeline')
  assert.equal(fm.desc, "One request's life: build, retry, read.")
  assert.equal(fm.status, 'active')
  assert.equal(fm.hue, '30')
  assert.deepEqual(fm.code, ['source/core/Ky.ts', 'source/core/Ky.ts#Ky.fetch'])
  assert.deepEqual(fm.related, ['source/errors/KyError.ts'])
})

test('parseFrontmatter applies YAML escapes inside quotes and leaves unbalanced or inner quotes alone', () => {
  const { fm } = parseFrontmatter([
    '---',
    'title: "Say \\"hi\\" twice"',
    "desc: 'it''s quoted'",
    'a: "starts only',
    'b: the "middle" stays',
    '---',
  ].join('\n'))
  assert.equal(fm.title, 'Say "hi" twice')
  assert.equal(fm.desc, "it's quoted")
  assert.equal(fm.a, '"starts only')
  assert.equal(fm.b, 'the "middle" stays')
})
