#!/usr/bin/env node
import { runAgencRuntimeWrapper } from "../lib/cli.js";

const exitCode = await runAgencRuntimeWrapper();
process.exitCode = exitCode;
