export function LoadingState({ message = "Carregando…" }: { message?: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-6 text-sm text-slate-600">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600"
      />
      {message}
    </p>
  );
}
