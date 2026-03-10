interface LoadingSpinnerProps {
  message?: string;
}

export function LoadingSpinner({ message }: LoadingSpinnerProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />
      {message && (
        <p className="text-sm text-ink-faint">{message}</p>
      )}
    </div>
  );
}
