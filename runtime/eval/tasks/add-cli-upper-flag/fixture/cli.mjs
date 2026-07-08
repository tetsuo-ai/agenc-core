const args = process.argv.slice(2);
const name = args[0] ?? "world";
process.stdout.write("hello, " + name + "\n");
