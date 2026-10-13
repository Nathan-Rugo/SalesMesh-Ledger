import type { Metadata } from 'next';
import Link from 'next/link';
import { LoginForm } from '@/features/auth/presentation/components/login-form';
import { SessionRedirect } from '@/features/auth/presentation/components/session-redirect';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to SalesMesh with your phone number and PIN to see your commission and payouts.',
};

export default function LoginPage() {
  return (
    <>
      <SessionRedirect />
      <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-ink">Sign in</h1>
      <p className="mt-2 mb-8 text-ink-muted">Use the phone number and PIN you set when you activated your account.</p>
      <LoginForm />
      <p className="mt-8 text-[15px] text-ink-muted">
        Got a one-time PIN from your merchant?{' '}
        <Link href="/register" className="inline-flex min-h-11 items-center font-semibold text-link underline underline-offset-4">
          Activate your account
        </Link>
      </p>
    </>
  );
}
