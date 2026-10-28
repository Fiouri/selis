import type * as App from "./app";
import * as impl from "./index";

/** Compile-time check: `index.ts` provides everything `app.d.ts` promises the app, with those types. */
export const appApi: typeof App = impl;
