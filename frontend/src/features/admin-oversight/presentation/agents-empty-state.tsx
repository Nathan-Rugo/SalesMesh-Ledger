import { ReceiptEmpty } from '@/shared/presentation/ui/receipt';

/** Agent directory before it is wired to the gateway (#14). Says what will appear and when; claims no count. */
export function AgentsEmptyState() {
  return (
    <ReceiptEmpty eyebrow="Agents" icon="users" title="Your agents will be listed here">
      <p>Each sales agent on your merchant account appears here with their M-Pesa payout number and whether they have activated.</p>
      <p>New agents activate with the one-time PIN you give them, then choose their own.</p>
    </ReceiptEmpty>
  );
}
