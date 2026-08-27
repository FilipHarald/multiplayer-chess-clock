import { cn } from '../../lib/utils';

export function Select({ className, children, ...props }) {
  return (
    <select className={cn('h-10 rounded-lg border border-input bg-secondary px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', className)} {...props}>
      {children}
    </select>
  );
}
