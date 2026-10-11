/**
 * Form mode, over one page: every fillable widget gets a control at its exact
 * place. PDFium draws the field's value (its appearance stream); the control
 * is a light accent tint until it is edited:
 * - text: tap → an input (textarea when multiline) on paper, committed on
 *   blur / Enter;
 * - checkbox / radio: a toggle with a ≥ 44 px target around the box;
 * - choice: a native select over the field.
 * Each change is an undoable command (`fieldCommand`).
 */
import type { DocHandle, FieldChange, FormField } from "@selis/engine";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../../components/Toast";
import type { EditSession } from "../annotate/session";
import { fieldCommand, useFormState } from "./formState";

const MIN_TARGET_PX = 44;

/** Keyed by field id + value: a new value (after a commit or undo) starts a fresh draft. */
function TextControl({
  field,
  scale,
  active,
  onCommit,
  onOpen,
  onDone,
}: {
  field: FormField;
  scale: number;
  active: boolean;
  onCommit: (text: string) => void;
  onOpen: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(field.value);
  // Open while it is the active field (a tap, or next / previous).
  const editing = active;
  const box = { left: field.rect.x * scale, top: field.rect.y * scale, width: field.rect.width * scale, height: field.rect.height * scale };
  const fontSize = Math.max(12, (field.fontSize > 0 ? field.fontSize : Math.min(12, field.rect.height * 0.7)) * scale);

  useEffect(() => {
    if (editing) (inputRef.current ?? textareaRef.current)?.focus();
  }, [editing]);

  const commit = () => {
    onDone();
    if (draft !== field.value) onCommit(draft);
  };

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={field.name}
        onPointerDown={(e) => e.preventDefault()}
        onClick={onOpen}
        className="selis-focus absolute rounded-[2px] border border-accent-7 bg-accent-3/35"
        style={{ ...box, minHeight: Math.min(MIN_TARGET_PX, box.height + 16) }}
        data-testid={`field-${field.name}`}
      />
    );
  }
  const className = "selis-focus absolute rounded-[2px] border-2 border-accent-9 bg-paper px-1 text-note-ink outline-none";
  const style = { ...box, fontSize, lineHeight: 1.2 };
  return field.multiline ? (
    <textarea
      ref={textareaRef}
      value={draft}
      aria-label={field.name}
      maxLength={field.maxLength ?? undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(field.value);
          onDone();
        }
      }}
      className={`${className} resize-none`}
      style={style}
      data-testid={`field-input-${field.name}`}
    />
  ) : (
    <input
      ref={inputRef}
      value={draft}
      aria-label={field.name}
      maxLength={field.maxLength ?? undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      enterKeyHint="done"
      placeholder={field.required ? t("forms.required") : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(field.value);
          onDone();
        }
      }}
      className={className}
      style={style}
      data-testid={`field-input-${field.name}`}
    />
  );
}

export function FormLayer({ doc, index, scale, session }: { doc: DocHandle; index: number; scale: number; session: EditSession }) {
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const all = useFormState((s) => s.fields);
  const active = useFormState((s) => s.active);
  const setActive = useFormState((s) => s.setActive);
  const fields = (all ?? []).filter((f) => f.page === index);
  if (fields.length === 0) return null;

  const change = (field: FormField, c: FieldChange) => {
    session.run(fieldCommand(doc, field, all ?? [], c)).catch((err: unknown) => {
      console.warn("selis: form field not changed", err);
      showToast(t("forms.failed"), "error");
    });
  };

  return (
    <div className="pointer-events-none absolute inset-0" data-testid={`form-layer-${index + 1}`} onClick={(e) => e.stopPropagation()}>
      {fields.map((field) => {
        const box = { left: field.rect.x * scale, top: field.rect.y * scale, width: field.rect.width * scale, height: field.rect.height * scale };
        const isActive = active === field.id;
        switch (field.kind) {
          case "text":
            return (
              <div key={field.id} className="pointer-events-auto">
                <TextControl
                  key={`${field.id}:${field.value}`}
                  field={field}
                  scale={scale}
                  active={isActive}
                  onOpen={() => setActive(field.id)}
                  onDone={() => {
                    if (useFormState.getState().active === field.id) setActive(null);
                  }}
                  onCommit={(text) => change(field, { kind: "text", text })}
                />
              </div>
            );
          case "checkbox":
          case "radio": {
            // Grow small boxes to a 44 px target, centred on the box.
            const w = Math.max(MIN_TARGET_PX, box.width);
            const h = Math.max(MIN_TARGET_PX, box.height);
            return (
              <button
                key={field.id}
                type="button"
                role={field.kind === "radio" ? "radio" : "checkbox"}
                aria-checked={field.checked}
                aria-label={field.name}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  setActive(field.id);
                  // A radio option on stays on (PDF radios rarely allow "none").
                  if (field.kind === "radio" && field.checked) return;
                  change(field, { kind: "checked", checked: !field.checked });
                }}
                className={`selis-focus pointer-events-auto absolute flex items-center justify-center rounded-[4px] ${
                  isActive ? "outline-2 outline-accent-9" : ""
                }`}
                style={{ left: box.left - (w - box.width) / 2, top: box.top - (h - box.height) / 2, width: w, height: h }}
                data-testid={`field-${field.name}${field.kind === "radio" ? `-${field.id}` : ""}`}
              >
                <span className="block rounded-[2px] border border-accent-7 bg-accent-3/35" style={{ width: box.width, height: box.height }} />
              </button>
            );
          }
          case "combobox":
          case "listbox": {
            const selected = field.options.findIndex((o) => o.selected);
            return (
              <select
                key={field.id}
                aria-label={field.name}
                value={selected >= 0 ? String(selected) : ""}
                onFocus={() => setActive(field.id)}
                onChange={(e) => change(field, { kind: "select", index: Number(e.target.value) })}
                // Transparent: PDFium draws the value; the native picker opens on tap.
                className="selis-focus pointer-events-auto absolute cursor-pointer appearance-none rounded-[2px] border border-accent-7 bg-accent-3/35 text-transparent"
                style={{ ...box, minHeight: Math.min(MIN_TARGET_PX, box.height + 16) }}
                data-testid={`field-${field.name}`}
              >
                {selected < 0 ? <option value="">{t("forms.chooseOption")}</option> : null}
                {field.options.map((o, i) => (
                  <option key={o.label} value={String(i)} className="text-neutral-12">
                    {o.label}
                  </option>
                ))}
              </select>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}
