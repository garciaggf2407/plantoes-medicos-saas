export function EmptyState({ message }: { message: string }) {
  return (
    <p
      role="status"
      className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600"
    >
      {message}
    </p>
  );
}
