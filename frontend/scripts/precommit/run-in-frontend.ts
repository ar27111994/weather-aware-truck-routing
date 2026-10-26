/**
 * The entry that `.pre-commit-config.yaml` runs for the frontend hooks: it hands the command line to
 * `main` and sets the exit code. Everything else, the rules and the tests, is in `in-frontend.ts`.
 */
import { fileURLToPath } from "node:url";

import { main } from "./in-frontend.ts";

const FRONTEND_DIRECTORY = fileURLToPath(new URL("../..", import.meta.url));

process.exitCode = main(process.argv.slice(2), FRONTEND_DIRECTORY);
