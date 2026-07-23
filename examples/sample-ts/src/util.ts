export function wagTail(who: string): void {
  console.log(`${who} wags tail`);
}

export function purr(who: string): void {
  console.log(`${who} purrs less than most`);
}

function _local_(test: string) {
  console.log("Do more local stuff");
  console.log("Do local stuff");
}

function _other_(test: string) {
  console.log("Other", _local_(test));
}