'use client';

import type { Role } from '../../domain/entities/session';
import { useSession } from '../state/session-provider';
import { Receipt, ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { SignOutButton } from './sign-out-button';

const ROLE_LABEL: Record<Role, string> = { SALES_AGENT: 'Sales agent', MERCHANT_ADMIN: 'Merchant admin' };

/** "••••3f9a": enough to tell accounts apart on a support call, nothing more. */
const maskId = (id: string) => (id.length > 4 ? `••••${id.slice(-4)}` : '••••');

/** Account slip for either role: who is signed in, and the ways out. No API calls of its own. */
export function AccountPanel() {
  const { session } = useSession();
  if (!session) return null; // the role guard renders this only for a resolved session
  return (
    <Receipt className="max-w-xl">
      <ReceiptEyebrow>Signed in</ReceiptEyebrow>
      <dl className="mt-3">
        <ReceiptRow label="Role">{ROLE_LABEL[session.user.role]}</ReceiptRow>
        <ReceiptRow label="Account">{maskId(session.user.id)}</ReceiptRow>
        <ReceiptRow label="Change PIN">
          <span className="font-sans text-ink-muted">Coming soon</span>
        </ReceiptRow>
      </dl>
      <ReceiptRule />
      <SignOutButton className="px-3" />
    </Receipt>
  );
}
