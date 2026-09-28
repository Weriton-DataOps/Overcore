import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RepositoryPathGuard, repositoryGlobToRegExp } from '../src/application/repository-path-guard.js'

const windows = process.platform === 'win32'

async function workbench() {
  const base = await mkdtemp(join(tmpdir(), 'overcore-path-guard-'))
  const worktree = join(base, 'worktree')
  const outside = join(base, 'outside')
  await mkdir(join(worktree, 'src'), { recursive: true })
  await mkdir(join(worktree, 'test'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(worktree, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(join(worktree, 'README.md'), '# fixture\n')
  // Em worktree real, `.git` é um arquivo que aponta para o gitdir.
  await writeFile(join(worktree, '.git'), 'gitdir: ../repo/.git/worktrees/fixture\n')
  await writeFile(join(outside, 'secret.txt'), 'fora do worktree\n')
  const guard = await RepositoryPathGuard.create(worktree, {
    include: ['src/**', 'test/**'],
    exclude: ['**/*.pem', 'src/generated/**']
  })
  return { base, worktree, outside, guard, cleanup: () => rm(base, { recursive: true, force: true }) }
}

test('guarda permite arquivo existente e arquivo novo dentro do escopo', async () => {
  const bench = await workbench()
  try {
    assert.deepEqual(await bench.guard.check('src/a.ts'), { allowed: true, relativePath: 'src/a.ts' })
    assert.deepEqual(
      await bench.guard.check('src/novo/profundo/b.ts'),
      { allowed: true, relativePath: 'src/novo/profundo/b.ts' }
    )
    assert.deepEqual(
      await bench.guard.check(join(bench.worktree, 'test', 'a.test.ts')),
      { allowed: true, relativePath: 'test/a.test.ts' }
    )
  } finally {
    await bench.cleanup()
  }
})

test('guarda recusa caminho fora do worktree, por relativo ou absoluto', async () => {
  const bench = await workbench()
  try {
    for (const candidate of ['../outside/secret.txt', 'src/../../outside/secret.txt', join(bench.outside, 'secret.txt')]) {
      const decision = await bench.guard.check(candidate)
      assert.equal(decision.allowed, false, candidate)
      assert.equal(!decision.allowed && decision.reason, 'outside-worktree', candidate)
    }
  } finally {
    await bench.cleanup()
  }
})

test('guarda recusa metadados do Git em qualquer profundidade e grafia', async () => {
  const bench = await workbench()
  try {
    const candidates = ['.git', '.git/config', 'src/.git/hooks/pre-commit']
    if (windows) candidates.push('.GIT/config', 'GIT~1/config')
    for (const candidate of candidates) {
      const decision = await bench.guard.check(candidate)
      assert.equal(!decision.allowed && decision.reason, 'git-metadata', candidate)
    }
  } finally {
    await bench.cleanup()
  }
})

test('guarda aplica inclusão e exclusão do escopo declarado', async () => {
  const bench = await workbench()
  try {
    const readme = await bench.guard.check('README.md')
    assert.equal(!readme.allowed && readme.reason, 'not-included')
    const key = await bench.guard.check('src/chaves/servidor.pem')
    assert.equal(!key.allowed && key.reason, 'excluded')
    const generated = await bench.guard.check('src/generated/client.ts')
    assert.equal(!generated.allowed && generated.reason, 'excluded')
  } finally {
    await bench.cleanup()
  }
})

test('guarda recusa escrita que sai do worktree por link ou junção', async () => {
  const bench = await workbench()
  try {
    await symlink(bench.outside, join(bench.worktree, 'src', 'atalho'), windows ? 'junction' : 'dir')
    for (const candidate of ['src/atalho/secret.txt', 'src/atalho/novo.ts']) {
      const decision = await bench.guard.check(candidate)
      assert.equal(!decision.allowed && decision.reason, 'escapes-through-link', candidate)
    }
  } finally {
    await bench.cleanup()
  }
})

test('guarda recusa a raiz e caminhos vazios ou com caractere nulo', async () => {
  const bench = await workbench()
  try {
    for (const candidate of ['.', '', 'src/a.ts\0.txt']) {
      const decision = await bench.guard.check(candidate)
      assert.equal(!decision.allowed && decision.reason, 'invalid-path', JSON.stringify(candidate))
    }
  } finally {
    await bench.cleanup()
  }
})

test('guarda recusa formas que o Windows reinterpreta', { skip: !windows }, async () => {
  const bench = await workbench()
  try {
    for (const candidate of ['src/a.ts:oculto', 'src/nul', 'src/con.txt', 'src/lpt1', 'src/b.ts.', 'src/pasta /c.ts', '.git./config']) {
      const decision = await bench.guard.check(candidate)
      assert.equal(!decision.allowed && decision.reason, 'invalid-path', candidate)
    }
  } finally {
    await bench.cleanup()
  }
})

test('glob não atravessa diretório com * e só atravessa com ** em segmento inteiro', () => {
  const star = repositoryGlobToRegExp('src/*.ts', false)
  assert.ok(star.test('src/a.ts'))
  assert.ok(!star.test('src/sub/a.ts'))

  const deep = repositoryGlobToRegExp('src/**', false)
  assert.ok(deep.test('src/a.ts'))
  assert.ok(deep.test('src/x/y/z.ts'))
  assert.ok(!deep.test('srcx/a.ts'))

  const anywhere = repositoryGlobToRegExp('**/*.pem', false)
  assert.ok(anywhere.test('chave.pem'))
  assert.ok(anywhere.test('a/b/chave.pem'))
  assert.ok(!anywhere.test('chave.pem.txt'))

  const inner = repositoryGlobToRegExp('src/a**b.ts', false)
  assert.ok(inner.test('src/aXXb.ts'))
  assert.ok(!inner.test('src/a/b.ts'))

  const literal = repositoryGlobToRegExp('docs/[rascunho].md', false)
  assert.ok(literal.test('docs/[rascunho].md'))
  assert.ok(!literal.test('docs/r.md'))
})

test('glob de escopo recusa forma absoluta, com barra invertida ou que sobe de diretório', () => {
  for (const glob of ['/etc/**', 'C:/Windows/**', 'src\\**', '../**', 'src/../../**', '']) {
    assert.throws(() => repositoryGlobToRegExp(glob, false), /Glob de escopo inválido/, JSON.stringify(glob))
  }
})

test('escopo sem inclusão é recusado na criação da guarda', async () => {
  const base = await mkdtemp(join(tmpdir(), 'overcore-path-guard-'))
  try {
    await assert.rejects(
      RepositoryPathGuard.create(base, { include: [], exclude: [] }),
      /ao menos um glob de inclusão/
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
