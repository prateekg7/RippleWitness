// Dependency-free Express stand-in for extractor tests (valid JS, never executed).
const app = {
  get(_path, _h) {},
  post(_path, _h) {},
  use(_prefix, _router) {},
};

function Router() {
  return { get(_p, _h) {} };
}

module.exports = { app, Router };
