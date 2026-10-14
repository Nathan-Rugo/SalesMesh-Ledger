import type { Metadata } from 'next';
import Link from 'next/link';
import { ActivateForm } from '@/features/auth/presentation/components/activate-form';
import { ReceiptEyebrow, ReceiptRule } from '@/shared/presentation/ui/receipt';

export const metadata: Metadata = {
  title: 'Activate your account',
  description: 'Activate your SalesMesh account with the one-time PIN from your merchant, then choose your own PIN.',
};

export default function RegisterPage() {
  return (
    <>
      <ReceiptEyebrow className="mb-3">SalesMesh · Activate</ReceiptEyebrow>
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-ink">Set your PIN</h1>
      <p className="mt-2 text-ink-muted">
        Confirm it&rsquo;s you, then choose a PIN only you know. You&rsquo;ll use it every time you sign in.
      </p>
      <ReceiptRule className="my-6" />
      <ActivateForm />
      <p className="mt-8 border-t border-line pt-4 text-[15px] text-ink-muted">
        Already activated?{' '}
        <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-link underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </>
  );
}
