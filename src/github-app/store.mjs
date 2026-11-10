import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'

// One service replica owns this database on a persistent volume. Source and tokens
// never enter it. Transactions make webhook deduplication and job claims atomic.
export class ReviewStore {
  constructor(path, { monthlyLimit = 500, now = Date.now } = {}) {
    this.now = now; this.monthlyLimit = monthlyLimit
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS deliveries (digest TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (installation INTEGER, month TEXT, attempts INTEGER NOT NULL, PRIMARY KEY(installation,month));
      CREATE TABLE IF NOT EXISTS revoked (installation INTEGER, repository INTEGER, PRIMARY KEY(installation,repository));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, key TEXT UNIQUE, installation INTEGER, repository INTEGER, scope TEXT,
        payload TEXT, state TEXT, created INTEGER, updated INTEGER, available INTEGER, attempts INTEGER DEFAULT 0,
        lease TEXT, lease_until INTEGER, check_id INTEGER, report TEXT, error TEXT, duration_ms INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS queue ON jobs(state,available);
      CREATE INDEX IF NOT EXISTS tenant ON jobs(installation,repository,created);`)
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result } catch (e) { this.db.exec('ROLLBACK'); throw e } }
  remember(digest) { return this.db.prepare('INSERT OR IGNORE INTO deliveries VALUES (?,?)').run(digest, this.now()).changes === 1 }
  blocked(installation, repository) { return !!this.db.prepare('SELECT 1 FROM revoked WHERE installation=? AND repository IN (0,?)').get(installation, repository) }
  revoke(installation, repository = 0) {
      this.db.prepare('INSERT OR IGNORE INTO revoked VALUES (?,?)').run(installation, repository)
      if (repository === 0) this.db.prepare('DELETE FROM usage WHERE installation=?').run(installation)
      // Uninstallation/removal deletes review content as well as stopping queued work.
      this.db.prepare('DELETE FROM jobs WHERE installation=? AND (?=0 OR repository=?)').run(installation, repository, repository)
  }
  restore(installation, repository = 0) { this.db.prepare('DELETE FROM revoked WHERE installation=? AND repository=?').run(installation, repository) }
  enqueue(job, digest, { rerun = false } = {}) {
    // A rerun gets a new durable identity, never the original job's id.
    const { id: previousId, ...payload } = job
    return this.transaction(() => {
      if (!this.remember(digest)) return { duplicate: true }
      if (this.blocked(job.installation, job.repository)) return { revoked: true }
      const key = createHash('sha256').update(JSON.stringify([job.installation, job.repository, job.scope, job.base, job.head, rerun ? digest : ''])).digest('hex')
      const existing = this.db.prepare('SELECT id FROM jobs WHERE key=?').get(key)
      if (existing) return { duplicate: true, id: existing.id }
      const now = this.now(), jobId = randomUUID()
      this.db.prepare('INSERT INTO jobs (id,key,installation,repository,scope,payload,state,created,updated,available) VALUES (?,?,?,?,?,?,?, ?,?,?)')
        .run(jobId, key, job.installation, job.repository, job.scope, JSON.stringify(payload), 'queued', now, now, now)
      return { id: jobId }
    })
  }
  claim() {
    return this.transaction(() => {
      const now = this.now()
      this.db.prepare("UPDATE jobs SET state='queued',lease=NULL WHERE state='running' AND lease_until<?").run(now)
      const row = this.db.prepare("SELECT * FROM jobs WHERE state='queued' AND available<=? ORDER BY created,id LIMIT 1").get(now)
      if (!row) return null
      const lease = randomUUID()
      this.db.prepare("UPDATE jobs SET state='running',lease=?,lease_until=?,attempts=attempts+1,updated=? WHERE id=?").run(lease, now + 180_000, now, row.id)
      this.db.prepare('INSERT INTO usage VALUES (?,?,1) ON CONFLICT(installation,month) DO UPDATE SET attempts=attempts+1').run(row.installation, new Date(now).toISOString().slice(0,7))
      return { ...row, ...JSON.parse(row.payload), lease, attempts: row.attempts + 1 }
    })
  }
  active(job) {
    return !!this.db.prepare("SELECT 1 FROM jobs WHERE id=? AND lease=? AND state='running'").get(job.id, job.lease) && !this.blocked(job.installation, job.repository)
  }
  quotaExceeded(job) {
    return (this.db.prepare('SELECT attempts FROM usage WHERE installation=? AND month=?').get(job.installation, new Date(this.now()).toISOString().slice(0,7))?.attempts ?? 0) > this.monthlyLimit
  }
  check(job, checkId) {
    this.db.prepare("UPDATE jobs SET check_id=? WHERE id=? AND lease=? AND state='running'").run(checkId, job.id, job.lease)
  }
  finish(job, state, { report = null, error = null, durationMs = 0 } = {}) {
    this.db.prepare("UPDATE jobs SET state=?,report=?,error=?,duration_ms=duration_ms+?,updated=?,lease=NULL WHERE id=? AND lease=?")
      .run(state, report ? JSON.stringify(report) : null, error, durationMs, this.now(), job.id, job.lease)
  }
  retry(job, error, delay = 30_000, durationMs = 0) {
    this.db.prepare("UPDATE jobs SET state='queued',available=?,error=?,duration_ms=duration_ms+?,updated=?,lease=NULL WHERE id=? AND lease=?")
      .run(this.now() + Math.max(1000, Math.min(delay, 3_600_000)), error, durationMs, this.now(), job.id, job.lease)
  }
  find(id, installation, repository) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=? AND installation=? AND repository=?').get(id, installation, repository)
    return row ? { ...JSON.parse(row.payload), id: row.id } : null
  }
  jobsForHead(installation, repository, head) {
    if (!Number.isSafeInteger(repository) || typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(head)) return []
    const rows = this.db.prepare('SELECT id,payload,scope FROM jobs WHERE installation=? AND repository=? ORDER BY created DESC, rowid DESC LIMIT 100').all(installation,repository)
    const seen = new Set(), jobs = []
    for (const row of rows) {
      if (seen.has(row.scope)) continue
      seen.add(row.scope)
      const payload = JSON.parse(row.payload)
      if (payload.head === head) jobs.push({ ...payload, id:row.id })
    }
    return jobs
  }
  history(installation) {
    return this.db.prepare('SELECT id,repository,scope,state,created,updated,attempts,check_id,duration_ms,error,report FROM jobs WHERE installation=? ORDER BY created DESC LIMIT 100').all(installation)
      .map(row => ({ ...row, report: row.report ? JSON.parse(row.report) : null }))
  }
  cleanup() {
    const cutoff = this.now() - 30 * 86400_000
    this.db.prepare("DELETE FROM jobs WHERE updated<? AND state NOT IN ('queued','running')").run(cutoff)
    this.db.prepare('DELETE FROM usage WHERE month<?').run(new Date(this.now() - 90 * 86400_000).toISOString().slice(0,7))
    this.db.prepare('DELETE FROM deliveries WHERE created<?').run(this.now() - 90 * 86400_000)
  }
  close() { this.db.close() }
}
