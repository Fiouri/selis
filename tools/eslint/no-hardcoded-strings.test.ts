import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { noHardcodedStrings } from "./no-hardcoded-strings.ts";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

tester.run("no-hardcoded-strings", noHardcodedStrings, {
  valid: [
    { code: "const a = <p>{t('library.title')}</p>;" },
    { code: "const a = <IconButton label={t('viewer.back')} />;" },
    { code: "const a = <span> · </span>;" },
    { code: "const a = <span>{count} / 3</span>;" },
    { code: "const a = <div className=\"flex gap-2\" data-testid=\"list\" />;" },
  ],
  invalid: [
    { code: "const a = <p>Hello</p>;", errors: [{ messageId: "text" }] },
    { code: "const a = <h1>Βιβλιοθήκη</h1>;", errors: [{ messageId: "text" }] },
    { code: "const a = <button aria-label=\"Close\" />;", errors: [{ messageId: "attribute" }] },
    { code: "const a = <img alt={'Logo'} />;", errors: [{ messageId: "attribute" }] },
    { code: "const a = <EmptyState title=\"Empty\" body=\"Nothing here\" />;", errors: 2 },
  ],
});
