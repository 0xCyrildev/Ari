#!/usr/bin/env node
import { run } from "./index.js";
const result = await run(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`));
process.exit(result.exit);
