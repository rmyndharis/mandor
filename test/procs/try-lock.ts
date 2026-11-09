import { withProjectLock } from "../../src/store.ts";

// Usage: try-lock.ts <projectId>. Prints what one tryOnce attempt returns.
console.log(JSON.stringify(withProjectLock(process.argv[2], () => "ran", { tryOnce: true })));
