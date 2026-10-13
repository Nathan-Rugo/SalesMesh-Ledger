import type { Metadata } from 'next';
import { AdminEmptyState } from '@/features/admin-oversight/presentation/admin-empty-state';

export const metadata: Metadata = { title: 'Oversight' };

export default function AdminPage() {
  return (
    <>
      <h1 className="mb-6 text-3xl font-extrabold tracking-[-0.03em] text-ink">Oversight</h1>
      <AdminEmptyState />
    </>
  );
}
