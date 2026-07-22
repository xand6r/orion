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
  // eslint-disable-next-line no-console
  console.log("\n\n\n\n");
  // eslint-disable-next-line no-console
  console.log(MOGWAI_BANNER.trimEnd());
  if (extra) {
    // eslint-disable-next-line no-console
    console.log(extra);
  }
  // eslint-disable-next-line no-console
  console.log("\n\n\n\n");
}
