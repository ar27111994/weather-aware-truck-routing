/**
 * The app's one entry to Zod: every module that creates schemas imports `z` from here (an ESLint
 * rule forbids importing values from "zod" anywhere else; type-only imports stay allowed).
 *
 * Production's `script-src` has no `'unsafe-eval'` (vercel.json). Zod 4 compiles a fast parser for
 * each object schema with `new Function` when the page allows it, and finds out by calling
 * `new Function("")` inside a try/catch when the first object schema is created. The policy blocks
 * that call, and the browser reports it as a `securitypolicyviolation` (blocked `eval`) although
 * the error is caught. `jitless` turns off both the compiler and the probe, so pages under the
 * policy run the interpreted parser they would have fallen back to anyway, and report nothing.
 * Allowing `'unsafe-eval'` instead would reopen string-to-code execution to any injected script.
 *
 * The setting is global, so it has to run before the first schema exists: importing `z` from this
 * module guarantees that, because a module's imports are evaluated before its body.
 */
import { z } from "zod";

z.config({ jitless: true });

export { z };
