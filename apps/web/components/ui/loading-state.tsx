export function LoadingState({ message = "Carregando…" }: { message?: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-6 text-sm text-label-secondary">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-separator border-t-accent"
      />
      {message}
    </p>
  );
}
