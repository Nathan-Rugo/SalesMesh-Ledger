/** Dashboard page title plus its one-line purpose. */
export function PageHeader({ title, purpose }: { title: string; purpose?: string }) {
  return (
    <header className="mb-6 flex flex-col gap-1.5">
      <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-ink">{title}</h1>
      {purpose ? <p className="max-w-prose text-[15px] text-ink-muted">{purpose}</p> : null}
    </header>
  );
}
