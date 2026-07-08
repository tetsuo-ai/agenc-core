const args = process.argv.slice(2);
const upper = args.includes("--upper");
const positional = args.filter((arg) => arg !== "--upper");
const name = positional[0] ?? "world";
const line = "hello, " + name;
process.stdout.write((upper ? line.toUpperCase() : line) + "\n");
