/**
 * Startup banner — printed to stdout (not JSON logs) so the art stays readable.
 */
const GREEN_DOT = "\x1b[32m●\x1b[0m";

export const MOGWAI_BANNER = `
      .--.      ORION ${GREEN_DOT} online
     |o_o |
     |:_/ |
    //   \\ \\
   (|     | )
  /'\\_   _/\\'
  \\___)=(___/
`;

export function printMogwaiBanner(extra?: string): void {
  // Flush-friendly: write once so docker logging drivers don't scramble lines.
  const parts = ["\n\n\n\n", MOGWAI_BANNER.trimEnd()];
  if (extra) parts.push(extra);
  parts.push("\n\n\n\n");
  // eslint-disable-next-line no-console
  console.log(parts.join("\n"));
}
