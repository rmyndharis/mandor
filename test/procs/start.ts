import { processStart } from "../../src/home.ts";

// Prints {pid, start} for the pid given as the first argument, or for this process.
const pid = process.argv[2] ? Number(process.argv[2]) : process.pid;
console.log(JSON.stringify({ pid, start: processStart(pid) }));
