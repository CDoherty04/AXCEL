import { formatDemo, runDemo } from "./demo.js";

const lines = formatDemo(await runDemo());
for (const line of lines) console.log(line);
