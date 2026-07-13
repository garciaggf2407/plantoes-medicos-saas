export function ErrorState({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-card bg-negative-bg px-4 py-3 text-sm text-negative">
      {message}
    </p>
  );
}
