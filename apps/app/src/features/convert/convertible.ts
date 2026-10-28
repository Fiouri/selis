import { SOURCE_EXTENSIONS } from "@selis/convert/kind";

const EXTENSIONS = new Set(Object.values(SOURCE_EXTENSIONS).flat());

/** Whether "Convert to PDF" reads a file of this name (ADR 0035): by its extension. */
export function isConvertibleName(name: string): boolean {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext !== undefined && EXTENSIONS.has(ext);
}
