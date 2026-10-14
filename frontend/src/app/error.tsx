'use client';

import { CrashReceipt } from '@/shared/presentation/ui/crash-receipt';

/** Route-level crash screen (full screen, outside any shell). */
export default function ErrorPage(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <CrashReceipt {...props} />;
}
