#!/usr/bin/env node
/** @deprecated Use `axcel history <address>` (`npm run axcel -- history <address>`). */
import { main } from "./axcel.mjs";

main(["history", ...process.argv.slice(2)]).catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
