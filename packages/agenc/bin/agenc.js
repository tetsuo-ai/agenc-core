#!/usr/bin/env node
import { runAgencWrapper } from "../lib/cli.js";

const exitCode = await runAgencWrapper();
process.exitCode = exitCode;
