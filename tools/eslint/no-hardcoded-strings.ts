/**
 * Fails on user-visible text that bypasses i18n:
 *  - non-whitespace JSX text (`<p>Hello</p>`)
 *  - string literals in user-facing JSX attributes (`aria-label="Close"`)
 *  - string literals passed to the `label`/`title`/`body` props of components
 * Punctuation/number-only text (e.g. "·", "—", "3") is allowed.
 */
import type { Rule } from "eslint";

const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "alt",
  "title",
  "placeholder",
  "label",
  "body",
]);

const HAS_LETTERS = /\p{L}/u;

type JsxAttributeNode = {
  name: { type: string; name: unknown };
  value: { type: string; value?: unknown; expression?: { type: string; value?: unknown; quasis?: unknown[] } } | null;
};

export const noHardcodedStrings: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow user-visible strings that are not translated (i18n)." },
    messages: {
      text: "Hardcoded UI text {{text}}. Use t(...) with a key in src/i18n/*.json.",
      attribute: "Hardcoded '{{name}}' text {{text}}. Use t(...) with a key in src/i18n/*.json.",
    },
    schema: [],
  },
  create(context) {
    const report = (node: Rule.Node, messageId: "text" | "attribute", text: string, name = "") => {
      context.report({ node, messageId, data: { text: JSON.stringify(text.trim().slice(0, 40)), name } });
    };

    return {
      JSXText(node: Rule.Node) {
        const value = (node as unknown as { value: string }).value;
        if (HAS_LETTERS.test(value)) report(node, "text", value);
      },
      JSXAttribute(node: Rule.Node) {
        const attr = node as unknown as JsxAttributeNode;
        if (attr.name.type !== "JSXIdentifier" || typeof attr.name.name !== "string") return;
        if (!TEXT_ATTRIBUTES.has(attr.name.name) || !attr.value) return;
        const { value } = attr;
        if (value.type === "Literal" && typeof value.value === "string" && HAS_LETTERS.test(value.value)) {
          report(node, "attribute", value.value, attr.name.name);
        }
        const expr = value.expression;
        if (value.type === "JSXExpressionContainer" && expr?.type === "Literal" && typeof expr.value === "string") {
          if (HAS_LETTERS.test(expr.value)) report(node, "attribute", expr.value, attr.name.name);
        }
      },
    };
  },
};

export default {
  meta: { name: "selis-i18n" },
  rules: { "no-hardcoded-strings": noHardcodedStrings },
};
