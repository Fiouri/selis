/**
 * Sign mode's docked sheet (same frame as the annotate tool sheet): the
 * "Οπτική υπογραφή" label and what it means, saved signatures as cards (a long
 * press deletes one), "+ Νέα", and a hint for the next step.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { forwardRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { useLongPress } from "../../components/useLongPress";
import type { Signature } from "../../lib/api";
import { NewSignatureSheet } from "./NewSignatureSheet";
import { useSignState } from "./SignatureLayer";
import { deleteSignature, signatureBytes, signatureSrc, useSignatures } from "./signatures";

const CARD = "h-16 w-[120px] shrink-0 rounded-card";

function SignatureCard({
  signature,
  index,
  selected,
  onSelect,
  onDelete,
}: {
  signature: Signature;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const press = useLongPress(onDelete);
  return (
    <button
      type="button"
      {...press}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={t("sign.signatureLabel", { index: index + 1 })}
      className={`selis-focus ${CARD} flex items-center justify-center overflow-hidden border bg-paper p-2 ${
        selected ? "border-transparent shadow-[inset_0_0_0_2px_var(--accent-9)]" : "border-control-line"
      }`}
      data-testid="signature-card"
    >
      <img src={signatureSrc(signature)} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
    </button>
  );
}

export const SignSheet = forwardRef<HTMLElement>(function SignSheet(_props, ref) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast((s) => s.show);
  const { data: signatures = [] } = useSignatures();
  const chosen = useSignState((s) => s.chosen);
  const choose = useSignState((s) => s.choose);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Signature | null>(null);

  const select = async (signature: Signature) => {
    if (chosen?.signature.id === signature.id) {
      choose(null);
      return;
    }
    try {
      choose({ signature, image: { mime: "image/png", bytes: await signatureBytes(signature) } });
    } catch (err) {
      console.warn("selis: signature image unavailable", err);
      showToast(t("annotate.failed"), "error");
    }
  };

  const confirmDelete = async () => {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    if (chosen?.signature.id === target.id) choose(null);
    const ok = await deleteSignature(queryClient, target.id);
    showToast(ok ? t("sign.deleted") : t("errors.generic"), ok ? "info" : "error");
  };

  const hint = signatures.length === 0 ? t("sign.emptyHint") : chosen ? t("sign.placeHint") : t("sign.chooseHint");
  return (
    <section
      ref={ref}
      aria-label={t("sign.saved")}
      className="absolute inset-x-0 bottom-0 z-10 rounded-t-sheet border-t border-neutral-5 bg-surface-raised shadow-3"
      style={{ paddingBottom: "calc(var(--safe-bottom) + 8px)", paddingLeft: "var(--safe-left)", paddingRight: "var(--safe-right)" }}
      data-testid="sign-sheet"
    >
      <div className="flex justify-center pt-2 pb-1" aria-hidden="true">
        <span className="h-1 w-9 rounded-full bg-control-line" />
      </div>
      <div className="flex flex-col gap-1 px-5 pt-1 pb-3">
        <span className="self-start rounded-full bg-accent-3 px-2.5 py-0.5 text-xs font-semibold text-accent-selected" data-testid="sign-badge">
          {t("sign.badge")}
        </span>
        <p className="text-xs text-neutral-11">{t("sign.explain")}</p>
      </div>
      <div className="flex gap-2 overflow-x-auto px-5 pb-2 [scrollbar-width:none]" role="group" aria-label={t("sign.saved")}>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className={`selis-focus ${CARD} flex flex-col items-center justify-center gap-0.5 border border-dashed border-control-line text-accent-selected active:bg-neutral-3`}
          data-testid="signature-new"
        >
          <Plus size={22} strokeWidth={1.75} aria-hidden="true" />
          <span className="text-xs font-semibold">{t("sign.new")}</span>
        </button>
        {signatures.map((s, i) => (
          <SignatureCard
            key={s.id}
            signature={s}
            index={i}
            selected={chosen?.signature.id === s.id}
            onSelect={() => void select(s)}
            onDelete={() => setDeleting(s)}
          />
        ))}
      </div>
      <p className="px-5 pt-1 pb-1 text-xs text-neutral-11" data-testid="sign-hint">
        {hint}
      </p>
      <NewSignatureSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(s) => {
          setCreating(false);
          void select(s);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={t("sign.deleteTitle")}
        message={t("sign.deleteBody")}
        confirmLabel={t("sign.deleteConfirm")}
        cancelLabel={t("sign.deleteCancel")}
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
        testId="signature-delete-dialog"
      />
    </section>
  );
});
