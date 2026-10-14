'use client';

import { CrashReceipt } from '@/shared/presentation/ui/crash-receipt';

/** Dashboard crash: rendered inside the shell, so nav and Sign out stay available. */
export default function DashboardError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <CrashReceipt {...props} inline />;
}
