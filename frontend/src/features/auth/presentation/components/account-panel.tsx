'use client';

import { useState } from 'react';
import { Button } from '@/shared/presentation/ui/button';
import { useToast } from '@/shared/presentation/ui/toast';
import type { Role } from '../../domain/entities/session';
import { ChangePinForm } from './change-pin-form';
import { useSession } from '../state/session-provider';
import { Receipt, ReceiptEyebrow, ReceiptRow, ReceiptRule } from '@/shared/presentation/ui/receipt';
import { SignOutButton } from './sign-out-button';

const ROLE_LABEL: Record<Role, string> = { SALES_AGENT: 'Sales agent', MERCHANT_ADMIN: 'Merchant admin' };

/** "••••3f9a": enough to tell accounts apart on a support call, nothing more. */
const maskId = (id: string) => (id.length > 4 ? `••••${id.slice(-4)}` : '••••');

/** Account slip for either role: who is signed in, and the ways out. No API calls of its own. */
export function AccountPanel() {
  const { session } = useSession();
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  if (!session) return null; // the role guard renders this only for a resolved session
  return (
    <Receipt className="max-w-xl">
      <ReceiptEyebrow>Signed in</ReceiptEyebrow>
      <dl className="mt-3">
        <ReceiptRow label="Role">{ROLE_LABEL[session.user.role]}</ReceiptRow>
        <ReceiptRow label="Account">{maskId(session.user.id)}</ReceiptRow>
        <ReceiptRow label="Change PIN">
          {changing ? null : (
            <Button variant="secondary" className="px-3" onClick={() => setChanging(true)}>
              Change
            </Button>
          )}
        </ReceiptRow>
      </dl>
      {changing ? (
        <ChangePinForm
          onCancel={() => setChanging(false)}
          onDone={() => {
            setChanging(false);
            toast('PIN changed. Other devices were signed out.');
          }}
        />
      ) : null}
      <ReceiptRule />
      <SignOutButton className="px-3" />
    </Receipt>
  );
}
