import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Collapsible({ title, children, className, defaultOpen = false }) {
  return (
    <CollapsiblePrimitive.Root defaultOpen={defaultOpen} className={cn('w-full overflow-hidden rounded-xl border border-border bg-card', className)}>
      <CollapsiblePrimitive.Trigger className="group flex min-h-12 w-full items-center justify-between px-4 py-3 text-left font-semibold outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span>{title}</span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" aria-hidden="true" />
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden border-t border-border transition-[height] duration-200 data-[starting-style]:h-0 data-[ending-style]:h-0">
        <div className="p-4">{children}</div>
      </CollapsiblePrimitive.Panel>
    </CollapsiblePrimitive.Root>
  );
}
