function list() {
  return deep();
}

function deep() {
  return deeper();
}

function deeper() {
  return level4();
}

function level4() {
  return [];
}

module.exports = { list, deep, deeper, level4 };
