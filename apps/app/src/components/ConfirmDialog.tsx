import { ConfirmDialog as Dialog, type ConfirmDialogProps } from "@selis/ui";
import { useOverlay } from "../state/navigation";

/** Confirm dialog that the system back gesture cancels (one history entry while open). */
export function ConfirmDialog(props: ConfirmDialogProps) {
  useOverlay(props.open, props.onCancel);
  return <Dialog {...props} />;
}
