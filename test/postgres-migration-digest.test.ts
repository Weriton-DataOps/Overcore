import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../src/domain/fingerprint.js'
import { appliedMigrationMatches, migrationDigest } from '../src/infrastructure/database/postgres.js'

const LF = 'CREATE TABLE a (id text);\nCREATE TABLE b (id text);\n'
const CRLF = LF.replace(/\n/g, '\r\n')

test('o digest de uma migração nova independe do fim de linha do checkout', () => {
  assert.equal(migrationDigest(CRLF), migrationDigest(LF))
  assert.equal(migrationDigest(LF), sha256(LF))
})

test('migração aplicada confere pelo digest normalizado ou pelo digest cru legado', () => {
  assert.equal(appliedMigrationMatches(sha256(LF), CRLF), true, 'banco migrado de checkout LF lido por checkout CRLF')
  assert.equal(appliedMigrationMatches(sha256(CRLF), CRLF), true, 'banco migrado de checkout CRLF, digest cru legado')
  assert.equal(appliedMigrationMatches(sha256(LF), LF), true)
  assert.equal(appliedMigrationMatches(sha256(LF), CRLF.replace('b (id', 'c (id')), false, 'conteúdo alterado continua recusado')
})
