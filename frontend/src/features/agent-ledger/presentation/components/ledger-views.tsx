'use client';

import type { ReactNode } from 'react';
import { errorMessage, type AppError } from '@/core/domain/app-error';
import { Button } from '@/shared/presentation/ui/button';
import { Icon } from '@/shared/presentation/ui/icon';
import { ReceiptEmpty } from '@/shared/presentation/ui/receipt';
import type { LedgerSnapshot } from '../../domain/entities/ledger';
import { CommissionLifecycle } from '../commission-lifecycle';
import { useLedger, type LedgerState } from '../state/use-ledger';
import { AccrualTimeline } from './accrual-timeline';
import { BalanceSlip } from './balance-slip';
import { PayoutButton } from './payout-button';
import { PayoutHistory } from './payout-history';
import { PayoutLineCard } from './payout-line-card';

/** A GET 503 temporarily_unavailable is the gateway being down, not the claim's "not sent" case. */
const loadErrorMessage = (e: AppError | null): string =>
  !e ? 'Something went wrong. Try again.' : errorMessage(e.kind === 'payout_refused' && e.code === 'temporarily_unavailable' ? { kind: 'unavailable' } : e);

function Skeleton() {
  return (
    <div role="status" aria-label="Loading your ledger" className="flex flex-col gap-6">
      <div className="h-44 animate-pulse rounded-2xl bg-inset" />
      <div className="h-28 animate-pulse rounded-2xl bg-inset" />
    </div>
  );
}

/** Loading, error-with-retry and the stale banner around a snapshot. */
function LedgerFrame({ ledger, children }: { ledger: LedgerState; children: (s: LedgerSnapshot, offline: boolean) => ReactNode }) {
  const { data, error, loaded, stale, refresh } = ledger;
  if (!loaded) return <Skeleton />;
  if (!data) {
    if (error?.kind === 'unauthenticated') return <Skeleton />; // the role guard is already redirecting to sign-in
    const disabled = error?.kind === 'payout_refused' && error.code === 'payouts_disabled';
    return (
      <ReceiptEmpty eyebrow="Ledger" icon={disabled ? 'wallet' : 'alert'} title={disabled ? 'Payouts are paused' : "Your ledger didn't load"}>
        <p>{loadErrorMessage(error)}</p>
        <div>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      </ReceiptEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {stale ? (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-escrow-hold-border bg-escrow-hold-bg p-3 text-sm font-medium text-escrow-hold-ink">
          <Icon name="offline" className="size-4 shrink-0" />
          Can&rsquo;t reach SalesMesh. Showing your last update; it refreshes when you&rsquo;re back online.
        </p>
      ) : null}
      {children(data, stale)}
    </div>
  );
}

/** /agent: balance slip with the claim, the payout-line card when needed, and the accrual timeline. */
export function AgentDashboard() {
  const ledger = useLedger();
  return (
    <LedgerFrame ledger={ledger}>
      {(s, offline) => {
        const fresh = s.balance.cents === 0 && s.accruals.length === 0 && s.payouts.length === 0;
        return (
          <>
            <BalanceSlip snapshot={s}>
              <PayoutButton snapshot={s} offline={offline} onChanged={ledger.refresh} />
            </BalanceSlip>
            {!s.destination || s.destinationChanging ? <PayoutLineCard snapshot={s} offline={offline} onChanged={ledger.refresh} /> : null}
            {s.accruals.length > 0 ? <AccrualTimeline accruals={s.accruals} pendingCount={s.pendingCount} /> : null}
            {fresh ? <CommissionLifecycle /> : null}
          </>
        );
      }}
    </LedgerFrame>
  );
}

/** /agent/payouts: history as receipts. */
export function PayoutsView() {
  const ledger = useLedger();
  return <LedgerFrame ledger={ledger}>{(s) => <PayoutHistory payouts={s.payouts} />}</LedgerFrame>;
}
