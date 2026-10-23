// Fill the app-embedded keys into PARKS from the APP_KEY_<PARK> lines in
// .dev.vars, as the worker does from its secrets (src/app-keys.ts). Import this
// before reading a park's queue config in a script. Run from the repo root.
import fs from "node:fs";
import { applyAppKeys } from "../src/app-keys.ts";
import { PARKS } from "../src/config.ts";

const vars = Object.fromEntries(
  (fs.existsSync(".dev.vars") ? fs.readFileSync(".dev.vars", "utf8") : "")
    .split("\n")
    .map((l) => /^(APP_KEY_[A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, "$2")]),
);
if (!Object.keys(vars).length) throw new Error("no APP_KEY_<PARK> lines in .dev.vars (see src/app-keys.ts)");
applyAppKeys(vars, PARKS);
