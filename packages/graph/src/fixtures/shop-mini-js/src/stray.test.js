// Stray test file: must be excluded from the graph (IT-GR-JS-03).
const { ghost } = require("./service.js");

ghost("/phantom", () => "never in graph");
