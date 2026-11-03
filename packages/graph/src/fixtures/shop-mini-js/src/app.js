const { app, Router } = require("./stub.js");
const { list } = require("./service.js");

const router = Router();
router.get("/items", () => list());
app.use("/api", router);
app.get("/health", () => "ok");
