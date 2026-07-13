export function EmptyState({ message }: { message: string }) {
  return (
    <p
      role="status"
      className="rounded-card border border-dashed border-separator bg-background px-4 py-8 text-center text-sm text-label-secondary"
    >
      {message}
    </p>
  );
}
