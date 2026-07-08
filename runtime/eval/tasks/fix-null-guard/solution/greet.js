export function greet(user) {
  const name =
    user && typeof user.name === "string" && user.name.length > 0
      ? user.name
      : "guest";
  return "hello, " + name;
}
