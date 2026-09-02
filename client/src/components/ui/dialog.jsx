import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { cn } from '../../lib/utils';

export function Dialog({ open, onOpenChange, trigger, title, children, className }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger render={trigger} />
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[60] bg-black/65 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-[60] grid place-items-center p-4">
          <DialogPrimitive.Popup className={cn('w-full max-w-sm rounded-xl border border-border bg-card p-5 text-foreground shadow-2xl outline-none', className)}>
            {title}
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const DialogTitle = DialogPrimitive.Title;
export const DialogClose = DialogPrimitive.Close;
