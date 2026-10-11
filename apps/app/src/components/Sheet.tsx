import { BottomSheet, type BottomSheetProps } from "@selis/ui";
import { useOverlay } from "../state/navigation";

/** Bottom sheet that the system back gesture closes (one history entry while open). */
export function Sheet(props: BottomSheetProps) {
  useOverlay(props.open, props.onClose);
  return <BottomSheet {...props} />;
}
