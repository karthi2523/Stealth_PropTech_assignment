import { Hono } from 'hono'

interface CreateHomeBody {
  name?: unknown
}

interface AddMemberBody {
  name?: unknown
}

interface CreateBillBody {
  title?: unknown
  totalCents?: unknown
}

interface ShareRow {
  id: string
  bill_id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}

interface MemberRow {
  id: string
  name: string
}

interface BalanceRow {
  memberId: string
  name: string
  outstandingCents: number
}

function isPositiveInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isInteger(val) && val > 0
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0
}

function calculateShares(members: MemberRow[], totalCents: number) {
  const n = members.length
  const base = Math.floor(totalCents / n)
  const remainder = totalCents % n

  return members.map((member, i) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: base + (i < remainder ? 1 : 0),
    paidAt: null as string | null,
  }))
}

const app = new Hono<{ Bindings: Env }>()

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((err, c) => {
  return c.json({ error: err.message || 'Internal server error' }, 500)
})

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.get('/api/homes', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT id, name, created_at as createdAt FROM homes ORDER BY rowid DESC',
  ).all<{ id: string; name: string; createdAt: string }>()

  return c.json({ homes: result.results })
})

app.post('/api/homes', async (c) => {
  const body = (await c.req.json().catch(() => null)) as CreateHomeBody | null
  if (!body || typeof body !== 'object' || !isNonEmptyString(body.name)) {
    return c.json({ error: 'Name is required' }, 400)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = (await c.req.json().catch(() => null)) as AddMemberBody | null
  if (!body || typeof body !== 'object' || !isNonEmptyString(body.name)) {
    return c.json({ error: 'Name is required' }, 400)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, name)
    .run()

  return c.json({ id, homeId, name }, 201)
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const billsResult = await c.env.DB.prepare(
    'SELECT id, home_id as homeId, title, total_cents as totalCents, created_at as createdAt FROM bills WHERE home_id = ? ORDER BY rowid DESC',
  )
    .bind(homeId)
    .all<{ id: string; homeId: string; title: string; totalCents: number; createdAt: string }>()

  const sharesResult = await c.env.DB.prepare(`
    SELECT s.id, s.bill_id as billId, s.member_id as memberId, m.name as memberName, s.amount_cents as amountCents, s.paid_at as paidAt
    FROM shares s
    JOIN members m ON s.member_id = m.id
    JOIN bills b ON s.bill_id = b.id
    WHERE b.home_id = ?
    ORDER BY s.rowid ASC
  `)
    .bind(homeId)
    .all<{
      id: string
      billId: string
      memberId: string
      memberName: string
      amountCents: number
      paidAt: string | null
    }>()

  const sharesByBill = new Map<
    string,
    Array<{
      id: string
      memberId: string
      memberName: string
      amountCents: number
      paidAt: string | null
    }>
  >()

  for (const s of sharesResult.results) {
    let list = sharesByBill.get(s.billId)
    if (!list) {
      list = []
      sharesByBill.set(s.billId, list)
    }
    list.push({
      id: s.id,
      memberId: s.memberId,
      memberName: s.memberName,
      amountCents: s.amountCents,
      paidAt: s.paidAt,
    })
  }

  const bills = billsResult.results.map((bill) => ({
    ...bill,
    shares: sharesByBill.get(bill.id) || [],
  }))

  return c.json({ bills }, 200)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const body = (await c.req.json().catch(() => null)) as CreateBillBody | null
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 422)
  }

  if (!isPositiveInteger(body.totalCents)) {
    return c.json({ error: 'totalCents must be a positive integer' }, 422)
  }

  if (!isNonEmptyString(body.title)) {
    return c.json({ error: 'Title is required' }, 422)
  }

  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const membersResult = await c.env.DB.prepare(
    'SELECT id, name FROM members WHERE home_id = ? ORDER BY rowid ASC',
  )
    .bind(homeId)
    .all<MemberRow>()

  const members = membersResult.results
  if (!members || members.length === 0) {
    return c.json({ error: 'Home has no members' }, 422)
  }

  const billId = crypto.randomUUID()
  const title = body.title.trim()
  const totalCents = body.totalCents
  const shares = calculateShares(members, totalCents)

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, title, totalCents),
    ...shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, billId, share.memberId, share.amountCents),
    ),
  ]

  await c.env.DB.batch(statements)

  return c.json({ id: billId, homeId, title, totalCents, shares }, 201)
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey?.trim()) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const key = idempotencyKey.trim()

  const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?').bind(billId).first()
  if (!bill) {
    return c.json({ error: 'Bill not found' }, 404)
  }

  const share = await c.env.DB.prepare(
    'SELECT id, bill_id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<ShareRow>()

  if (!share) {
    return c.json({ error: 'Share not found' }, 404)
  }

  if (share.paid_at !== null) {
    if (share.idempotency_key === key) {
      return c.json(
        {
          id: share.id,
          memberId: share.member_id,
          amountCents: share.amount_cents,
          paidAt: share.paid_at,
        },
        200,
      )
    }
    return c.json({ error: 'Share already paid' }, 409)
  }

  const paidAt = new Date().toISOString()
  const updateResult = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  )
    .bind(paidAt, key, shareId, billId)
    .run()

  if (updateResult.meta.changes > 0) {
    return c.json(
      {
        id: share.id,
        memberId: share.member_id,
        amountCents: share.amount_cents,
        paidAt,
      },
      200,
    )
  }

  const latest = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<ShareRow>()

  if (latest?.idempotency_key === key) {
    return c.json(
      {
        id: latest.id,
        memberId: latest.member_id,
        amountCents: latest.amount_cents,
        paidAt: latest.paid_at,
      },
      200,
    )
  }

  return c.json({ error: 'Share already paid' }, 409)
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const result = await c.env.DB.prepare(`
    SELECT
      m.id AS memberId,
      m.name AS name,
      COALESCE(SUM(CASE WHEN s.paid_at IS NULL AND s.id IS NOT NULL THEN s.amount_cents ELSE 0 END), 0) AS outstandingCents
    FROM members m
    LEFT JOIN shares s ON s.member_id = m.id
    LEFT JOIN bills b ON s.bill_id = b.id AND b.home_id = m.home_id
    WHERE m.home_id = ?
    GROUP BY m.id, m.name
    ORDER BY m.rowid ASC
  `)
    .bind(homeId)
    .all<BalanceRow>()

  return c.json({ balances: result.results }, 200)
})

export default app
