import { ReceiptEmpty } from '@/shared/presentation/ui/receipt';

/** No payouts yet: says what will appear and when. */
export function PayoutsEmptyState() {
  return (
    <ReceiptEmpty eyebrow="Payouts · M-Pesa" icon="wallet" title="Your payouts will show here">
      <p>
        A payout appears once commission clears and is sent to your M-Pesa number, with its M-Pesa receipt code so you can match it to
        the SMS on your phone.
      </p>
      <p>Money still held in escrow stays on your ledger until the customer&rsquo;s payment settles.</p>
    </ReceiptEmpty>
  );
}
