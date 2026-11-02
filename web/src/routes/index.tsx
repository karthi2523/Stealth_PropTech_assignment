import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

export const Route = createFileRoute('/')({
  component: BillSplitterApp,
})

interface HomeItem {
  id: string
  name: string
  createdAt?: string
}

interface ShareItem {
  id: string
  memberId: string
  memberName?: string
  amountCents: number
  paidAt: string | null
}

interface BillItem {
  id: string
  homeId: string
  title: string
  totalCents: number
  createdAt?: string
  shares: ShareItem[]
}

interface BalanceItem {
  memberId: string
  name: string
  outstandingCents: number
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function BillSplitterApp() {
  const [homes, setHomes] = useState<HomeItem[]>([])
  const [selectedHomeId, setSelectedHomeId] = useState<string>('')
  const [balances, setBalances] = useState<BalanceItem[]>([])
  const [bills, setBills] = useState<BillItem[]>([])

  const [isLoadingHomes, setIsLoadingHomes] = useState<boolean>(true)
  const [isLoadingData, setIsLoadingData] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [payingShareId, setPayingShareId] = useState<string | null>(null)

  // Form states for creating home / member / bill
  const [newHomeName, setNewHomeName] = useState('')
  const [newMemberName, setNewMemberName] = useState('')
  const [billTitle, setBillTitle] = useState('')
  const [billAmount, setBillAmount] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Fetch homes list safely
  const fetchHomes = useCallback(async () => {
    setIsLoadingHomes(true)
    setErrorMessage(null)
    try {
      const res = await fetch('/api/homes')
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(data?.error || `Failed to fetch homes (Status ${res.status})`)
      }
      const data = (await res.json()) as { homes: HomeItem[] }
      setHomes(data.homes || [])
      if (data.homes && data.homes.length > 0) {
        setSelectedHomeId((prev) => prev || data.homes[0]?.id || '')
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not load homes')
    } finally {
      setIsLoadingHomes(false)
    }
  }, [])

  // Fetch home details (balances + bills) safely
  const fetchHomeData = useCallback(async (homeId: string) => {
    if (!homeId) return
    setIsLoadingData(true)
    setErrorMessage(null)
    setPaymentError(null)

    try {
      const [balancesRes, billsRes] = await Promise.all([
        fetch(`/api/homes/${homeId}/balances`),
        fetch(`/api/homes/${homeId}/bills`),
      ])

      if (!balancesRes.ok) {
        const data = (await balancesRes.json().catch(() => null)) as { error?: string } | null
        throw new Error(data?.error || `Failed to fetch balances (${balancesRes.status})`)
      }
      if (!billsRes.ok) {
        const data = (await billsRes.json().catch(() => null)) as { error?: string } | null
        throw new Error(data?.error || `Failed to fetch bills (${billsRes.status})`)
      }

      const balancesData = (await balancesRes.json()) as { balances: BalanceItem[] }
      const billsData = (await billsRes.json()) as { bills: BillItem[] }

      setBalances(balancesData.balances || [])
      setBills(billsData.bills || [])
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Error loading bills and balances')
    } finally {
      setIsLoadingData(false)
    }
  }, [])

  useEffect(() => {
    fetchHomes()
  }, [fetchHomes])

  useEffect(() => {
    if (selectedHomeId) {
      fetchHomeData(selectedHomeId)
    } else {
      setBalances([])
      setBills([])
    }
  }, [selectedHomeId, fetchHomeData])

  // Pay a share with idempotency protection
  const handlePayShare = async (billId: string, shareId: string) => {
    setPaymentError(null)
    setPayingShareId(shareId)

    // Generate unique idempotency key for this payment intent
    const idempotencyKey = crypto.randomUUID()

    try {
      const res = await fetch(`/api/bills/${billId}/shares/${shareId}/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
      })

      const data = (await res.json().catch(() => null)) as {
        id?: string
        paidAt?: string
        error?: string
      } | null

      if (!res.ok) {
        // Keep share unpaid and show error
        setPaymentError(data?.error || `Payment failed with status ${res.status}`)
        return
      }

      if (data?.paidAt) {
        // Optimistically update local share state to Paid
        setBills((prevBills) =>
          prevBills.map((bill) => {
            if (bill.id !== billId) return bill
            return {
              ...bill,
              shares: bill.shares.map((s) =>
                s.id === shareId ? { ...s, paidAt: data.paidAt || null } : s,
              ),
            }
          }),
        )

        // Refresh balances in background
        if (selectedHomeId) {
          fetch(`/api/homes/${selectedHomeId}/balances`)
            .then((r) => r.json())
            .then((bData: { balances?: BalanceItem[] }) => {
              if (bData?.balances) setBalances(bData.balances)
            })
            .catch(() => {})
        }
      }
    } catch (err) {
      // Keeps share unpaid and displays safe error
      setPaymentError(
        err instanceof Error ? err.message : 'Network error: payment could not be processed',
      )
    } finally {
      setPayingShareId(null)
    }
  }

  // Create a new home
  const handleCreateHome = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newHomeName.trim()) return
    setIsSubmitting(true)
    setFormError(null)

    try {
      const res = await fetch('/api/homes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newHomeName.trim() }),
      })
      const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null
      if (!res.ok || !data?.id) {
        throw new Error(data?.error || 'Failed to create home')
      }
      setNewHomeName('')
      await fetchHomes()
      setSelectedHomeId(data.id)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create home')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Add a member to the current home
  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newMemberName.trim() || !selectedHomeId) return
    setIsSubmitting(true)
    setFormError(null)

    try {
      const res = await fetch(`/api/homes/${selectedHomeId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newMemberName.trim() }),
      })
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to add member')
      }
      setNewMemberName('')
      fetchHomeData(selectedHomeId)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add member')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Add a bill
  const handleCreateBill = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!billTitle.trim() || !billAmount || !selectedHomeId) return
    setIsSubmitting(true)
    setFormError(null)

    const parsedCents = Math.round(Number.parseFloat(billAmount) * 100)
    if (Number.isNaN(parsedCents) || parsedCents <= 0) {
      setFormError('Amount must be a positive number')
      setIsSubmitting(false)
      return
    }

    try {
      const res = await fetch(`/api/homes/${selectedHomeId}/bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: billTitle.trim(),
          totalCents: parsedCents,
        }),
      })
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to create bill')
      }
      setBillTitle('')
      setBillAmount('')
      fetchHomeData(selectedHomeId)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create bill')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="container">
      {/* Top Header */}
      <header className="header">
        <div className="header-title">
          <h1>Shared Bill Splitter</h1>
          <p>Split shared expenses fairly with idempotent, concurrency-safe payments</p>
        </div>

        {/* Home Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {isLoadingHomes ? (
            <div className="skeleton" style={{ width: 180, height: 38 }} />
          ) : (
            <select
              className="select"
              style={{ minWidth: 200 }}
              value={selectedHomeId}
              onChange={(e) => setSelectedHomeId(e.target.value)}
            >
              {homes.length === 0 ? (
                <option value="">No homes created</option>
              ) : (
                homes.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))
              )}
            </select>
          )}
        </div>
      </header>

      {/* Global Error Banner */}
      {errorMessage && (
        <div className="alert alert-danger" role="alert">
          <div>
            <strong>Error: </strong>
            {errorMessage}
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => (selectedHomeId ? fetchHomeData(selectedHomeId) : fetchHomes())}
          >
            Retry
          </button>
        </div>
      )}

      {/* Payment Error Banner */}
      {paymentError && (
        <div className="alert alert-danger" role="alert">
          <div>
            <strong>Payment Issue: </strong>
            {paymentError}
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setPaymentError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Setup / Add Home Section if no homes or to create another */}
      <div className="card">
        <div className="card-title">
          <span>Manage Homes & Members</span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {/* Create Home Form */}
          <form onSubmit={handleCreateHome} style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className="input"
              placeholder="New home name (e.g. Flat 4B)"
              value={newHomeName}
              onChange={(e) => setNewHomeName(e.target.value)}
              disabled={isSubmitting}
            />
            <button
              type="submit"
              className="btn btn-secondary"
              disabled={isSubmitting || !newHomeName.trim()}
              style={{ whiteSpace: 'nowrap' }}
            >
              + Add Home
            </button>
          </form>

          {/* Add Member Form */}
          {selectedHomeId && (
            <form onSubmit={handleAddMember} style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                className="input"
                placeholder="New member name (e.g. Asha)"
                value={newMemberName}
                onChange={(e) => setNewMemberName(e.target.value)}
                disabled={isSubmitting}
              />
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={isSubmitting || !newMemberName.trim()}
                style={{ whiteSpace: 'nowrap' }}
              >
                + Add Member
              </button>
            </form>
          )}
        </div>
        {formError && (
          <div style={{ marginTop: 10, color: 'var(--danger-text)', fontSize: 13 }}>
            {formError}
          </div>
        )}
      </div>

      {/* If No Home Selected or Exists */}
      {!selectedHomeId ? (
        <div className="card empty-state">
          <div className="empty-state-icon">🏠</div>
          <h3>No Home Selected</h3>
          <p>Create a home above to start tracking and splitting bills.</p>
        </div>
      ) : (
        <>
          {/* Members & Balances Card */}
          <div className="card">
            <div className="card-title">
              <span>Member Outstanding Balances</span>
              <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>
                Order added: earliest receives remainder cents
              </span>
            </div>

            {isLoadingData ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <div className="skeleton" style={{ height: 64 }} />
                <div className="skeleton" style={{ height: 64 }} />
                <div className="skeleton" style={{ height: 64 }} />
              </div>
            ) : balances.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                No members in this home yet. Add members above before adding bills.
              </div>
            ) : (
              <div className="balances-grid">
                {balances.map((b, index) => (
                  <div key={b.memberId} className="balance-pill">
                    <span className="balance-pill-name">
                      {index + 1}. {b.name}
                    </span>
                    <span
                      className={`balance-pill-amount ${b.outstandingCents === 0 ? 'zero' : ''}`}
                    >
                      {formatCents(b.outstandingCents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Create Bill Form */}
          <div className="card">
            <div className="card-title">
              <span>Add & Split New Bill</span>
            </div>
            <form
              onSubmit={handleCreateBill}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}
            >
              <input
                type="text"
                className="input"
                style={{ flex: '2 1 200px' }}
                placeholder="Bill title (e.g. WiFi, Groceries)"
                value={billTitle}
                onChange={(e) => setBillTitle(e.target.value)}
                disabled={isSubmitting || balances.length === 0}
              />
              <div style={{ flex: '1 1 140px', position: 'relative' }}>
                <span
                  style={{
                    position: 'absolute',
                    left: 10,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-muted)',
                  }}
                >
                  $
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  className="input"
                  style={{ paddingLeft: 24 }}
                  placeholder="0.00"
                  value={billAmount}
                  onChange={(e) => setBillAmount(e.target.value)}
                  disabled={isSubmitting || balances.length === 0}
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting || !billTitle.trim() || !billAmount || balances.length === 0}
              >
                Split Bill
              </button>
            </form>
            {balances.length === 0 && (
              <p style={{ marginTop: 8, fontSize: 13, color: 'var(--warning-text)' }}>
                Cannot create a bill: this home has no members.
              </p>
            )}
          </div>

          {/* Bills & Shares Section */}
          <div className="card">
            <div className="card-title">
              <span>Bills & Shares</span>
              {bills.length > 0 && (
                <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>
                  {bills.length} {bills.length === 1 ? 'bill' : 'bills'}
                </span>
              )}
            </div>

            {isLoadingData ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="skeleton" style={{ height: 110 }} />
                <div className="skeleton" style={{ height: 110 }} />
              </div>
            ) : bills.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🧾</div>
                <h3>No Bills Yet</h3>
                <p>Add a bill above to split it among members.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {bills.map((bill) => (
                  <div
                    key={bill.id}
                    style={{
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 16,
                      backgroundColor: '#ffffff',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        borderBottom: '1px solid #f1f5f9',
                        paddingBottom: 8,
                        marginBottom: 10,
                      }}
                    >
                      <h4 style={{ fontSize: 16, fontWeight: 600 }}>{bill.title}</h4>
                      <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-main)' }}>
                        {formatCents(bill.totalCents)}
                      </span>
                    </div>

                    <div className="shares-list">
                      {bill.shares.map((share) => {
                        const isPaid = share.paidAt !== null
                        const isPaying = payingShareId === share.id
                        // Find member name if available
                        const member = balances.find((b) => b.memberId === share.memberId)
                        const displayName =
                          share.memberName || member?.name || share.memberId.slice(0, 8)

                        return (
                          <div key={share.id} className="share-row">
                            <div className="share-info">
                              <span className="share-member">{displayName}</span>
                              <span className="share-amount">{formatCents(share.amountCents)}</span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              {isPaid ? (
                                <span className="badge badge-paid">
                                  ✓ Paid{' '}
                                  {share.paidAt && (
                                    <span style={{ marginLeft: 4, fontWeight: 400, opacity: 0.85 }}>
                                      (
                                      {new Date(share.paidAt).toLocaleTimeString([], {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })}
                                      )
                                    </span>
                                  )}
                                </span>
                              ) : (
                                <>
                                  <span className="badge badge-unpaid">Unpaid</span>
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-sm"
                                    disabled={isPaying}
                                    onClick={() => handlePayShare(bill.id, share.id)}
                                  >
                                    {isPaying ? 'Processing...' : 'Pay Share'}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
