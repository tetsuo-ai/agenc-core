export function loadPort(iniText) {
  const match = /port = (\d+)/u.exec(iniText);
  return match ? Number(match[1]) : 8080;
}
