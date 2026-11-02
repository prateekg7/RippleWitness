export function list(): string[] {
  return deep();
}

export function deep(): string[] {
  return deeper();
}

export function deeper(): string[] {
  return level4();
}

export function level4(): string[] {
  return [];
}
