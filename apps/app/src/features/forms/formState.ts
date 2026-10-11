/**
 * Form mode: the document's fields (for the banner and next / previous), the
 * field being edited, and the undoable commands for filling and flattening.
 */
import type { DocHandle, FieldChange, FormField } from "@selis/engine";
import { create } from "zustand";
import type { Command } from "../annotate/session";

/** Fields Selis fills (buttons, signatures and unknown kinds are left alone). */
export function isFillable(f: FormField): boolean {
  return !f.readOnly && (f.kind === "text" || f.kind === "checkbox" || f.kind === "radio" || f.kind === "combobox" || f.kind === "listbox");
}

type FormState = {
  /** Every fillable widget, in page order; null until loaded. */
  fields: FormField[] | null;
  /** Widget being edited (focused input, or target of next / previous). */
  active: string | null;
  /** The last widget that was active: next / previous go on from here. */
  cursor: string | null;
  setFields: (fields: FormField[] | null) => void;
  /** Applies a page's fresh widgets (after a change) to the document list. */
  mergePage: (page: number, fields: readonly FormField[]) => void;
  setActive: (id: string | null) => void;
};

export const useFormState = create<FormState>((set) => ({
  fields: null,
  active: null,
  cursor: null,
  setFields: (fields) => set({ fields: fields?.filter(isFillable) ?? null, active: null, cursor: null }),
  mergePage: (page, fresh) =>
    set((s) => {
      if (!s.fields) return {};
      const byId = new Map(fresh.map((f) => [f.id, f]));
      return { fields: s.fields.map((f) => (f.page === page ? (byId.get(f.id) ?? f) : f)) };
    }),
  setActive: (active) => set((s) => ({ active, cursor: active ?? s.cursor })),
}));

/** Distinct fields (radio options share a name) for the banner count. */
export function fieldCount(fields: readonly FormField[]): number {
  return new Set(fields.map((f) => f.name)).size;
}

/** The change that puts a widget back the way it is now (undo). */
function undoChange(field: FormField, siblings: readonly FormField[]): { id: string; change: FieldChange } {
  switch (field.kind) {
    case "checkbox":
      return { id: field.id, change: { kind: "checked", checked: field.checked } };
    case "radio": {
      // Undo re-selects whichever option of the group was on (or clears this one).
      const on = siblings.find((f) => f.kind === "radio" && f.name === field.name && f.checked);
      return on ? { id: on.id, change: { kind: "checked", checked: true } } : { id: field.id, change: { kind: "checked", checked: false } };
    }
    case "combobox":
    case "listbox": {
      const index = field.options.findIndex((o) => o.selected);
      return { id: field.id, change: index >= 0 ? { kind: "select", index } : { kind: "text", text: field.value } };
    }
    default:
      return { id: field.id, change: { kind: "text", text: field.value } };
  }
}

/** Fills a field; undo restores its previous value. */
export function fieldCommand(doc: DocHandle, field: FormField, siblings: readonly FormField[], change: FieldChange): Command {
  const back = undoChange(field, siblings);
  const apply = async (id: string, c: FieldChange) => {
    const fresh = await doc.setFormField(field.page, id, c);
    useFormState.getState().mergePage(field.page, fresh);
  };
  return {
    tool: "form",
    apply: () => apply(field.id, change),
    revert: () => apply(back.id, back.change),
  };
}

/**
 * Flattens the whole document. Undo reloads the bytes saved just before the
 * first flatten (kept in memory while the document is open). The snapshot is
 * taken inside `apply`, so it runs in the session queue after earlier edits.
 */
export function flattenCommand(doc: DocHandle): Command {
  let before: ArrayBuffer | null = null;
  const refresh = async () => {
    useFormState.getState().setFields(await doc.documentFields());
  };
  return {
    tool: "flatten",
    apply: async () => {
      before ??= await doc.save();
      await doc.flatten();
      await refresh();
    },
    revert: async () => {
      if (!before) return;
      // `reload` takes the buffer: hand it a copy so undo can happen again after a redo.
      await doc.reload(before.slice(0));
      await refresh();
    },
  };
}
