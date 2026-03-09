interface LoadingSpinnerProps {
  message?: string;
}

export function LoadingSpinner({ message }: LoadingSpinnerProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-200 border-t-zinc-700" />
      {message && (
        <p className="text-sm text-zinc-400">{message}</p>
      )}
    </div>
  );
}
